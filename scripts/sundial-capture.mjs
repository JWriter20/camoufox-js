// Drive our latest Camoufox at https://sundial.daijro.dev/, log in, run the
// fingerprint test, then walk every sidebar section and dump its rendered HTML
// into a gitignored folder (one file per section: browserDetails.html,
// network.html, fonts.html, ...).
//
// REQUIRES Node >= 22 (camoufox-js engines field). On this box, from the
// camoufox-js/ submodule root:
//   ~/.nvm/versions/node/v22.22.2/bin/node scripts/sundial-capture.mjs
//
// Env (loaded from stealth-browsers/.env automatically, real env wins):
//   DATACENTER_PROXY_URL   http://user:pass@host:port   (required)
//   SUNDIAL_USER           login username               (required)
//   SUNDIAL_PWD            login password               (required)
//   XVFB_DISPLAY           existing Xvfb display string, e.g. ":99"
//                          -> passed to Camoufox as the `virtual_display`
//                          LaunchOption (becomes env.DISPLAY for the browser).
//                          If unset, falls back to headless:'virtual' so
//                          Camoufox spins up its own throwaway Xvfb.
//   CAMOUFOX_EXE           override the browser executable. Set this to test
//                          an UNPUBLISHED local build, e.g.
//                          .../stealth-browsers/camoufox-cache/camoufox
//                          If unset, the latest published release from
//                          JWriter20/camoufox is downloaded into a sandboxed
//                          (gitignored) cache and used. We NEVER touch the
//                          production ~/.cache/camoufox* paths.
//   OUT_DIR                output folder (default: ./sundial-capture-output)
//
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Camoufox } from "../dist/sync_api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // camoufox-js/scripts/
const SUBMODULE_ROOT = path.resolve(__dirname, ".."); // camoufox-js/
const REPO_ROOT = path.resolve(__dirname, "../.."); // stealth-browsers/

// ----------------------------------------------------------------------------
// .env loader (tiny, no dependency). Real process.env always wins.
// ----------------------------------------------------------------------------
function loadDotEnv() {
  const envPath = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

// ----------------------------------------------------------------------------
// Config / required env
// ----------------------------------------------------------------------------
const SITE = "https://sundial.daijro.dev/";
const OUT_DIR = process.env.OUT_DIR
  ? path.resolve(process.env.OUT_DIR)
  : path.join(SUBMODULE_ROOT, "sundial-capture-output");

const PROXY_URL = process.env.DATACENTER_PROXY_URL;
const USER = process.env.SUNDIAL_USER;
const PWD = process.env.SUNDIAL_PWD;

function die(msg) {
  console.error(`\n[sundial-capture] FATAL: ${msg}\n`);
  process.exit(1);
}
if (!PROXY_URL) die("DATACENTER_PROXY_URL is not set (.env or env).");
if (!USER) die("SUNDIAL_USER is not set (.env or env).");
if (!PWD) die("SUNDIAL_PWD is not set (.env or env).");

// ----------------------------------------------------------------------------
// Proxy: parse http://user:pass@host:port into a Playwright proxy object and
// verify egress works BEFORE launching the browser (fail fast).
// ----------------------------------------------------------------------------
function parseProxy(s) {
  const u = new URL(s);
  const server = `${u.protocol}//${u.hostname}:${u.port}`;
  return {
    server,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    port: u.port,
  };
}
const proxy = parseProxy(PROXY_URL);

function verifyProxy() {
  console.log(
    `[sundial-capture] verifying proxy ${proxy.server} (user ${proxy.username.slice(0, 3)}***) ...`,
  );
  try {
    const out = execFileSync(
      "curl",
      ["-s", "--max-time", "25", "--proxy", PROXY_URL, "https://ifconfig.me/ip"],
      { encoding: "utf8" },
    ).trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(out)) {
      die(`proxy check returned unexpected body: ${JSON.stringify(out)}`);
    }
    console.log(`[sundial-capture] proxy OK, egress IP = ${out}`);
  } catch (e) {
    die(`proxy connectivity check failed: ${e.message}`);
  }
}

// ----------------------------------------------------------------------------
// Executable resolution.
//   - CAMOUFOX_EXE override  -> use it as-is (for testing unpublished builds).
//   - otherwise download the latest JWriter20/camoufox release into a
//     sandboxed, gitignored cache and use that. Production ~/.cache/camoufox*
//     paths are never touched.
// ----------------------------------------------------------------------------
const PUBLISHED_CACHE = path.join(REPO_ROOT, "camoufox-published-cache");
const RELEASES_API =
  "https://api.github.com/repos/JWriter20/camoufox/releases/latest";

function ghJson(url) {
  const args = ["-sSL", "--max-time", "60", "-H", "User-Agent: sundial-capture"];
  if (process.env.GITHUB_TOKEN)
    args.push("-H", `Authorization: Bearer ${process.env.GITHUB_TOKEN}`);
  args.push(url);
  return JSON.parse(execFileSync("curl", args, { encoding: "utf8" }));
}

function resolveExecutable() {
  if (process.env.CAMOUFOX_EXE) {
    const exe = path.resolve(process.env.CAMOUFOX_EXE);
    if (!fs.existsSync(exe))
      die(`CAMOUFOX_EXE points to a missing file: ${exe}`);
    console.log(`[sundial-capture] using CAMOUFOX_EXE (local build): ${exe}`);
    return exe;
  }

  console.log(
    "[sundial-capture] no CAMOUFOX_EXE; resolving latest published release ...",
  );
  const rel = ghJson(RELEASES_API);
  const tag = rel.tag_name;
  const asset = (rel.assets || []).find((a) => /-lin\.x86_64\.zip$/.test(a.name));
  if (!asset) die(`no linux asset in release ${tag}`);

  const destDir = path.join(PUBLISHED_CACHE, tag);
  const exe = path.join(destDir, "camoufox");
  if (fs.existsSync(exe)) {
    console.log(`[sundial-capture] published release ${tag} already cached: ${exe}`);
    return exe;
  }

  fs.mkdirSync(destDir, { recursive: true });
  const zipPath = path.join(PUBLISHED_CACHE, asset.name);
  console.log(
    `[sundial-capture] downloading ${asset.name} (${(asset.size / 1e6).toFixed(0)}MB) ...`,
  );
  execFileSync(
    "curl",
    ["-sSL", "--max-time", "600", "-o", zipPath, asset.browser_download_url],
    { stdio: "inherit" },
  );
  console.log(`[sundial-capture] extracting into ${destDir} ...`);
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", destDir], {
    stdio: "inherit",
  });
  fs.rmSync(zipPath, { force: true });
  if (!fs.existsSync(exe))
    die(`extraction did not produce an executable at ${exe}`);
  try {
    fs.chmodSync(exe, 0o755);
  } catch {}
  console.log(`[sundial-capture] published release ${tag} ready: ${exe}`);
  return exe;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function slug(s) {
  return (s || "section")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function saveSection(page, label, fileBase) {
  const html = await page.content();
  const file = path.join(OUT_DIR, `${fileBase}.html`);
  fs.writeFileSync(file, html, "utf8");
  console.log(
    `[sundial-capture]   saved ${path.basename(file)} (${(html.length / 1024).toFixed(0)} KB) — "${label}"`,
  );
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
verifyProxy();
const EXE = resolveExecutable();
fs.mkdirSync(OUT_DIR, { recursive: true });
console.log(`[sundial-capture] output dir: ${OUT_DIR}`);

// Display: pass an existing Xvfb string in via `virtual_display`, else let
// Camoufox spawn its own with headless:'virtual'.
const xvfb = process.env.XVFB_DISPLAY;
const displayOpts = xvfb
  ? { virtual_display: xvfb } // -> env.DISPLAY = xvfb for the browser process
  : { headless: "virtual" }; // Camoufox spins up its own Xvfb
console.log(
  xvfb
    ? `[sundial-capture] using provided Xvfb display: ${xvfb}`
    : "[sundial-capture] no XVFB_DISPLAY; using headless:'virtual' (own Xvfb)",
);

// `os` spoof target. Defaults to linux (the build's native platform); the
// upgrade harness sets SPOOF_OS=macos|windows to capture each spoof so the
// sundial comparator can diff per-OS old-vs-new (the linux binary spoofs the
// other platforms' navigator/UA/fonts/screen via Camoufox's `os` option).
const SPOOF_OS = process.env.SPOOF_OS || "linux";

// ----------------------------------------------------------------------------
// Pinned fingerprint (upgrade-harness mode).
//
// By DEFAULT Camoufox randomizes a fresh fingerprint EVERY launch — screen
// dims, GPU/WebGL renderer, hardwareConcurrency, plus per-launch canvas/audio/
// font seeds. That's correct for production, but it means two captures of the
// SAME build diverge wildly, so an old-vs-new comparison can't tell version
// drift from intended randomization.
//
// For the upgrade harness, set PINNED_FP=/path/to/fingerprint.json to pin the
// fingerprint (a BrowserForge `Fingerprint` object, passed verbatim via the
// `fingerprint` LaunchOption) AND zero the three per-launch seeds. With both
// pinned, the OLD baseline and the NEW build produce byte-identical spoofed
// values, so compare-sundial.mjs only flags genuine Firefox-version changes.
// Generate the file ONCE (e.g. capture-baseline.sh dumps the fingerprint it
// used) and reuse it for both sides of every comparison, per SPOOF_OS.
//
// The seeds use setInto/mergeInto in the launcher (set-only-if-absent), so
// passing them in `config` overrides the per-launch randomization cleanly.
let pinnedOpts = {};
if (process.env.PINNED_FP) {
  const fpPath = path.resolve(process.env.PINNED_FP);
  if (!fs.existsSync(fpPath)) die(`PINNED_FP points to a missing file: ${fpPath}`);
  const fingerprint = JSON.parse(fs.readFileSync(fpPath, "utf8"));
  pinnedOpts = {
    fingerprint,
    config: { "audio:seed": 0, "fonts:spacing_seed": 0, "canvas:aaOffset": 0 },
  };
  console.log(`[sundial-capture] PINNED fingerprint from ${fpPath} (seeds zeroed)`);
}

const browser = await Camoufox({
  executable_path: EXE,
  os: SPOOF_OS, // keep platform self-consistent with the spoof target
  i_know_what_im_doing: true, // allow custom executable_path
  proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
  geoip: true, // align tz/locale to the proxy exit IP
  ...pinnedOpts,
  ...displayOpts,
});

let exitCode = 0;
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(90_000);

  console.log(`[sundial-capture] navigating to ${SITE} ...`);
  await page.goto(SITE, { waitUntil: "domcontentloaded" });

  // ---- Login (POST form: username/password/submit, action /__auth/login) ----
  // Server flow (verified): POST -> 303 /  + Set-Cookie sundial_session (JWT).
  // The authed page is a SvelteKit SPA that renders the sidebar client-side
  // into <div id="app">, so after the redirect we must wait for HYDRATION,
  // not just domcontentloaded.
  const userInput = page.locator('input[name="username"]');
  if (await userInput.count()) {
    console.log("[sundial-capture] login form present; signing in ...");
    await userInput.first().fill(USER);
    await page.locator('input[name="password"]').first().fill(PWD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }).catch(() => {}),
      page
        .locator('form[action="/__auth/login"] button[type="submit"]')
        .click(),
    ]);
  } else {
    console.log("[sundial-capture] no login form (already authed?) — continuing");
  }

  // ---- Authed landing page: <main class="landing"> with a "run test" CTA ----
  // Verified flow: login -> SPA hydrates a LANDING page (not the sidebar) that
  // holds <div class="actions"><button class="btn">run test</button></div>.
  // The sidebar + test sections only appear AFTER clicking run test.
  try {
    await page.waitForFunction(
      () =>
        !!document.querySelector("aside.sidebar") ||
        !!document.querySelector("main.landing"),
      { timeout: 60_000 },
    );
  } catch (e) {
    const dbg = path.join(OUT_DIR, "_debug-no-landing.html");
    fs.writeFileSync(dbg, await page.content(), "utf8");
    const title = await page.title().catch(() => "");
    throw new Error(
      `neither landing nor sidebar rendered (title="${title}"). ` +
        `Login may have failed or the SPA changed. Wrote ${dbg}`,
    );
  }

  const onLanding = await page.evaluate(
    () => !!document.querySelector("main.landing"),
  );
  if (onLanding) {
    console.log('[sundial-capture] landing page present; clicking "run test" ...');
    const runBtn = page
      .locator("main.landing button", { hasText: "run test" })
      .first();
    if (await runBtn.count()) {
      await runBtn.click();
    } else {
      // Fallback: the only/obvious CTA in the actions row.
      await page.locator("main.landing .actions button").first().click();
    }
  } else {
    console.log("[sundial-capture] already past landing (sidebar present).");
  }

  // After clicking run test, the SPA swaps the landing view for the report
  // layout — wait for the sidebar to render.
  try {
    await page.waitForFunction(
      () => !!document.querySelector("aside.sidebar"),
      { timeout: 90_000 },
    );
  } catch (e) {
    const dbg = path.join(OUT_DIR, "_debug-no-sidebar.html");
    fs.writeFileSync(dbg, await page.content(), "utf8");
    throw new Error(
      `sidebar never rendered after run test. Wrote ${dbg}`,
    );
  }
  console.log("[sundial-capture] sidebar present — test running.");

  // Let the first (default) section + async probes settle.
  await page.waitForTimeout(8_000);

  // ---- Enumerate sidebar sections and capture each one's HTML ----
  // Sidebar entries are <button> tabs/tiles each with a text <span> label.
  // We read the labels first (so the list is stable), then click each by
  // its accessible text and dump page.content().
  const labels = await page.evaluate(() => {
    const out = [];
    const aside = document.querySelector("aside.sidebar");
    if (!aside) return out;
    for (const btn of aside.querySelectorAll("button")) {
      // Skip utility buttons (Report JSON, Search, log out).
      const cls = btn.className || "";
      if (/tab-report|tab-search/.test(cls)) continue;
      if (btn.closest("form")) continue; // logout form button

      // Two shapes in the sidebar:
      //   tile: <span class="icon"/> <span class="label">Network</span>
      //         <span class="count"><span class="fail">1</span><span class="dim">/41</span></span>
      //   tab : <svg/> <span>Browser Info</span>   (no .label / .count)
      // Prefer an explicit .label; else the first leaf <span> that is NOT a
      // count/icon (so we never grab the "/41" badge).
      let text = "";
      const labelEl = btn.querySelector("span.label");
      if (labelEl && labelEl.textContent.trim()) {
        text = labelEl.textContent.trim();
      } else {
        const span = [...btn.querySelectorAll("span")].find(
          (s) =>
            s.children.length === 0 &&
            s.textContent.trim() &&
            !s.closest("span.count") &&
            !s.classList.contains("count") &&
            !s.classList.contains("icon") &&
            !s.classList.contains("fail") &&
            !s.classList.contains("dim") &&
            !s.classList.contains("tab-ic"),
        );
        text = (span ? span.textContent : btn.textContent).trim();
      }
      if (text) out.push(text);
    }
    return [...new Set(out)];
  });

  console.log(
    `[sundial-capture] found ${labels.length} sidebar sections: ${labels.join(", ")}`,
  );
  if (!labels.length)
    throw new Error("no sidebar sections found — page structure changed?");

  // Friendly filenames; default to a slug of the label.
  const fileNameFor = (label) => {
    const map = {
      "Browser Info": "browserDetails",
      Network: "network",
      Fonts: "fonts",
      Extensions: "extensions",
      "Keyboard Layout": "keyboardLayout",
      Identity: "identity",
      Security: "security",
      "JS Engine": "jsEngine",
      Graphics: "graphics",
      Display: "display",
      Locale: "locale",
      Audio: "audio",
    };
    return map[label] || slug(label);
  };

  for (const label of labels) {
    // Click the sidebar button whose visible text is exactly this label.
    const btn = page
      .locator("aside.sidebar button", { hasText: label })
      .first();
    try {
      await btn.click({ timeout: 15_000 });
    } catch (e) {
      console.log(
        `[sundial-capture]   (could not click "${label}": ${e.message}) — capturing current DOM`,
      );
    }
    // Let the section render / its async probes settle.
    await page.waitForTimeout(2_500);
    await saveSection(page, label, fileNameFor(label));
  }

  console.log(
    `\n[sundial-capture] DONE — ${labels.length} section file(s) in ${OUT_DIR}`,
  );
} catch (e) {
  exitCode = 1;
  console.error(`[sundial-capture] ERROR: ${e.stack || e.message}`);
} finally {
  await browser.close();
}
process.exit(exitCode);
