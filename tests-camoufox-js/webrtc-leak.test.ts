import { describe, expect, test } from "vitest";
import { Camoufox } from "../src";

/*
 * WebRTC public-IP leak regression test.
 *
 * The fork's webrtc-ip-spoofing.patch rewrites the IP in every ICE candidate /
 * SDP / getStats() entry to config["webrtc:ipv4"] (normally the proxy exit IP,
 * set by the geoip path in utils.ts). A 2026-06 regression wired the spoof gate
 * to WebRTCIPManager storage that nothing ever populated, so the gate always
 * returned false and the real public IP leaked in every srflx ICE candidate.
 * This test pins config["webrtc:ipv4"] to a sentinel and asserts the
 * server-reflexive candidate shows the SPOOFED ip, not the machine's real one.
 *
 * It uses NO proxy on purpose: STUN is UDP and production proxies are TCP-only,
 * so a srflx candidate never forms through them and the leak is invisible.
 * Running direct, with real UDP egress to a public STUN server, is what
 * actually reproduces the bug this patch fixes.
 *
 * Requires a fork build (CAMOUFOX_EXECUTABLE_PATH / FFPATH) and outbound UDP to
 * the STUN server. Skips cleanly when either is missing so CI without UDP
 * egress doesn't fail spuriously.
 */

const SENTINEL_IP = "5.6.7.8";
const STUN = process.env.STUN_URL || "stun:stun.l.google.com:19302";
const EXEC_PATH =
	process.env.CAMOUFOX_EXECUTABLE_PATH || process.env.FFPATH || "";

interface GatherResult {
	candidates: { candidate: string; address: string | null; type: string | null }[];
	sdp: string;
	error: string | null;
}

// Runs in the page: open an RTCPeerConnection against a public STUN server,
// gather ICE candidates to completion, report the raw candidate strings + SDP.
function gatherIce(stunUrl: string): Promise<GatherResult> {
	return new Promise<GatherResult>((resolve) => {
		const out: GatherResult = { candidates: [], sdp: "", error: null };
		let pc: RTCPeerConnection;
		try {
			pc = new RTCPeerConnection({ iceServers: [{ urls: stunUrl }] });
		} catch (e) {
			out.error = `RTCPeerConnection ctor threw: ${(e as Error).message}`;
			return resolve(out);
		}
		const done = () => {
			try {
				out.sdp = pc.localDescription ? pc.localDescription.sdp : "";
			} catch {}
			resolve(out);
		};
		pc.onicecandidate = (ev) => {
			if (ev.candidate?.candidate) {
				out.candidates.push({
					candidate: ev.candidate.candidate,
					address: ev.candidate.address ?? null,
					type: ev.candidate.type ?? null,
				});
			} else if (!ev.candidate) {
				done();
			}
		};
		pc.createDataChannel("probe");
		pc.createOffer()
			.then((o) => pc.setLocalDescription(o))
			.catch((e) => {
				out.error = `offer/setLocalDescription threw: ${(e as Error).message}`;
				resolve(out);
			});
		setTimeout(done, 12000);
	});
}

function ipv4sIn(text: string): string[] {
	const re =
		/(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)/g;
	return [...text.matchAll(re)].map((m) => m[0]);
}

async function realPublicIP(): Promise<string | null> {
	try {
		const res = await fetch("https://api.ipify.org", {
			signal: AbortSignal.timeout(8000),
		});
		return (await res.text()).trim() || null;
	} catch {
		return null;
	}
}

describe.skipIf(!EXEC_PATH)("WebRTC IP spoof", () => {
	test(
		"srflx ICE candidate shows the spoofed IP, never the real public IP",
		async () => {
			const realIP = await realPublicIP();

			const browser = await Camoufox({
				executable_path: EXEC_PATH,
				headless: true,
				// Drive the spoof directly via config, bypassing the geoip/proxy
				// path so the test is hermetic. This is exactly the key utils.ts
				// sets from geoip.
				config: { "webrtc:ipv4": SENTINEL_IP },
			});

			try {
				const page = await browser.newPage();
				await page.goto("https://example.com/", {
					waitUntil: "domcontentloaded",
				});
				const result = await page.evaluate(gatherIce, STUN);

				const srflx = result.candidates.filter((c) => c.type === "srflx");

				// If no srflx candidate gathered, UDP STUN is blocked in this
				// environment — the test can't prove anything, so skip rather
				// than fail. (Locally, with UDP egress, srflx always forms.)
				if (srflx.length === 0) {
					console.warn(
						"[webrtc-leak] no srflx candidate gathered (UDP STUN blocked?) — skipping assertions",
					);
					return;
				}

				const allText =
					result.candidates.map((c) => c.candidate).join("\n") +
					"\n" +
					result.sdp;

				// Real public IP must never appear in any candidate or the SDP.
				if (realIP) {
					expect(ipv4sIn(allText)).not.toContain(realIP);
				}

				// Every srflx candidate's address must be the sentinel.
				const srflxAddrs = [
					...new Set(srflx.map((c) => c.address).filter(Boolean)),
				];
				expect(srflxAddrs).toEqual([SENTINEL_IP]);
			} finally {
				await browser.close();
			}
		},
		30e3,
	);
});
