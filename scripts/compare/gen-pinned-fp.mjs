// gen-pinned-fp.mjs
// ---------------------------------------------------------------------------
// Generate ONE pinned BrowserForge fingerprint for a given OS spoof and write
// it to a file. The upgrade harness reuses this single file for BOTH the OLD
// baseline capture and every NEW-build capture, so old-vs-new comparisons see
// an identical spoofed identity and only flag genuine Firefox-version changes.
//
// generateFingerprint isn't exported from index.js, so we import it from the
// built fingerprints.js directly (dist must exist — run `pnpm build` first).
//
// Usage:  OS=linux|macos|windows  OUT=/path/fp.json  [W=1920 H=1080]  node gen-pinned-fp.mjs
//
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateFingerprint } from "../../dist/fingerprints.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OS = process.env.OS || "linux";
const OUT = process.env.OUT || path.join(__dirname, `pinned-${OS}.json`);
const W = Number(process.env.W || 1920);
const H = Number(process.env.H || 1080);

const osMap = { linux: "linux", macos: "macos", windows: "windows" };
const opSys = osMap[OS];
if (!opSys) {
  console.error(`bad OS=${OS} (linux|macos|windows)`);
  process.exit(2);
}

const fp = generateFingerprint([W, H], { operatingSystems: [opSys] });
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(path.resolve(OUT), JSON.stringify(fp, null, 2));
console.log(
  `[gen-pinned-fp] os=${OS} screen=${fp.screen?.width}x${fp.screen?.height} ` +
    `hwConc=${fp.navigator?.hardwareConcurrency} gpu=${fp.videoCard?.renderer} -> ${path.resolve(OUT)}`,
);
