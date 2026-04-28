import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { closeSync, existsSync, openSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { globSync } from "glob";
import {
	CannotExecuteXvfb,
	CannotFindXvfb,
	VirtualDisplayNotSupported,
} from "./exceptions.js";
import { OS_NAME } from "./pkgman.js";

// POSIX open(2) flags. Node doesn't export these as constants on all
// platforms; Linux x86_64 values are stable.
const O_WRONLY = 0x1;
const O_CREAT = 0x40;
const O_EXCL = 0x80;

// How long to wait for Xvfb to bind its X11 socket before giving up.
const SOCKET_READY_TIMEOUT_MS = 10_000;
const SOCKET_POLL_INTERVAL_MS = 50;

export class VirtualDisplay {
	private debug: boolean;
	private proc: ChildProcess | null = null;
	private _display: number | null = null;
	private _claimPath: string | null = null;

	constructor(debug: boolean = false) {
		this.debug = debug;
	}

	private get xvfb_args(): string[] {
		return [
			"-screen",
			"0",
			"1x1x24",
			"-ac",
			"-nolisten",
			"tcp",
			"-extension",
			"RENDER",
			"+extension",
			"GLX",
			"-extension",
			"COMPOSITE",
			"-extension",
			"XVideo",
			"-extension",
			"XVideo-MotionCompensation",
			"-extension",
			"XINERAMA",
			"-shmem",
			"-fp",
			"built-ins",
			"-nocursor",
			"-br",
		];
	}

	private get xvfb_path(): string {
		const path = execFileSync("which", ["Xvfb"]).toString().trim();
		if (!path) {
			throw new CannotFindXvfb("Please install Xvfb to use headless mode.");
		}
		if (!existsSync(path) || !execFileSync("test", ["-x", path])) {
			throw new CannotExecuteXvfb(
				`I do not have permission to execute Xvfb: ${path}`,
			);
		}
		return path;
	}

	private xvfb_cmd(display: number): string[] {
		return [this.xvfb_path, `:${display}`, ...this.xvfb_args];
	}

	private execute_xvfb(display: number): void {
		const cmd = this.xvfb_cmd(display);
		if (this.debug) {
			console.log("Starting virtual display:", cmd.join(" "));
		}
		// Force Mesa software GLX. On systems with NVIDIA drivers installed,
		// libGLvnd loads NVIDIA's GLX provider, which acquires a global rwlock
		// at GL init. Under any GPU contention this blocks Xvfb startup for
		// many seconds. Xvfb on 1x1x24 never renders anything GPU-accelerated.
		this.proc = spawn(cmd[0], cmd.slice(1), {
			stdio: this.debug ? "inherit" : "ignore",
			detached: true,
			env: {
				...process.env,
				__GLX_VENDOR_LIBRARY_NAME: "mesa",
				LIBGL_ALWAYS_SOFTWARE: "1",
			},
		});
	}

	public async get(): Promise<string> {
		VirtualDisplay.assert_linux();

		if (!this.proc) {
			const display = VirtualDisplay._claim_display();
			this._display = display;
			this._claimPath = VirtualDisplay._claim_path(display);
			this.execute_xvfb(display);
			await this._waitForSocket(display);
		} else if (this.debug) {
			console.log(`Using virtual display: ${this._display}`);
		}

		return `:${this._display}`;
	}

	public kill(): void {
		if (this.proc && !this.proc.killed) {
			if (this.debug) {
				console.log("Terminating virtual display:", this._display);
			}
			this.proc.kill();
		}
		if (this._claimPath) {
			try {
				unlinkSync(this._claimPath);
			} catch {
				// claim file already gone
			}
			this._claimPath = null;
		}
	}

	/**
	 * Poll for /tmp/.X11-unix/X<display> — the socket Xvfb only creates on
	 * a successful bind. If it never appears, Xvfb failed to claim the
	 * display (typically a real lock collision we couldn't see).
	 */
	private async _waitForSocket(display: number): Promise<void> {
		const tmpd = process.env.TMPDIR || tmpdir();
		const socketPath = path.join(tmpd, ".X11-unix", `X${display}`);
		const deadline = Date.now() + SOCKET_READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (this.proc?.exitCode != null) {
				throw new CannotExecuteXvfb(
					`Xvfb exited with code ${this.proc.exitCode} before binding display :${display}`,
				);
			}
			if (existsSync(socketPath)) {
				return;
			}
			await sleep(SOCKET_POLL_INTERVAL_MS);
		}
		throw new CannotExecuteXvfb(
			`Xvfb did not bind display :${display} within ${SOCKET_READY_TIMEOUT_MS}ms`,
		);
	}

	/**
	 * Lock files Xvfb creates: /tmp/.X<N>-lock.
	 */
	public static _get_lock_files(): string[] {
		const tmpd = process.env.TMPDIR || tmpdir();
		try {
			return globSync(path.join(tmpd, ".X*-lock")).filter((p) => {
				try {
					return statSync(p).isFile();
				} catch {
					return false;
				}
			});
		} catch {
			return [];
		}
	}

	/**
	 * Camoufox-private claim file path for a display number. Distinct from
	 * Xvfb's .X<N>-lock so Xvfb is free to manage its own lock semantics.
	 */
	private static _claim_path(display: number): string {
		const tmpd = process.env.TMPDIR || tmpdir();
		return path.join(tmpd, `.camoufox-X${display}.claim`);
	}

	/**
	 * Atomically reserve a display number across concurrent camoufox-js
	 * processes by O_CREAT|O_EXCL on a private claim file. Xvfb itself
	 * never sees this file, so its own lock-file handling is unaffected.
	 * The caller must release the claim by unlinking it (see kill()).
	 */
	private static _claim_display(): number {
		const ls = VirtualDisplay._get_lock_files().map((x) =>
			parseInt(x.split("X")[1].split("-")[0], 10),
		);
		const baseline = ls.length ? Math.max(99, Math.max(...ls)) : 99;

		for (let attempt = 0; attempt < 50; attempt++) {
			const candidate = baseline + randomInt(3, 20) + attempt;
			const claimPath = VirtualDisplay._claim_path(candidate);
			// Skip if Xvfb already holds this display.
			if (existsSync(path.join(tmpdir(), `.X${candidate}-lock`))) {
				continue;
			}
			try {
				const fd = openSync(claimPath, O_EXCL | O_CREAT | O_WRONLY, 0o644);
				closeSync(fd);
				return candidate;
			} catch (e: any) {
				if (e?.code === "EEXIST") continue;
				throw e;
			}
		}
		throw new CannotExecuteXvfb(
			"Could not reserve a free X11 display after 50 attempts",
		);
	}

	private static assert_linux(): void {
		if (OS_NAME !== "lin") {
			throw new VirtualDisplayNotSupported(
				"Virtual display is only supported on Linux.",
			);
		}
	}
}
