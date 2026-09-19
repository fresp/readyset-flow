import type { ExtensionAPI, ExtensionUISelectOption } from "@oh-my-pi/pi-coding-agent";
import {
	BRAINSTORM_DIR,
	type BrainstormMeta,
	isProposed,
	loadBrainstorms,
	markApproved,
	reconcileStatuses,
	validateBrainstormContent,
} from "../lib/readyset-brainstorm.ts";
import { readFile } from "node:fs/promises";
import {
	appendContext,
	archiveChange,
	changePaths,
	checkTaskVerification,
	ensureReadysetRoot,
	findSpecFiles,
	getProgress,
	hasExploration,
	listSubmodules,
	readReview,
	scaffoldChange,
	validateChange,
} from "../lib/readyset-spec.ts";
import { readFallbackChain, readPinnedModel, readPreferredLanguage } from "../lib/readyset-omp-config.ts";
import { ReviewSidebarOverlay, type OverlaySection } from "../lib/readyset-review-overlay.ts";

/** Minimal structural shape this file actually calls — deliberately not importing the real
 *  `Theme`/`KeybindingsManager` types from `@oh-my-pi/pi-tui` even as types, so this file has
 *  zero dependency (type or runtime) on that package resolving at all. `readyset-review-overlay.ts`
 *  takes the real types as type-only imports (erased at strip-time); this is the boundary where
 *  the wider extension hands them through without needing to know their full shape. */
interface OverlayTheme {
	fg: (name: string, text: string) => string;
	bold: (text: string) => string;
}
interface OverlayKeybindings {
	matches: (data: string, name: string) => boolean;
}

/**
 * /readyset — Readyset's core command: propose, review, and execute a brainstorm
 * against real repo state, standing entirely on its own.
 *
 * "Readyset" names what this fuses from three sources, each enforced structurally below (not
 * just described in doc comments):
 * - omp `/plan`'s grounding discipline — a dedicated Explore turn runs before Propose,
 *   writes EXPLORATION.md, and has `.gitmodules` submodules injected into its prompt
 *   explicitly (listSubmodules()) so none can be silently dropped the way one was in an
 *   earlier version of this command's own output.
 * - the proposal/design/spec/tasks split and review-then-apply discipline popularized by
 *   spec-driven-development tooling (Open Questions preserved, a gate before execution).
 * - mattpocock/skills prompting hygiene — Apply requires a machine-checkable `_Verified:`
 *   note under every completed task (checkTaskVerification()) before the gate lets you move
 *   on, and a separate Code-review turn (fresh context, adversarial framing, writes
 *   REVIEW.md) runs after implementation and before the archive offer, rather than trusting
 *   the same turn that wrote the code to also grade it. CONTEXT.md logs every phase
 *   transition deterministically (appendContext(), not left to the model to remember).
 * See the package README for the full mapping.
 *
 * Neither /plan nor any external CLI binary is used here — this extension does not shell
 * out to anything. It implements its own change-artifact format (readyset-spec.ts: scaffold,
 * structural validate, progress tracking, archive), in plain TypeScript, over its own
 * `readyset/` directory layout. This is Readyset's own format; it does not read from, write to,
 * or stay compatible with any other spec-driven-development tool's files.
 *
 * Trade-off, stated plainly: `validateChange` here is a shallow structural check
 * (required sections, at least one requirement+scenario, at least one task) — not a real
 * schema validator. It catches an empty or malformed artifact, not every compliance issue a
 * full schema-aware tool would. `archiveChange` merges delta specs into the main spec by
 * append-only, never a real ADDED/MODIFIED/REMOVED diff-merge — safe, but cruder than a
 * proper archiver. Both are said in the review panel, not hidden.
 *
 * Deterministic steps (scaffold, validate, progress, archive) run here in plain
 * TypeScript — no LLM turn, no token cost, no chance of being skipped. Only steps that
 * need judgment (writing proposal/design/spec/tasks; implementing code) go through a
 * triggered agent turn, which is told the exact file paths and section shapes to use so
 * it doesn't need any CLI either.
 *
 * Review "screen": omp's extension API has no full-screen custom view (confirmed against
 * upstream docs — dialogs are limited to select/confirm/input/editor, plus a 10-line
 * setWidget panel). This uses setWidget as a persistent summary panel and ctx.ui.select
 * for the decision — the closest a third-party extension can get, not a recreation of
 * /plan's native Plan Review surface.
 */

const ARTIFACT_GUIDE = `Write exactly these files under readyset/changes/<id>/ (create directories as needed):

- proposal.md — must have a "## Why" section (1-2 paragraphs on the problem) and a
  "## What Changes" section (bullet list of concrete changes).
- design.md — "## Context", "## Goals / Non-Goals", "## Decisions" (numbered, each with
  Rationale and Alternatives considered), "## Risks / Trade-offs".
- specs/<capability-slug>/spec.md — "## Purpose", then "## ADDED Requirements" with one
  or more "### Requirement: <name>" blocks, each followed by one or more
  "#### Scenario: <name>" blocks written as:
    - **WHEN** <trigger>
    - **THEN** <observable outcome>
  Use MODIFIED/REMOVED Requirements sections instead of ADDED when changing or removing
  existing behavior already covered by an existing spec.
- tasks.md — numbered sections, each task a "- [ ] N.M <description>" checkbox line with
  a verification note.`;

/**
 * Explore turn — new in pipeline v2. Runs before Propose and writes EXPLORATION.md.
 *
 * This is the direct fix for a real regression found comparing this fusion command's own
 * output against native /plan on the same brainstorm: the propose turn grepped
 * docker-compose for the wrong env var and *completely dropped* one of two git submodules
 * from its reconciliation tasks — despite being told in prose to "check .gitmodules". Prose
 * alone wasn't enough; the model skipped it under the combined load of writing proposal +
 * design + specs + tasks in one turn.
 *
 * The fix here is structural, not just a stronger prompt: `listSubmodules()` reads
 * .gitmodules itself (deterministic fs work, zero token cost, cannot be skipped) and the
 * exact list is injected into the prompt as a checklist the model has to account for one by
 * one. Explore is also its own separate turn — a smaller, single-purpose pass is less likely
 * to shortcut grounding than one more thing competing for attention inside Propose.
 */
function exploreTurnPrompt(b: BrainstormMeta, submodules: { name: string; path: string }[]): string {
	const paths = changePaths("", b.changeId);
	const submoduleLine =
		submodules.length > 0
			? `\n\nThis repo has ${submodules.length} git submodule(s) declared in .gitmodules — account for EVERY one of them ` +
				`by name in your findings, even if a given submodule turns out to be unaffected by this change (say so explicitly, ` +
				`don't just omit it):\n` +
				submodules.map((s) => `  - ${s.name} (path: ${s.path})`).join("\n")
			: "";
	return (
		`Explore the ground truth for the Readyset change "${b.changeId}" before any planning artifact is written. ` +
		`Read the brainstorm at ${b.file} fully first, then write ${paths.exploration}.\n\n` +
		"Write EXPLORATION.md as a findings log, one entry per thing you actually checked — not a restatement of the " +
		"brainstorm. For each entry: what you checked (an exact file path, command you ran, or commit you looked at), and " +
		"what you found (quote the actual line/value, or the actual test/command output — not a paraphrase). Specifically:\n" +
		"- read any docker-compose*.yml / .env.example for config keys this change touches, and quote the actual current " +
		"value of anything relevant, not what you'd expect it to be;\n" +
		"- run the relevant test suite if one exists, and paste the real pass/fail summary;\n" +
		"- if you claim an implementation 'already exists', cite the exact commit hash and branch you checked it at." +
		submoduleLine +
		"\n\nDo not write proposal.md, design.md, specs/, or tasks.md in this turn — findings only. It's fine, and expected, " +
		"to write 'checked X, found nothing relevant' rather than force every entry into a discovered problem."
	);
}

function proposeTurnPrompt(b: BrainstormMeta): string {
	const paths = changePaths("", b.changeId);
	return (
		`Create a Readyset change named "${b.changeId}" from the brainstorm at ${b.file}. ` +
		`Read the brainstorm fully first, then read ${paths.exploration} — it holds this change's grounding findings, ` +
		"already checked against real repo state in a prior turn. Do not re-derive or contradict it; every claim in " +
		"proposal.md/design.md that touches something EXPLORATION.md covered should point back to that finding, not restate " +
		"a fresh guess.\n\n" +
		"If you need a fact this change depends on and EXPLORATION.md doesn't cover it — a submodule's gitlink vs. its " +
		"checked-out commit, an extra config file, anything load-bearing to a Decision or a blocking task — you may check " +
		"it yourself with a real command, but two things are not optional: (1) never write 'EXPLORATION.md recorded/found " +
		"this' for something EXPLORATION.md does not actually contain — say 'verified during planning' instead, so the " +
		"provenance in proposal.md/design.md/tasks.md is never false; (2) append what you checked and found to " +
		`${paths.exploration} itself (a new '## Additional findings (Propose turn)' section, same one-entry-per-thing-` +
		"checked format Explore used), so the next person reading EXPLORATION.md sees the complete grounding trail, not " +
		"just what the Explore turn happened to cover.\n\n" +
		ARTIFACT_GUIDE +
		"\n\nCarry over the brainstorm's Decision, Seam, Scope and Acceptance Criteria (keep the criteria as WHEN/THEN " +
		"scenarios), and use its Spec Impact section to shape the delta specs. Do not reopen options the brainstorm " +
		"already decided; carry its Open Questions into the proposal rather than answering them silently.\n\n" +
		"If EXPLORATION.md surfaced something the brainstorm didn't anticipate (a submodule it didn't mention, a config " +
		"value that's already drifted), fold it into What Changes / tasks.md rather than silently dropping it. Do not " +
		"implement code in this turn — planning artifacts only."
	);
}

function refineTurnPrompt(changeId: string, feedback: string, issues: string[]): string {
	const issuesLine = issues.length > 0 ? `\n\nStructural check also flagged: ${issues.join("; ")}.` : "";
	return (
		`Revise the Readyset change "${changeId}" under readyset/changes/${changeId}/ per this feedback: ${feedback}` +
		issuesLine +
		"\n\nRead the existing proposal.md/design.md/specs/tasks.md first. " +
		ARTIFACT_GUIDE +
		"\n\nDo not implement code in this turn — planning artifacts only."
	);
}

/**
 * Apply turn. Pipeline v2 adds a TDD-style discipline from mattpocock/skills: a task isn't
 * done just because the code was written, it's done once something actually checked it. The
 * `_Verified:` note format is machine-checkable (checkTaskVerification() counts them), so the
 * review panel can show "N tasks missing verification" as a real signal rather than trusting
 * the same turn's self-report.
 */
function applyTurnPrompt(changeId: string): string {
	const paths = changePaths("", changeId); // relative paths only; cwd prefix stripped for the prompt
	return (
		`Implement the Readyset change "${changeId}". Read ${paths.proposal}, ${paths.design}, every ` +
		`specs/**/spec.md under ${paths.specsDir}, and ${paths.tasks} before starting. ` +
		"Loop through pending tasks in tasks.md: make the minimal focused change each task describes, then verify it — run " +
		"the relevant test, hit the endpoint, execute the script, whatever actually exercises the behavior the task " +
		"describes. Only mark a task complete (`- [ ]` -> `- [x]`) once you have a real result to point to, and immediately " +
		"below the checked line add an indented note in this exact format: `  _Verified: <what you ran or checked, and the " +
		"actual result>_` (e.g. `_Verified: ran \\`npm test\\`, 12/12 pass_` or `_Verified: curl'd /health, got 200_`). A task " +
		"with no real way to verify (e.g. a doc-only change) still gets a note explaining why: `_Verified: doc-only, no " +
		"behavior to check_` — never check a box with no note at all.\n\n" +
		"Pause and ask if a task is unclear, needs scope beyond what the spec describes, or you hit an error or blocker — " +
		"never silently narrow or drop specified behavior, and never check a box to move on without actually verifying it. " +
		"Keep going until every task is complete or you are blocked, then report progress as N/M tasks."
	);
}

/**
 * Code-review turn — new in pipeline v2, fires after every task is done but before the
 * archive offer. This is the mattpocock/skills "review critically in a separate pass"
 * pattern: the same turn that just implemented the change is a poor judge of its own diff
 * (it already believes its choices were right), so review happens as its own fresh turn with
 * an explicitly adversarial framing, writing REVIEW.md rather than silently approving.
 */
function codeReviewTurnPrompt(changeId: string): string {
	const paths = changePaths("", changeId);
	return (
		`Critically review the implementation of Readyset change "${changeId}". Read ${paths.proposal}, ${paths.design}, ` +
		`every specs/**/spec.md under ${paths.specsDir}, and ${paths.tasks} (including its _Verified: notes) — then read ` +
		"the actual diff/files this change touched. You did not write this implementation; your job is to find problems " +
		"in it, not to confirm it's fine.\n\n" +
		"Write " +
		paths.review +
		" covering: (1) does the implementation actually match every requirement's WHEN/THEN scenarios, or does it narrow, " +
		"skip, or half-implement any of them; (2) are the _Verified: notes credible — do they describe something that would " +
		"actually catch a failure, or are they vague/self-serving (e.g. 'looks correct' is not a verification); (3) any " +
		"correctness bug, edge case, or regression risk you can see in the touched files, whether or not tasks.md " +
		"mentioned it. Structure it as a findings list; if you genuinely find nothing, say so plainly rather than padding " +
		"the file — but check hard before concluding that. Do not edit the implementation in this turn — findings only."
	);
}

/**
 * Grill turn — fires the FIRST message of what will become a real multi-turn conversation,
 * unlike Explore/Propose/Apply/Refine/Code-review (which are each a single fire-and-wait turn
 * driven by `spendTurn`/`fireTurnAndWait`). A genuine "grill until the design tree resolves,
 * never accept a passive answer" loop — mattpocock/skills style, matching the existing
 * upstream `brainstorm-ai` skill's own rules 3 and 6 — means asking the user real questions and
 * getting real replies across ordinary chat turns. There is nothing for extension code to
 * synchronously wait on: `startGrilling` below fires this prompt and returns immediately; the
 * rest of the back-and-forth happens as normal chat turns the user answers directly, ending
 * once the model writes the brainstorm file itself and the user re-invokes /readyset to
 * pick it up.
 *
 * The file this writes must match `loadBrainstorms()`/`parseBranch()`'s expected shape exactly
 * (same frontmatter keys, a "- Branch: <type>/<slug>" line under Git Workflow) so once written
 * it is indistinguishable from a brainstorm the separate upstream `brainstorm-ai` skill
 * produced — /readyset's own picker, and reconcileStatuses, treat either identically.
 *
 * Round cap is prompt-level only, deliberately — there is no `TurnBudget`-style hard stop on
 * grilling the way there is on Explore/Propose/Apply/Refine/Code-review, because those are each
 * one `spendTurn` call extension code fires and waits on; grilling's rounds are ordinary chat
 * turns the user answers directly, which this extension's code never sees or counts (it only
 * fires the opening message). GRILL_ROUND_CAP below is the number of question-rounds after
 * which the prompt itself is told to check in rather than keep going indefinitely — a soft,
 * model-followed convention, not something `startGrilling`/the handler can enforce. The other
 * half of the mitigation is structural and does run in code: `validateBrainstormContent`
 * (readyset-brainstorm.ts), checked before Explore ever spends a turn on whatever grilling
 * actually produced — see its call site in the command handler.
 *
 * The rules below are adapted from mattpocock/skills' actual `grilling` skill, vendored verbatim
 * (MIT-licensed) at `src/skill/mattpocock-grilling.md` in this package -- check that file, not
 * just this comment, when tuning wording, since it's the real source this was built from rather
 * than a paraphrase of a paraphrase. One rule from there carried over close to verbatim because
 * a real grilling run exposed exactly the gap it closes: "finding facts is your job, never the
 * user's" -- an early run left a checkable external fact (a WhatsApp Business Platform tier
 * requirement) as an open question/silent assumption instead of looking it up, even though a web
 * search tool is a baseline part of this omp setup's toolset. See the corresponding bullet below.
 */
const GRILL_ROUND_CAP = 4;
function grillTurnPrompt(ideaText: string, today: string, preferredLanguage?: string): string {
	return (
		"Grill this raw idea into a decided Readyset brainstorm file, mattpocock/skills style — interrogate it, " +
		`don't just accept it. Raw idea from the user: "${ideaText}"\n\n` +
		"This is the first message of a real conversation, not a one-shot task: ask your first round of " +
		"questions now, in this reply, and then stop — end your turn there. The user will answer in their next " +
		"message, in the same chat. Keep going, round by round, until the design is genuinely settled. Rules:\n" +
		// Trimmed (2026-09-18) to roughly half its original wording after an audit flagged this
		// prompt's real, recurring token cost against its unenforceable, soft-only nature -- same
		// instruction, fewer words. See GRILL_ROUND_CAP's own doc comment for why this can only ever
		// be a soft, prompt-level check rather than something the extension's code enforces.
		`- Track your round count. At round ${GRILL_ROUND_CAP} without the design tree resolved, stop and check in: ` +
		"summarize what's decided, name what's still open, and ask whether to keep grilling or write the " +
		"brainstorm now with the rest under Open Questions. Pace check only — not permission to accept a passive answer.\n" +
		"- Map out the decision branches this idea implies before asking anything (what's actually unresolved: " +
		"approach, scope boundary, the seam/module it touches, how success is observed), then ask only the " +
		"questions answerable right now, all in one numbered round, each with your own recommended answer so " +
		"the user can confirm or override rather than starting from a blank page.\n" +
		"- Never accept a passive reply ('okay', 'terserah', 'up to you', 'looks good') as a real decision on " +
		"anything load-bearing — if the user brushes past a question, restate it as a concrete pick with your " +
		"recommendation and ask again. Only an explicit 'defer this to the planning harness' counts as a " +
		"resolved answer for something the user genuinely doesn't want to decide yet.\n" +
		"- Offer at least two real options/approaches when there's more than one reasonable way in, and discuss " +
		"the trade-off — don't just assert a pick.\n" +
		"- Do real read-only repo research (Read/Grep/Glob, read-only git/shell commands) before or between " +
		"rounds wherever it would sharpen a question or firm up a recommendation — don't ask the user something " +
		"the repo already answers.\n" +
		"- Finding facts is your job, never the user's (mattpocock/skills' own rule for this — see " +
		"src/skill/mattpocock-grilling.md in this package). A question about external platform behavior, API " +
		"rules/tiers, or anything else this session's web search tool could actually answer does not belong " +
		"in a round as an open question or a silent assumption — look it up first, then ask (or state) the " +
		"real thing. Reserve open questions for what only the user can decide or knows.\n" +
		(preferredLanguage
			? `- Preferred language for this discussion: ${preferredLanguage}. Write your FIRST round of questions, ` +
				"and every reply after, in that language -- don't wait for the user to reply in it first before " +
				"switching. The brainstorm FILE you write at the end must still be entirely in English regardless, " +
				"exactly like the structure below.\n\n"
			: "- Reply in whatever language the user is using for the back-and-forth itself. The brainstorm FILE you " +
				"write at the end must be entirely in English regardless, exactly like the structure below.\n\n") +
		"Before writing the file, explicitly close out — per the existing brainstorm-ai skill's own closing " +
		"rules, so the file reads as though that skill wrote it: which option is decided (or explicitly " +
		"deferred), the seam, in/out of scope, and acceptance criteria as WHEN/THEN lines. Then auto-derive " +
		"(don't ask) the branch type with a one-line reason, and the lane from that branch type — full for " +
		"feature/adjust/experimental, fast for bugfix/hotfix/refactor/chore/docs/test/release. Do ask directly " +
		"(it's a workflow preference the content can't reveal): commit-only vs. commit + merge request per task.\n\n" +
		"Once — and only once — every one of those is actually resolved or explicitly deferred, write the file " +
		`to .ai/brainstorms/${today}-<slug>.md (kebab-case slug derived from the title) with exactly this shape:\n\n` +
		"---\n" +
		"title: <short topic title>\n" +
		"slug: <slug>\n" +
		"status: open\n" +
		"lane: full/fast\n" +
		"change_id:\n" +
		`created: ${today}\n` +
		"namespace: <repo/project path this is scoped to, or cross-namespace>\n" +
		"---\n\n" +
		"## Problem / Context\n## Options Explored\n### Option A: <name>\n### Option B: <name>\n" +
		"## Leaning Direction\n## Decision\n## Seam\n## Scope\n## Acceptance Criteria\n## Spec Impact\n" +
		"## Git Workflow\n- Branch: <type>/<slug>\n- Inference reason: <one line>\n" +
		"- Lane: <full | fast> — <one line>\n- Per-task flow: <\"commit only\" | \"commit + merge request per task\">\n" +
		"## Open Questions\n## Technical Constraints & Notes from Repo\n## Next Step\n\n" +
		"Once the file is written, tell the user its path and that running /readyset again picks it up " +
		"from here (Explore, then Propose) — do not fire off Explore or Propose yourself in this turn."
	);
}

interface ReviewCtx {
	cwd: string;
	ui: {
		select: (prompt: string, options: ExtensionUISelectOption[], opts?: { helpText?: string }) => Promise<string | undefined>;
		input?: (prompt: string) => Promise<string | undefined>;
		setEditorText: (text: string) => void;
		setWidget?: (lines: string[]) => void;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		// Interactive-mode-only (docs/extensions.md): renders a real custom TUI component with
		// keyboard focus — the same mechanism native /plan's own review sidebar is built from.
		// Absent (or a no-op) in RPC/ACP/print modes, so every call site feature-detects it and
		// falls back to `browseReviewSections`'s menu-driven view rather than assuming it exists.
		custom?: <T>(
			factory: (tui: unknown, theme: OverlayTheme, keybindings: OverlayKeybindings, done: (result: T) => void) => unknown,
			options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
		) => Promise<T>;
	};
	waitForIdle: () => Promise<void>;
	// Both documented on the general handler ctx (see extensions.md "Handler Context
	// Capabilities"). Optional here because real-world timing means we'd rather degrade to
	// the old (racy) behavior than throw if a given omp build doesn't expose them.
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	// ctx.models.current() — confirmed in extensions.md ("the live session model, read lazily
	// so it reflects /model switches"). Used to save/restore the model around a pinned run.
	models?: {
		current?: () => unknown;
		resolve?: (spec: string) => unknown;
	};
}

/**
 * Pins a specific model for the turns fired inside `fn`, then restores whatever model the
 * session had before, even if `fn` throws. This exists so a Readyset run is reproducible
 * independent of whatever model happened to be active in the chat session that invoked it —
 * without it, re-running the same change could silently use a different (possibly weaker or
 * more expensive) model each time.
 *
 * `pi.setModel(modelSpec)` and `ctx.models.current()`/`.resolve()` are confirmed to exist on
 * the extension API (extensions.md), but the exact accepted/returned shape for setModel isn't
 * documented in detail — this resolves a raw model spec string via `ctx.models.resolve()`
 * first (the same path `--model` itself uses) rather than assuming setModel takes a bare
 * string, and treats whatever `ctx.models.current()` returns as an opaque value to hand back
 * to `setModel()` unchanged for restoration. If either API is missing on a given omp build,
 * this degrades to running with whatever model the session already has, with a warning.
 *
 * `modelSpec` can come from the `--model` flag or from `readyset.model` (its `.default`, in the
 * current nested shape, or the bare legacy value) in `~/.omp/agent/config.yml` (flag wins if
 * both are set) — `source` is just for the notification text, so it's clear which one actually
 * took effect.
 *
 * `fallbackChain` (optional, possibly empty) covers only the pin itself failing to apply — i.e.
 * `setModel()` throwing while switching to `modelSpec`, which usually means the configured
 * spec is wrong (typo, retired model), not that the model is transiently unavailable. Each
 * entry is tried in order, stopping at the first that pins successfully; only once every entry
 * has failed does this give up and run unpinned. A runtime provider outage mid-turn is a
 * different problem, and omp already has its own answer for it (`retry.fallbackChains` in
 * `~/.omp/agent/config.yml`, applied automatically to whatever model is active) — this does not
 * attempt to duplicate that. `fallbackSource` labels the whole chain (it's read from one place
 * in config, or is a single `--fallback-model` flag value), not each entry individually.
 */
export async function withPinnedModel<T>(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	modelSpec: string | undefined,
	source: string,
	fallbackChain: string[],
	fallbackSource: string,
	fn: () => Promise<T>,
): Promise<T> {
	if (!modelSpec) return fn();

	// Bound to `pi`, not just extracted — a bare `pi.setModel` reference loses its `this` when
	// called detached (`const f = obj.method; f()`), which is exactly what a real terminal run
	// (2026-09-18) hit: "undefined is not an object (evaluating 'this.runtime')" on every call,
	// pin and fallback and restore alike, because the real setModel implementation reads state
	// off `this` internally. `.bind(pi)` keeps the existence check below working unchanged
	// (bind on undefined would throw, so the optional chain still yields `undefined` when
	// `pi.setModel` isn't there) while fixing every call site without touching them.
	const setModel = (pi as unknown as { setModel?: (spec: unknown) => unknown }).setModel?.bind(pi);
	if (!setModel || !ctx.models?.current) {
		ctx.ui.notify(
			`Model "${modelSpec}" (from ${source}) was given, but this omp build doesn't expose pi.setModel/ctx.models.current — ` +
				"running with whatever model this session already has.",
			"warning",
		);
		return fn();
	}

	const original = ctx.models.current();
	let activeSpec = modelSpec;
	let activeSource = source;

	try {
		const resolved = ctx.models.resolve ? ctx.models.resolve(modelSpec) : modelSpec;
		await setModel(resolved);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		if (fallbackChain.length === 0) {
			ctx.ui.notify(
				`Couldn't pin model "${modelSpec}" (from ${source}): ${reason}. No fallback configured (readyset.model.fallbackChains) — ` +
					"running with whatever model this session already has.",
				"warning",
			);
			return fn();
		}

		let pinned = false;
		for (const [i, fallbackSpec] of fallbackChain.entries()) {
			ctx.ui.notify(
				i === 0
					? `Couldn't pin model "${modelSpec}" (from ${source}): ${reason}. Trying fallback "${fallbackSpec}" (from ${fallbackSource})...`
					: `Fallback "${fallbackChain[i - 1]}" also failed to pin. Trying next fallback "${fallbackSpec}" (from ${fallbackSource})...`,
				"warning",
			);
			try {
				const resolvedFallback = ctx.models.resolve ? ctx.models.resolve(fallbackSpec) : fallbackSpec;
				await setModel(resolvedFallback);
				activeSpec = fallbackSpec;
				activeSource = fallbackSource;
				pinned = true;
				break;
			} catch {
				// try the next entry in the chain
			}
		}

		if (!pinned) {
			ctx.ui.notify(
				`Every fallback in the chain (${fallbackChain.join(", ")}, from ${fallbackSource}) failed to pin. ` +
					"Running with whatever model this session already has.",
				"warning",
			);
			return fn();
		}
	}

	ctx.ui.notify(`Pinned model "${activeSpec}" (from ${activeSource}) for this /readyset run.`, "info");

	try {
		return await fn();
	} finally {
		try {
			await setModel(original);
		} catch {
			ctx.ui.notify(
				`Couldn't restore the model this session had before pinning "${activeSpec}" — check /model if it looks off.`,
				"warning",
			);
		}
	}
}

/**
 * Fires a triggered agent turn and waits for it to actually finish — not just for
 * `waitForIdle()` to resolve.
 *
 * Confirmed live (2026-09-18, real omp run): `pi.sendUserMessage(prompt, { deliverAs:
 * "nextTurn", triggerTurn: true })` schedules the turn, it does not start it synchronously.
 * Calling `ctx.waitForIdle()` immediately after can race it — if the session still reads as
 * idle in that instant (the turn hasn't flipped it to "running" yet), `waitForIdle()`
 * resolves immediately, before the turn has produced anything. That is exactly what
 * happened: the "doesn't look finished" warning fired, and only afterward did the turn's
 * own prompt/output actually appear.
 *
 * Fix: poll briefly for the session to leave idle (or show a pending message) before
 * calling waitForIdle() for real. If `isIdle`/`hasPendingMessages` aren't available on this
 * build's ctx, this falls back to the original (racy) immediate wait rather than hanging
 * forever on an unknown API.
 */
async function fireTurnAndWait(pi: ExtensionAPI, ctx: ReviewCtx, prompt: string): Promise<void> {
	pi.sendUserMessage(prompt, { deliverAs: "nextTurn", triggerTurn: true });

	if (ctx.isIdle || ctx.hasPendingMessages) {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const idle = ctx.isIdle ? ctx.isIdle() : true;
			const pending = ctx.hasPendingMessages ? ctx.hasPendingMessages() : false;
			if (!idle || pending) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	await ctx.waitForIdle();
}

/**
 * Kicks off grilling for a raw, directly-typed idea and returns immediately — deliberately not
 * awaited against `ctx.waitForIdle()` the way `spendTurn`/`fireTurnAndWait` are, because the
 * turns that follow are ordinary chat turns the user answers directly (see `grillTurnPrompt`'s
 * doc comment). Handler call sites `return` right after this.
 */
function startGrilling(pi: ExtensionAPI, ctx: ReviewCtx, ideaText: string, preferredLanguage?: string): void {
	const today = new Date().toISOString().slice(0, 10);
	const preview = ideaText.length > 60 ? `${ideaText.slice(0, 57)}...` : ideaText;
	ctx.ui.notify(
		`Grilling started for: "${preview}"${preferredLanguage ? ` in ${preferredLanguage}` : ""} — Readyset will ask questions ` +
			"right here in the chat; answer them, and it'll write the brainstorm file once the design is genuinely " +
			"resolved. Run /readyset again afterward to pick it up from there.",
		"info",
	);
	pi.sendUserMessage(grillTurnPrompt(ideaText, today, preferredLanguage), { deliverAs: "nextTurn", triggerTurn: true });
}

const MAX_TURNS_PER_RUN = 10;
const MAX_VERIFICATION_SENDBACKS = 2;

/**
 * Every triggered turn (Explore/Propose/Refine/Apply/Code-review) costs real tokens, and
 * several of them sit inside loops a user could drive indefinitely (repeated Refine, repeated
 * "Send back for verification"). This is a hard per-invocation ceiling on total turns fired —
 * a guardrail against an unbounded loop burning cost with no natural stopping point, not a
 * precise cost estimate. It resets on every `/readyset` invocation; there is no
 * cross-session budget store yet, so a determined user can still re-run the command for a
 * fresh budget — this catches an accidental loop, not a deliberate one.
 */
interface TurnBudget {
	readonly max: number;
	spent: number;
}

function createTurnBudget(max: number = MAX_TURNS_PER_RUN): TurnBudget {
	return { max, spent: 0 };
}

/** Fires a turn against the budget. Returns false (and notifies) without firing anything if
 *  the budget is already spent — callers must stop, not retry, when this returns false. */
async function spendTurn(pi: ExtensionAPI, ctx: ReviewCtx, budget: TurnBudget, label: string, prompt: string): Promise<boolean> {
	if (budget.spent >= budget.max) {
		ctx.ui.notify(
			`Turn budget (${budget.max} agent turns) reached for this /readyset run — stopping before ${label} to avoid an ` +
				"unbounded loop. Check readyset/changes/<id>/CONTEXT.md for what ran, then re-run /readyset to continue with a fresh budget.",
			"warning",
		);
		return false;
	}
	budget.spent++;
	await fireTurnAndWait(pi, ctx, prompt);
	return true;
}

interface ReviewSnapshot {
	counted: { done: number; total: number } | undefined;
	validated: Awaited<ReturnType<typeof validateChange>>;
	verification: Awaited<ReturnType<typeof checkTaskVerification>>;
	explored: boolean;
	reviewed: boolean;
}

/** One validate + progress + verification pass, shared by the widget and the gate prompt so
 *  they never disagree and none of it runs twice for the same decision. All pure fs work
 *  (readyset-spec.ts) — no LLM turn, no CLI process. */
async function takeReviewSnapshot(ctx: ReviewCtx, chosen: BrainstormMeta): Promise<ReviewSnapshot> {
	const progress = await getProgress(ctx.cwd, chosen.changeId);
	const validated = await validateChange(ctx.cwd, chosen.changeId);
	const verification = await checkTaskVerification(ctx.cwd, chosen.changeId);
	const explored = await hasExploration(ctx.cwd, chosen.changeId);
	const review = await readReview(ctx.cwd, chosen.changeId);
	return {
		counted: progress ? { done: progress.done, total: progress.total } : undefined,
		validated,
		verification,
		explored,
		reviewed: !!review,
	};
}

async function readOrPlaceholder(path: string, placeholder: string): Promise<string> {
	const raw = await readFile(path, "utf8").catch(() => undefined);
	const trimmed = raw?.trim();
	return trimmed ? trimmed : placeholder;
}

const DOC_RULE = "═".repeat(78);
const SECTION_RULE = "─".repeat(78);

interface ReviewSection {
	/** Stable id, used as the select-menu label prefix so a pick can be matched back reliably
	 *  even if two sections' headings collide. */
	id: string;
	heading: string;
	/** Short status shown in the table of contents and the jump-to-section menu. */
	status: string;
	render: () => Promise<string>;
}

/**
 * Builds the list of review sections for `chosen` — the single source of truth for both the
 * full compiled document and the "Jump to section" single-section view, so they can never
 * drift out of sync with each other.
 */
async function buildReviewSections(ctx: ReviewCtx, chosen: BrainstormMeta, snapshot: ReviewSnapshot): Promise<ReviewSection[]> {
	const paths = changePaths(ctx.cwd, chosen.changeId);
	const specFiles = await findSpecFiles(paths.specsDir).catch(() => [] as string[]);

	return [
		{
			id: "exploration",
			heading: "Exploration",
			status: snapshot.explored ? "done" : "not run",
			render: () => readOrPlaceholder(paths.exploration, "_(Explore did not run, or wrote nothing.)_"),
		},
		{
			id: "proposal",
			heading: "Proposal",
			status: "proposal.md",
			render: () => readOrPlaceholder(paths.proposal, "_(proposal.md not found.)_"),
		},
		{
			id: "design",
			heading: "Design",
			status: "design.md",
			render: () => readOrPlaceholder(paths.design, "_(design.md not found.)_"),
		},
		{
			id: "specs",
			heading: `Specs (${specFiles.length})`,
			status: specFiles.length > 0 ? `${specFiles.length} file(s)` : "none found",
			render: async () => {
				if (specFiles.length === 0) return "_(no specs/**/spec.md found.)_";
				const parts: string[] = [];
				for (const specFile of specFiles) {
					const rel = specFile.slice(paths.specsDir.length + 1);
					parts.push(`### specs/${rel}`, "", await readOrPlaceholder(specFile, "_(empty)_"));
				}
				return parts.join("\n\n");
			},
		},
		{
			id: "tasks",
			heading: snapshot.counted ? `Tasks (${snapshot.counted.done}/${snapshot.counted.total})` : "Tasks",
			status: snapshot.counted ? `${snapshot.counted.done}/${snapshot.counted.total} ticked` : "tasks.md not found",
			render: () => readOrPlaceholder(paths.tasks, "_(tasks.md not found.)_"),
		},
		{
			id: "verification",
			heading: "Verification summary",
			status: snapshot.verification ? (snapshot.verification.missing > 0 ? `${snapshot.verification.missing} missing` : "all verified") : "n/a",
			render: async () =>
				snapshot.verification
					? `${snapshot.verification.withVerificationNote}/${snapshot.verification.checkedTasks} checked tasks carry a _Verified: note (${snapshot.verification.missing} missing).`
					: "_(tasks.md unreadable — nothing to summarize.)_",
		},
		{
			id: "code-review",
			heading: "Code review",
			status: snapshot.reviewed ? "done" : "not run yet",
			render: () => readOrPlaceholder(paths.review, "_(Code review has not run yet.)_"),
		},
		{
			id: "context-log",
			heading: "Context log",
			status: "audit trail",
			render: () => readOrPlaceholder(paths.context, "_(No phase transitions logged yet.)_"),
		},
	];
}

/**
 * Compiles every artifact for a change into one structured, scrollable document — a table of
 * contents up top (section name + at-a-glance status), then each section between `───` rules
 * — and pushes it to the editor pane via `ctx.ui.setEditorText`.
 *
 * A real persistent sidebar (native `/plan`'s clickable outline + content pane) turned out to
 * be possible after all via `ctx.ui.custom()` in Interactive mode — see `readyset-review-overlay.ts`
 * and `openSidebarOverlay` below, offered as "Sidebar view" on the gate whenever `ctx.ui.custom`
 * is present. This compiled document is pushed to the editor pane unconditionally at the top of
 * every gate loop iteration (see `reviewAndMaybeExecute`), so it's always current whether or not
 * the user opens the sidebar — there is deliberately no separate "just show me the full doc" gate
 * option, since one pushed automatically on every loop turn would be a no-op by construction.
 * `browseReviewSections` below remains the fallback "one section at a time" menu for RPC/ACP/print
 * contexts, where `ctx.ui.custom` isn't available.
 */
async function buildReviewDocument(ctx: ReviewCtx, chosen: BrainstormMeta, snapshot: ReviewSnapshot): Promise<string> {
	const sections = await buildReviewSections(ctx, chosen, snapshot);

	const lines: string[] = [DOC_RULE, ` ${chosen.title}  (${chosen.changeId})`, DOC_RULE, "", `Brainstorm: ${chosen.file}`, "", "Sections:"];
	sections.forEach((s, i) => lines.push(`  ${i + 1}. ${s.heading.padEnd(24)} [${s.status}]`));
	lines.push("", DOC_RULE);

	for (const [i, s] of sections.entries()) {
		lines.push("", SECTION_RULE, ` ${i + 1}. ${s.heading.toUpperCase()}`, SECTION_RULE, "", await s.render());
	}

	return lines.join("\n");
}

/** Renders just one section (by id) the same way `buildReviewDocument` would, for the
 *  "Jump to section" view — same content, without the noise of every other section. */
async function buildSingleSectionDocument(ctx: ReviewCtx, chosen: BrainstormMeta, snapshot: ReviewSnapshot, sectionId: string): Promise<string | undefined> {
	const sections = await buildReviewSections(ctx, chosen, snapshot);
	const section = sections.find((s) => s.id === sectionId);
	if (!section) return undefined;
	return [DOC_RULE, ` ${section.heading.toUpperCase()}  —  ${chosen.changeId}`, DOC_RULE, "", await section.render()].join("\n");
}

/**
 * "Jump to section" — a menu-driven stand-in for a sidebar (see `buildReviewDocument`'s doc
 * comment for why a real one isn't possible). Loops until the user picks "Back to full
 * document", pushing just the picked section's content to the editor each time.
 */
/**
 * "Sidebar view" — a real persistent section list + content pane, via `ctx.ui.custom()`
 * (Interactive mode only; see `readyset-review-overlay.ts`'s module doc comment for how this
 * was confirmed against `@oh-my-pi/pi-tui`'s own real source, not assumed). Up/Down moves the
 * section cursor, PgUp/PgDn scrolls the body, Esc returns to the gate. `ctx.ui.custom` is
 * feature-detected by the caller, not here — this function assumes it exists.
 */
async function openSidebarOverlay(ctx: ReviewCtx, chosen: BrainstormMeta, snapshot: ReviewSnapshot): Promise<void> {
	const sections = await buildReviewSections(ctx, chosen, snapshot);
	const overlaySections: OverlaySection[] = [];
	for (const s of sections) {
		overlaySections.push({ id: s.id, heading: s.heading, status: s.status, bodyLines: (await s.render()).split("\n") });
	}

	type OverlayCtorArgs = ConstructorParameters<typeof ReviewSidebarOverlay>;
	await ctx.ui.custom!<undefined>((_tui, theme, keybindings, done) =>
		new ReviewSidebarOverlay(
			theme as unknown as OverlayCtorArgs[0],
			keybindings as unknown as OverlayCtorArgs[1],
			`Readyset review — ${chosen.title} (${chosen.changeId})`,
			overlaySections,
			done,
		),
	{ overlay: true, overlayOptions: { fullscreen: true } },
	).catch((err) => {
		ctx.ui.notify(`Sidebar view failed to open: ${err instanceof Error ? err.message : String(err)}. Falling back to Jump to section.`, "warning");
		return browseReviewSections(ctx, chosen, snapshot);
	});
}

async function browseReviewSections(ctx: ReviewCtx, chosen: BrainstormMeta, snapshot: ReviewSnapshot): Promise<void> {
	const sections = await buildReviewSections(ctx, chosen, snapshot);
	const BACK = "◂ Back to full document";

	for (;;) {
		const options: ExtensionUISelectOption[] = sections.map((s, i) => ({
			label: `${i + 1}. ${s.heading}`,
			description: s.status,
		}));
		options.push({ label: BACK, description: "show every section again, with the table of contents" });

		const picked = await ctx.ui.select(`Jump to a section — "${chosen.changeId}"`, options, { helpText: "enter to view · esc to go back" });
		if (!picked || picked === BACK) {
			ctx.ui.setEditorText(await buildReviewDocument(ctx, chosen, snapshot));
			return;
		}

		const idx = sections.findIndex((s, i) => `${i + 1}. ${s.heading}` === picked);
		if (idx === -1) continue;
		const doc = await buildSingleSectionDocument(ctx, chosen, snapshot, sections[idx].id);
		if (doc) {
			ctx.ui.setEditorText(doc);
			ctx.ui.notify(`Showing "${sections[idx].heading}" in the editor pane.`, "info");
		}
	}
}

function showReviewPanel(ctx: ReviewCtx, chosen: BrainstormMeta, snapshot: ReviewSnapshot, budget: TurnBudget): void {
	const lines = [
		`Change: ${chosen.changeId}`,
		snapshot.validated.summary,
		snapshot.explored ? "exploration: done" : "exploration: skipped",
		snapshot.counted ? `tasks: ${snapshot.counted.done}/${snapshot.counted.total} ticked` : "tasks.md not found",
		snapshot.verification
			? snapshot.verification.missing > 0
				? `verification: ${snapshot.verification.missing}/${snapshot.verification.checkedTasks} checked tasks missing a _Verified: note`
				: `verification: ${snapshot.verification.withVerificationNote}/${snapshot.verification.checkedTasks} checked tasks verified`
			: "verification: n/a",
		snapshot.reviewed ? "code review: done — see REVIEW.md" : "code review: not run yet",
		`agent turns this run: ${budget.spent}/${budget.max}`,
		`proposal: readyset/changes/${chosen.changeId}/proposal.md`,
	];
	ctx.ui.setWidget?.(lines);
}

/**
 * The fused review+refine loop. Runs after propose-equivalent artifacts exist for
 * `chosen`. Loops on "Refine" until the user picks Approve or Discard, so refinement
 * doesn't require re-invoking the command either.
 */
async function reviewAndMaybeExecute(pi: ExtensionAPI, ctx: ReviewCtx, initial: BrainstormMeta, budget: TurnBudget): Promise<void> {
	let chosen = initial;
	let verificationSendbacks = 0;

	for (;;) {
		const snapshot = await takeReviewSnapshot(ctx, chosen);
		showReviewPanel(ctx, chosen, snapshot, budget);
		ctx.ui.setEditorText(await buildReviewDocument(ctx, chosen, snapshot));
		const taskSummary = snapshot.counted
			? `${snapshot.counted.done}/${snapshot.counted.total} tasks ticked`
			: "tasks.md not found yet";

		const hasSidebar = typeof ctx.ui.custom === "function";
		const choice = await ctx.ui.select(`Review change "${chosen.changeId}" — ${snapshot.validated.summary}`, [
			{ label: "Approve & Execute", description: `implement per tasks.md, then report progress — ${taskSummary}` },
			{ label: "Refine", description: "describe what to change; revises the artifacts and re-validates" },
			...(hasSidebar
				? [{ label: "Sidebar view", description: "persistent section list + content, like native /plan's review — ↑/↓ · PgUp/PgDn · Esc" }]
				: [{ label: "Jump to section", description: "browse one section at a time (exploration/proposal/design/specs/tasks/…)" }]),
			{ label: "Discard", description: "leave as proposed, do nothing" },
		]);

		if (!choice || choice === "Discard") return;

		if (choice === "Sidebar view") {
			await openSidebarOverlay(ctx, chosen, snapshot);
			continue; // stay in the loop; re-show the panel/gate (and full document) after they close the overlay
		}

		if (choice === "Jump to section") {
			await browseReviewSections(ctx, chosen, snapshot);
			continue; // stay in the loop; re-show the panel/gate (and full document) after they're done browsing
		}

		if (choice === "Refine") {
			const feedback = ctx.ui.input ? await ctx.ui.input("What should change?") : undefined;
			if (!feedback) {
				ctx.ui.notify("No feedback given — nothing changed.", "info");
				continue;
			}
			ctx.ui.notify(`Revising "${chosen.changeId}"...`, "info");
			const refineFired = await spendTurn(
				pi,
				ctx,
				budget,
				"Refine",
				refineTurnPrompt(chosen.changeId, feedback, snapshot.validated.issues.map((i) => `${i.file}: ${i.problem}`)),
			);
			if (!refineFired) return;
			await appendContext(ctx.cwd, chosen.changeId, "Refine", `User feedback: ${feedback}`);
			continue; // loop back: re-validate and show the panel/gate again
		}

		// "Approve & Execute". Runs its own inner loop around Apply so a missing-verification
		// re-run just fires Apply again — it does not send the user back through the main gate
		// (Approve & Execute / Refine / Discard) to re-approve something already approved.
		await markApproved(chosen);
		ctx.ui.notify(`Approved. Implementing "${chosen.changeId}"...`, "info");

		let verification: Awaited<ReturnType<typeof checkTaskVerification>>;
		applyLoop: for (;;) {
			const applyFired = await spendTurn(pi, ctx, budget, "Apply", applyTurnPrompt(chosen.changeId));
			if (!applyFired) return;

			const status = await getProgress(ctx.cwd, chosen.changeId);
			if (!status) {
				ctx.ui.notify(`Implementation ran, but couldn't read tasks.md for "${chosen.changeId}" afterward.`, "warning");
				return;
			}
			if (status.state !== "all_done") {
				ctx.ui.notify(
					`Paused at ${status.done}/${status.total} tasks (state: ${status.state}) — check the transcript above for why.`,
					"warning",
				);
				return;
			}

			verification = await checkTaskVerification(ctx.cwd, chosen.changeId);
			await appendContext(
				ctx.cwd,
				chosen.changeId,
				"Apply",
				`Implementation reported ${status.done}/${status.total} tasks done. ` +
					(verification
						? `${verification.withVerificationNote}/${verification.checkedTasks} carry a _Verified: note (${verification.missing} missing).`
						: "tasks.md unreadable for verification check."),
			);

			if (verification && verification.missing > 0) {
				const canSendBack = verificationSendbacks < MAX_VERIFICATION_SENDBACKS;
				const options = canSendBack
					? [
							{ label: "Send back for verification", description: "fires another apply turn asking it to verify + note the missing tasks" },
							{ label: "Continue to code review anyway", description: "proceed without full verification coverage" },
						]
					: [{ label: "Continue to code review anyway", description: "proceed without full verification coverage" }];
				const proceedAnyway = await ctx.ui.select(
					`Implementation complete, but ${verification.missing}/${verification.checkedTasks} checked tasks have no _Verified: note — ` +
						"the apply turn marked them done without something that actually checked the behavior." +
						(canSendBack ? "" : ` (already sent back ${verificationSendbacks}x — proceeding without full coverage this time.)`),
					options,
				);
				if (proceedAnyway === "Send back for verification") {
					verificationSendbacks++;
					ctx.ui.notify(`Asking "${chosen.changeId}" to verify the remaining tasks...`, "info");
					continue applyLoop;
				}
			}
			break;
		}

		const finalStatus = await getProgress(ctx.cwd, chosen.changeId);
		ctx.ui.notify(
			`Implementation complete: ${finalStatus?.done ?? "?"}/${finalStatus?.total ?? "?"} tasks. Running code review...`,
			"info",
		);
		const reviewFired = await spendTurn(pi, ctx, budget, "Code review", codeReviewTurnPrompt(chosen.changeId));
		if (!reviewFired) return;
		const reviewContent = await readReview(ctx.cwd, chosen.changeId);
		await appendContext(
			ctx.cwd,
			chosen.changeId,
			"Code review",
			reviewContent ? "REVIEW.md written — see file for findings." : "Code review turn ran but REVIEW.md is empty or missing.",
		);

		if (reviewContent) {
			ctx.ui.setWidget?.([`Change: ${chosen.changeId}`, "REVIEW.md:", ...reviewContent.split("\n").slice(0, 8)]);
		}

		const archiveChoice = await ctx.ui.select(
			`Code review done for "${chosen.changeId}"${reviewContent ? " — see readyset/changes/" + chosen.changeId + "/REVIEW.md" : ""}. Archive now?`,
			[
				{ label: "Archive now", description: "moves the change to changes/archive/ and merges deltas into specs/ (append-only, best-effort — review after)" },
				{ label: "Address findings first", description: "leave it in readyset/changes/ so you can fix review findings, then re-run /readyset" },
				{ label: "Not yet", description: "leave it in readyset/changes/ for now" },
			],
		);
		if (archiveChoice === "Archive now") {
			const result = await archiveChange(ctx.cwd, chosen.changeId);
			ctx.ui.notify(
				`Archived to ${result.archivedDir}. Merged into: ${result.mergedSpecFiles.join(", ") || "(no spec files found to merge)"} ` +
					"— this was an append-only merge, not a real ADDED/MODIFIED/REMOVED diff; review the merged spec.",
				"info",
			);
		}
		return;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("readyset", {
		description:
			"Readyset: propose + review + execute a brainstorm against real repo state, standalone — no /plan or external CLI required " +
			"(flags: --all, --fast, --idea <raw idea text> to grill a new brainstorm from scratch, --lang <language> to open " +
			"grilling's discussion in that language from round 1 (must come before --idea), --model <spec> to pin a model " +
			"for this run's turns, --fallback-model <spec> if the pin fails to apply)",
		handler: async (args, ctx) => {
			const showAll = args?.includes("--all");
			const includeFast = args?.includes("--fast");

			// Standalone: bootstrap readyset/{changes,specs} ourselves if missing — there is no
			// separate init step or CLI to run first.
			await ensureReadysetRoot(ctx.cwd);

			// --lang <language> (or, if no flag, readyset.language in ~/.omp/agent/config.yml) sets
			// the language grilling's discussion (questions and replies) opens in from round 1,
			// rather than grillTurnPrompt's reactive default of matching whatever language the
			// user's own replies happen to be in -- for a dev who isn't fluent in English, waiting
			// for them to switch first means round 1 always arrives in English regardless. The
			// brainstorm FILE itself stays English either way (see grillTurnPrompt). Must come
			// before --idea on the command line: --idea joins everything after it into the idea
			// text, so a --lang placed after --idea would be swallowed into that text instead of
			// parsed as a flag.
			const langFlagIdx = args?.indexOf("--lang") ?? -1;
			const langFromFlag = langFlagIdx >= 0 ? args?.[langFlagIdx + 1] : undefined;
			const resolvedConfigLanguage = langFromFlag ? undefined : await readPreferredLanguage();
			const preferredLanguage = langFromFlag ?? resolvedConfigLanguage?.language;

			// --idea skips the picker entirely: everything after it is joined back into the raw idea
			// text (so it need not be quoted as a single arg), and grilling starts immediately. Must
			// come last among flags on the command line.
			const ideaFlagIdx = args?.indexOf("--idea") ?? -1;
			const ideaFromFlag = ideaFlagIdx >= 0 ? (args ?? []).slice(ideaFlagIdx + 1).join(" ").trim() : "";
			if (ideaFromFlag) {
				startGrilling(pi, ctx as unknown as ReviewCtx, ideaFromFlag, preferredLanguage);
				return;
			}

			const all = await loadBrainstorms(ctx.cwd);
			const updated = await reconcileStatuses(ctx.cwd, all);
			if (updated > 0) ctx.ui.notify(`Synced status of ${updated} brainstorm(s) with readyset/changes`, "info");

			const items = all
				.filter((b) => showAll || b.status !== "archived")
				.filter((b) => includeFast || b.lane === "full");

			// Offering "type a new idea" needs ctx.ui.input to actually collect it -- feature-detected
			// the same way ctx.ui.custom is for the Sidebar view, so this degrades gracefully (falls
			// back to --idea only) on an omp build that doesn't expose input() on this ctx shape.
			const canGrillFromScratch = typeof (ctx as unknown as ReviewCtx).ui.input === "function";
			const NEW_IDEA_LABEL = "✎ Type a new idea (grill it here)";

			if (items.length === 0) {
				ctx.ui.notify(
					`No full-lane brainstorms found in ${BRAINSTORM_DIR}/ (--fast includes fast-lane, --all includes archived)` +
						(canGrillFromScratch ? ` -- or run /readyset --idea "<your raw idea>" to grill a new one into existence.` : ""),
					"warning",
				);
				return;
			}

			const byLabel = new Map<string, BrainstormMeta>();
			const options: ExtensionUISelectOption[] = items.map((b) => {
				const label = `${b.created ?? "?"} · ${b.title}`;
				const lane = b.laneSource === "default" ? "full lane (assumed)" : `${b.lane} lane`;
				const next = b.status === "archived" ? "done" : isProposed(b.status) ? "→ review" : "→ propose + review";
				byLabel.set(label, b);
				return { label, description: [next, lane, b.namespace].filter(Boolean).join(" · ") };
			});
			if (canGrillFromScratch) {
				options.unshift({
					label: NEW_IDEA_LABEL,
					description: "type a raw idea; Readyset grills it mattpocock-style into a brainstorm, then hands off to Explore",
				});
			}

			const picked = await ctx.ui.select("Pick a brainstorm to take through Readyset (fused review)", options, {
				helpText: "enter to continue · esc to cancel",
			});
			if (!picked) return;

			if (picked === NEW_IDEA_LABEL) {
				const reviewCtxForInput = ctx as unknown as ReviewCtx;
				const idea = (await reviewCtxForInput.ui.input!("What's the idea? A sentence or two is enough -- Readyset will grill for the rest."))?.trim();
				if (!idea) {
					ctx.ui.notify("No idea given -- nothing started.", "info");
					return;
				}
				startGrilling(pi, reviewCtxForInput, idea, preferredLanguage);
				return;
			}

			const chosen = byLabel.get(picked);
			if (!chosen) return;

			if (chosen.status === "archived") {
				ctx.ui.notify(`Change "${chosen.changeId}" is already archived. Start a new brainstorm for follow-up work.`, "warning");
				return;
			}

			const reviewCtx = ctx as unknown as ReviewCtx;
			const budget = createTurnBudget();

			// --model <spec> (or, if no flag is given, a configured default from
			// ~/.omp/agent/config.yml: readyset.model if set, else omp's own modelRoles.default) pins
			// a specific model for every turn this run fires (Explore through Code-review), so a run
			// is reproducible regardless of whatever model happened to be active in the chat session
			// that invoked it. The original model is restored once this run finishes, whether it
			// completes, stops early (Discard, budget exhausted), or throws. Flag wins over config.
			//
			// --fallback-model <spec> (a single spec, not a chain) or readyset.model.fallbackChains
			// (an ordered list, tried in turn until one pins — legacy readyset.fallbackModel still
			// works too, as a one-element chain) is tried if pinning the resolved model above fails
			// outright (a bad/retired spec) — see withPinnedModel's doc comment for why this is
			// narrower than, and doesn't replace, omp's own retry.fallbackChains.
			const modelFlagIdx = args?.indexOf("--model") ?? -1;
			const modelFromFlag = modelFlagIdx >= 0 ? args?.[modelFlagIdx + 1] : undefined;
			const resolvedConfigModel = modelFromFlag ? undefined : await readPinnedModel();
			const pinnedModel = modelFromFlag ?? resolvedConfigModel?.model;
			const pinnedModelSource = modelFromFlag ? "--model flag" : (resolvedConfigModel?.source ?? "");

			const fallbackFlagIdx = args?.indexOf("--fallback-model") ?? -1;
			const fallbackFromFlag = fallbackFlagIdx >= 0 ? args?.[fallbackFlagIdx + 1] : undefined;
			const resolvedConfigFallback = fallbackFromFlag ? undefined : await readFallbackChain();
			const fallbackChain = fallbackFromFlag ? [fallbackFromFlag] : (resolvedConfigFallback?.chain ?? []);
			const fallbackChainSource = fallbackFromFlag ? "--fallback-model flag" : (resolvedConfigFallback?.source ?? "");

			await withPinnedModel(pi, reviewCtx, pinnedModel, pinnedModelSource, fallbackChain, fallbackChainSource, async () => {
				if (isProposed(chosen.status)) {
					await reviewAndMaybeExecute(pi, reviewCtx, chosen, budget);
					return;
				}

				// Structural gate on the brainstorm itself, before Explore/Propose spend any turns on
				// it — catches a brainstorm (from grilling or otherwise) whose Decision/Seam/Scope/
				// Acceptance Criteria were never actually resolved. See validateBrainstormContent's doc
				// comment for why this exists specifically for the grilling path: a fired turn working
				// from a prose instruction alone can accept a passive answer despite being told not to,
				// and there is no other structural check between grilling writing the file and Explore
				// spending real turns on it.
				const contentCheck = validateBrainstormContent(chosen.raw);
				if (!contentCheck.ok) {
					const gapList = contentCheck.issues.map((i) => `${i.section} (${i.problem})`).join("; ");
					// contentCheck.summary carries the "(structural check)" label deliberately -- same
					// wording validateChange uses below in the review gate, so neither reads as a
					// stronger guarantee than it actually is just because of how it's phrased here.
					const proceed = await reviewCtx.ui.select(
						`${contentCheck.summary}: ${gapList}.`,
						[
							{ label: "Continue anyway", description: "proceed to Explore/Propose despite the gaps above" },
							{ label: "Go back", description: "cancel -- fill in (or keep grilling) the brainstorm first, then run /readyset again" },
						],
					);
					if (proceed !== "Continue anyway") {
						ctx.ui.notify(`Stopped before Explore -- resolve the gaps in "${chosen.title}" and run /readyset again.`, "info");
						return;
					}
				}

				await scaffoldChange(ctx.cwd, chosen.changeId);

				const submodules = await listSubmodules(ctx.cwd);
				ctx.ui.notify(`Exploring ground truth for "${chosen.changeId}" — this can take a while...`, "info");
				const exploreFired = await spendTurn(pi, reviewCtx, budget, "Explore", exploreTurnPrompt(chosen, submodules));
				if (!exploreFired) return;

				const explored = await hasExploration(ctx.cwd, chosen.changeId);
				await appendContext(
					ctx.cwd,
					chosen.changeId,
					"Explore",
					explored
						? `EXPLORATION.md written. ${submodules.length} submodule(s) known from .gitmodules: ${submodules.map((s) => s.name).join(", ") || "(none)"}.`
						: "Explore turn ran but EXPLORATION.md is empty or missing — Propose will still run, but without grounded findings to lean on.",
				);
				if (!explored) {
					ctx.ui.notify(
						`Exploration for "${chosen.changeId}" didn't produce EXPLORATION.md — continuing to Propose anyway, but its ` +
							"grounding will be weaker than usual. Check the transcript above.",
						"warning",
					);
				}

				ctx.ui.notify(`Proposing change "${chosen.changeId}" — this can take a while...`, "info");
				const proposeFired = await spendTurn(pi, reviewCtx, budget, "Propose", proposeTurnPrompt(chosen));
				if (!proposeFired) return;
				await appendContext(ctx.cwd, chosen.changeId, "Propose", "Propose turn ran; see proposal.md/design.md/specs/tasks.md.");

				const reloaded = await loadBrainstorms(ctx.cwd);
				await reconcileStatuses(ctx.cwd, reloaded);
				const after = reloaded.find((b) => b.changeId === chosen.changeId);

				// reconcileStatuses/changeState only checks whether readyset/changes/<id>/ exists as a
				// directory — and scaffoldChange above already created it before the turn ran. So a
				// turn that wrote nothing at all still leaves a dir behind and isProposed() alone
				// would wrongly look "finished". Check proposal.md actually has content too.
				const wroteProposal = after ? (await validateChange(ctx.cwd, after.changeId)).issues.every((i) => !(i.file === "proposal.md" && i.problem === "missing")) : false;

				if (!after || !isProposed(after.status) || !wroteProposal) {
					ctx.ui.notify(
						`Propose for "${chosen.changeId}" doesn't look finished (readyset/changes/${chosen.changeId}/proposal.md ` +
							"not found or empty) — check the transcript above for errors, then run /readyset again.",
						"warning",
					);
					return;
				}

				await reviewAndMaybeExecute(pi, reviewCtx, after, budget);
			});
		},
	});
}
