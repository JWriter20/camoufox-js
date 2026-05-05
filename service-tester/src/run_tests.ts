#!/usr/bin/env node
/*
 * Camoufox Service Tester — TypeScript CLI (camoufox-js port).
 *
 * Mirrors camoufox/service-tester/run_tests.py: launches N firefox
 * fingerprints simultaneously, each behind its own proxy, and grades
 * the antibot-detection checks bundle running in the page.
 *
 * Architectural difference vs python:
 *   camoufox-py uses a single browser instance + per-context fingerprints
 *   via AsyncNewContext (the upstream `feat/cloverlabs-context-fingerprint`
 *   feature). camoufox-js's master doesn't ship that yet — fingerprints
 *   are applied at process launch via CAMOU_CONFIG. So this harness spins
 *   up N independent Browser instances in parallel, each with its own
 *   { os, proxy }. End result for the validator is equivalent: N
 *   distinct, simultaneous fingerprinted browsers running the checks.
 *   Grade thresholds, certificate format, and JSON shape are identical.
 */

import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

// camoufox-js's compiled package — service-tester runs from
// service-tester/dist/, so "../../dist" resolves to camoufox-js/dist.
// Requires `pnpm build` to have been run at the camoufox-js root first;
// run_tests.sh handles that automatically.
import { Camoufox } from "../../dist/index.js";
import { ensureBundle, startHttpServer } from "./bundle.js";
import {
	type Certificate,
	type FullResult,
	type ProfileResult,
	type ProfileSpec,
	computeCrossProfile,
	generateCertificate,
	printCertificate,
	printProfileResult,
} from "./certificate.js";
import {
	BOLD,
	PROXIES_FILE,
	RED,
	RESET,
	gradeColor,
} from "./constants.js";
import {
	adjustCrossOsFontChecks,
	computeGrade,
	countAllChecks,
} from "./grading.js";
import { loadProxies, type PlaywrightProxy, resolveProxyGeo } from "./proxies.js";

interface CliOptions {
	profileCount: number;
	headful: boolean;
	proxies: string;
	secret: string;
	saveCert: string | null;
	noCert: boolean;
	ffVersion?: number;
}

function parseCliArgs(argv: string[]): CliOptions {
	const { values } = parseArgs({
		args: argv,
		options: {
			"profile-count": { type: "string", default: "6" },
			headful: { type: "boolean", default: false },
			proxies: { type: "string", default: PROXIES_FILE },
			secret: { type: "string", default: "camoufox-service-test" },
			"save-cert": { type: "string" },
			"no-cert": { type: "boolean", default: false },
			"ff-version": { type: "string" },
			help: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});
	if (values.help) {
		console.log(`Usage: run_tests [options]

  --profile-count N       Number of profiles to test (1-6, default: 6)
  --headful               Run with visible browser window
  --proxies PATH          Path to proxies file (default: proxies.txt next to this script)
                          Format: user:pass@domain:port (one per line)
  --secret KEY            HMAC signing key for the certificate
  --save-cert PATH        Save certificate text to this file
  --no-cert               Skip certificate generation
  --ff-version N          Pin the Firefox/Camoufox major version
`);
		process.exit(0);
	}
	const profileCount = Number.parseInt(String(values["profile-count"]), 10);
	if (!Number.isFinite(profileCount) || profileCount < 1) {
		console.error("ERROR: --profile-count must be a positive integer");
		process.exit(1);
	}
	const ffVersion = values["ff-version"]
		? Number.parseInt(String(values["ff-version"]), 10)
		: undefined;
	return {
		profileCount,
		headful: !!values.headful,
		proxies: String(values.proxies),
		secret: String(values.secret),
		saveCert: values["save-cert"] ? String(values["save-cert"]) : null,
		noCert: !!values["no-cert"],
		ffVersion,
	};
}

async function runOneProfile(
	spec: ProfileSpec,
	proxy: PlaywrightProxy,
	testPageUrl: string,
	headless: boolean,
	ffVersion: number | undefined,
): Promise<ProfileResult> {
	const profile: ProfileSpec = { ...spec };
	try {
		// Launch a dedicated camoufox process for this profile. Each one
		// gets its own fingerprint (driven by `os`) + its own proxy. Note:
		// camoufox-js's launch-time UA path has been verified end-to-end —
		// the fingerprint UA is a stock "Firefox/<v>", not "Camoufox/...".
		const launchOpts: Record<string, any> = {
			os: spec.os,
			headless,
			proxy,
			geoip: true,
		};
		if (ffVersion) launchOpts.ff_version = ffVersion;

		const browser = await Camoufox(launchOpts);
		try {
			const page = await browser.newPage();
			await page.goto(testPageUrl, {
				waitUntil: "domcontentloaded",
				timeout: 30_000,
			});
			await page.waitForFunction(() => !!(window as any).__testComplete__, {
				timeout: 120_000,
			});
			const testError = await page.evaluate(() => (window as any).__testError__);
			if (testError) {
				return {
					profile,
					results: null,
					grade: "F",
					passCount: 0,
					totalChecks: 0,
					error: String(testError),
				};
			}
			const results = (await page.evaluate(
				() => (window as any).__testResults__,
			)) as Record<string, any>;
			adjustCrossOsFontChecks(spec.os, results);
			const [passCount, totalChecks] = countAllChecks(results);
			const grade = computeGrade(passCount, totalChecks);
			return { profile, results, grade, passCount, totalChecks };
		} finally {
			await browser.close().catch(() => {});
		}
	} catch (e) {
		return {
			profile,
			results: null,
			grade: "F",
			passCount: 0,
			totalChecks: 0,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

async function main(): Promise<number> {
	const opts = parseCliArgs(process.argv.slice(2));

	// 1. Build / locate the checks bundle.
	await ensureBundle();

	// 2. Load proxies.
	const proxies = loadProxies(opts.proxies);
	console.log(`Loaded ${proxies.length} proxy/proxies from ${path.basename(opts.proxies)}`);

	// 3. Build profile specs (mac × 3, linux × 3, capped to profile-count).
	const allSpecs: ProfileSpec[] = [];
	for (let i = 0; i < 3; i++) {
		allSpecs.push({
			os: "macos",
			name: `macOS Per-Context ${String.fromCharCode(65 + i)}`,
		});
	}
	for (let i = 0; i < 3; i++) {
		allSpecs.push({
			os: "linux",
			name: `Linux Per-Context ${String.fromCharCode(65 + i)}`,
		});
	}
	const entries = allSpecs.slice(0, Math.max(1, Math.min(opts.profileCount, allSpecs.length)));

	// Round-robin proxy assignment, identical to python.
	const profileProxies = entries.map((_, i) => proxies[i % proxies.length]);

	// 4. Resolve proxy geo concurrently for the certificate's PROXY DEBUG block.
	console.log("Resolving proxy locations...");
	const geos = await Promise.all(profileProxies.map((p) => resolveProxyGeo(p)));
	for (let i = 0; i < entries.length; i++) {
		entries[i].proxyGeo = geos[i];
	}

	// 5. Start the local HTTP server that serves /test and /checks-bundle.js.
	const { port, close: closeServer } = await startHttpServer();
	const testPageUrl = `http://127.0.0.1:${port}/test`;
	console.log(`HTTP server started on port ${port}`);

	const timestamp = new Date().toISOString();
	console.log(`\n${"─".repeat(60)}`);
	console.log(`Per-context phase: ${entries.length} profiles (all open simultaneously)`);
	console.log("─".repeat(60));
	console.log("Launching browsers...");

	// 6. Run all profiles concurrently. They share only the test-page URL.
	const profileResults = await Promise.all(
		entries.map((spec, i) =>
			runOneProfile(spec, profileProxies[i], testPageUrl, !opts.headful, opts.ffVersion),
		),
	);

	for (const pr of profileResults) {
		printProfileResult(pr);
	}

	await closeServer();

	// 7. Summary + certificate.
	const crossProfile = computeCrossProfile(profileResults);
	const totalPassed = profileResults.reduce((s, p) => s + p.passCount, 0);
	const totalChecksSum = profileResults.reduce((s, p) => s + p.totalChecks, 0);
	const overallGrade = computeGrade(totalPassed, totalChecksSum);

	const fullResult: FullResult = {
		profiles: profileResults,
		crossProfile,
		overallGrade,
		totalPassed,
		totalChecks: totalChecksSum,
		timestamp,
	};

	console.log(`\n${"─".repeat(60)}`);
	console.log(
		`Overall Grade: ${gradeColor(overallGrade)}${BOLD}${overallGrade}${RESET}  ` +
			`Score: ${totalPassed}/${totalChecksSum}  Profiles: ${profileResults.length}`,
	);
	console.log("─".repeat(60));

	if (!opts.noCert) {
		const cert: Certificate = generateCertificate(fullResult, opts.secret);
		printCertificate(cert, crossProfile, overallGrade);
		if (cert.failedTests.length > 0) {
			console.log(`${RED}Failed checks:${RESET}`);
			for (const ft of cert.failedTests) {
				console.log(`  ${RED}✗${RESET} ${ft}`);
			}
			console.log("");
		}
		if (opts.saveCert) {
			await fs.writeFile(
				opts.saveCert,
				`Grade: ${overallGrade}\nScore: ${totalPassed}/${totalChecksSum}\n` +
					`ID: ${cert.id}\nHash: ${cert.resultsHash}\nSig: ${cert.signature}\n`,
			);
			console.log(`Certificate saved to: ${opts.saveCert}`);
		}
	}

	return overallGrade === "A" || overallGrade === "B" ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(err);
		process.exit(1);
	},
);
