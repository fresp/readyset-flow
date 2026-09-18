/**
 * Reads omp's own global config (`~/.omp/agent/config.yml`) — not a separate Readyset file.
 * Readyset doesn't invent its own config file; it reads two things out of omp's existing one:
 *
 *   modelRoles:              <- omp's own general default model, confirmed against omp's docs
 *     default: spark/minimax-m3
 *
 *   readyset:                  <- Readyset's own namespaced section, same shape/style as
 *     model: anthropic/claude-opus-5   modelRoles, but not part of omp's own schema — omp
 *     fallbackModel: anthropic/claude-sonnet-5   itself doesn't read or validate this section.
 *                                        It's inert to omp, meaningful only to Readyset, and
 *                                        lets you pin a model for `/readyset-review` specifically
 *                                        without changing what everything else in omp defaults
 *                                        to.
 *
 * Precedence when Readyset resolves a default (see `readPinnedModel`): `--model` flag (in
 * readyset-review.ts, not here) > `readyset.model` > `modelRoles.default` > no pin. Same shape,
 * same precedence for the fallback (`--fallback-model` > `readyset.fallbackModel` — there is no
 * `modelRoles.fallback` to fall further back to; omp's own docs don't define one).
 *
 * `readyset.fallbackModel` is a narrower guard than it might look like: it only covers the pin
 * itself failing to apply (an unrecognized/misconfigured model spec — a typo in this file, or
 * a model that's been retired) — it fires when `pi.setModel()` throws while trying to switch
 * to the configured model, before any turn has even started. It does NOT retry a turn that
 * started and then hit a runtime provider outage mid-generation; that's a different problem
 * omp already has its own answer for — per-role/per-model chains under omp's own
 * `retry.fallbackChains` (README: "When the primary throws 429s or hits a quota wall, the
 * next entry takes the rest of the turn — restored on cooldown"), which applies automatically
 * to whatever model is active regardless of who pinned it. Configure that directly in
 * `~/.omp/agent/config.yml` for outage protection during a turn; `readyset.fallbackModel` here
 * is only for "the configured model itself is bad," not "the model is temporarily down."
 *
 * The parser here handles exactly one shape — a top-level key with an indented single-level
 * sub-key — and nothing more. It is not a general YAML parser (same trade-off as elsewhere in
 * this package: no runtime dependency on an external package for two fields), so it does not
 * handle multiple documents, anchors/references, flow style (`{default: x}`), or deeper
 * nesting. `modelRoles` is omp's file format, read here, not defined here — if omp's schema
 * changes shape, this needs updating to match. `readyset` is Readyset's own, so it's free to add
 * more fields under it later without touching omp's format at all.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const OMP_CONFIG_PATH = join(homedir(), ".omp", "agent", "config.yml");

/** Extracts `<topKey>.<subKey>` from a one-level-nested `key:\n  subKey: value` block.
 *  Exposed for tests; production code should go through `readPinnedModel()`. */
export function parseNestedKey(raw: string, topKey: string, subKey: string): string | undefined {
	const topPattern = new RegExp(`^${topKey}\\s*:\\s*$`);
	const subPattern = new RegExp(`^${subKey}\\s*:\\s*(.+)$`);
	let inSection = false;

	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, "").replace(/\s+$/, "");
		if (line.trim() === "") continue;

		const indent = line.length - line.trimStart().length;
		if (indent === 0) {
			inSection = topPattern.test(line.trim());
			continue;
		}
		if (!inSection) continue;

		const match = line.trim().match(subPattern);
		if (match) {
			let value = match[1].trim();
			if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
				value = value.slice(1, -1);
			}
			return value || undefined;
		}
	}
	return undefined;
}

/** omp's own general default model: `modelRoles.default`. */
export function parseOmpDefaultModel(raw: string): string | undefined {
	return parseNestedKey(raw, "modelRoles", "default");
}

/** Readyset's own override, namespaced under `readyset.model` in the same file. */
export function parseModelOverride(raw: string): string | undefined {
	return parseNestedKey(raw, "readyset", "model");
}

/** Readyset's own fallback, namespaced under `readyset.fallbackModel` in the same file. */
export function parseFallbackModel(raw: string): string | undefined {
	return parseNestedKey(raw, "readyset", "fallbackModel");
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

/** Reads `~/.omp/agent/config.yml` (or `configPath`, for tests) for `readyset.fallbackModel` —
 *  the model to try if pinning the resolved default (from `readPinnedModel`) fails to
 *  apply. Never throws; missing file or missing key both just mean "no fallback configured". */
export async function readFallbackModel(configPath: string = OMP_CONFIG_PATH): Promise<ResolvedModelDefault> {
	const raw = await readFile(configPath, "utf8").catch(() => undefined);
	if (raw === undefined) return { model: undefined, source: undefined };

	const fallbackModel = parseFallbackModel(raw);
	if (fallbackModel) return { model: fallbackModel, source: "readyset.fallbackModel in ~/.omp/agent/config.yml" };

	return { model: undefined, source: undefined };
}
