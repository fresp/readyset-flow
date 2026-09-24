import type { ReviewMode } from "./readyset-omp-config.ts";

/** `/readyset`'s argument parsing. Pure. */
export interface ReadysetArgs {
	all: boolean;
	fast: boolean;
	/** `--lane fast|full`: force the lane for this run, bypassing the brainstorm's recorded lane. */
	lane?: string;
	/** `--compact auto|always|never` — when to compact at a phase boundary. Defaults to "auto". */
	compact?: "auto" | "always" | "never";
	/** `--review auto|always|never`: force the code-review policy for this run. Wins over
	 *  `readyset.review.mode`. */
	review?: ReviewMode;
	/** `--review <change-id>`: anything else after `--review` is an on-demand review target —
	 *  run exactly one review turn for that existing change and then offer archive as usual. */
	reviewTarget?: string;
	lang?: string;
	model?: string;
	fallbackModel?: string;
	idea?: string;
	/**
	 * Per-phase model overrides: `[{ phase, model }]` where phase is one of
	 * `grill|explore|propose|apply|review` (case-insensitive) and model is a spec in the
	 * same format as `--model`. Resolution order per phase: `--phase-model` entry >
	 * `readyset.model.phases.<phase>` in config > the run's pinned `--model`/default.
	 * Grill+Explore ran on the strongest model by default and produced the worst
	 * input-per-value ratio in the benchmark (39% of fresh input for research/Q&A); a
	 * lighter model is usually fine there and cuts cost without touching quality.
	 */
	phaseModels?: { phase: string; model: string }[];
}

/**
 * Parses `/readyset`'s argument string into the flags it supports.
 *
 * omp passes a registered command's arguments as the RAW remainder of the line after the command
 * name — `handler: (args: string, ctx)`, confirmed in real omp source (`RegisteredCommand`, and
 * `#tryExecuteExtensionCommand`'s `text.slice(spaceIndex + 1)`) and against live behavior: an
 * earlier version of this file treated `args` as a pre-split array, which made `--idea` throw
 * "`.join` is not a function" on every invocation, and silently read `--lang`/`--model`/
 * `--fallback-model` as the single character `"-"` (string indexing instead of array indexing).
 * Only `--all`/`--fast` ever worked, by accident, because `String.includes` happens to match
 * substrings. So this tokenizes the raw string itself.
 *
 * Quoting is honored the way a shell would for a single shell-style token (`--model "a b"`), and
 * the idea consumes every remaining token joined back with single spaces, so it needs no quoting
 * and can't be followed by other flags (which is why `--lang` etc. must come before it).
 *
 * The idea is either `--idea <text>` or, more simply, the bare text itself: the first token that
 * is neither a `--flag` nor a flag's value starts the idea (`/readyset let users export CSV`).
 * That is why every value-taking flag consumes its value token here, even an invalid one — a
 * `--lane medium` must never turn "medium" into the start of an idea.
 */
export function parseReadysetArgs(raw: string): ReadysetArgs {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const ch of raw ?? "") {
		if (quote !== undefined) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			if (current !== "") {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current !== "") tokens.push(current);

	const parsed: ReadysetArgs = { all: false, fast: false };
	const phaseModels: { phase: string; model: string }[] = [];
	// The next token as this flag's value, or undefined when there is none or it is another flag.
	const valueAt = (i: number): string | undefined => {
		const v = tokens[i + 1];
		return v === undefined || v.startsWith("--") ? undefined : v;
	};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--all") parsed.all = true;
		else if (token === "--fast") parsed.fast = true;
		else if (token === "--lane") {
			// An unknown value is kept (and consumed) so the handler can warn about it by name;
			// the handler only honors fast|full.
			const value = valueAt(i)?.toLowerCase();
			if (value !== undefined) {
				parsed.lane = value;
				i++;
			}
		} else if (token === "--compact") {
			// Deliberately NOT defaulted here: leaving it undefined lets the handler tell "unset"
			// from an explicit bad value (same pattern as --lane), so the caller can warn. A bad
			// value is still consumed so it cannot start a bare idea.
			const value = valueAt(i)?.toLowerCase();
			if (value !== undefined) {
				if (value === "auto" || value === "always" || value === "never") parsed.compact = value;
				i++;
			}
		} else if (token === "--review") {
			// `--review auto|always|never` sets the policy for this run; any OTHER non-empty
			// value is an on-demand target (a change id). A bare `--review` (no value) leaves
			// both unset and the handler warns -- same "unset is distinguishable from bad"
			// pattern as --lane/--compact.
			const value = (tokens[i + 1] ?? "").trim();
			const mode = value.toLowerCase();
			if (mode === "auto" || mode === "always" || mode === "never") {
				parsed.review = mode;
				i++;
			} else if (value !== "" && !value.startsWith("-")) {
				parsed.reviewTarget = value;
				i++;
			}
		} else if (token === "--lang" || token === "--model" || token === "--fallback-model") {
			const value = valueAt(i);
			if (value !== undefined) {
				if (token === "--lang") parsed.lang = value;
				else if (token === "--model") parsed.model = value;
				else parsed.fallbackModel = value;
				i++;
			}
		} else if (token === "--phase-model") {
			// `--phase-model <phase>=<spec>` (e.g. `--phase-model explore=cliproxy/glm-5.2`);
			// repeatable, one phase per flag. Unknown phases are rejected at use time, not
			// here, so a typo degrades to a warning rather than silently changing behavior.
			const pair = valueAt(i) ?? "";
			const eq = pair.indexOf("=");
			if (pair !== "") i++;
			if (eq > 0) phaseModels.push({ phase: pair.slice(0, eq).toLowerCase(), model: pair.slice(eq + 1) });
		}
		else if (token === "--idea") {
			const rest = tokens.slice(i + 1).join(" ").trim();
			if (rest !== "") parsed.idea = rest;
			break;
		} else if (!token.startsWith("--")) {
			// Bare text: the idea itself, `/readyset <idea>` — everything from here to the end.
			parsed.idea = tokens.slice(i).join(" ").trim();
			break;
		}
		// Any other `--something` is an unknown flag and is ignored.
	}
	if (phaseModels.length > 0) parsed.phaseModels = phaseModels;
	return parsed;
}
