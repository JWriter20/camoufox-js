// classify-playwright.mjs
// ---------------------------------------------------------------------------
// Compare the NEW build's Playwright result set against the OLD baseline and
// bucket every test into still-passing / still-failing-tolerated / NEWLY-failing
// / newly-passing / removed. NEWLY-failing is the only blocking bucket — those
// are tests that passed on the old build (or are brand-new and fail now) and so
// represent a regression our patches introduced, not upstream flake.
//
// Inputs are Playwright JSON reporter output (`--reporter=json`). Because a FF
// bump usually bumps playwright-core too, old and new may be at different tags,
// so classification is by TEST TITLE (set membership), never by index.
//
// Usage:
//   node classify-playwright.mjs <old-results.json> <new-results.json> \
//        [--out <classification.md>] [--kf-out <proposed-known-failures.txt>] \
//        [--tag <vX.Y.Z>]
//
// Exit 0 iff the NEWLY-failing bucket is empty.
//
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && !["--out", "--kf-out", "--tag"].includes(argv[i - 1]),
);
const [oldPath, newPath] = positional;
if (!oldPath || !newPath) {
  console.error(
    "usage: node classify-playwright.mjs <old.json> <new.json> [--out md] [--kf-out txt] [--tag vX.Y.Z]",
  );
  process.exit(2);
}
const OUT = flag("--out", null);
const KF_OUT = flag("--kf-out", null);
const TAG = flag("--tag", "");

// ---------------------------------------------------------------------------
// flatten a Playwright JSON report into { fullTitle -> status }
// status normalized to: passed | failed | flaky | skipped | timedOut
// ---------------------------------------------------------------------------
function flatten(report) {
  const out = {};
  // Two shapes accepted:
  //  (a) Playwright JSON: { suites:[ {specs:[ {title, tests:[ {results:[{status}], status} ]} ], suites:[...] } ] }
  //  (b) a plain map { "title": "passed", ... } (our own simplified dumps)
  if (report && typeof report === "object" && !Array.isArray(report.suites) &&
      Object.values(report).every((v) => typeof v === "string")) {
    return { ...report };
  }
  const walk = (suite, prefix) => {
    const title = [prefix, suite.title].filter(Boolean).join(" › ");
    for (const spec of suite.specs || []) {
      const specTitle = [title, spec.title].filter(Boolean).join(" › ");
      // a spec has tests[]; each test has results[] and an overall status/outcome
      for (const t of spec.tests || []) {
        // prefer the computed outcome if present
        const status =
          t.status ||
          t.outcome ||
          (t.results && t.results.length
            ? t.results[t.results.length - 1].status
            : "unknown");
        // include projectName so firefox-library vs firefox-page don't collide
        const proj = t.projectName ? ` [${t.projectName}]` : "";
        out[specTitle + proj] = normalize(status, spec);
      }
      if (!(spec.tests && spec.tests.length)) {
        out[specTitle] = spec.ok === false ? "failed" : "passed";
      }
    }
    for (const child of suite.suites || []) walk(child, title);
  };
  for (const s of report.suites || []) walk(s, "");
  return out;
}

function normalize(status, spec) {
  const s = String(status).toLowerCase();
  if (s === "expected" || s === "passed") return "passed";
  if (s === "unexpected" || s === "failed") return "failed";
  if (s === "flaky") return "flaky";
  if (s === "skipped") return "skipped";
  if (s === "timedout" || s === "timed-out") return "timedOut";
  return s;
}

const isFail = (st) => st === "failed" || st === "timedOut";
const isPass = (st) => st === "passed" || st === "flaky"; // flaky = eventually passed

function load(p) {
  const txt = fs.readFileSync(path.resolve(p), "utf8");
  return flatten(JSON.parse(txt));
}

const oldR = load(oldPath);
const newR = load(newPath);

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------
const buckets = {
  stillPassing: [],
  stillFailingTolerated: [],
  newlyFailing: [],
  newlyPassing: [],
  removed: [],
};

const allTitles = new Set([...Object.keys(oldR), ...Object.keys(newR)]);
for (const t of allTitles) {
  const o = oldR[t];
  const n = newR[t];
  if (o != null && n == null) {
    buckets.removed.push(t);
  } else if (n != null && o == null) {
    // brand-new test: failing now = a regression to investigate; passing = fine
    if (isFail(n)) buckets.newlyFailing.push(t);
    else buckets.newlyPassing.push(t);
  } else {
    // present in both
    if (isFail(o) && isFail(n)) buckets.stillFailingTolerated.push(t);
    else if (isPass(o) && isFail(n)) buckets.newlyFailing.push(t);
    else if (isFail(o) && isPass(n)) buckets.newlyPassing.push(t);
    else buckets.stillPassing.push(t);
  }
}
for (const k of Object.keys(buckets)) buckets[k].sort();

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const blocking = buckets.newlyFailing.length;
const lines = [];
lines.push(`# Playwright classification${TAG ? ` (${TAG})` : ""}`);
lines.push("");
lines.push(`- old: \`${oldPath}\` (${Object.keys(oldR).length} tests)`);
lines.push(`- new: \`${newPath}\` (${Object.keys(newR).length} tests)`);
lines.push("");
lines.push(
  `**NEWLY-failing: ${blocking}** (must be 0) | still-passing: ${buckets.stillPassing.length} | ` +
    `still-failing-tolerated: ${buckets.stillFailingTolerated.length} | ` +
    `newly-passing: ${buckets.newlyPassing.length} | removed: ${buckets.removed.length}`,
);
lines.push("");
lines.push(blocking === 0
  ? "✅ **PASS** — no new Playwright regressions."
  : `🔴 **FAIL** — ${blocking} newly-failing test(s) to investigate.`);
lines.push("");

function section(title, items, fenced = false) {
  lines.push(`## ${title} (${items.length})`);
  lines.push("");
  if (!items.length) { lines.push("_none_", ""); return; }
  for (const t of items) lines.push(`- ${t}`);
  lines.push("");
}
section("🔴 NEWLY-failing (blockers — fix our patches)", buckets.newlyFailing);
section("🟡 still-failing-tolerated (candidates for known-failures)", buckets.stillFailingTolerated);
section("· newly-passing (informational)", buckets.newlyPassing);
section("· removed/renamed upstream (informational)", buckets.removed);

const md = lines.join("\n");
if (OUT) {
  fs.writeFileSync(path.resolve(OUT), md);
  console.log(`[classify-playwright] report -> ${path.resolve(OUT)}`);
}

// propose a known-failures file seeded from still-failing-tolerated
if (KF_OUT) {
  const kf = [
    "# Proposed known-failures — seeded from still-failing-tolerated.",
    "# The stage-7 agent reviews this: keep genuine upstream-flake/known-broken",
    "# titles, DELETE any that are real regressions in our patches.",
    ...buckets.stillFailingTolerated.map((t) => t.replace(/ \[[^\]]+\]$/, "")),
  ];
  fs.writeFileSync(path.resolve(KF_OUT), kf.join("\n") + "\n");
  console.log(`[classify-playwright] proposed known-failures -> ${path.resolve(KF_OUT)}`);
}

console.log(
  `PLAYWRIGHT_SUMMARY newly_failing=${blocking} still_passing=${buckets.stillPassing.length} ` +
    `still_failing=${buckets.stillFailingTolerated.length} newly_passing=${buckets.newlyPassing.length} ` +
    `removed=${buckets.removed.length} verdict=${blocking === 0 ? "PASS" : "FAIL"}`,
);
if (!OUT) console.log("\n" + md);
process.exit(blocking === 0 ? 0 : 1);
