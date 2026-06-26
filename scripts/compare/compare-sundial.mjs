// compare-sundial.mjs
// ---------------------------------------------------------------------------
// Diff two normalized Sundial captures (old build vs new build, produced by
// normalize-sundial.mjs) and emit a divergence report. Used by the upgrade
// harness's stage 6: the OLD/baseline capture is compared against the NEW
// build's capture, both run with the SAME `os` spoof and (ideally) the same
// proxy pool, so any change in a SPOOFED_STABLE field is a real regression.
//
// Classification of every (section, field):
//   REAL DIVERGENCE  a stable field changed / appeared / disappeared  -> FAIL
//   NEW-PROBE        the new capture has a section/field the old one  -> FLAG
//                    lacked (e.g. a new WebKit-leak probe) — agent judgment
//   PROXY-NOISE      a proxy-derived field changed but stays well-formed -> ok
//   PROXY-BROKEN     a proxy-derived field went empty/malformed where    -> FAIL
//                    the baseline had a good value (geoip path broke)
//   (matching stable fields are silent)
//
// Exit code: 0 if zero REAL divergences AND zero PROXY-BROKEN; 1 otherwise.
// NEW-PROBE alone does NOT fail the build (it's a flag), but is reported.
//
// Usage:
//   node compare-sundial.mjs <old-normalized.json> <new-normalized.json> \
//        [--out <divergence.md>] [--strict-new-probe]
//     --strict-new-probe  treat NEW-PROBE findings as failures too
//
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && argv[i - 1] !== "--out",
);
const [oldPath, newPath] = positional;
if (!oldPath || !newPath) {
  console.error(
    "usage: node compare-sundial.mjs <old-normalized.json> <new-normalized.json> [--out <md>] [--strict-new-probe]",
  );
  process.exit(2);
}
const STRICT_NEW = argv.includes("--strict-new-probe");
const OUT = flag("--out", null);

const oldN = JSON.parse(fs.readFileSync(path.resolve(oldPath), "utf8"));
const newN = JSON.parse(fs.readFileSync(path.resolve(newPath), "utf8"));

// ---------------------------------------------------------------------------
// proxy-derived well-formedness (shape checks, not value equality)
// ---------------------------------------------------------------------------
function proxyWellFormed(label, value) {
  if (value == null || value === "") return false;
  const lab = label.toLowerCase();
  if (lab.includes("timezone") || lab.includes("time zone")) {
    // IANA zone, a "Region, Noffsetmin", an abbreviation, or a descriptive
    // tz-name — all acceptable; just must be non-empty and not a bare number.
    return /[A-Za-z]/.test(value);
  }
  if (lab.includes("locale") || lab.includes("language")) {
    return /[A-Za-z]{2}/.test(value);
  }
  return true; // other proxy-derived fields: presence is enough
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------
const findings = []; // {section, field, kind, old, new}
const sections = new Set([
  ...Object.keys(oldN.sections || {}),
  ...Object.keys(newN.sections || {}),
]);

function eqStable(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [a];
    const bb = Array.isArray(b) ? b : [b];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
    return true;
  }
  return a === b;
}

// For array (font-list) fields, compute the added/removed members for a
// readable report instead of dumping 3500 entries.
function arrayDelta(oldArr, newArr) {
  const o = new Set(Array.isArray(oldArr) ? oldArr : [oldArr]);
  const n = new Set(Array.isArray(newArr) ? newArr : [newArr]);
  const added = [...n].filter((x) => !o.has(x));
  const removed = [...o].filter((x) => !n.has(x));
  return { added, removed };
}

for (const sec of [...sections].sort()) {
  const o = oldN.sections?.[sec];
  const n = newN.sections?.[sec];
  if (!o && n) {
    findings.push({ section: sec, field: "(whole section)", kind: "NEW-PROBE", old: "—", new: "section present" });
    continue;
  }
  if (o && !n) {
    findings.push({ section: sec, field: "(whole section)", kind: "REAL", old: "section present", new: "MISSING" });
    continue;
  }

  // stable fields
  const oStable = o.stable || {};
  const nStable = n.stable || {};
  for (const f of new Set([...Object.keys(oStable), ...Object.keys(nStable)])) {
    const ov = oStable[f];
    const nv = nStable[f];
    if (!(f in oStable)) {
      findings.push({ section: sec, field: f, kind: "NEW-PROBE", old: "—", new: shorten(nv) });
    } else if (!(f in nStable)) {
      findings.push({ section: sec, field: f, kind: "REAL", old: shorten(ov), new: "MISSING" });
    } else if (!eqStable(ov, nv)) {
      if (Array.isArray(ov) || Array.isArray(nv)) {
        const { added, removed } = arrayDelta(ov, nv);
        findings.push({
          section: sec, field: f, kind: "REAL",
          old: `${(Array.isArray(ov) ? ov : [ov]).length} items`,
          new: `${(Array.isArray(nv) ? nv : [nv]).length} items` +
            (added.length ? ` | +[${added.slice(0, 12).join(", ")}${added.length > 12 ? ", …" : ""}]` : "") +
            (removed.length ? ` | -[${removed.slice(0, 12).join(", ")}${removed.length > 12 ? ", …" : ""}]` : ""),
        });
      } else {
        findings.push({ section: sec, field: f, kind: "REAL", old: shorten(ov), new: shorten(nv) });
      }
    }
  }

  // proxy-derived fields: only flag if a good baseline value went bad
  const oProxy = o.proxy || {};
  const nProxy = n.proxy || {};
  for (const f of new Set([...Object.keys(oProxy), ...Object.keys(nProxy)])) {
    const ov = oProxy[f];
    const nv = nProxy[f];
    if (f in oProxy && f in nProxy && ov !== nv) {
      const okOld = proxyWellFormed(f, ov);
      const okNew = proxyWellFormed(f, nv);
      if (okOld && !okNew) {
        findings.push({ section: sec, field: f, kind: "PROXY-BROKEN", old: shorten(ov), new: shorten(nv) });
      } else {
        findings.push({ section: sec, field: f, kind: "PROXY-NOISE", old: shorten(ov), new: shorten(nv) });
      }
    }
  }
}

function shorten(v) {
  const s = Array.isArray(v) ? `[${v.length} items]` : String(v);
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const real = findings.filter((f) => f.kind === "REAL");
const broken = findings.filter((f) => f.kind === "PROXY-BROKEN");
const newProbe = findings.filter((f) => f.kind === "NEW-PROBE");
const noise = findings.filter((f) => f.kind === "PROXY-NOISE");

const blockers = real.length + broken.length + (STRICT_NEW ? newProbe.length : 0);

const lines = [];
lines.push("# Sundial divergence report");
lines.push("");
lines.push(`- old: \`${oldPath}\``);
lines.push(`- new: \`${newPath}\``);
lines.push("");
lines.push(
  `**REAL divergences: ${real.length}** | PROXY-BROKEN: ${broken.length} | ` +
    `NEW-PROBE: ${newProbe.length}${STRICT_NEW ? " (strict→blocking)" : " (flag)"} | ` +
    `proxy-noise (ignored): ${noise.length}`,
);
lines.push("");
lines.push(blockers === 0 ? "✅ **PASS** — no real fingerprint divergence." : `🔴 **FAIL** — ${blockers} blocking divergence(s).`);
lines.push("");

function table(title, rows) {
  if (!rows.length) return;
  lines.push(`## ${title} (${rows.length})`);
  lines.push("");
  lines.push("| section | field | old | new |");
  lines.push("|---------|-------|-----|-----|");
  for (const r of rows) {
    const esc = (s) => String(s).replace(/\|/g, "\\|");
    lines.push(`| ${esc(r.section)} | ${esc(r.field)} | ${esc(r.old)} | ${esc(r.new)} |`);
  }
  lines.push("");
}

table("🔴 REAL divergences (must be 0 to pass)", real);
table("🔴 PROXY-BROKEN (geoip path regressed)", broken);
table("🟡 NEW-PROBE (new section/field — agent judgment)", newProbe);
table("· proxy-noise (informational, not blocking)", noise);

const md = lines.join("\n");
if (OUT) {
  fs.writeFileSync(path.resolve(OUT), md);
  console.log(`[compare-sundial] report -> ${path.resolve(OUT)}`);
}
// machine-readable summary line (last stdout line, for the orchestrator)
console.log(
  `SUNDIAL_SUMMARY real=${real.length} proxy_broken=${broken.length} ` +
    `new_probe=${newProbe.length} noise=${noise.length} blockers=${blockers} ` +
    `verdict=${blockers === 0 ? "PASS" : "FAIL"}`,
);
if (!OUT) console.log("\n" + md);

process.exit(blockers === 0 ? 0 : 1);
