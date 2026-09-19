/**
 * `readyset-flow configure` — an interactive wizard for the `readyset:` section of
 * `~/.omp/agent/config.yml` (language, model default, fallback chain). A separate command from
 * `install`, deliberately: `install` stays non-interactive and safe to call from a script or CI
 * (its existing contract), so a wizard that blocks on stdin never runs unless explicitly asked
 * for.
 *
 * Writing this back safely is the actual hard part. `readyset-omp-config.ts`'s own
 * `parseYamlSubset` is read-only and lossy by design (no comments, no formatting, no key order
 * preserved) -- fine for *reading* a handful of fields at runtime, unusable for *writing*
 * without destroying whatever else a user's real config.yml has in it (modelRoles, retry,
 * comments, blank-line grouping). Rather than add this package's first-ever runtime dependency
 * (a real YAML library) just to round-trip a file mostly untouched, this does a plain-text
 * splice: find the existing top-level `readyset:` block by scanning raw lines (no YAML parsing
 * at all), replace exactly those lines, and leave every byte outside that block untouched. If
 * no `readyset:` block exists yet, the new one is appended at the end instead.
 *
 * This deliberately only ever touches a `readyset:` block written in the block-mapping shape
 * this package itself always writes (`readyset:` alone on its line, children indented under
 * it) -- the same shape `parseYamlSubset` reads at runtime. A `readyset: <inline flow value>`
 * written by hand (rare, and not a shape this package has ever produced) is left alone with a
 * warning rather than guessed at, since splicing it out could silently drop a value.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";

/** True when line `i` is a top-level (column-0, non-blank) key -- the boundary a `readyset:`
 *  block's own extent stops at, whether that's the next real key or a re-check of its own start. */
function isTopLevelKeyLine(line) {
	return /^\S/.test(line);
}

/**
 * Scans raw config.yml lines (already split, no trailing-newline bookkeeping here -- see
 * `spliceReadysetBlock`) for a top-level `readyset:` block. Returns `{ start, end }` (end
 * exclusive) when found in the block-mapping shape this package writes, `{ conflict: true }`
 * when a `readyset:` line exists but isn't that shape (inline value -- see module doc comment),
 * or `null` when there's no `readyset:` key at all. Exported for direct testing.
 */
export function findReadysetBlock(lines) {
	for (let i = 0; i < lines.length; i++) {
		if (!/^readyset:/.test(lines[i])) continue;
		const afterColon = lines[i].slice("readyset:".length).trim();
		if (afterColon !== "") return { conflict: true };
		let end = lines.length;
		for (let j = i + 1; j < lines.length; j++) {
			if (isTopLevelKeyLine(lines[j])) {
				end = j;
				break;
			}
		}
		return { start: i, end };
	}
	return null;
}

/** Wraps `value` in double quotes only if it needs it for this package's own subset parser to
 *  read it back correctly (a literal `#` would otherwise start a comment; a leading `- ` or
 *  `: ` could otherwise be misread as list/mapping syntax). Bare otherwise -- most model specs
 *  and language names never need this. */
function quoteIfNeeded(value) {
	if (value === "" || /[#"']/.test(value) || /^[-?:>|%@]/.test(value) || value.includes(": ")) {
		return `"${value.replace(/"/g, '\\"')}"`;
	}
	return value;
}

/**
 * Builds the `readyset:` block's lines from resolved wizard answers. Returns `[]` (meaning: no
 * block at all) when every field is unset -- `spliceReadysetBlock` then removes an existing
 * block entirely rather than leaving a valueless `readyset:` stub behind. Exported for direct
 * testing.
 */
export function buildReadysetBlockLines({ language, modelDefault, fallbackChain = [] }) {
	const hasModel = Boolean(modelDefault) || fallbackChain.length > 0;
	if (!language && !hasModel) return [];

	const lines = ["readyset:"];
	if (language) lines.push(`  language: ${quoteIfNeeded(language)}`);
	if (hasModel) {
		lines.push("  model:");
		if (modelDefault) lines.push(`    default: ${quoteIfNeeded(modelDefault)}`);
		if (fallbackChain.length > 0) {
			lines.push("    fallbackChains:");
			for (const spec of fallbackChain) lines.push(`      - ${quoteIfNeeded(spec)}`);
		}
	}
	return lines;
}

/**
 * Splices `blockLines` into `raw` in place of any existing top-level `readyset:` block, or
 * appends it (with one blank separator line) if none exists. `blockLines: []` removes an
 * existing block entirely and adds nothing if there wasn't one. Always returns text ending in
 * exactly one trailing newline. Throws if an existing `readyset:` key isn't in the block shape
 * this function knows how to replace (see `findReadysetBlock`) -- the caller is expected to
 * catch this and tell the user to resolve it by hand rather than guess.
 */
export function spliceReadysetBlock(raw, blockLines) {
	const content = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
	const lines = content === "" ? [] : content.split("\n");

	const found = findReadysetBlock(lines);
	if (found && found.conflict) {
		throw new Error(
			"Found a `readyset:` key in config.yml that isn't in the block-mapping shape this wizard " +
				"expects (readyset: on its own line, children indented under it) -- not touching it " +
				"automatically. Edit it by hand instead.",
		);
	}

	let result;
	if (found) {
		result = [...lines.slice(0, found.start), ...blockLines, ...lines.slice(found.end)];
	} else if (blockLines.length === 0) {
		result = lines; // nothing to remove, nothing to add
	} else {
		const needsSeparator = lines.length > 0 && lines[lines.length - 1].trim() !== "";
		result = needsSeparator ? [...lines, "", ...blockLines] : [...lines, ...blockLines];
	}

	return `${result.join("\n")}\n`;
}

/** Runs `configure-runner.mts` (the one place this package's real `parseYamlSubset` reads
 *  config.yml) as a subprocess with `--experimental-strip-types`, so the wizard's "current
 *  value" prefill can never drift from what `/readyset` itself would actually resolve at
 *  runtime -- same reasoning `install.mjs`'s `validate` command already established. Returns
 *  `{ language, modelDefault, fallbackChain }`, all fields empty/undefined if the subprocess
 *  can't run (old Node) or the file doesn't exist yet -- the wizard still works, just without
 *  prefill, so an older Node doesn't block configuration outright the way it does `validate`. */
async function readCurrentConfig(configPath, spawnSync, runnerPath) {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", runnerPath, configPath], { encoding: "utf8" });
	if (result.error || result.status !== 0) {
		return { language: undefined, modelDefault: undefined, fallbackChain: [], readable: false };
	}
	try {
		const parsed = JSON.parse(result.stdout.trim());
		return { ...parsed, readable: true };
	} catch {
		return { language: undefined, modelDefault: undefined, fallbackChain: [], readable: false };
	}
}

/** `blank` keeps `current` (or leaves the field unset if there's no current value); a literal
 *  `-` explicitly clears it even if `current` was set; anything else replaces it. This is the
 *  one piece of prompt-reply parsing shared by every field in the wizard. */
function resolveAnswer(answer, current) {
	const trimmed = answer.trim();
	if (trimmed === "") return current;
	if (trimmed === "-") return undefined;
	return trimmed;
}

/**
 * The interactive wizard itself: reads current config, asks three questions (an overall
 * yes/no first, so `n`/Ctrl-C leaves the file untouched and prints the manual-edit block
 * instead), splices the result into `configPath`, and reports what changed. `io` is injectable
 * so this can run against something other than the real terminal; only `install.mjs`'s CLI
 * dispatch calls this with the real one.
 */
export async function runConfigureWizard(configPath, { spawnSync, runnerPath, input = process.stdin, output = process.stdout }) {
	const rl = createInterface({ input, output });
	const ask = (q) => rl.question(q);

	try {
		const current = await readCurrentConfig(configPath, spawnSync, runnerPath);
		if (!current.readable) {
			output.write(
				"(couldn't read current config.yml values -- readyset-flow configure needs Node 22.6+ for this " +
					"step, same as `validate`; continuing without prefill)\n\n",
			);
		}

		output.write(`Configuring the readyset: section of ${configPath}\n`);
		if (current.language || current.modelDefault || current.fallbackChain?.length) {
			output.write("Current: ");
			const parts = [];
			if (current.language) parts.push(`language=${current.language}`);
			if (current.modelDefault) parts.push(`model.default=${current.modelDefault}`);
			if (current.fallbackChain?.length) parts.push(`fallbackChains=[${current.fallbackChain.join(", ")}]`);
			output.write(`${parts.join(", ")}\n`);
		}
		const proceed = await ask("Set this up now? [Y/n] ");
		if (/^n/i.test(proceed.trim())) {
			output.write(
				"\nSkipped -- nothing written. Add this to ~/.omp/agent/config.yml by hand whenever you're ready:\n\n" +
					"readyset:\n  language: Indonesian\n  model:\n    default: anthropic/claude-opus-5\n" +
					"    fallbackChains:\n      - anthropic/claude-sonnet-5\n      - spark/minimax-m3\n",
			);
			return;
		}

		output.write("\n(blank keeps the current value / leaves it unset; a single `-` clears it explicitly)\n");
		const languageAnswer = await ask(`Preferred grilling language${current.language ? ` [${current.language}]` : " (e.g. Indonesian)"}: `);
		const modelAnswer = await ask(`Default model${current.modelDefault ? ` [${current.modelDefault}]` : " (e.g. anthropic/claude-opus-5)"}: `);
		const fallbackAnswer = await ask(
			`Fallback models, comma-separated, tried in order${current.fallbackChain?.length ? ` [${current.fallbackChain.join(", ")}]` : ""}: `,
		);

		const language = resolveAnswer(languageAnswer, current.language);
		const modelDefault = resolveAnswer(modelAnswer, current.modelDefault);
		const fallbackChain =
			fallbackAnswer.trim() === ""
				? (current.fallbackChain ?? [])
				: fallbackAnswer.trim() === "-"
					? []
					: fallbackAnswer
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);

		const blockLines = buildReadysetBlockLines({ language, modelDefault, fallbackChain });
		const raw = await readFile(configPath, "utf8").catch(() => "");
		const spliced = spliceReadysetBlock(raw, blockLines);

		// Compare with trailing-newline normalization ignored, so answering "keep everything as-is"
		// (every prompt left blank) never rewrites the file just to add a newline it happened to be
		// missing -- a no-op run should leave config.yml byte-identical, not just semantically equal.
		if (spliced.trimEnd() === raw.trimEnd()) {
			output.write(`\nNo changes -- ${configPath} already matches what you entered.\n`);
			return;
		}

		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, spliced, "utf8");

		if (blockLines.length === 0) {
			output.write(`\nCleared the readyset: section from ${configPath} (nothing was set).\n`);
		} else {
			output.write(`\nWrote readyset: to ${configPath}:\n\n${blockLines.map((l) => `  ${l}`).join("\n")}\n`);
		}
	} finally {
		rl.close();
	}
}
