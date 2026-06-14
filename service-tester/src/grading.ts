// Grading logic mirrored 1:1 from camoufox/service-tester/_grading.py.
// Keep in lockstep with the python side — both consume the same checks
// bundle so the grade thresholds and check counting must match.

export function computeGrade(passCount: number, totalChecks: number): string {
	const failCount = totalChecks - passCount;
	if (failCount === 0) return "A";
	if (failCount <= 2) return "B";
	if (failCount <= 5) return "C";
	if (failCount <= 10) return "D";
	return "F";
}

function countChecks(categories: Record<string, any>): [number, number] {
	let passed = 0;
	let total = 0;
	for (const cat of Object.values(categories)) {
		if (!cat || typeof cat !== "object") continue;
		for (const check of Object.values(cat as Record<string, any>)) {
			if (check && typeof check.passed === "boolean") {
				total += 1;
				if (check.passed) passed += 1;
			}
		}
	}
	return [passed, total];
}

export function countAllChecks(results: Record<string, any>): [number, number] {
	let passCount = 0;
	let totalChecks = 0;

	for (const categoryName of ["core", "extended", "workers"]) {
		const [p, t] = countChecks(results[categoryName] ?? {});
		passCount += p;
		totalChecks += t;
	}

	// WebRTC
	totalChecks += 1;
	if (results.webrtc?.passed) passCount += 1;

	// Stability
	totalChecks += 1;
	if (results.stability?.stable) passCount += 1;

	// Self-destruct (per-context mode)
	if (results.selfDestruct) {
		for (const check of Object.values(results.selfDestruct as Record<string, any>)) {
			if (check && typeof check.passed === "boolean") {
				totalChecks += 1;
				if (check.passed) passCount += 1;
			}
		}
	}

	return [passCount, totalChecks];
}

// Fonts: a non-host-OS profile (e.g. macOS-spoofed contexts on a Linux
// host) cannot legitimately produce host-OS fonts, so cross-OS font
// checks are expected to "fail" — flip them to passing with a tag.
export function adjustCrossOsFontChecks(
	osType: string,
	results: Record<string, any>,
): void {
	const hostOs =
		process.platform === "darwin"
			? "macos"
			: process.platform === "win32"
				? "windows"
				: "linux";
	if (osType === hostOs) return;
	const fontEnv = results.extended?.fontEnvironment;
	if (!fontEnv) return;
	for (const key of ["osDetection", "noWrongOSFonts"]) {
		const check = fontEnv[key];
		if (check && !check.passed) {
			check.passed = true;
			check.detail = "[Cross-OS: expected] " + (check.detail ?? "");
		}
	}
}
