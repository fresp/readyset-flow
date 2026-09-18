import type { ExtensionAPI, ExtensionUISelectOption } from "@oh-my-pi/pi-coding-agent";
import {
	BRAINSTORM_DIR,
	type BrainstormMeta,
	isProposed,
	loadBrainstorms,
	markApproved,
	reconcileStatuses,
} from "../lib/brainstorm.ts";
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
import { readFallbackModel, readPinnedModel } from "../lib/omp-config.ts";

/**
 * /readyset-review — Readyset's core command: propose, review, and execute a brainstorm
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

interface ReviewCtx {
	cwd: string;
	ui: {
		select: (prompt: string, options: ExtensionUISelectOption[], opts?: { helpText?: string }) => Promise<string | undefined>;
		input?: (prompt: string) => Promise<string | undefined>;
		setEditorText: (text: string) => void;
		setWidget?: (lines: string[]) => void;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
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
 * `modelSpec` can come from the `--model` flag or from `readyset.model` in
 * `~/.omp/agent/config.yml` (flag wins if both are set) — `source` is just for the
 * notification text, so it's clear which one actually took effect.
 *
 * `fallbackSpec`/`fallbackSource` (optional) cover only the pin itself failing to apply — i.e.
 * `setModel()` throwing while switching to `modelSpec`, which usually means the configured
 * spec is wrong (typo, retired model), not that the model is transiently unavailable. A
 * runtime provider outage mid-turn is a different problem, and omp already has its own answer
 * for it (`retry.fallbackChains` in `~/.omp/agent/config.yml`, applied automatically to
 * whatever model is active) — this does not attempt to duplicate that.
 */
async function withPinnedModel<T>(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	modelSpec: string | undefined,
	source: string,
	fallbackSpec: string | undefined,
	fallbackSource: string,
	fn: () => Promise<T>,
): Promise<T> {
	if (!modelSpec) return fn();

	const setModel = (pi as unknown as { setModel?: (spec: unknown) => unknown }).setModel;
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
		if (!fallbackSpec) {
			ctx.ui.notify(
				`Couldn't pin model "${modelSpec}" (from ${source}): ${reason}. No fallback configured (readyset.fallbackModel) — ` +
					"running with whatever model this session already has.",
				"warning",
			);
			return fn();
		}
		ctx.ui.notify(`Couldn't pin model "${modelSpec}" (from ${source}): ${reason}. Trying fallback "${fallbackSpec}" (from ${fallbackSource})...`, "warning");
		try {
			const resolvedFallback = ctx.models.resolve ? ctx.models.resolve(fallbackSpec) : fallbackSpec;
			await setModel(resolvedFallback);
			activeSpec = fallbackSpec;
			activeSource = fallbackSource;
		} catch (fallbackErr) {
			const fallbackReason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
			ctx.ui.notify(
				`Fallback model "${fallbackSpec}" (from ${fallbackSource}) also failed to pin: ${fallbackReason}. ` +
					"Running with whatever model this session already has.",
				"warning",
			);
			return fn();
		}
	}

	ctx.ui.notify(`Pinned model "${activeSpec}" (from ${activeSource}) for this /readyset-review run.`, "info");

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

const MAX_TURNS_PER_RUN = 10;
const MAX_VERIFICATION_SENDBACKS = 2;

/**
 * Every triggered turn (Explore/Propose/Refine/Apply/Code-review) costs real tokens, and
 * several of them sit inside loops a user could drive indefinitely (repeated Refine, repeated
 * "Send back for verification"). This is a hard per-invocation ceiling on total turns fired —
 * a guardrail against an unbounded loop burning cost with no natural stopping point, not a
 * precise cost estimate. It resets on every `/readyset-review` invocation; there is no
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
			`Turn budget (${budget.max} agent turns) reached for this /readyset-review run — stopping before ${label} to avoid an ` +
				"unbounded loop. Check readyset/changes/<id>/CONTEXT.md for what ran, then re-run /readyset-review to continue with a fresh budget.",
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
 * Honest ceiling: omp's extension API has no confirmed way to register a navigable
 * multi-section sidebar the way native `/plan`'s Plan Review does (a clickable outline down
 * the left, content on the right) — confirmed against upstream docs: "Extensions cannot
 * create sidebars, tree views, webviews, split panes, or other persistent navigable regions.
 * UI is confined to modal dialogs or single stacked widgets above/below the editor." The TOC
 * plus rules here, and the "Jump to section" menu (`browseReviewSections` below) that lets a
 * user view one section at a time instead of scrolling the whole thing, are the closest
 * functional equivalent this extension can build within that ceiling — a menu-driven jump
 * instead of a persistent clickable list, not a visual recreation of it.
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

		const choice = await ctx.ui.select(`Review change "${chosen.changeId}" — ${snapshot.validated.summary}`, [
			{ label: "Approve & Execute", description: `implement per tasks.md, then report progress — ${taskSummary}` },
			{ label: "Refine", description: "describe what to change; revises the artifacts and re-validates" },
			{ label: "Jump to section", description: "browse one section at a time (exploration/proposal/design/specs/tasks/…)" },
			{ label: "Buka untuk direview", description: "see the full compiled document in the editor pane — no changes made" },
			{ label: "Discard", description: "leave as proposed, do nothing" },
		]);

		if (!choice || choice === "Discard") return;

		if (choice === "Jump to section") {
			await browseReviewSections(ctx, chosen, snapshot);
			continue; // stay in the loop; re-show the panel/gate (and full document) after they're done browsing
		}

		if (choice === "Buka untuk direview") {
			ctx.ui.notify(
				`Full change document (exploration/proposal/design/specs/tasks/verification/review) is in the editor pane — nothing was changed.`,
				"info",
			);
			continue; // stay in the loop; re-show the panel/gate after they've looked
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
				{ label: "Address findings first", description: "leave it in readyset/changes/ so you can fix review findings, then re-run /readyset-review" },
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
	pi.registerCommand("readyset-review", {
		description:
			"Readyset: propose + review + execute a brainstorm against real repo state, standalone — no /plan or external CLI required " +
			"(flags: --all, --fast, --model <spec> to pin a model for this run's turns, --fallback-model <spec> if the pin fails to apply)",
		handler: async (args, ctx) => {
			const showAll = args?.includes("--all");
			const includeFast = args?.includes("--fast");

			// Standalone: bootstrap readyset/{changes,specs} ourselves if missing — there is no
			// separate init step or CLI to run first.
			await ensureReadysetRoot(ctx.cwd);

			const all = await loadBrainstorms(ctx.cwd);
			const updated = await reconcileStatuses(ctx.cwd, all);
			if (updated > 0) ctx.ui.notify(`Synced status of ${updated} brainstorm(s) with readyset/changes`, "info");

			const items = all
				.filter((b) => showAll || b.status !== "archived")
				.filter((b) => includeFast || b.lane === "full");

			if (items.length === 0) {
				ctx.ui.notify(
					`No full-lane brainstorms found in ${BRAINSTORM_DIR}/ (--fast includes fast-lane, --all includes archived)`,
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

			const picked = await ctx.ui.select("Pick a brainstorm to take through Readyset (fused review)", options, {
				helpText: "enter to continue · esc to cancel",
			});
			if (!picked) return;
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
			// --fallback-model <spec> (or readyset.fallbackModel) is tried if pinning the resolved
			// model above fails outright (a bad/retired spec) — see withPinnedModel's doc comment
			// for why this is narrower than, and doesn't replace, omp's own retry.fallbackChains.
			const modelFlagIdx = args?.indexOf("--model") ?? -1;
			const modelFromFlag = modelFlagIdx >= 0 ? args?.[modelFlagIdx + 1] : undefined;
			const resolvedConfigModel = modelFromFlag ? undefined : await readPinnedModel();
			const pinnedModel = modelFromFlag ?? resolvedConfigModel?.model;
			const pinnedModelSource = modelFromFlag ? "--model flag" : (resolvedConfigModel?.source ?? "");

			const fallbackFlagIdx = args?.indexOf("--fallback-model") ?? -1;
			const fallbackFromFlag = fallbackFlagIdx >= 0 ? args?.[fallbackFlagIdx + 1] : undefined;
			const resolvedConfigFallback = fallbackFromFlag ? undefined : await readFallbackModel();
			const fallbackModel = fallbackFromFlag ?? resolvedConfigFallback?.model;
			const fallbackModelSource = fallbackFromFlag ? "--fallback-model flag" : (resolvedConfigFallback?.source ?? "");

			await withPinnedModel(pi, reviewCtx, pinnedModel, pinnedModelSource, fallbackModel, fallbackModelSource, async () => {
				if (isProposed(chosen.status)) {
					await reviewAndMaybeExecute(pi, reviewCtx, chosen, budget);
					return;
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
							"not found or empty) — check the transcript above for errors, then run /readyset-review again.",
						"warning",
					);
					return;
				}

				await reviewAndMaybeExecute(pi, reviewCtx, after, budget);
			});
		},
	});
}
