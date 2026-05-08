import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir =
	import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

export interface Voice {
	lang: string;
	name: string;
	voiceUri: string;
	isDefault: boolean;
	isLocalService: boolean;
}

interface RawVoiceCatalog {
	mac: string[];
	win: string[];
	lin: string[];
}

let cache: RawVoiceCatalog | null = null;

function loadCatalog(): RawVoiceCatalog {
	if (cache) return cache;
	const data = JSON.parse(
		fs.readFileSync(path.join(currentDir, "data-files", "voices.json"), "utf8"),
	);
	cache = { mac: data.mac ?? [], win: data.win ?? [], lin: data.lin ?? [] };
	return cache;
}

const ESSENTIAL_MAC = new Set([
	"Samantha",
	"Alex",
	"Fred",
	"Victoria",
	"Karen",
	"Daniel",
]);

// Real Firefox URI prefixes per backend.
// macOS NSSpeechSynthesizer -> "urn:moz-tts:osx:<identifier>"
// Windows SAPI -> "urn:moz-tts:sapi:<token>"
// Linux speech-dispatcher -> "urn:moz-tts:speechd:<index>"
const URI_PREFIX = {
	mac: "urn:moz-tts:osx:",
	win: "urn:moz-tts:sapi:",
	lin: "urn:moz-tts:speechd:",
} as const;

function uriSlug(name: string): string {
	// Real Apple identifiers look like "com.apple.voice.compact.en-US.Samantha".
	// We can't synthesize those exactly without Apple's catalog, but a stable
	// dotted slug derived from the voice name is shape-plausible and stable
	// across launches (same fingerprint hash), which is what matters for
	// detectors. They check format/prefix/structure, not Apple-catalog membership.
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ".")
		.replace(/^\.|\.$/g, "");
}

function parseVoiceEntry(
	entry: string,
	osKey: "mac" | "win" | "lin",
): Voice | null {
	// Format: "Name:lang:type" where type is "local" or "remote".
	// Voice names can contain parens but not colons (verified across the dataset),
	// so a simple last-two-colons split is safe.
	const lastColon = entry.lastIndexOf(":");
	if (lastColon < 0) return null;
	const type = entry.slice(lastColon + 1);
	const beforeType = entry.slice(0, lastColon);
	const langColon = beforeType.lastIndexOf(":");
	if (langColon < 0) return null;
	const lang = beforeType.slice(langColon + 1);
	const name = beforeType.slice(0, langColon);
	if (!name || !lang) return null;

	return {
		name,
		lang,
		voiceUri: `${URI_PREFIX[osKey]}${uriSlug(name)}`,
		isDefault: false,
		isLocalService: type === "local",
	};
}

function osToKey(os: string): "mac" | "win" | "lin" {
	if (os === "mac" || os === "macos") return "mac";
	if (os === "win" || os === "windows") return "win";
	return "lin";
}

/**
 * Generate a per-OS voice list shaped for the camoufox `voices` MaskConfig key.
 *
 *   macOS:   essential voices + random 40-80% of the rest
 *   Windows: full set (only ~50 voices, subsetting reads as suspicious)
 *   Linux:   empty — callers should NOT override on Linux. A typical Ubuntu
 *            desktop has speech-dispatcher + espeak-ng running with a
 *            13k-voice catalog (102 speaker variants × 130 langs), and
 *            host-and-spoof both being Linux means letting the native
 *            registration run is more authentic than any synthesized list.
 *            Returned [] is a sentinel meaning "no override" — the call
 *            site should leave `voices:blockIfNotDefined` unset.
 *
 * Returned shape matches MaskConfig::MVoices() — array of objects with
 * {lang, name, voiceUri, isDefault, isLocalService}. Anything else
 * is silently dropped by the C++ parser.
 */
export function generateVoiceSubset(os: string, locale?: string): Voice[] {
	const osKey = osToKey(os);
	const catalog = loadCatalog();
	const raw = catalog[osKey];
	if (!raw || raw.length === 0) return [];

	const parsed = raw
		.map((e) => parseVoiceEntry(e, osKey))
		.filter((v): v is Voice => v !== null);

	let selected: Voice[];
	if (osKey === "win") {
		selected = parsed;
	} else if (osKey === "mac") {
		const essential = parsed.filter((v) => ESSENTIAL_MAC.has(v.name));
		const nonEssential = parsed.filter((v) => !ESSENTIAL_MAC.has(v.name));
		const pct = 40 + Math.floor(Math.random() * 41); // 40-80%
		const count = Math.round((pct / 100) * nonEssential.length);
		const shuffled = nonEssential
			.map((v) => ({ v, k: Math.random() }))
			.sort((a, b) => a.k - b.k)
			.slice(0, Math.min(count, nonEssential.length))
			.map((x) => x.v);
		selected = [...essential, ...shuffled];
	} else {
		// lin: empty
		return [];
	}

	// Mark default voice. CreepJS's speech detector compares the default
	// voice's lang prefix to Intl.DateTimeFormat().resolvedOptions().locale
	// and flags `voiceLangMismatch` if they diverge — which downgrades
	// timezone entropy in their analysis. Match the spoofed locale prefix
	// so a de-DE locale picks Anna, not Alex.
	const localePrefix = locale ? locale.split("-")[0].toLowerCase() : "en";
	let idx = selected.findIndex(
		(v) => v.lang.toLowerCase() === locale?.toLowerCase(),
	);
	if (idx < 0) {
		idx = selected.findIndex(
			(v) => v.lang.split("-")[0].toLowerCase() === localePrefix,
		);
	}
	if (idx < 0) idx = 0;
	if (selected.length > 0)
		selected[idx] = { ...selected[idx], isDefault: true };

	return selected;
}
