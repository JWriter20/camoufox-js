/*
 * camoufox-js test fixture (Node --require shim).
 *
 * Wired into the upstream microsoft/playwright run via NODE_OPTIONS=--require
 * by run-tests.sh. Mirrors `camoufox/tests-camoufox/camoufox_plugin.py` in
 * spirit but goes one step further: it routes every `firefox.launch(...)`
 * and `firefox.launchPersistentContext(...)` call through camoufox-js's own
 * `launchOptions(...)` pipeline, so the upstream suite exercises the same
 * fingerprint-driven launch path that real camoufox-js consumers use.
 *
 * Why we need this:
 *   The upstream test runner launches Camoufox via raw firefox.launch({
 *   executablePath: FFPATH }) — no fingerprint, no fonts, no spoofed
 *   navigator.userAgent. That bypasses the entire stealth pipeline, leaving
 *   the binary's compile-time defaults visible (e.g. UA = "Camoufox/<v>"
 *   instead of the fingerprint-driven "Firefox/<v>"). Specs that assert the
 *   stock-Firefox UA shape (page-basic.spec.ts: "should have sane user
 *   agent") then fail not because of a real bug, but because we never
 *   actually applied the spoofing layer. Routing through launchOptions()
 *   makes the test bed look like a real consumer.
 *
 * What we DO NOT do:
 *   - Override `navigator.webdriver`. That's stealth-by-design (always
 *     false under camoufox); upstream tests asserting webdriver=true are
 *     fundamentally incompatible and stay in the known-failures file.
 *   - Touch chromium/webkit launches. Only the firefox BrowserType is
 *     patched so cross-browser specs stay correct for non-firefox runs.
 */

"use strict";

const path = require("node:path");

// Resolve playwright-core from inside the upstream tree (CWD when this shim
// is required is the cloned upstream cache dir, where run-tests.sh does
// `pushd "$UPSTREAM_DIR"` before invoking node packages/playwright/cli.js).
// The upstream `packages/playwright-core` re-exports from its own `lib/`,
// which is what every spec eventually touches via `require('playwright')`
// → `packages/playwright/index.js` → playwright-core.
//
// We patch BrowserType.prototype directly. Once the prototype is patched,
// every `firefox.launch` reaches our wrapper regardless of whether a spec
// imports `playwright`, `@playwright/test`, or playwright-core.
let BrowserType;
try {
	// Resolve relative to the upstream tree we're running in.
	BrowserType = require(
		path.join(process.cwd(), "packages/playwright-core/lib/client/browserType.js"),
	).BrowserType;
} catch (err) {
	// If we can't load playwright-core (e.g. require() ran before pushd in
	// some unusual entry path), bail loudly rather than silently leaving
	// every launch un-spoofed.
	console.error("[camoufox-fixture] Failed to load BrowserType:", err.message);
	throw err;
}

// Resolve camoufox-js's compiled launchOptions from a fixed absolute path.
// We can't use a relative require because the require root is the upstream
// tree, which has no link to camoufox-js. Bake the absolute path in via env.
const CAMOUFOX_JS_DIST = process.env.CAMOUFOX_JS_DIST;
if (!CAMOUFOX_JS_DIST) {
	throw new Error(
		"[camoufox-fixture] CAMOUFOX_JS_DIST env var must point at camoufox-js's dist/",
	);
}
const { launchOptions } = require(path.join(CAMOUFOX_JS_DIST, "utils.js"));

const origLaunch = BrowserType.prototype.launch;
const origPersistent = BrowserType.prototype.launchPersistentContext;

async function buildSpoofedOptions(callerOptions) {
	// callerOptions is what the test passed to firefox.launch(...). We pass
	// the lot through to launchOptions() so per-test overrides (proxy, args,
	// extra env, etc.) survive. headless flows through too.
	const opts = await launchOptions({
		...callerOptions,
		// FFPATH points at the camoufox binary; the test runner already sets
		// this. Fall through to whatever the caller specified, otherwise use
		// FFPATH directly.
		executable_path: callerOptions?.executablePath || process.env.FFPATH,
		// launchOptions() interprets headless as a boolean, which matches
		// upstream's contract. "virtual" mode is camoufox-js-specific and
		// not relevant for the upstream suite.
		headless:
			typeof callerOptions?.headless === "boolean"
				? callerOptions.headless
				: true,
	});
	// Merge: caller's explicit options win for top-level keys (e.g. proxy,
	// timeout) so per-test customisation isn't trampled by the fingerprint
	// pipeline. But we DO want our `env` and `args` (which carry the
	// CAMOU_CONFIG fingerprint blob) to take precedence over the caller's.
	return {
		...callerOptions,
		...opts,
		env: { ...callerOptions?.env, ...opts.env },
		args: [...(opts.args || []), ...(callerOptions?.args || [])],
	};
}

BrowserType.prototype.launch = async function patchedLaunch(options) {
	if (this.name() !== "firefox") {
		return origLaunch.call(this, options);
	}
	const spoofed = await buildSpoofedOptions(options);
	return origLaunch.call(this, spoofed);
};

BrowserType.prototype.launchPersistentContext = async function patchedPersistent(
	userDataDir,
	options,
) {
	if (this.name() !== "firefox") {
		return origPersistent.call(this, userDataDir, options);
	}
	const spoofed = await buildSpoofedOptions(options);
	return origPersistent.call(this, userDataDir, spoofed);
};
