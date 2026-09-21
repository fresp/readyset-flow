/**
 * Reads omp's own global config (`~/.omp/agent/config.yml`) — not a separate Readyset file.
 * Readyset doesn't invent its own config file; it reads a few things out of omp's existing one:
 *
 *   modelRoles:              <- omp's own general default model, confirmed against omp's docs
 *     default: spark/minimax-m3
 *
 *   readyset:                  <- Readyset's own namespaced section, not part of omp's own
 *     language: Indonesian       schema -- omp itself doesn't read or validate this section.
 *     model:                     It's inert to omp, meaningful only to Readyset, and lets you
 *       default: anthropic/claude-opus-5   pin a model (or a grilling discussion language) for
 *       fallbackChains:                     `/readyset` specifically without changing what
 *         - anthropic/claude-sonnet-5       everything else in omp defaults to.
 *         - spark/minimax-m3
 *
 * `readyset.model` deliberately mirrors the shape of omp's own `retry.fallbackChains` (a
 * `default` plus an ordered list of fallbacks to try in turn) rather than inventing Readyset's
 * own shape for the same idea -- one config-reading convention across the file, not two. A
 * bare `readyset.model: <spec>` (no nested `default`/`fallbackChains`) and a bare
 * `readyset.fallbackModel: <spec>` (single fallback, not a chain) both still work -- see
 * `parseModelOverride`/`readFallbackChain` -- for anyone who set Readyset up before this shape
 * existed; there was never a published version of this package with the old shape, but no
 * reason to make an already-working config.yml stop parsing over a schema polish.
 *
 * Precedence when Readyset resolves a default (see `readPinnedModel`): `--model` flag (in
 * readyset-review.ts, not here) > `readyset.model` (`.default` if nested, else the bare value)
 * > `modelRoles.default` > no pin. Same idea for the fallback chain (see `readFallbackChain`):
 * `--fallback-model` flag (a single spec, not a chain) > `readyset.model.fallbackChains` (tried
 * in order until one pins) > legacy `readyset.fallbackModel` (a one-element chain) > no
 * fallback. And for the preferred language (`--lang` > `readyset.language` >
 * grillTurnPrompt's reactive default — there is no omp-wide language setting to fall back to
 * next, unlike `modelRoles.default`).
 *
 * The fallback chain is a narrower guard than it might look like: it only covers the pin
 * itself failing to apply (an unrecognized/misconfigured model spec — a typo in this file, or
 * a model that's been retired) — `withPinnedModel` (readyset-review.ts) tries each entry in
 * order, stopping at the first that pins, and only warns and runs unpinned once every entry in
 * the chain has failed. It does NOT retry a turn that started and then hit a runtime provider
 * outage mid-generation; that's a different problem omp already has its own answer for — its
 * own `retry.fallbackChains` (README: "When the primary throws 429s or hits a quota wall, the
 * next entry takes the rest of the turn — restored on cooldown"), which applies automatically
 * to whatever model is active regardless of who pinned it. Configure that directly in
 * `~/.omp/agent/config.yml`, outside the `readyset` section, for outage protection during a
 * turn; Readyset's own fallback chain here is only for "every configured model itself is bad,"
 * not "the model is temporarily down."
 *
 * `parseYamlSubset` below handles the subset actually needed here: nested mappings and simple
 * `- item` lists, indentation-driven, no flow style (`{a: b}`, `[a, b]`), no anchors/multi-doc.
 * It is not a general YAML parser (same trade-off as elsewhere in this package: no runtime
 * dependency on an external package for a handful of fields it reads). `modelRoles` is omp's
 * own file format, read here, not defined here — if omp's schema changes shape, this needs
 * updating to match. `readyset` is Readyset's own, free to grow more fields under it later
 * without touching omp's format at all.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// readyset-review.ts's handler calls readPreferredLanguage()/readPinnedModel()/readFallbackChain()
// with NO argument by design -- see readyset-review.ts's own comment on that invariant (the
// wizard's writes and /readyset's reads must always agree on this exact path, never a
// --target-derived one). That means the test suite has no way to isolate those call sites from
// a real ~/.omp/agent/config.yml through the public API alone. READYSET_TEST_CONFIG_PATH is that
// seam: unset in every real invocation (install.mjs/configure.mjs never set it, and nothing in
// this package's own runtime code sets an env var to influence its own config resolution), so
// production behavior is exactly `join(homedir(), ".omp", "agent", "config.yml")` as before --
// only test/readyset-review.test.mts sets it, to a scratch path that's guaranteed not to exist.
// (Found this gap because a real `npm publish` on a machine that actually has a populated
// ~/.omp/agent/config.yml -- e.g. one already using `readyset-flow configure` -- surfaced two
// "reactive default" tests silently reading that real file instead of a clean one.)
const OMP_CONFIG_PATH = process.env.READYSET_TEST_CONFIG_PATH || join(homedir(), ".omp", "agent", "config.yml");

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };

function stripQuotes(v: string): string {
	if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
		return v.slice(1, -1);
	}
	return v;
}

/**
 * Parses the YAML subset this file needs: nested `key:` mappings (indentation-driven) and
 * `- item` lists under a key with no inline value. Comments (`#...`, unless a quote appears
 * earlier on the line) and blank lines are dropped first. Exposed for tests; production code
 * should go through `readPinnedModel`/`readFallbackChain`/`readPreferredLanguage`.
 */
export function parseYamlSubset(raw: string): Record<string, YamlValue> {
	const entries: { indent: number; content: string }[] = [];
	for (const rawLine of raw.split(/\r?\n/)) {
		let line = rawLine;
		let quote: '"' | "'" | undefined;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (quote) {
				if (ch === quote) quote = undefined;
			} else if (ch === '"' || ch === "'") {
				quote = ch;
			} else if (ch === "#") {
				line = line.slice(0, i);
				break;
			}
		}
		line = line.replace(/\s+$/, "");
		if (line.trim() === "") continue;
		entries.push({ indent: line.length - line.trimStart().length, content: line.trim() });
	}

	let pos = 0;

	function parseList(indent: number): string[] {
		const list: string[] = [];
		while (pos < entries.length && entries[pos].indent === indent && entries[pos].content.startsWith("- ")) {
			list.push(stripQuotes(entries[pos].content.slice(2).trim()));
			pos++;
		}
		return list;
	}

	function parseBlock(indent: number): Record<string, YamlValue> {
		const obj: Record<string, YamlValue> = {};
		while (pos < entries.length) {
			const entry = entries[pos];
			if (entry.indent !== indent || entry.content.startsWith("- ")) break;
			const match = entry.content.match(/^([^:]+):\s*(.*)$/);
			if (!match) {
				pos++;
				continue;
			}
			const key = match[1].trim();
			const inlineValue = match[2].trim();
			pos++;
			if (inlineValue !== "") {
				obj[key] = stripQuotes(inlineValue);
				continue;
			}
			if (pos < entries.length && entries[pos].indent > indent) {
				const childIndent = entries[pos].indent;
				obj[key] = entries[pos].content.startsWith("- ") ? parseList(childIndent) : parseBlock(childIndent);
			}
		}
		return obj;
	}

	return parseBlock(0);
}

/** Reads a dotted path out of a parsed doc (`getPath(doc, "readyset.model.default")`), stopping
 *  and returning `undefined` as soon as the path runs off the edge of a mapping. */
function getPath(doc: Record<string, YamlValue>, path: string): YamlValue | undefined {
	let cur: YamlValue | undefined = doc;
	for (const key of path.split(".")) {
		if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
		cur = (cur as Record<string, YamlValue>)[key];
	}
	return cur;
}

/** Extracts `<topKey>.<subKey>` from a one-level-nested `key:\n  subKey: value` block. Kept
 *  for the two omp-native reads that are genuinely that flat (`modelRoles.default`); prefer
 *  `parseYamlSubset` + `getPath` for anything with more shape. Exposed for tests. */
export function parseNestedKey(raw: string, topKey: string, subKey: string): string | undefined {
	const value = getPath(parseYamlSubset(raw), `${topKey}.${subKey}`);
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** omp's own general default model: `modelRoles.default`. */
export function parseOmpDefaultModel(raw: string): string | undefined {
	return parseNestedKey(raw, "modelRoles", "default");
}

/** Readyset's own model override: `readyset.model.default` (current shape) or a bare
 *  `readyset.model: <spec>` (legacy shape, still supported). */
export function parseModelOverride(raw: string): string | undefined {
	const doc = parseYamlSubset(raw);
	const model = getPath(doc, "readyset.model");
	if (typeof model === "string" && model !== "") return model; // legacy: readyset.model: <spec>
	const nested = getPath(doc, "readyset.model.default");
	return typeof nested === "string" && nested !== "" ? nested : undefined;
}

/** Readyset's per-phase model overrides: `readyset.model.phases.<phase>` where phase is one
 *  of `grill|explore|propose|apply|review` (case-insensitive). Returns the entries found;
 *  empty when none are set. Unknown phase names are kept — the caller warns rather than
 *  silently changing behavior. */
export function parsePhaseModels(raw: string): { phase: string; model: string }[] {
	const doc = parseYamlSubset(raw);
	const phases = getPath(doc, "readyset.model.phases");
	if (typeof phases !== "object" || phases === null || Array.isArray(phases)) return [];
	const out: { phase: string; model: string }[] = [];
	for (const [phase, model] of Object.entries(phases as Record<string, YamlValue>)) {
		if (typeof model === "string" && model !== "") out.push({ phase: phase.toLowerCase(), model });
	}
	return out;
}

/** Default for `readyset.compact.minContextPercent`: skip a boundary's compaction when the
 *  context is below this share of the window, because the summarization turn costs more than it
 *  saves on a nearly-empty context. */
export const DEFAULT_COMPACT_MIN_CONTEXT_PERCENT = 25;

export interface ParsedCompactMinPercent {
	/** The resolved percentage (0-100), or the default when unset/unreadable. */
	percent: number;
	/** Human-readable warning when a value was present but rejected; undefined when clean. */
	warning: string | undefined;
	/** True when the key was present (even if rejected). */
	present: boolean;
}

/**
 * Parses `readyset.compact.minContextPercent` — a number in [0, 100]. Any other value (non-numeric,
 * out of range, empty) is rejected and the default is used, with a warning the caller surfaces.
 * Absent key is not a warning, just the default.
 */
export function parseCompactMinContextPercent(raw: string): ParsedCompactMinPercent {
	const doc = parseYamlSubset(raw);
	const value = getPath(doc, "readyset.compact.minContextPercent");
	if (value === undefined) return { percent: DEFAULT_COMPACT_MIN_CONTEXT_PERCENT, warning: undefined, present: false };
	const text = typeof value === "string" ? value.trim() : String(value);
	const num = Number(text);
	if (text === "" || Number.isNaN(num) || !Number.isFinite(num) || num < 0 || num > 100) {
		return {
			percent: DEFAULT_COMPACT_MIN_CONTEXT_PERCENT,
			warning: `readyset.compact.minContextPercent ("${text}") isn't a number between 0 and 100 — using the default (${DEFAULT_COMPACT_MIN_CONTEXT_PERCENT}).`,
			present: true,
		};
	}
	return { percent: num, warning: undefined, present: true };
}

export interface ResolvedCompactMinPercent { percent: number; warning: string | undefined }

/** Reads `readyset.compact.minContextPercent` (or `configPath`, for tests). Never throws — a
 *  missing/unreadable file means "use the default", same as every other reader here. */
export async function readCompactMinContextPercent(configPath: string = OMP_CONFIG_PATH): Promise<ResolvedCompactMinPercent> {
	const raw = await readFile(configPath, "utf8").catch(() => undefined);
	if (raw === undefined) return { percent: DEFAULT_COMPACT_MIN_CONTEXT_PERCENT, warning: undefined };
	const parsed = parseCompactMinContextPercent(raw);
	return { percent: parsed.percent, warning: parsed.warning };
}

/** Readyset's own fallback chain: `readyset.model.fallbackChains` (an ordered list, current
 *  shape) or a bare `readyset.fallbackModel: <spec>` (legacy shape — treated as a one-element
 *  chain). Returns every entry found; empty when neither is set. */
export function parseFallbackChain(raw: string): string[] {
	const doc = parseYamlSubset(raw);
	const chain = getPath(doc, "readyset.model.fallbackChains");
	if (Array.isArray(chain)) {
		const specs = chain.filter((v): v is string => typeof v === "string" && v !== "");
		if (specs.length > 0) return specs;
	}
	const legacy = getPath(doc, "readyset.fallbackModel");
	return typeof legacy === "string" && legacy !== "" ? [legacy] : [];
}

/** @deprecated kept only so existing callers/tests of the single-fallback shape keep working;
 *  new code should read `readFallbackChain` and use the whole chain. Returns the chain's first
 *  entry, if any. */
export function parseFallbackModel(raw: string): string | undefined {
	return parseFallbackChain(raw)[0];
}

/** Readyset's own grilling-discussion language default, namespaced under `readyset.language`
 *  in the same file (`readyset.lang` also works, as an alias -- a real config was seen using
 *  the short form, presumably by analogy with the `--lang` CLI flag; both are accepted rather
 *  than silently ignoring one of them). Same precedence pattern as `model` above, but there is
 *  no omp-wide equivalent to fall back to the way there is `modelRoles.default` -- omp has no
 *  notion of a preferred discussion language, so the only fallback when this is unset is the
 *  existing reactive default (grillTurnPrompt tells the model to match whatever language the
 *  user replies in, rather than picking one up front). See `readPreferredLanguage`. */
export function parseLanguageOverride(raw: string): string | undefined {
	return parseNestedKey(raw, "readyset", "language") ?? parseNestedKey(raw, "readyset", "lang");
}

export interface ResolvedModelDefault {
	model: string | undefined;
	/** Human-readable label for where `model` came from, for notification text. `undefined`
	 *  iff `model` is `undefined`. */
	source: string | undefined;
}

/** Reads `~/.omp/agent/config.yml` (or `configPath`, for tests) and resolves a default model:
 *  `readyset.model` if set, else `modelRoles.default`, else neither. Never throws — a
 *  missing/unreadable/malformed omp config just means "no default to fall back to". */
export async function readPinnedModel(configPath: string = OMP_CONFIG_PATH): Promise<ResolvedModelDefault> {
	const raw = await readFile(configPath, "utf8").catch(() => undefined);
	if (raw === undefined) return { model: undefined, source: undefined };

	const modelOverride = parseModelOverride(raw);
	if (modelOverride) return { model: modelOverride, source: "readyset.model in ~/.omp/agent/config.yml" };

	const defaultModel = parseOmpDefaultModel(raw);
	if (defaultModel) return { model: defaultModel, source: "modelRoles.default in ~/.omp/agent/config.yml" };

	return { model: undefined, source: undefined };
}

export interface ResolvedFallbackChain {
	/** Every fallback model to try, in order. Empty when none is configured. */
	chain: string[];
	/** Human-readable label for where `chain` came from. `undefined` iff `chain` is empty. */
	source: string | undefined;
}

/** Reads `~/.omp/agent/config.yml` (or `configPath`, for tests) for Readyset's fallback chain
 *  — every model to try, in order, if pinning the resolved default (from `readPinnedModel`)
 *  fails to apply; `withPinnedModel` (readyset-review.ts) stops at the first that pins. Prefers
 *  `readyset.model.fallbackChains` (current shape); falls back to the legacy single
 *  `readyset.fallbackModel` (treated as a one-element chain) when that's unset. Never throws —
 *  missing file or missing key both just mean "no fallback configured". */
export async function readFallbackChain(configPath: string = OMP_CONFIG_PATH): Promise<ResolvedFallbackChain> {
	const raw = await readFile(configPath, "utf8").catch(() => undefined);
	if (raw === undefined) return { chain: [], source: undefined };

	const doc = parseYamlSubset(raw);
	const nested = getPath(doc, "readyset.model.fallbackChains");
	if (Array.isArray(nested)) {
		const specs = nested.filter((v): v is string => typeof v === "string" && v !== "");
		if (specs.length > 0) return { chain: specs, source: "readyset.model.fallbackChains in ~/.omp/agent/config.yml" };
	}

	const legacy = getPath(doc, "readyset.fallbackModel");
	if (typeof legacy === "string" && legacy !== "") return { chain: [legacy], source: "readyset.fallbackModel in ~/.omp/agent/config.yml" };

	return { chain: [], source: undefined };
}

/** @deprecated kept only for existing callers of the single-fallback shape; new code should
 *  use `readFallbackChain` and try the whole chain. Returns the chain's first entry, if any. */
export async function readFallbackModel(configPath: string = OMP_CONFIG_PATH): Promise<ResolvedModelDefault> {
	const { chain, source } = await readFallbackChain(configPath);
	return { model: chain[0], source: chain.length > 0 ? source : undefined };
}

export interface ResolvedPhaseModels {
	/** Every per-phase override found, each tagged with where it came from. */
	entries: { phase: string; model: string; source: string }[];
}

/** Reads `readyset.model.phases.<phase>` (or `configPath`, for tests) for per-phase model
 *  overrides. Never throws — a missing file or missing key just means "no overrides". */
export async function readPhaseModels(configPath: string = OMP_CONFIG_PATH): Promise<ResolvedPhaseModels> {
	const raw = await readFile(configPath, "utf8").catch(() => undefined);
	if (raw === undefined) return { entries: [] };
	return {
		entries: parsePhaseModels(raw).map((e) => ({ ...e, source: "readyset.model.phases in ~/.omp/agent/config.yml" })),
	};
}

export interface ResolvedLanguageDefault {
	language: string | undefined;
	/** Human-readable label for where `language` came from, for notification text. `undefined`
	 *  iff `language` is `undefined`. */
	source: string | undefined;
}

/** Reads `~/.omp/agent/config.yml` (or `configPath`, for tests) for `readyset.language` — a
 *  default preferred language for grilling's discussion (questions and replies), so a dev who
 *  isn't fluent in English doesn't have to type `--lang` every time. `--lang` on the command
 *  line still wins when given (see readyset-review.ts). Never throws; missing file or missing
 *  key both just mean "no preferred language configured" (grillTurnPrompt then falls back to
 *  its reactive default: match whatever language the user's own replies are in). */
export async function readPreferredLanguage(configPath: string = OMP_CONFIG_PATH): Promise<ResolvedLanguageDefault> {
	const raw = await readFile(configPath, "utf8").catch(() => undefined);
	if (raw === undefined) return { language: undefined, source: undefined };

	const language = parseNestedKey(raw, "readyset", "language");
	if (language) return { language, source: "readyset.language in ~/.omp/agent/config.yml" };

	const lang = parseNestedKey(raw, "readyset", "lang");
	if (lang) return { language: lang, source: "readyset.lang in ~/.omp/agent/config.yml" };

	return { language: undefined, source: undefined };
}
