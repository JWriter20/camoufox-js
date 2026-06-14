import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// At runtime this file lives in service-tester/dist/. We resolve the
// (vendored) checks entrypoint and the HTML template relative to it so a
// fresh `pnpm build` in service-tester/ produces a self-contained directory
// that doesn't reach into the camoufox sibling repo.
const SERVICE_TESTER_ROOT = path.resolve(__dirname, "..");
const CHECKS_ENTRY = path.join(
	SERVICE_TESTER_ROOT,
	"src",
	"checks",
	"index.ts",
);
const HTML_TEMPLATE = path.join(
	SERVICE_TESTER_ROOT,
	"src",
	"test_page_template.html",
);
const BUNDLE_PATH = path.join(SERVICE_TESTER_ROOT, "dist", "checks-bundle.js");

export async function ensureBundle(): Promise<string> {
	try {
		await fs.access(BUNDLE_PATH);
		return BUNDLE_PATH;
	} catch {
		// fall through to build
	}
	console.log("Building checks bundle (first run)...");
	await esbuild({
		entryPoints: [CHECKS_ENTRY],
		bundle: true,
		platform: "browser",
		target: "es2017",
		format: "iife",
		globalName: "CamoufoxChecks",
		outfile: BUNDLE_PATH,
		// Same flags as build-tester/scripts/bundle.py — keep the produced
		// IIFE shape so the test page template's `CamoufoxChecks.runAllChecks()`
		// call matches without modification.
	});
	console.log(`Bundle built: ${BUNDLE_PATH}`);
	return BUNDLE_PATH;
}

// Tiny static HTTP server used by the test pages. Returns the bound port.
// The server only ever sees localhost requests from camoufox-spawned pages,
// and the response surface is two whitelisted paths — keep it minimal.
export async function startHttpServer(): Promise<{
	port: number;
	close: () => Promise<void>;
}> {
	const html = await fs.readFile(HTML_TEMPLATE);
	const bundle = await fs.readFile(BUNDLE_PATH);

	const server = http.createServer((req, res) => {
		const url = req.url ?? "/";
		if (url === "/test" || url === "/test/") {
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Length": String(html.length),
			});
			res.end(html);
		} else if (url === "/checks-bundle.js") {
			res.writeHead(200, {
				"Content-Type": "application/javascript",
				"Content-Length": String(bundle.length),
			});
			res.end(bundle);
		} else {
			res.writeHead(404);
			res.end();
		}
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Failed to bind HTTP server");
	}
	return {
		port: address.port,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}
