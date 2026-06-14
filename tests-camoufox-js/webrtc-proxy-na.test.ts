import { describe, expect, test } from "vitest";
import { Camoufox } from "../src";

/*
 * WebRTC "n/a behind a TCP proxy" regression test.
 *
 * THE BUG (HANDOFF-webrtc-proxy-na-fix.md):
 *   The fork's webrtc-ip-spoofing.patch was rewrite-only: it replaced the IP in
 *   srflx ICE candidates that ICE *already gathered*. Behind a TCP-only proxy,
 *   STUN (UDP) can't traverse, so NO srflx candidate ever forms -> the spoof has
 *   nothing to rewrite -> WebRTC reports `n/a`. n/a looks like
 *   media.peerconnection.enabled=false and is flagged as suspicious by anti-bot.
 *
 * THE FIX:
 *   When ICE gathering completes with no public candidate, the browser now
 *   FABRICATES a synthetic srflx carrying config["webrtc:ipv4"] (the proxy exit
 *   IP) into THREE surfaces a detector can read: the live onicecandidate stream,
 *   pc.localDescription.sdp, and pc.getStats(). All three must agree or the
 *   mismatch itself leaks.
 *
 * WHY THE OTHER TEST CAN'T SEE THIS:
 *   webrtc-leak.test.ts runs no-proxy with a REACHABLE STUN server and
 *   soft-skips if no srflx forms. It only exercises the rewrite path. It passes
 *   whether the spoof rewrites a real candidate OR produces nothing, so it is
 *   blind to the proxy/n-a bug. This test asserts a NON-EMPTY srflx == spoof IP.
 *
 * TWO SCENARIOS:
 *   1. blackhole-STUN  (default, no external creds): spoof IP set + an
 *      unreachable TEST-NET-1 STUN server faithfully reproduces "UDP STUN
 *      blocked by a TCP proxy". MUST PASS on a fixed build, MUST FAIL on the
 *      pre-fix build (0 candidates). Needs only a fork build + the binary; no
 *      real proxy, no UDP egress.
 *   2. real-TCP-proxy  (opt-in via CAMOUFOX_TEST_PROXY): drives the actual
 *      production geoip path (geoip:true -> publicIP(proxy) -> webrtc:ipv4) and
 *      asserts the WebRTC srflx equals the proxy exit IP. Skips when no proxy is
 *      configured so CI without a proxy doesn't fail spuriously.
 *
 * Requires a fork build via CAMOUFOX_EXECUTABLE_PATH / FFPATH.
 */

const SENTINEL_IP = "5.6.7.8";
// TEST-NET-1 blackhole: a syntactically-valid STUN URL that no UDP packet can
// ever reach a response from -> gathering completes with zero public candidates,
// exactly like a TCP proxy swallowing the UDP STUN.
const BLACKHOLE_STUN = "stun:192.0.2.1:3478";

const EXEC_PATH =
	process.env.CAMOUFOX_EXECUTABLE_PATH || process.env.FFPATH || "";

// Opt-in real proxy. Format: a playwright proxy.server URL, optionally with
// creds in the URL, e.g. "http://user:pass@host:port" or "http://host:port".
// Set CAMOUFOX_TEST_PROXY to run the real-proxy scenario.
const PROXY_SERVER = process.env.CAMOUFOX_TEST_PROXY || "";

interface GatherResult {
	candidates: {
		candidate: string;
		address: string | null;
		type: string | null;
	}[];
	sdp: string;
	statsSrflx: { address: string | null; protocol: string | null }[];
	statsPairs: number;
	error: string | null;
}

// Runs in the page: open an RTCPeerConnection, gather ICE to completion (or a
// generous timeout that outlasts the ~11s STUN-blackhole gather), and report
// the candidate strings, SDP, and getStats() local-candidate srflx entries.
function gatherIce(arg: { stunUrl: string; timeoutMs: number }) {
	const { stunUrl, timeoutMs } = arg;
	return new Promise<GatherResult>((resolve) => {
		const out: GatherResult = {
			candidates: [],
			sdp: "",
			statsSrflx: [],
			statsPairs: 0,
			error: null,
		};
		let pc: RTCPeerConnection;
		try {
			pc = new RTCPeerConnection({ iceServers: [{ urls: stunUrl }] });
		} catch (e) {
			out.error = `ctor: ${(e as Error).message}`;
			return resolve(out);
		}
		let settled = false;
		const finish = async () => {
			if (settled) return;
			settled = true;
			try {
				out.sdp = pc.localDescription ? pc.localDescription.sdp : "";
			} catch {}
			try {
				const report = await pc.getStats();
				report.forEach(
					(s: {
						type?: string;
						candidateType?: string;
						address?: string | null;
						protocol?: string | null;
					}) => {
						if (s.type === "local-candidate" && s.candidateType === "srflx") {
							out.statsSrflx.push({
								address: s.address ?? null,
								protocol: s.protocol ?? null,
							});
						}
						if (s.type === "candidate-pair") out.statsPairs++;
					},
				);
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
				// gathering complete (null candidate)
				void finish();
			}
		};
		pc.createDataChannel("probe");
		pc.createOffer()
			.then((o) => pc.setLocalDescription(o))
			.catch((e) => {
				out.error = `offer: ${(e as Error).message}`;
				void finish();
			});
		setTimeout(() => void finish(), timeoutMs);
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

// Replica of CreepJS's actual WebRTC probe (src/webrtc/index.ts). This is the
// REAL detection surface — the plain candidate/SDP/getStats checks above pass
// even for a broken single-srflx fabrication, but CreepJS renders four fields
// with precise timing logic and a half-populated state (host box filled, stun
// box "blocked") is a worse tell than n/a. CreepJS: ONE RTCPeerConnection with
// STUN servers, latches the FIRST candidate as "host connection" + its
// foundation as "type & base ip", and fills "stun connection"/"ip" from the
// candidate present when getIPAddress(localDescription.sdp) first returns a
// real IP (3s budget, else "blocked").
interface CreepResult {
	hostBox: string | null; // first candidate (CreepJS "host connection")
	foundation: string | null; // foundation token of the first candidate
	stunBox: string | null; // candidate when SDP first exposed a real IP
	ipFromSdp: string | null; // getIPAddress(localDescription.sdp)
}
function creepWebrtcReplica(stunUrl: string) {
	return new Promise<CreepResult>((resolve) => {
		const out: CreepResult = {
			hostBox: null,
			foundation: null,
			stunBox: null,
			ipFromSdp: null,
		};
		const pc = new RTCPeerConnection({
			iceCandidatePoolSize: 1,
			iceServers: [{ urls: [stunUrl] }],
		});
		// CreepJS's exact getIPAddress: c=IN line first, else udp/tcp <n> <ip>.
		const getIP = (sdp: string): string | undefined => {
			const blocked = "0.0.0.0";
			const candRe = /((udp|tcp)\s)((\d|\w)+\s)((\d|\w|(\.|:))+)(?=\s)/gi;
			const connRe = /(c=IN\s)(.+)\s/gi;
			const connIp = ((sdp.match(connRe) || [])[0] || "").trim().split(" ")[2];
			if (connIp && connIp !== blocked) return connIp;
			const candIp = ((sdp.match(candRe) || [])[0] || "").split(" ")[2];
			return candIp && candIp !== blocked ? candIp : undefined;
		};
		let done = false;
		let iceCandidate: string | null = null;
		const finish = () => {
			if (done) return;
			done = true;
			resolve(out);
		};
		pc.addEventListener("icecandidate", (ev) => {
			const c = ev.candidate?.candidate;
			if (!c) return;
			if (!iceCandidate) {
				iceCandidate = c;
				out.hostBox = c;
				out.foundation = (/^candidate:([\w]+)/.exec(c) || [])[1] || "";
			}
			const sdp = pc.localDescription ? pc.localDescription.sdp : "";
			const addr = getIP(sdp);
			if (!addr) return;
			out.stunBox = c;
			out.ipFromSdp = addr;
			finish();
		});
		pc.createDataChannel("");
		pc.createOffer().then((o) => pc.setLocalDescription(o));
		setTimeout(finish, 3000);
	});
}

// Assert CreepJS renders all four WebRTC fields like a real browser: a typ host
// .local candidate in slot 1 (foundation 0), the srflx with the spoof IP in the
// stun slot, and ip == spoof IP. NONE blocked. This is what actually regressed.
function assertCreepRendersLikeRealBrowser(r: CreepResult, spoofIp: string) {
	expect(r.hostBox, "CreepJS host box must not be blocked").toBeTruthy();
	expect(
		r.hostBox,
		`host box should be a 'typ host' .local candidate, got: ${r.hostBox}`,
	).toMatch(/\.local\b.*typ host/);
	expect(
		r.foundation,
		"foundation (type & base ip) should be '0' like a real host candidate",
	).toBe("0");
	expect(
		r.stunBox,
		"CreepJS 'stun connection' must NOT be blocked (was the bug)",
	).toBeTruthy();
	expect(r.stunBox).toContain(spoofIp);
	expect(r.stunBox).toMatch(/typ srflx/);
	expect(
		r.ipFromSdp,
		"CreepJS 'ip' (foundation/ip) must be the spoof IP, not blocked",
	).toBe(spoofIp);
}

// Assert the spoof IP shows up as a srflx across ALL THREE surfaces, and the
// real public IP never appears. This is the heart of the fix.
function assertSrflxMatchesSpoofEverywhere(
	r: GatherResult,
	spoofIp: string,
	realIp: string | null,
) {
	// (a) onicecandidate stream: at least one srflx whose address is the spoof IP.
	const srflx = r.candidates.filter((c) => c.type === "srflx");
	expect(
		srflx.length,
		`expected >=1 srflx candidate in the onicecandidate stream, got ${r.candidates.length} candidates total (n/a bug if 0)`,
	).toBeGreaterThan(0);
	const srflxAddrs = [...new Set(srflx.map((c) => c.address).filter(Boolean))];
	expect(srflxAddrs).toEqual([spoofIp]);

	// (b) localDescription.sdp: an a=candidate srflx line carrying the spoof IP.
	const sdpSrflx = r.sdp
		.split(/\r?\n/)
		.filter((l) => l.startsWith("a=candidate:") && l.includes(" typ srflx "));
	expect(
		sdpSrflx.length,
		"expected a srflx a=candidate line in localDescription.sdp",
	).toBeGreaterThan(0);
	expect(sdpSrflx.some((l) => l.includes(spoofIp))).toBe(true);

	// (c) getStats(): a local-candidate srflx entry with the spoof IP, so the
	// three surfaces are self-consistent (a srflx in the SDP with no matching
	// stat is itself a detectable tell).
	expect(
		r.statsSrflx.length,
		"expected a srflx local-candidate in getStats() (SDP/stats mismatch leaks otherwise)",
	).toBeGreaterThan(0);
	expect(r.statsSrflx.some((s) => s.address === spoofIp)).toBe(true);

	// Candidate-pair stats must stay empty (no remote peer); fabricating them
	// would be a novel inconsistency a real browser never shows.
	expect(
		r.statsPairs,
		"there should be no candidate-pair stats with no remote peer",
	).toBe(0);

	// The real public IP must never appear in any surface.
	const allText = `${r.candidates.map((c) => c.candidate).join("\n")}\n${r.sdp}\n${r.statsSrflx.map((s) => s.address).join("\n")}`;
	if (realIp) {
		expect(ipv4sIn(allText)).not.toContain(realIp);
	}
}

describe.skipIf(!EXEC_PATH)("WebRTC n/a behind a TCP proxy", () => {
	// Scenario 1 — reproduces the exact n/a condition without a real proxy.
	// MUST PASS on a fixed build; FAILS on the pre-fix build (0 candidates).
	test("fabricates a srflx == spoof IP across candidates + SDP + getStats when STUN is blocked", async () => {
		const realIP = await realPublicIP();
		const browser = await Camoufox({
			executable_path: EXEC_PATH,
			headless: true,
			// Drive the spoof directly via config — exactly what the geoip
			// path sets from the proxy IP in production (utils.ts).
			config: { "webrtc:ipv4": SENTINEL_IP },
			// Force proxy-only ICE so NO real srflx can ever form, even on a
			// host with open UDP egress. The blackhole STUN URL alone is not
			// enough: on a UDP-open box ICE still finds a real public route,
			// surfaces a real srflx, flips mSurfacedPublicCandidate, and
			// suppresses fabrication — so the test would spuriously fail on
			// dev machines while passing in production (always behind a proxy
			// with proxy_only_if_behind_proxy=true). proxy_only=true reproduces
			// the production "no real srflx, must fabricate" condition with no
			// live proxy needed. This is the unconditional form of the
			// ice.proxy_only_if_behind_proxy pref already in camoufox.cfg.
			firefox_user_prefs: {
				"media.peerconnection.ice.proxy_only": true,
			},
		});
		try {
			const page = await browser.newPage();
			await page.goto("https://example.com/", {
				waitUntil: "domcontentloaded",
			});
			const r = await page.evaluate(gatherIce, {
				stunUrl: BLACKHOLE_STUN,
				timeoutMs: 20000,
			});
			expect(r.error).toBeNull();
			assertSrflxMatchesSpoofEverywhere(r, SENTINEL_IP, realIP);

			// The actual detection surface: CreepJS must render host/stun/
			// foundation/ip like a real browser, not a half-blocked state.
			const creep = await page.evaluate(creepWebrtcReplica, BLACKHOLE_STUN);
			assertCreepRendersLikeRealBrowser(creep, SENTINEL_IP);
		} finally {
			await browser.close();
		}
	}, 50e3);

	// Scenario 2 — the real report: an actual TCP proxy + the geoip path.
	// Opt-in; skips cleanly when CAMOUFOX_TEST_PROXY is not set.
	test.skipIf(!PROXY_SERVER)(
		"WebRTC reports the proxy exit IP (not n/a) behind a real TCP proxy via geoip",
		async () => {
			const realIP = await realPublicIP();

			// Parse optional creds out of the URL form user:pass@host:port.
			const u = new URL(PROXY_SERVER);
			const proxy: { server: string; username?: string; password?: string } = {
				server: `${u.protocol}//${u.host}`,
			};
			if (u.username) proxy.username = decodeURIComponent(u.username);
			if (u.password) proxy.password = decodeURIComponent(u.password);

			const browser = await Camoufox({
				executable_path: EXEC_PATH,
				headless: true,
				proxy,
				// geoip:true runs publicIP(proxy) -> sets webrtc:ipv4 to the proxy
				// exit IP. This is the exact production path the bug report hit.
				geoip: true,
			});
			try {
				const page = await browser.newPage();
				// Discover the proxy exit IP independently over HTTP through the
				// same proxy, so we can assert WebRTC == HTTP IP.
				await page.goto("https://api.ipify.org/?format=text", {
					waitUntil: "domcontentloaded",
				});
				const proxyExitIp = (await page.evaluate(
					() => document.body.textContent?.trim() ?? "",
				)) as string;
				expect(proxyExitIp, "could not resolve proxy exit IP").toMatch(
					/^\d{1,3}(\.\d{1,3}){3}$/,
				);

				await page.goto("https://example.com/", {
					waitUntil: "domcontentloaded",
				});
				// Use a real public STUN server: behind a TCP proxy it still can't
				// form a srflx, so this exercises the fabrication path end-to-end.
				const r = await page.evaluate(gatherIce, {
					stunUrl: "stun:stun.l.google.com:19302",
					timeoutMs: 20000,
				});
				expect(r.error).toBeNull();
				assertSrflxMatchesSpoofEverywhere(r, proxyExitIp, realIP);

				// CreepJS detection surface: host/stun/foundation/ip must all
				// render with the proxy IP, exactly like a real browser.
				const creep = await page.evaluate(
					creepWebrtcReplica,
					"stun:stun.l.google.com:19302",
				);
				assertCreepRendersLikeRealBrowser(creep, proxyExitIp);
			} finally {
				await browser.close();
			}
		},
		60e3,
	);
});
