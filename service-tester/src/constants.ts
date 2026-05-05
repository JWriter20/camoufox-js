import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Paths ────────────────────────────────────────────────────────────────────

// Resolve to a value, computed at module load. This file lives in
// service-tester/src/ at runtime (compiled to service-tester/dist/),
// so the constants are independent of where the user invokes us from.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// At runtime, this file is compiled to service-tester/dist/constants.js,
// so __dirname is .../service-tester/dist and one level up is the package
// root. Vendored TS sources, the HTML template, and proxies.txt all live
// under that root — no sibling-repo dependency.
export const SERVICE_TESTER_DIR = path.resolve(__dirname, "..");

export const PROXIES_FILE = path.join(SERVICE_TESTER_DIR, "proxies.txt");

// ─── Check category labels ────────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<string, string> = {
	automation: "Automation Detection",
	jsEngine: "JS Engine",
	lieDetection: "Lie Detection",
	firefoxAPIs: "Firefox APIs",
	crossSignal: "Cross-Signal",
	cssFingerprint: "CSS Fingerprint",
	mathEngine: "Math Engine",
	permissionsAPI: "Permissions",
	speechVoices: "Speech Voices",
	performanceAPI: "Performance",
	intlConsistency: "Intl Consistency",
	emojiFingerprint: "Emoji",
	canvasNoiseDetection: "Canvas Noise",
	webglRenderHash: "WebGL Render",
	fontPlatformConsistency: "Font Platform",
	audioIntegrity: "Audio Integrity",
	iframeTesting: "Iframe Testing",
	workerConsistency: "Workers",
	headlessDetection: "Headless Detection",
	trashDetection: "Trash Detection",
	fontEnvironment: "Font Environment",
};

// ─── ANSI colors ──────────────────────────────────────────────────────────────

export const GREEN = "\x1b[92m";
export const RED = "\x1b[91m";
export const YELLOW = "\x1b[93m";
export const CYAN = "\x1b[96m";
export const BOLD = "\x1b[1m";
export const RESET = "\x1b[0m";

const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI_ESCAPE_RE, "");
}

export function gradeColor(g: string): string {
	if (g === "A") return GREEN;
	if (g === "B" || g === "C") return YELLOW;
	return RED;
}

// ─── Certificate box drawing ──────────────────────────────────────────────────

export const BOX_W = 60;

export function boxLine(inner: string): string {
	const visible = stripAnsi(inner).length;
	return `║${inner}${" ".repeat(Math.max(0, BOX_W - visible))}║`;
}

export function boxSep(): string {
	return `╠${"═".repeat(BOX_W)}╣`;
}

export function boxTop(): string {
	return `╔${"═".repeat(BOX_W)}╗`;
}

export function boxBot(): string {
	return `╚${"═".repeat(BOX_W)}╝`;
}

// ─── ASCII art ────────────────────────────────────────────────────────────────

export const CAT_ART = `    /\\_____/\\
   /  o   o  \\
  ( ==  ^  == )
   )         (
  (  )     (  )
 ( (  )   (  ) )
(__(__)___(__)__)`;
