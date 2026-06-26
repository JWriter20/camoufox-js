// normalize-sundial.mjs
// ---------------------------------------------------------------------------
// Turn a raw Sundial capture directory (one *.html per section, produced by
// scripts/sundial-capture.mjs) into a single normalized.json holding ONLY the
// stable fingerprint signals, with every field classified stable / proxy-
// derived / dropped per scripts/compare/sundial-volatile.json.
//
// The point: a raw `diff` of two captures is useless — the HTML carries proxy
// exit IPs, per-session mDNS UUIDs, timestamps and Xvfb-scheduling noise. This
// strips all of that so compare-sundial.mjs can flag REAL fingerprint drift
// (a font appearing/disappearing, a canvas/WebGL/audio hash changing under the
// same `os` spoof) — exactly the leaks a Firefox-version bump introduces.
//
// Dependency-free on purpose (no HTML parser): Sundial renders each result as a
// flat set of <span class="check-name">…</span> … <span class="check-peek">…
// </span> pairs, a header strip of <span class="stat-label">/<span
// class="stat-value">, and the Fonts list as <span class="ft-font">…</span>.
// Regex extraction over those three shapes is robust and has no install step
// (camoufox-js/.gitignore ignores scripts/, so a node_modules dep here would
// not survive anyway).
//
// Usage:
//   node normalize-sundial.mjs <capture-dir> [--out <file>]
//     <capture-dir>  dir of *.html from sundial-capture.mjs
//     --out          output path (default: <capture-dir>/normalized.json)
//
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "sundial-volatile.json"), "utf8"),
);

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
const captureDir = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--out");
if (!captureDir) {
  console.error("usage: node normalize-sundial.mjs <capture-dir> [--out <file>]");
  process.exit(2);
}
const CAPTURE = path.resolve(captureDir);
const OUT = path.resolve(flag("--out", path.join(CAPTURE, "normalized.json")));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function unescapeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
function stripTags(s) {
  return unescapeHtml(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

const volPatterns = RULES.volatileValuePatterns.map((p) => new RegExp(p, "i"));
const dropLabels = RULES.dropLabelSubstrings.map((s) => s.toLowerCase());
const proxyLabels = RULES.proxyDerivedLabelSubstrings.map((s) => s.toLowerCase());

function classify(label, value) {
  const lab = label.toLowerCase();
  if (proxyLabels.some((s) => lab.includes(s))) return "proxy";
  if (dropLabels.some((s) => lab.includes(s))) return "drop";
  if (volPatterns.some((re) => re.test(value))) return "drop";
  return "stable";
}

// Canonicalize a stable value so cosmetic differences don't trip the diff.
function canonValue(v) {
  let s = v.trim();
  // lowercase bare hex hashes (>= 8 hex chars, nothing else)
  if (/^[0-9a-fA-F]{8,}$/.test(s)) s = s.toLowerCase();
  // round standalone floats to 4dp (e.g. VisualViewport "1280.000000")
  s = s.replace(/-?\d+\.\d{5,}/g, (m) => String(Number(m).toFixed(4)));
  return s;
}

// ---------------------------------------------------------------------------
// per-file extraction
// ---------------------------------------------------------------------------
// 1) check-name -> check-peek pairs (the bulk of every section)
const RE_CHECK =
  /class="check-name[^"]*"[^>]*>([\s\S]*?)<\/span>[\s\S]*?class="check-peek[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
// 2) header strip stat-label -> stat-value
const RE_STAT =
  /class="stat-label[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>\s*<[^>]*class="stat-value[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/g;
// 3) fonts list
const RE_FTFONT = /class="ft-font(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/span>/g;

function extractFile(html, section) {
  const stable = {};
  const proxy = {};
  const dropped = [];

  const add = (label, rawVal) => {
    const lvalue = stripTags(rawVal);
    const cls = classify(label, lvalue);
    if (cls === "drop") dropped.push(label);
    else if (cls === "proxy") proxy[label] = lvalue;
    else stable[label] = canonValue(lvalue);
  };

  // header strip (skip empty Browser etc.)
  for (const m of html.matchAll(RE_STAT)) {
    const label = stripTags(m[1]);
    const val = stripTags(m[2]);
    if (!label || !val) continue;
    add(`hdr:${label}`, m[2]);
  }

  // generic check rows
  for (const m of html.matchAll(RE_CHECK)) {
    const label = stripTags(m[1]);
    if (!label) continue;
    add(label, m[2]);
  }

  // fonts section: collect the font list as ONE sorted stable signal
  if (section === "fonts") {
    const fonts = [];
    let infoNote = null;
    for (const m of html.matchAll(RE_FTFONT)) {
      const isInfo = /ft-font-info/.test(m[0]);
      const name = stripTags(m[1]);
      if (!name) continue;
      if (isInfo) infoNote = name; // e.g. an "+N more" / summary chip
      else fonts.push(name);
    }
    if (fonts.length) {
      const uniq = [...new Set(fonts)].sort((a, b) => a.localeCompare(b));
      stable["fontList"] = uniq;
      stable["fontCount"] = String(uniq.length);
      if (infoNote) stable["fontInfo"] = infoNote;
    }
  }

  return { stable, proxy, dropped };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
if (!fs.existsSync(CAPTURE) || !fs.statSync(CAPTURE).isDirectory()) {
  console.error(`capture dir not found: ${CAPTURE}`);
  process.exit(2);
}
const files = fs
  .readdirSync(CAPTURE)
  .filter((f) => f.endsWith(".html") && !f.startsWith("_debug"));
if (!files.length) {
  console.error(`no section *.html in ${CAPTURE}`);
  process.exit(2);
}

const out = {
  _meta: { capture: CAPTURE, sections: [], generatedFrom: "normalize-sundial.mjs" },
  sections: {},
};
let totalStable = 0;
let totalProxy = 0;
let totalDropped = 0;

for (const f of files.sort()) {
  const section = f.replace(/\.html$/, "");
  const html = fs.readFileSync(path.join(CAPTURE, f), "utf8");
  const { stable, proxy, dropped } = extractFile(html, section);
  out.sections[section] = { stable, proxy, droppedLabels: dropped.sort() };
  out._meta.sections.push(section);
  totalStable += Object.keys(stable).length;
  totalProxy += Object.keys(proxy).length;
  totalDropped += dropped.length;
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(
  `[normalize-sundial] ${files.length} sections | ${totalStable} stable, ` +
    `${totalProxy} proxy-derived, ${totalDropped} dropped -> ${OUT}`,
);
