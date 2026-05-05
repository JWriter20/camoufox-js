import crypto from "node:crypto";
import {
	BOLD,
	BOX_W,
	CAT_ART,
	CATEGORY_LABELS,
	CYAN,
	GREEN,
	RED,
	RESET,
	boxBot,
	boxLine,
	boxSep,
	boxTop,
	gradeColor,
} from "./constants.js";
import type { ProxyGeo } from "./proxies.js";

// ── Profile entry shapes ──────────────────────────────────────────────────────
// Mirrors what python's run_tests.py builds; keeps json-shape compat so the
// signed certificate cross-validates between the two harnesses if needed.

export interface ProfileSpec {
	name: string;
	os: "linux" | "macos" | "windows";
	proxyGeo?: ProxyGeo;
}

export interface ProfileResult {
	profile: ProfileSpec;
	results: Record<string, any> | null;
	grade: string;
	passCount: number;
	totalChecks: number;
	error?: string;
}

export interface FullResult {
	profiles: ProfileResult[];
	crossProfile: CrossProfileSummary;
	overallGrade: string;
	totalPassed: number;
	totalChecks: number;
	timestamp: string;
}

export interface UniquenessSummary {
	uniqueAudio: number;
	uniqueCanvas: number;
	uniqueFonts: number;
	uniqueTimezones: number;
	uniqueScreens: number;
	uniqueVoices: number;
	uniqueWebGL: number;
	uniquePlatforms: number;
	total: number;
}

export interface CrossProfileSummary {
	macPerContext: UniquenessSummary;
	linuxPerContext: UniquenessSummary;
}

export interface SectionResult {
	name: string;
	passed: number;
	total: number;
}

export interface Certificate {
	id: string;
	signature: string;
	resultsHash: string;
	timestamp: string;
	platform: string;
	camoufoxVersion: string;
	passCount: number;
	totalTests: number;
	overallPass: boolean;
	sectionResults: SectionResult[];
	failedTests: string[];
	profileCount: number;
	proxyInfo: {
		name: string;
		ip: string;
		city: string;
		country: string;
		timezone: string;
	}[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSectionLine(name: string, passed: number, total: number): string {
	const ok = passed === total;
	const score = `${passed}/${total}`;
	const statusVisible = ok ? "[PASS]" : `[${total - passed} FAIL]`;
	const statusAnsi = ok
		? `${GREEN}${statusVisible}${RESET}`
		: `${RED}${statusVisible}${RESET}`;
	const prefixVis = `  ${name} `;
	const suffixVis = ` ${score}  ${statusVisible}  `;
	const dotsLen = Math.max(1, BOX_W - prefixVis.length - suffixVis.length);
	const inner = `  ${name} ${".".repeat(dotsLen)} ${score}  ${statusAnsi}  `;
	return boxLine(inner);
}

export function printProfileResult(pr: ProfileResult): void {
	const { profile, error } = pr;
	const grade = pr.grade ?? "F";
	const passCount = pr.passCount ?? 0;
	const totalChecks = pr.totalChecks ?? 0;
	const gc = gradeColor(grade);

	if (error) {
		console.log(`  ${RED}✗${RESET} ${profile.name}: ${RED}ERROR${RESET} — ${error}`);
		return;
	}
	const tick = grade === "A" || grade === "B" ? "✓" : "✗";
	console.log(
		`  ${tick} ${profile.name}: ${gc}${BOLD}[${grade}]${RESET} ${passCount}/${totalChecks}`,
	);
	const results = pr.results ?? {};
	const stability = results.stability ?? {};
	if (stability && !stability.stable) {
		console.log(`      ${RED}↳ Stability: ${stability.detail ?? "?"}${RESET}`);
	}
	const webrtc = results.webrtc ?? {};
	if (webrtc && !webrtc.passed) {
		console.log(`      ${RED}↳ WebRTC: ${webrtc.detail ?? "?"}${RESET}`);
	}
}

function computeSectionResults(results: Record<string, any>): SectionResult[] {
	const sections: SectionResult[] = [];
	const allCategories: Record<string, any> = {
		...(results.core ?? {}),
		...(results.extended ?? {}),
		...(results.workers ?? {}),
	};
	for (const [key, checks] of Object.entries(allCategories)) {
		if (key === "webglExtended") continue;
		if (!checks || typeof checks !== "object") continue;
		let passed = 0;
		let total = 0;
		for (const check of Object.values(checks as Record<string, any>)) {
			if (check && typeof check.passed === "boolean") {
				total += 1;
				if (check.passed) passed += 1;
			}
		}
		if (total > 0) {
			sections.push({ name: CATEGORY_LABELS[key] ?? key, passed, total });
		}
	}
	const webrtc = results.webrtc ?? {};
	const stability = results.stability ?? {};
	sections.push({ name: "WebRTC", passed: webrtc.passed ? 1 : 0, total: 1 });
	sections.push({
		name: "Stability",
		passed: stability.stable ? 1 : 0,
		total: 1,
	});
	return sections;
}

export function computeCrossProfile(profiles: ProfileResult[]): CrossProfileSummary {
	const empty = (): UniquenessSummary => ({
		uniqueAudio: 0,
		uniqueCanvas: 0,
		uniqueFonts: 0,
		uniqueTimezones: 0,
		uniqueScreens: 0,
		uniqueVoices: 0,
		uniqueWebGL: 0,
		uniquePlatforms: 0,
		total: 0,
	});

	const analyze = (group: ProfileResult[]): UniquenessSummary => {
		if (group.length === 0) return empty();
		const audio = new Set<string>();
		const canvas = new Set<string>();
		const fonts = new Set<string>();
		const timezones = new Set<string>();
		const screens = new Set<string>();
		const voices = new Set<string>();
		const webglSet = new Set<string>();
		const platforms = new Set<string>();
		for (const p of group) {
			const fp = (p.results ?? {}).fingerprints ?? {};
			if (fp.audio?.hash) audio.add(fp.audio.hash);
			if (fp.canvas?.hash) canvas.add(fp.canvas.hash);
			if (fp.fonts?.hash) fonts.add(fp.fonts.hash);
			if (fp.timezone?.timezone) timezones.add(fp.timezone.timezone);
			if (fp.screen) screens.add(`${fp.screen.width}x${fp.screen.height}`);
			if (fp.speechVoices?.hash) voices.add(fp.speechVoices.hash);
			if (fp.webgl) webglSet.add(`${fp.webgl.unmaskedVendor}|${fp.webgl.unmaskedRenderer}`);
			if (fp.navigator?.platform) platforms.add(fp.navigator.platform);
		}
		return {
			uniqueAudio: audio.size,
			uniqueCanvas: canvas.size,
			uniqueFonts: fonts.size,
			uniqueTimezones: timezones.size,
			uniqueScreens: screens.size,
			uniqueVoices: voices.size,
			uniqueWebGL: webglSet.size,
			uniquePlatforms: platforms.size,
			total: group.length,
		};
	};

	return {
		macPerContext: analyze(profiles.filter((p) => p.profile.os === "macos")),
		linuxPerContext: analyze(profiles.filter((p) => p.profile.os === "linux")),
	};
}

export function generateCertificate(full: FullResult, secret: string): Certificate {
	const allSectionResults: SectionResult[] = [];
	const allFailedTests: string[] = [];

	for (const pr of full.profiles) {
		if (!pr.results) {
			allFailedTests.push(`${pr.profile.name}: Error — ${pr.error ?? "unknown"}`);
			continue;
		}
		const sections = computeSectionResults(pr.results);
		for (const s of sections) {
			const existing = allSectionResults.find((e) => e.name === s.name);
			if (existing) {
				existing.passed += s.passed;
				existing.total += s.total;
			} else {
				allSectionResults.push({ ...s });
			}
		}
		const allCats: Record<string, any> = {
			...(pr.results.core ?? {}),
			...(pr.results.extended ?? {}),
			...(pr.results.workers ?? {}),
		};
		for (const [catKey, checks] of Object.entries(allCats)) {
			if (!checks || typeof checks !== "object") continue;
			for (const [checkName, check] of Object.entries(checks as Record<string, any>)) {
				if (check && typeof check.passed === "boolean" && !check.passed) {
					const label = CATEGORY_LABELS[catKey] ?? catKey;
					allFailedTests.push(
						`${pr.profile.name}: ${label}: ${checkName} — ${check.detail ?? ""}`,
					);
				}
			}
		}
		const webrtc = pr.results.webrtc ?? {};
		const stability = pr.results.stability ?? {};
		if (!webrtc.passed) {
			allFailedTests.push(`${pr.profile.name}: WebRTC: ${webrtc.detail ?? ""}`);
		}
		if (!stability.stable) {
			allFailedTests.push(`${pr.profile.name}: Stability: ${stability.detail ?? ""}`);
		}
	}

	const cp = full.crossProfile;
	const mac = cp.macPerContext;
	const linux = cp.linuxPerContext;

	if (mac.total > 0) {
		const macUnique =
			(mac.uniqueAudio === mac.total ? 1 : 0) +
			(mac.uniqueCanvas === mac.total ? 1 : 0) +
			(mac.uniqueTimezones === mac.total ? 1 : 0) +
			(mac.uniqueScreens === mac.total ? 1 : 0);
		allSectionResults.push({ name: "Mac Uniqueness", passed: macUnique, total: 4 });
	}
	if (linux.total > 0) {
		const linuxUnique =
			(linux.uniqueAudio === linux.total ? 1 : 0) +
			(linux.uniqueCanvas === linux.total ? 1 : 0) +
			(linux.uniqueTimezones === linux.total ? 1 : 0) +
			(linux.uniqueScreens === linux.total ? 1 : 0);
		allSectionResults.push({ name: "Linux Uniqueness", passed: linuxUnique, total: 4 });
	}

	const hashData = {
		profiles: full.profiles.map((p) => ({
			name: p.profile.name,
			grade: p.grade,
			passCount: p.passCount,
			totalChecks: p.totalChecks,
		})),
		crossProfile: full.crossProfile,
		timestamp: full.timestamp,
	};
	// JSON.stringify with separator keys-only-no-spaces to match python's
	// json.dumps(separators=(",",":")) so the signed hash is stable across
	// the two implementations.
	const resultsHash = crypto
		.createHash("sha256")
		.update(JSON.stringify(hashData))
		.digest("hex");
	const signature = crypto
		.createHmac("sha256", secret)
		.update(resultsHash)
		.digest("hex");

	let ua = "";
	for (const pr of full.profiles) {
		if (pr.results) {
			ua = pr.results.fingerprints?.navigator?.userAgent ?? "";
			break;
		}
	}
	const fxMatch = /Firefox\/(\d+\.\d+)/.exec(ua);
	const camoufoxVersionStr = fxMatch ? `Firefox ${fxMatch[1]}` : ua.slice(0, 60);

	const proxyInfo = full.profiles.map((pr) => {
		const geo = pr.profile.proxyGeo ?? {};
		return {
			name: pr.profile.name,
			ip: geo.query ?? "?",
			city: geo.city ?? "?",
			country: geo.country ?? "?",
			timezone: geo.timezone ?? "?",
		};
	});

	return {
		id: crypto.randomUUID(),
		signature,
		resultsHash,
		timestamp: full.timestamp,
		platform: "Multi-OS (Service)",
		camoufoxVersion: camoufoxVersionStr,
		passCount: full.totalPassed,
		totalTests: full.totalChecks,
		overallPass: full.totalPassed === full.totalChecks,
		sectionResults: allSectionResults,
		failedTests: allFailedTests.slice(0, 20),
		profileCount: full.profiles.length,
		proxyInfo,
	};
}

export function printCertificate(
	cert: Certificate,
	crossProfile: CrossProfileSummary,
	overallGrade: string,
): void {
	const gc = gradeColor(overallGrade);
	console.log("");
	console.log(CYAN + CAT_ART + RESET);
	console.log("");
	console.log(BOLD + boxTop() + RESET);

	const title = "CAMOUFOX SERVICE VERIFICATION CERTIFICATE";
	const titlePad = Math.max(0, Math.floor((BOX_W - title.length) / 2));
	console.log(BOLD + boxLine(`${" ".repeat(titlePad)}${title}`) + RESET);
	console.log(BOLD + boxSep() + RESET);

	const gradeInner = `  ${gc}${BOLD}Grade: ${overallGrade}${RESET}     Score: ${cert.passCount}/${cert.totalTests}     Profiles: ${cert.profileCount}`;
	console.log(boxLine(gradeInner));
	console.log(boxLine(`  Issued: ${cert.timestamp}`));

	if (cert.overallPass) {
		console.log(boxLine(`  Status: ${GREEN}ALL PASS${RESET}`));
	} else {
		console.log(boxLine(`  Status: ${RED}FAILURES DETECTED${RESET}`));
	}

	console.log(BOLD + boxSep() + RESET);
	console.log(boxLine(`  ${BOLD}SECTION RESULTS${RESET}`));
	for (const s of cert.sectionResults) {
		console.log(formatSectionLine(s.name, s.passed, s.total));
	}

	console.log(BOLD + boxSep() + RESET);
	console.log(boxLine(`  ${BOLD}CROSS-PROFILE UNIQUENESS${RESET}`));
	const mac = crossProfile.macPerContext;
	const linux = crossProfile.linuxPerContext;
	if (mac.total > 0) {
		const t = mac.total;
		console.log(
			boxLine(
				`  macOS  Audio:${mac.uniqueAudio}/${t}  Canvas:${mac.uniqueCanvas}/${t}  TZ:${mac.uniqueTimezones}/${t}  Screen:${mac.uniqueScreens}/${t}`,
			),
		);
	}
	if (linux.total > 0) {
		const t = linux.total;
		console.log(
			boxLine(
				`  Linux  Audio:${linux.uniqueAudio}/${t}  Canvas:${linux.uniqueCanvas}/${t}  TZ:${linux.uniqueTimezones}/${t}  Screen:${linux.uniqueScreens}/${t}`,
			),
		);
	}

	if (cert.proxyInfo.length > 0) {
		console.log(BOLD + boxSep() + RESET);
		console.log(boxLine(`  ${BOLD}PROXY DEBUG${RESET}`));
		for (const pi of cert.proxyInfo) {
			const shortName = pi.name.replace(" Per-Context", "");
			console.log(
				boxLine(`  ${CYAN}${shortName.padEnd(9)}${RESET}  ${pi.ip.padEnd(15)}  ${pi.timezone}`),
			);
			console.log(boxLine(`  ${"".padEnd(11)}${pi.city}, ${pi.country}`));
		}
	}

	console.log(BOLD + boxSep() + RESET);
	console.log(boxLine(`  ID:   ${cert.id}`));
	console.log(boxLine(`  Hash: ${cert.resultsHash.slice(0, 48)}...`));
	console.log(boxLine(`  Sig:  ${cert.signature.slice(0, 48)}...`));
	console.log(BOLD + boxBot() + RESET);
	console.log("");
}
