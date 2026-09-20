import type { ExtensionAPI, ExtensionAskDialogQuestion, ExtensionAskDialogResult, ExtensionUISelectOption } from "@oh-my-pi/pi-coding-agent";
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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	appendContext,
	archiveChange,
	changePaths,
	checkPhaseViolations,
	checkScope,
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
import { readFallbackChain, readPhaseModels, readPinnedModel, readPreferredLanguage } from "../lib/readyset-omp-config.ts";
import {
	ReviewSidebarOverlay,
	type OverlaySection,
	type OverlayTheme,
	type ReviewOverlayResult,
} from "../lib/readyset-review-overlay.ts";
import {
	checkTaskEvidence,
	EVIDENCE_MAX_OUTPUT_BYTES,
	EVIDENCE_TIMEOUT_MS,
	findEvidenceConflicts,
	persistEvidence,
	runCommand,
	truncateForCapture,
} from "../lib/readyset-evidence.ts";

/** Minimal structural shape this file actually calls — deliberately not importing the real
 *  `KeybindingsManager` type from `@oh-my-pi/pi-tui` even as a type, so this file has zero
 *  dependency (type or runtime) on that package resolving at all. This is the boundary where the
 *  wider extension hands those objects through without needing to know their full shape;
 *  `OverlayTheme` itself is imported from readyset-review-overlay.ts, which owns the one
 *  definition of what the sidebar calls. */
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

- proposal.md — must have a "## Why" section (1-2 paragraphs on the problem), a
  "## What Changes" section (bullet list of concrete changes), and a "## Files This Change
  Will Touch" section: an exhaustive repo-relative path list of every existing file Apply is
  allowed to modify plus every new file it may create. This is the scope contract the gate
  and Apply are checked against — keep it tight (benchmark: readyset diffs ran 2x the plan
  arm's, and T12 grew an unasked-for 160-line bench file). A file not on this list may not
  be written during Apply without asking first.
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
 * `internalGuidance` for `ctx.compact()` when the user picks Approve & Compact. Deliberately not
 * a user-facing "focus" instruction (see `ReviewCtx.compact`'s doc comment on why this rides the
 * private `internalGuidance` channel, not `customInstructions`) — it tells the summarizer what's
 * safe to compress away for a Readyset change specifically: proposal/design/specs/tasks are all
 * persisted under readyset/changes/<id>/ already, so the Explore/Propose discussion that produced
 * them isn't load-bearing for Apply, which re-reads those files from disk regardless of what's
 * left in context (see `applyTurnPrompt`).
 */

/**
 * Runs ctx.compact() before Apply with the Readyset-specific internal guidance. The benchmark
 * showed Explore/Propose context dominating Apply and Review token cost (T01: max context
 * 154k, ~76% of all tokens as cache reads), and everything those phases produced is already
 * persisted under readyset/changes/<id>/ — so compacting here is safe (Apply re-reads the
 * artifacts from disk), and skipping it just pays for the same history twice. A missing
 * ctx.compact (older omp build) or a failed compaction degrades to plain Approve & Execute
 * rather than blocking the user from proceeding at all.
 */
async function compactBeforeApply(ctx: ReviewCtx, changeId: string): Promise<void> {
	if (typeof ctx.compact !== "function") {
		ctx.ui.notify("Compact isn't available in this context — approving without it.", "warning");
		return;
	}
	ctx.ui.notify(`Compacting context before executing "${changeId}"...`, "info");
	try {
		await ctx.compact({
			internalGuidance: compactBeforeExecuteGuidance(changeId),
			suppressContinuation: true,
		});
	} catch (err) {
		ctx.ui.notify(
			`Compact failed (${err instanceof Error ? err.message : String(err)}) — continuing without it.`,
			"warning",
		);
	}
}

function compactBeforeExecuteGuidance(changeId: string): string {
	const paths = changePaths("", changeId);
	return (
		`Readyset change "${changeId}" was just approved for execution. Its proposal (${paths.proposal}), ` +
		`design (${paths.design}), specs (${paths.specsDir}), and tasks (${paths.tasks}) are all persisted to ` +
		"disk and will be re-read from there when execution starts — the Explore/Propose discussion that " +
		"produced them does not need to be retained. Keep the change id and these file paths; the rest of " +
		"that discussion can be summarized away."
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
 * Grill turn — fires the FIRST message of the grilling conversation, unlike
 * Explore/Propose/Apply/Refine/Code-review (which are each a single fire-and-wait turn driven
 * by `spendTurn`/`fireTurnAndWait`). A genuine "grill until the design tree resolves, never
 * accept a passive answer" loop — mattpocock/skills style, matching the existing upstream
 * `brainstorm-ai` skill's own rules 3 and 6 — means asking the user real questions and getting
 * real replies.
 *
 * As of the `readyset_ask` tool (registered below, in the default export), each round of
 * questions is a real structured picker — `ctx.ui.askDialog()`, omp's own native multi-question
 * dialog surface, the same mechanism this session's own AskUserQuestion-equivalent uses — not
 * plain "❓ Q1 ... ➡️ <recommendation>" chat text the user has to type a reply to. Because
 * `askDialog()` blocks synchronously on real user input, the model can call `readyset_ask`
 * repeatedly, round after round, inside the SAME fired turn — it does not need to end its turn
 * between rounds the way it used to. `startGrilling` below still just fires this prompt and
 * returns; everything after that (every round, and the eventual file write) happens inside that
 * one turn now, driven entirely by the model's own tool calls.
 *
 * The file this writes must match `loadBrainstorms()`/`parseBranch()`'s expected shape exactly
 * (same frontmatter keys, a "- Branch: <type>/<slug>" line under Git Workflow) so once written
 * it is indistinguishable from a brainstorm the separate upstream `brainstorm-ai` skill
 * produced — /readyset's own picker, and reconcileStatuses, treat either identically.
 *
 * Round cap is enforced in code now, not just prompt-level: `readyset_ask`'s own `execute()`
 * tracks how many rounds have run for the current grilling session (`grillRoundState`, reset by
 * `startGrilling`) and, once `GRILL_ROUND_CAP` is reached, refuses to open the dialog again and
 * instead returns a tool result telling the model to check in via plain text — summarize what's
 * decided, name what's open, ask whether to keep going. This is a real ceiling (the tool simply
 * won't present another dialog), not a soft, model-followed convention the way it was before
 * `readyset_ask` existed. The other half of the mitigation is unchanged and still runs in code:
 * `validateBrainstormContent` (readyset-brainstorm.ts), checked before Explore ever spends a
 * turn on whatever grilling actually produced — see its call site in the command handler.
 *
 * `askDialog` is only available in Interactive mode (confirmed in extensions.md — RPC/ACP/print
 * modes leave it undefined). `readyset_ask`'s `execute()` feature-detects it the same way this
 * file's other `ctx.ui.custom`-gated code does (see `openSidebarOverlay`): when it's missing,
 * the tool returns a result telling the model to ask that round in plain chat text instead,
 * same content, same rules — grilling still works everywhere, just without the structured UI
 * where the surface for it doesn't exist.
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

/** How many `readyset_ask` rounds have fired for the CURRENT grilling session, plus whether a
 *  grilling session has been started this session at all (`active`) that the command handler
 *  hasn't checked yet. Reset by `startGrilling`; `active` is consumed (set back to `false`) the
 *  next time the command handler's content-check gate runs, so it fires at most once per
 *  grilling session. Module-level (not per-invocation state threaded through the tool call) is a
 *  deliberate trade-off: `registerTool`'s `execute()` has no way to receive extension-local
 *  state per grilling run, only `ctx` (the ExtensionContext) — this is the same reason
 *  `TurnBudget` is a plain object rather than something passed through the tool API. Good enough
 *  for a single-user, single-session tool like this one; a concurrent second grilling session in
 *  the same omp process would share (and reset) this counter, which is an accepted limitation,
 *  not a real scenario Readyset needs to guard against.
 *
 * `active` exists specifically so the command handler can catch a real failure mode: nothing
 * forces the model to actually call `readyset_ask` — that's a prompt-level instruction, not a
 * structural one — so a model running fast/aggressively (more likely with `tools.approvalMode:
 * yolo`, though that setting itself only gates tool-call approval and has no effect on
 * `ctx.ui.select`/`askDialog` truly waiting for real input) could in principle skip asking
 * entirely and just write a brainstorm from its own assumptions. `grillRoundState.active` is
 * deliberately scoped tight to avoid false alarms: it only means "grilling was started THIS
 * session and the gate hasn't looked yet" — a brainstorm hand-written, or grilled in an earlier
 * omp process, leaves `active` at its default `false` and triggers no warning, since this
 * session genuinely has no signal either way about it. It only fires for the one scenario it can
 * actually attest to: a grilling run that started and finished (or was abandoned) in this same
 * process without ever calling `readyset_ask`. See the gate's call site (in the command handler)
 * for how this combines with `validateBrainstormContent`. */
const grillRoundState = { rounds: 0, active: false };
function grillTurnPrompt(ideaText: string, today: string, preferredLanguage?: string): string {
	return (
		"Grill this raw idea into a decided Readyset brainstorm file, mattpocock/skills style — interrogate it, " +
		`don't just accept it. Raw idea from the user: "${ideaText}"\n\n` +
		"Use the `readyset_ask` tool for EVERY round of questions — do not write '❓ Q1 ...' as plain chat text. " +
		"Give it 2 or more real options per question and mark your own recommended one via recommendedIndex, so " +
		"the user picks or overrides rather than starting from a blank page. You can keep calling `readyset_ask` " +
		"round after round in this same turn — you don't need to end your turn between rounds. Keep going until " +
		"the design is genuinely settled, or until the tool tells you the round cap was hit (then check in: " +
		"summarize what's decided, name what's still open, ask in plain chat whether to keep grilling or write " +
		"the brainstorm now with the rest under Open Questions — pace check only, not permission to accept a " +
		"passive answer). If the tool reports the user chose to discuss instead of picking, or that the " +
		"structured picker isn't available this session, continue that round in plain chat text instead, then go " +
		"back to `readyset_ask` for the next round once it's resolved. Rules:\n" +
		"- Map out the decision branches this idea implies before asking anything (what's actually unresolved: " +
		"approach, scope boundary, the seam/module it touches, how success is observed), then ask only the " +
		"questions answerable right now, all in one round.\n" +
		"- Never accept a passive answer ('okay', 'terserah', 'up to you', 'looks good' — whether typed as a " +
		"custom answer or implied by picking your own recommended option without engaging) as a real decision on " +
		"anything load-bearing — if the user brushes past a question, restate it as a concrete pick with your " +
		"recommendation and ask again. Only an explicit 'defer this to the planning harness' counts as a " +
		"resolved answer for something the user genuinely doesn't want to decide yet.\n" +
		"- Offer at least two real options/approaches when there's more than one reasonable way in, with a short " +
		"description of the trade-off on each option — don't just assert a pick.\n" +
		"- Do ONE focused pass of read-only repo research (Read/Grep/Glob, read-only git/shell commands) " +
		"BEFORE round 1 — map the idea onto real files/modules/seams first, then carry those findings through " +
		"every round. Do not re-research the same question in later rounds; research only genuinely new " +
		"questions that round 1 couldn't have anticipated. The benchmark showed a single grilling session " +
		"making 17 bash + 16 read calls spread across rounds for what one upfront pass covers — every " +
		"repeated lookup re-pays the same context cost. Don't ask the user something the repo already " +
		"answers.\n" +
		"- Finding facts is your job, never the user's (mattpocock/skills' own rule for this — see " +
		"src/skill/mattpocock-grilling.md in this package). A question about external platform behavior, API " +
		"rules/tiers, or anything else this session's web search tool could actually answer does not belong " +
		"in a round as an open question or a silent assumption — look it up first, then ask (or state) the " +
		"real thing. Reserve open questions for what only the user can decide or knows.\n" +
		(preferredLanguage
			? `- Preferred language for this discussion: ${preferredLanguage}. Write every question and option ` +
				"text you pass to `readyset_ask`, and any plain-chat fallback text, in that language from the very " +
				"first round -- don't wait for the user to reply in it first before switching. Keep each " +
				"`readyset_ask` question's `header` (the short chip label above it, e.g. 'Eligibility gate') in " +
				"English regardless of preferred language -- it reads like fixed UI chrome, not conversation, and " +
				"a picker with some tabs translated and some not (e.g. 'Framing' next to a translated tab) is more " +
				"jarring than just keeping all of them in English. The brainstorm FILE you write at the end must " +
				"still be entirely in English regardless, exactly like the structure below.\n\n"
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
	/** Host run mode ("tui" | "rpc" | "json" | "print"). Custom overlays are TUI-only -- see reviewAndMaybeExecute. */
	mode?: string;
	ui: {
		select: (prompt: string, options: ExtensionUISelectOption[], opts?: { helpText?: string }) => Promise<string | undefined>;
		input?: (prompt: string) => Promise<string | undefined>;
		setEditorText: (text: string) => void;
		// Real signature is `setWidget(key: string, content: ExtensionWidgetContent, options?)` —
		// the key is what a later call with the same key replaces. This used to be declared (and
		// called) as `(lines: string[])`, which the host received as key = the array and
		// content = undefined, so the summary panel never actually rendered.
		setWidget?: (key: string, lines: string[]) => void;
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
	// Confirmed against the real `ExtensionContext` type (extensibility/extensions/types.ts):
	// `compact(instructionsOrOptions)` is the same public API native /plan's own "Approve and
	// compact context" option calls internally. `internalGuidance` is piped only to the native
	// summarizer, never exposed as `customInstructions` on the `session_before_compact` hook, so
	// extensions that treat that field as user focus don't mistake this package's boilerplate
	// for the operator's own intent — same reasoning /plan's usage documents. `suppressContinuation`
	// is set by the caller (`reviewAndMaybeExecute`) because it dispatches the Apply turn itself
	// right after compacting, same as plan-mode does after its own "Approve and compact" — without
	// it, a manual compaction that interrupts something in flight would also fire an unwanted
	// auto-continue nudge. Optional because omp builds without it should still let Approve &
	// Compact degrade to a plain Approve (see `reviewAndMaybeExecute`'s "compact" branch) rather
	// than throw.
	compact?: (
		instructionsOrOptions?: string | { internalGuidance?: string; suppressContinuation?: boolean },
	) => Promise<void>;
	// Confirmed against the real type (`ContextUsage` in `@oh-my-pi/pi-tui/status-line/types`):
	// `{ tokens, contextWindow, percent }`. Informational only — shown in the review panel so the
	// user can judge for themselves whether Approve & Compact is worth reaching for; nothing here
	// gates which CTAs are offered.
	getContextUsage?: () => { tokens: number; contextWindow: number; percent: number } | undefined;
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
/**
 * Runs `fn` with a phase-specific model override for one labeled phase. The run's pinned model
 * is captured from ctx.models.current() and restored afterward, so an override only affects the
 * turns fired inside `fn`. An override that fails to pin warns and runs the phase on the pinned
 * model instead — it is a cost optimization, never a reason to stop the run.
 *
 * Unknown phase labels are a caller bug, not a user typo: `phase` here is always one of the
 * extension's own labels (grill|explore|propose|apply|review), so an unrecognized one throws
 * rather than silently running the phase on the wrong model.
 */
export async function withPhaseModel<T>(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	phase: string,
	overrides: Map<string, { model: string; source: string }>,
	fn: () => Promise<T>,
): Promise<T> {
	const knownPhases = ["grill", "explore", "propose", "apply", "review"];
	if (!knownPhases.includes(phase)) {
		throw new Error(`unknown phase "${phase}" — expected one of ${knownPhases.join("|")}`);
	}
	const override = overrides.get(phase);
	if (!override) return fn();

	const setModel = (pi as unknown as { setModel?: (spec: unknown) => unknown }).setModel?.bind(pi);
	const models = ctx.models;
	if (!setModel || !models?.current) {
		ctx.ui.notify(
			`Phase model "${override.model}" for ${phase} (from ${override.source}) was given, but this omp build doesn't expose pi.setModel/ctx.models.current — running ${phase} on the run's model.`,
			"warning",
		);
		return fn();
	}
	const resolved = models.resolve ? models.resolve(override.model) : override.model;
	if (resolved === undefined || resolved === null) {
		ctx.ui.notify(
			`Phase model "${override.model}" for ${phase} (from ${override.source}) didn't resolve to any available model — running ${phase} on the run's model.`,
			"warning",
		);
		return fn();
	}
	const pinned = models.current();
	let applied: unknown;
	try {
		applied = await setModel(resolved);
	} catch {
		applied = false;
	}
	if (applied === false) {
		ctx.ui.notify(
			`Phase model "${override.model}" for ${phase} (from ${override.source}) couldn't be applied (usually: no API key) — running ${phase} on the run's model.`,
			"warning",
		);
		return fn();
	}
	ctx.ui.notify(`Phase model for ${phase}: "${override.model}" (from ${override.source}).`, "info");
	try {
		return await fn();
	} finally {
		try {
			await setModel(pinned);
		} catch {
			ctx.ui.notify(`Couldn't restore the run model after the ${phase} phase — check /model if it looks off.`, "warning");
		}
	}
}

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
	const models = ctx.models;
	if (!setModel || !models?.current) {
		ctx.ui.notify(
			`Model "${modelSpec}" (from ${source}) was given, but this omp build doesn't expose pi.setModel/ctx.models.current — ` +
				"running with whatever model this session already has.",
			"warning",
		);
		return fn();
	}

	/**
	 * Resolves a spec and applies it, throwing when it did NOT actually take effect.
	 *
	 * `pi.setModel` is `(model: Model) => Promise<boolean>`, and its real implementation returns
	 * `false` — without throwing — when there's no API key for that model (`runExtensionSetModel`
	 * in omp source: `const key = await session.modelRegistry.getApiKey(model); if (!key) return
	 * false;`). Treating only rejections as failure, as this used to, made a failed pin look
	 * successful: it reported "Pinned model ..." for a session model that never changed, and the
	 * configured fallback chain was never tried. `ctx.models.resolve` returning `undefined` for an
	 * unmatched spec is the same class of failure and is handled the same way.
	 */
	const applyModel = async (spec: string): Promise<void> => {
		const resolved = models.resolve ? models.resolve(spec) : spec;
		if (resolved === undefined || resolved === null) {
			throw new Error(`"${spec}" didn't resolve to any available model`);
		}
		const applied = await setModel(resolved);
		if (applied === false) {
			throw new Error(`"${spec}" resolved, but couldn't be applied (usually: no API key available for it)`);
		}
	};

	const original = models.current();
	let activeSpec = modelSpec;
	let activeSource = source;

	try {
		await applyModel(modelSpec);
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
				await applyModel(fallbackSpec);
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
 * `pi.sendUserMessage(prompt)` with no `deliverAs` is the wanted behavior: the host starts a
 * turn when the session is idle, and queues as a steer while streaming. It is also the only
 * shape the user-message API accepts — `SendUserMessageOptions.deliverAs` is `"steer" |
 * "followUp" | "aside"`. An earlier version of this file passed `{ deliverAs: "nextTurn",
 * triggerTurn: true }`, which belongs to `pi.sendMessage` and is silently ignored here (the
 * turn still started, by falling through to the host's plain prompt path, so the net effect
 * looked right for the wrong reason).
 *
 * The send is still fire-and-forget from the extension's side — the host does not await it —
 * so the turn is not guaranteed to have flipped the session out of idle by the time this
 * returns. Calling `ctx.waitForIdle()` immediately can race it: if the session still reads as
 * idle in that instant, `waitForIdle()` resolves at once, before the turn has produced
 * anything. That is exactly what happened live (2026-09-18): the "doesn't look finished"
 * warning fired, and only afterward did the turn's own prompt/output actually appear.
 *
 * Fix: poll briefly for the session to leave idle (or show a pending message) before
 * calling waitForIdle() for real. If `isIdle`/`hasPendingMessages` aren't available on this
 * build's ctx, this falls back to the original (racy) immediate wait rather than hanging
 * forever on an unknown API.
 */
async function fireTurnAndWait(pi: ExtensionAPI, ctx: ReviewCtx, prompt: string): Promise<void> {
	pi.sendUserMessage(prompt);

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
	grillRoundState.rounds = 0;
	grillRoundState.active = true; // consumed by the command handler's zero-rounds check -- see grillRoundState's doc comment
	ctx.ui.notify(
		`Grilling started for: "${preview}"${preferredLanguage ? ` in ${preferredLanguage}` : ""} — Readyset will ask questions ` +
			"right here in the chat (a structured picker where available); answer them, and it'll write the " +
			"brainstorm file once the design is genuinely resolved. Run /readyset again afterward to pick it up " +
			"from there.",
		"info",
	);
	pi.sendUserMessage(grillTurnPrompt(ideaText, today, preferredLanguage));
}

const MAX_TURNS_PER_RUN = 10;
const MAX_VERIFICATION_SENDBACKS = 2;

/**
 * A phase budget caps how much wall-clock work one labeled phase may consume before it must
 * either hand something concrete back or stop. Distinct from TurnBudget (which counts fired
 * agent turns): this watches elapsed time while a single turn runs, because a turn can churn
 * for an unbounded number of tool calls without spending any more TurnBudget. The benchmark
 * runs showed Explore/Product phases consuming millions of tokens in a single fired turn; a
 * turn-count ceiling alone cannot see that.
 */
interface PhaseBudget {
	/** Wall-clock ceiling for the phase, in milliseconds. */
	readonly maxMs: number;
	startedAt: number;
}

const DEFAULT_PHASE_BUDGET_MS = 20 * 60 * 1000;

function startPhaseBudget(maxMs: number = DEFAULT_PHASE_BUDGET_MS): PhaseBudget {
	return { maxMs, startedAt: Date.now() };
}

function phaseBudgetExceeded(budget: PhaseBudget): boolean {
	return Date.now() - budget.startedAt > budget.maxMs;
}

function phaseBudgetElapsedMs(budget: PhaseBudget): number {
	return Date.now() - budget.startedAt;
}

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

/**
 * Runs `git status --porcelain` in the repo root and returns the repo-relative paths of every
 * changed file (tracked modifications plus untracked files; renames are reported as their
 * destination). Throws when git is unavailable or the cwd is not a repo — a planning turn in a
 * non-repo has no git boundary to violate, so the caller treats that as "nothing to check",
 * not as a violation.
 */
async function changedPathsSinceBaseline(cwd: string): Promise<string[]> {
	const run = promisify(execFile);
	const { stdout } = await run("git", ["status", "--porcelain", "-uall"], { cwd, timeout: 30000 });
	const paths: string[] = [];
	for (const line of stdout.split("\n")) {
		if (line.length < 4) continue;
		// Porcelain v1: XY + space + path, or "R  old -> new" for renames.
		const rest = line.slice(3);
		const arrow = rest.indexOf(" -> ");
		paths.push(arrow === -1 ? rest : rest.slice(arrow + 4));
	}
	return paths.filter((p) => p !== "");
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
	scope: Awaited<ReturnType<typeof checkScope>>;
	explored: boolean;
	reviewed: boolean;
	/** Runtime evidence (readyset_verify) — independent of, and never reconciled with,
	 *  `verification` (the self-reported _Verified: note check) above. See
	 *  `findEvidenceConflicts`'s doc comment for exactly what "conflict" means here. */
	evidenceTotal: number;
	evidenceConflicts: Awaited<ReturnType<typeof findEvidenceConflicts>>;
}

/** One validate + progress + verification pass, shared by the widget and the gate prompt so
 *  they never disagree and none of it runs twice for the same decision. All pure fs work
 *  (readyset-spec.ts) — no LLM turn, no CLI process. */
async function takeReviewSnapshot(ctx: ReviewCtx, chosen: BrainstormMeta): Promise<ReviewSnapshot> {
	const progress = await getProgress(ctx.cwd, chosen.changeId);
	const validated = await validateChange(ctx.cwd, chosen.changeId);
	const verification = await checkTaskVerification(ctx.cwd, chosen.changeId);
	// Scope is checked against the working tree, not the plan: anything the repo already
	// shows as changed that the contract doesn't name is flagged here, in the gate.
	const scope = await checkScope(ctx.cwd, chosen.changeId, await changedPathsSinceBaseline(ctx.cwd).catch(() => []));
	const explored = await hasExploration(ctx.cwd, chosen.changeId);
	const review = await readReview(ctx.cwd, chosen.changeId);
	const { totalRecords: evidenceTotal } = await checkTaskEvidence(ctx.cwd, chosen.changeId);
	const evidenceConflicts = await findEvidenceConflicts(ctx.cwd, chosen.changeId);
	return {
		counted: progress ? { done: progress.done, total: progress.total } : undefined,
		validated,
		verification,
		scope,
		explored,
		reviewed: !!review,
		evidenceTotal,
		evidenceConflicts,
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
			id: "evidence",
			heading: "Runtime evidence",
			status:
				snapshot.evidenceTotal > 0
					? `${snapshot.evidenceTotal} record(s)${snapshot.evidenceConflicts.length > 0 ? `, ${snapshot.evidenceConflicts.length} conflict(s)` : ""}`
					: "none",
			render: async () => {
				const { byTask } = await checkTaskEvidence(ctx.cwd, chosen.changeId);
				if (byTask.size === 0) {
					return "_(No readyset_verify evidence recorded for this change. This is independent of the " +
						"_Verified: notes above -- their absence here doesn't mean verification wasn't done, only that " +
						"it wasn't runtime-captured.)_";
				}
				const conflictTaskIds = new Set(snapshot.evidenceConflicts.map((c) => c.taskId));
				const parts: string[] = [];
				for (const [taskId, summary] of byTask) {
					const flag = conflictTaskIds.has(taskId)
						? " -- ⚠ CONFLICT: task is marked done, but the latest evidence below shows a non-zero/no exit code"
						: "";
					parts.push(`### Task ${taskId}${flag}`, "");
					for (const rec of summary.records) {
						const outcome = rec.timedOut ? "timed out" : rec.exitCode === null ? "no exit code" : `exit ${rec.exitCode}`;
						parts.push(`- ${rec.id}: \`${rec.command}\` -> ${outcome} (${rec.durationMs}ms)`);
					}
					parts.push("");
				}
				return parts.join("\n");
			},
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
 * and `openSidebarOverlay` below. It opens automatically, as the review gate itself, whenever
 * `ctx.ui.custom` is present — not offered as a "Sidebar view" choice on a separate menu; Approve
 * & Execute / Refine / Discard are CTAs baked into the overlay (see
 * `readyset-review-overlay.ts`'s `ReviewOverlayResult`), so there's no menu step before it either.
 * This compiled document is pushed to the editor pane unconditionally at the top of every gate
 * loop iteration (see `reviewAndMaybeExecute`), so it's always current alongside the sidebar —
 * there is deliberately no separate "just show me the full doc" gate option, since one pushed
 * automatically on every loop turn would be a no-op by construction. `classicGateSelect` /
 * `browseReviewSections` below remain the fallback menu-driven gate for RPC/ACP/print contexts,
 * where `ctx.ui.custom` isn't available.
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
 * The review gate itself, whenever a real TUI is available — a persistent section list +
 * content pane via `ctx.ui.custom()` (Interactive mode only; see `readyset-review-overlay.ts`'s
 * module doc comment for how this was confirmed against `@oh-my-pi/pi-tui`'s own real source,
 * not assumed), with Approve & Execute / Approve & Compact / Refine / Discard as CTAs inside it
 * (the `[A]`/`[C]`/`[R]`/`[D]` keys `ReviewSidebarOverlay.handleInput` binds). Up/Down scroll the current section's content
 * and cross into the next/previous section once it's exhausted; Left/Right jump straight to a
 * section, bypassing its content; PgUp/PgDn take a bigger scroll step within the current
 * section. Esc cancels (treated the same as an explicit Discard by the caller). Errors
 * opening the overlay are NOT swallowed here — the caller (`reviewAndMaybeExecute`) catches them
 * and falls back to `classicGateSelect`'s menu, since a failed overlay open means there's no CTA
 * surface for the user to act on at all. `ctx.ui.custom` is feature-detected by the caller, not
 * here — this function assumes it exists.
 */
async function openSidebarOverlay(
	ctx: ReviewCtx,
	chosen: BrainstormMeta,
	snapshot: ReviewSnapshot,
	taskSummary: string,
): Promise<ReviewOverlayResult> {
	const sections = await buildReviewSections(ctx, chosen, snapshot);
	const overlaySections: OverlaySection[] = [];
	for (const s of sections) {
		overlaySections.push({ id: s.id, heading: s.heading, status: s.status, bodyLines: (await s.render()).split("\n") });
	}

	type OverlayCtorArgs = ConstructorParameters<typeof ReviewSidebarOverlay>;
	return await ctx.ui.custom!<ReviewOverlayResult>((_tui, theme, keybindings, done) =>
		new ReviewSidebarOverlay(
			theme as unknown as OverlayCtorArgs[0],
			keybindings as unknown as OverlayCtorArgs[1],
			`Readyset review — ${chosen.title} (${chosen.changeId})`,
			overlaySections,
			taskSummary,
			done,
		),
	// `width: "90%"` is load-bearing, not decoration: `OverlayOptions.fullscreen` (confirmed
	// against pi-tui's real source -- see readyset-review-overlay.ts's module doc comment) only
	// controls the alt-screen buffer, not sizing. Without an explicit width the overlay defaults
	// to `min(80, terminalWidth)`, which is why an earlier version rendered as a narrow box even
	// on a wide terminal.
	{ overlay: true, overlayOptions: { fullscreen: true, width: "90%" } },
	);
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
	// Informational only -- doesn't gate which CTAs are offered (Approve & Compact is always
	// there; see reviewAndMaybeExecute). Lets the user judge for themselves whether it's worth
	// reaching for right now instead of Readyset guessing at a threshold.
	const usage = ctx.getContextUsage?.();
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
		snapshot.evidenceTotal > 0
			? `runtime evidence: ${snapshot.evidenceTotal} record(s)${snapshot.evidenceConflicts.length > 0 ? ` -- ${snapshot.evidenceConflicts.length} conflict(s): task done but evidence shows failure` : ""}`
			: "runtime evidence: none",
		snapshot.reviewed ? "code review: done — see REVIEW.md" : "code review: not run yet",
		snapshot.scope.noContract
			? "scope: no 'Files This Change Will Touch' contract in proposal.md — scope unknown"
			: snapshot.scope.outside.length > 0
				? `scope: OUT OF SCOPE already changed in the tree: ${snapshot.scope.outside.join(", ")}`
				: "scope: working tree matches the contract",
		`agent turns this run: ${budget.spent}/${budget.max}`,
		...(usage ? [`context: ${usage.percent}% (${usage.tokens.toLocaleString()}/${usage.contextWindow.toLocaleString()} tokens)`] : []),
		`proposal: readyset/changes/${chosen.changeId}/proposal.md`,
	];
	ctx.ui.setWidget?.("readyset", lines);
}

/**
 * The classic, menu-driven gate — used only when the sidebar overlay isn't available
 * (`ctx.ui.custom` missing: RPC/ACP/print-headless contexts, or the overlay threw on open).
 * Loops internally on "Jump to section" so the caller always gets back a real gate decision
 * (approve/refine/discard/cancel), never an intermediate browsing state.
 */
async function classicGateSelect(
	ctx: ReviewCtx,
	chosen: BrainstormMeta,
	snapshot: ReviewSnapshot,
	taskSummary: string,
): Promise<ReviewOverlayResult> {
	for (;;) {
		const choice = await ctx.ui.select(`Review change "${chosen.changeId}" — ${snapshot.validated.summary}`, [
			{ label: "Approve & Execute", description: `compact context first, then implement per tasks.md — ${taskSummary}` },
			{ label: "Approve & Execute, keep context", description: "implement without compacting (keep the full Explore/Propose discussion in context)" },
			{ label: "Refine", description: "describe what to change; revises the artifacts and re-validates" },
			{ label: "Jump to section", description: "browse one section at a time (exploration/proposal/design/specs/tasks/…)" },
			{ label: "Discard", description: "leave as proposed, do nothing" },
		]);

		if (choice === "Jump to section") {
			await browseReviewSections(ctx, chosen, snapshot);
			continue; // stay in the loop; re-show this same menu after they're done browsing
		}
		if (choice === "Approve & Execute") return "approve";
		if (choice === "Approve & Execute, keep context") return "keep-context";
		if (choice === "Refine") return "refine";
		if (choice === "Discard") return "discard";
		return undefined; // cancelled (no choice)
	}
}

/**
 * The fused review+refine loop. Runs after propose-equivalent artifacts exist for `chosen`.
 * Loops on "Refine" until the user picks Approve or Discard, so refinement doesn't require
 * re-invoking the command either.
 *
 * Whenever `ctx.ui.custom` is available, the sidebar overlay opens automatically at the top of
 * every loop iteration — it IS the review gate, with Approve & Execute / Keep context /
 * Refine / Discard as CTAs baked into it, not a "Sidebar view" choice offered on a separate menu
 * the user had to pick first. `classicGateSelect` is the fallback for contexts without a real
 * TUI, and also covers the (rare) case where the overlay itself throws on open. Approve &
 * Execute runs `ctx.compact()` before falling through to the Apply flow — see the compact
 * branch below and `ReviewCtx.compact`'s doc comment.
 *
 * `phaseModels` carries the run's per-phase model overrides (grill|explore|propose|apply|
 * review); the Explore/Propose caller passes its own map, this loop passes the same map on
 * for Refine/Apply/Code-review so an override covers its phase wherever that phase fires.
 */
async function reviewAndMaybeExecute(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	initial: BrainstormMeta,
	budget: TurnBudget,
	phaseModels: Map<string, { model: string; source: string }> = new Map(),
): Promise<void> {
	let chosen = initial;
	let verificationSendbacks = 0;

	for (;;) {
		const snapshot = await takeReviewSnapshot(ctx, chosen);
		showReviewPanel(ctx, chosen, snapshot, budget);
		ctx.ui.setEditorText(await buildReviewDocument(ctx, chosen, snapshot));
		const taskSummary = snapshot.counted
			? `${snapshot.counted.done}/${snapshot.counted.total} tasks ticked`
			: "tasks.md not found yet";

		// `ui.custom` existing is not enough: omp's RPC host implements it as a stub that resolves
		// `undefined` immediately ("Custom UI not supported in RPC mode"), which this loop would read
		// as Esc == Discard -- silently throwing the gate away before the user ever sees it. omp's own
		// ExtensionContext docs say to guard custom components with `mode === "tui"`. `mode` is
		// optional here only for older omp builds that don't expose it (those were TUI-only anyway).
		const hasSidebar = typeof ctx.ui.custom === "function" && (ctx.mode === undefined || ctx.mode === "tui");
		let choice: ReviewOverlayResult;
		if (hasSidebar) {
			try {
				choice = await openSidebarOverlay(ctx, chosen, snapshot, taskSummary);
			} catch (err) {
				ctx.ui.notify(`Sidebar view failed to open: ${err instanceof Error ? err.message : String(err)}. Falling back to the classic menu.`, "warning");
				choice = await classicGateSelect(ctx, chosen, snapshot, taskSummary);
			}
		} else {
			choice = await classicGateSelect(ctx, chosen, snapshot, taskSummary);
		}

		if (!choice || choice === "discard") return;

		// "Approve & Execute" compacts first (see compactBeforeApply for why this is safe
		// for a Readyset change specifically: everything Explore/Propose produced is already
		// persisted under readyset/changes/<id>/, and Apply re-reads those files from disk).
		// "Approve & Execute, keep context" skips the compact for the case where discussion
		// nuance didn't make it into the artifacts. A missing ctx.compact (older omp build)
		// or a failed compaction degrades to plain Approve & Execute rather than blocking
		// the user from proceeding at all. A scope mismatch (out-of-contract files already
		// changed in the tree) likewise warns, never blocks: it is shown in the gate panel
		// so approval happens with eyes open, not stopped for work the user can see. "compact"
		// is kept as an accepted result for
		// older sidebar builds that still return it (defensive; the current overlay no
		// longer offers it).
		if (choice === "approve" || choice === "compact") {
			await compactBeforeApply(ctx, chosen.changeId);
			choice = "approve";
		}

		if (choice === "refine") {
			const feedback = ctx.ui.input ? await ctx.ui.input("What should change?") : undefined;
			if (!feedback) {
				ctx.ui.notify("No feedback given — nothing changed.", "info");
				continue;
			}
			ctx.ui.notify(`Revising "${chosen.changeId}"...`, "info");
			const refineFired = await withPhaseModel(pi, ctx, "propose", phaseModels, () =>
				spendTurn(
					pi,
					ctx,
					budget,
					"Refine",
					refineTurnPrompt(chosen.changeId, feedback, snapshot.validated.issues.map((i) => `${i.file}: ${i.problem}`)),
				),
			);
			if (!refineFired) return;
			await appendContext(ctx.cwd, chosen.changeId, "Refine", `User feedback: ${feedback}`);
			continue; // loop back: re-validate and show the panel/gate again
		}

		// "approve". Runs its own inner loop around Apply so a missing-verification
		// re-run just fires Apply again — it does not send the user back through the main gate
		// (Approve & Execute / Refine / Discard) to re-approve something already approved.
		await markApproved(chosen);
		ctx.ui.notify(`Approved. Implementing "${chosen.changeId}"...`, "info");

		let verification: Awaited<ReturnType<typeof checkTaskVerification>>;
		applyLoop: for (;;) {
			activeVerifyChangeId = chosen.changeId;
			let applyFired: boolean;
			try {
				applyFired = await withPhaseModel(pi, ctx, "apply", phaseModels, () =>
					spendTurn(pi, ctx, budget, "Apply", applyTurnPrompt(chosen.changeId)),
				);
			} finally {
				activeVerifyChangeId = undefined;
			}
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
		const reviewFired = await withPhaseModel(pi, ctx, "review", phaseModels, () =>
			spendTurn(pi, ctx, budget, "Code review", codeReviewTurnPrompt(chosen.changeId)),
		);
		if (!reviewFired) return;
		const reviewContent = await readReview(ctx.cwd, chosen.changeId);
		await appendContext(
			ctx.cwd,
			chosen.changeId,
			"Code review",
			reviewContent ? "REVIEW.md written — see file for findings." : "Code review turn ran but REVIEW.md is empty or missing.",
		);

		if (reviewContent) {
			ctx.ui.setWidget?.("readyset", [`Change: ${chosen.changeId}`, "REVIEW.md:", ...reviewContent.split("\n").slice(0, 8)]);
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
			const baseNotice =
				`Archived to ${result.archivedDir}. Merged into: ${result.mergedSpecFiles.join(", ") || "(no spec files found to merge)"} ` +
				"— this was an append-only merge, not a real ADDED/MODIFIED/REMOVED diff; review the merged spec.";
			if (result.unappliedModifications.length === 0) {
				ctx.ui.notify(baseNotice, "info");
			} else {
				// MODIFIED/REMOVED specifically: the append-only merge did NOT actually change or remove these --
				// the old requirement text is still sitting in the canonical spec, untouched, right next to the
				// appended delta that claims it changed/disappeared. Worth a sharper, itemized warning rather
				// than the same generic notice an ADDED-only archive gets.
				const items = result.unappliedModifications
					.map((u) => `  - ${u.verb}: "${u.requirement}" (in ${u.specFile})`)
					.join("\n");
				ctx.ui.notify(
					`${baseNotice}\n\n⚠ ${result.unappliedModifications.length} requirement(s) below were declared MODIFIED/REMOVED ` +
						"in this change but were only appended, NOT actually changed or removed in the canonical spec -- the " +
						"old text is still there. Manual cleanup needed:\n" +
						items,
					"warning",
				);
			}
		}
		return;
	}
}

/**
 * Shape of `readyset_ask`'s params. Declared explicitly and cast to inside `execute()` because
 * omp's `registerTool` generic infers `Static<TSchema>` as `unknown` for a `pi.zod` schema — a
 * Zod object doesn't map through TypeBox's `TSchema`, so inference falls back to the constraint
 * default even though the runtime value is exactly this shape.
 */
interface ReadysetAskParams {
	questions: {
		id: string;
		question: string;
		header?: string;
		options: { label: string; description?: string }[];
		recommendedIndex?: number;
		multi?: boolean;
	}[];
}

/**
 * Registers `readyset_ask` — the tool `grillTurnPrompt` tells the model to call for every round
 * of grilling questions, instead of writing "❓ Q1 ..." as plain chat text. Presents
 * `ctx.ui.askDialog()`, omp's own native multi-question picker dialog (Interactive mode only —
 * see `grillTurnPrompt`'s doc comment for the plain-chat-text fallback when it's unavailable),
 * and returns the user's picks (or their own typed answer, or "let's discuss instead") back to
 * the model as the tool result so it can decide whether the design tree is settled yet.
 *
 * Enforces `GRILL_ROUND_CAP` in code (see `grillRoundState`'s doc comment) — once the cap is
 * hit, this refuses to open another dialog and tells the model to check in via plain text
 * instead, a real ceiling rather than the prompt-level-only convention grilling used before this
 * tool existed.
 */
function registerAskTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "readyset_ask",
		label: "Readyset: Ask",
		description:
			"Ask the user one round of grilling questions as a real structured picker instead of plain chat text -- " +
			"use this for EVERY round while grilling a Readyset brainstorm. 1-4 questions per call, each with 2+ " +
			"real options (mark your own recommended one via recommendedIndex) plus room for the user to type " +
			"their own answer or ask to discuss instead of picking. Only meaningful during a /readyset grilling " +
			"conversation.",
		parameters: pi.zod.object({
			questions: pi.zod
				.array(
					pi.zod.object({
						id: pi.zod.string().describe("short stable id for this question within the round, e.g. 'q1'"),
						question: pi.zod.string().describe("the question text"),
						header: pi.zod.string().optional().describe("short label shown as a chip, e.g. 'Approach'"),
						options: pi.zod
							.array(
								pi.zod.object({
									label: pi.zod.string(),
									description: pi.zod.string().optional().describe("brief trade-off/context for this option"),
								}),
							)
							.min(2)
							.describe("2 or more real options"),
						recommendedIndex: pi.zod.number().int().min(0).optional().describe("index of your recommended option, if any"),
						multi: pi.zod.boolean().optional().describe("true if more than one option can be selected"),
					}),
				)
				.min(1)
				.max(4)
				.describe("1-4 questions for this round"),
		}),
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { questions: askedQuestions } = params as ReadysetAskParams;
			if (grillRoundState.rounds >= GRILL_ROUND_CAP) {
				return {
					content: [
						{
							type: "text",
							text:
								`Round cap (${GRILL_ROUND_CAP}) reached for this grilling session -- not opening another dialog. ` +
								"Check in with the user in plain chat text instead: summarize what's decided, name what's still " +
								"open, and ask whether to keep grilling or write the brainstorm now with the rest under Open " +
								"Questions.",
						},
					],
				};
			}
			grillRoundState.rounds++;

			if (!ctx.ui.askDialog) {
				return {
					content: [
						{
							type: "text",
							text:
								"The structured picker isn't available in this session (non-interactive mode) -- ask this " +
								"round's questions as plain chat text instead, same content and same rules (real options, your " +
								"own recommendation, never accept a passive answer), then wait for the user's next message.",
						},
					],
				};
			}

			const questions: ExtensionAskDialogQuestion[] = askedQuestions.map((q) => ({
				id: q.id,
				question: q.question,
				header: q.header,
				options: q.options,
				multi: q.multi,
				recommended: q.recommendedIndex,
			}));

			let result: ExtensionAskDialogResult | undefined;
			try {
				result = await ctx.ui.askDialog(questions);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `The structured picker failed to open (${reason}) -- ask this round's questions as plain chat text instead.`,
						},
					],
				};
			}

			if (!result) {
				return {
					content: [
						{
							type: "text",
							text:
								"The user closed the picker without answering. Ask them directly in plain chat what they'd " +
								"like to do -- keep grilling, or stop here.",
						},
					],
				};
			}

			if (result.kind === "chat") {
				return {
					content: [
						{
							type: "text",
							text:
								"The user chose to discuss this round in plain chat instead of picking from the options -- " +
								"continue the conversation normally and wait for their next message before calling " +
								"readyset_ask again.",
						},
					],
				};
			}

			const lines = result.results.map((r) => {
				const picked = r.customInput
					? `their own answer: "${r.customInput}"`
					: r.selectedOptions.length > 0
						? r.selectedOptions.join(", ")
						: "(no option picked)";
				return `- ${r.question} -> ${picked}${r.note ? ` (note: ${r.note})` : ""}${r.timedOut ? " [timed out]" : ""}`;
			});
			return { content: [{ type: "text", text: `User's answers this round:\n${lines.join("\n")}` }] };
		},
	});
}

/**
 * Which Readyset change `readyset_verify` should attach evidence to. Module-level, same
 * trade-off `grillRoundState` documents above: `registerTool`'s `execute()` has no per-run
 * channel for extension-local state, only `ctx`, and evidence needs to know which
 * `readyset/changes/<id>/` to write into — a concept Readyset owns, not omp. Set right before
 * an Apply turn fires (see the `applyLoop` call site below) and cleared once that turn
 * finishes, so a `readyset_verify` call outside an active Apply turn gets a clear "not
 * currently applicable" result instead of silently writing evidence to a stale change. Not
 * designed for two concurrent Apply turns in the same process — an accepted limitation, not a
 * real scenario this single-session tool needs to guard against.
 */
let activeVerifyChangeId: string | undefined;

/** Shape of `readyset_verify`'s params — see `ReadysetAskParams` for why this is declared and
 *  cast to rather than inferred from the `pi.zod` schema passed to `registerTool`. */
interface ReadysetVerifyParams {
	taskId: string;
	command: string;
}

/**
 * Registers `readyset_verify` — a runtime evidence *collector*, not a correctness judge.
 *
 * What it does, and only this: runs a command (real `node:child_process`, see
 * `readyset-evidence.ts`'s `runCommand` doc comment for why `shell: true` and why there's no
 * OMP execution mechanism to reuse instead), captures the REAL exit code/stdout/stderr/
 * duration, and persists it as an immutable evidence record tied to a `taskId`
 * (`readyset/changes/<id>/evidence/E<NNN>.md`).
 *
 * What it deliberately does NOT do, on purpose, per the locked v1 scope: mark a task `[x]`,
 * modify `_Verified:`, decide correctness, infer requirement satisfaction, perform semantic
 * review, or become a general verification engine. `_Verified:` (the model's own prose note,
 * checked structurally by `checkTaskVerification` in readyset-spec.ts) is UNCHANGED and stays
 * exactly as load-bearing as before — this tool runs alongside it, not instead of it. The
 * shape is:
 *
 *   readyset_verify() -> EvidenceRecord -> task references evidence -> Review interprets evidence
 *
 * never:
 *
 *   readyset_verify() -> "task is correct"
 *
 * `npm test` exiting 0 means "npm test executed successfully" — it does NOT mean "the
 * implementation satisfies the requirement." A command that runs clean but tests the wrong
 * thing is exactly as "verified" by this tool as one that actually covers the requirement;
 * judging that distinction stays the separate Code-review turn's job, same as before this
 * tool existed.
 *
 * Approval tier is `"exec"` (command execution) — confirmed against real omp source
 * (`ToolDefinition.approval`'s doc comment: `"exec": code execution`; this is also the
 * default when the field is omitted, set explicitly here to self-document rather than rely on
 * the default silently). This goes through the SAME approval gate as any other write/exec
 * tool call — `tools.approvalMode` in the user's own config governs it exactly like it
 * governs the model's ordinary bash tool, per the same reasoning `grillRoundState`'s doc
 * comment above lays out for `ctx.ui` dialogs (except this genuinely is a permission-gated
 * tool call, not a UI dialog, so approval mode DOES apply here — this is real command
 * execution, deliberately not exempted from it).
 *
 * Self-reported `_Verified:` and runtime-captured evidence are two independent signals and
 * this tool never reconciles them — see the "Evidence" review section and the
 * `findEvidenceConflicts` call in `takeReviewSnapshot` for where a mismatch (task marked done,
 * latest evidence shows failure) is surfaced. v1 keeps that passive/observational only (a line
 * in the review panel), not a blocking gate — see the package README/doc comments for why.
 *
 * `applyTurnPrompt` is deliberately NOT changed to mention or encourage this tool in v1 — the
 * point of this iteration is to observe whether the model reaches for it naturally once it
 * exists, not to force it via prompt instruction.
 */
function registerVerifyTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "readyset_verify",
		label: "Readyset: Verify",
		description:
			"Run a command and capture its REAL execution result (exit code, stdout, stderr, duration) as an " +
			"immutable evidence record tied to a task -- for use during Apply, when you want a machine-captured " +
			"record instead of just writing a `_Verified:` note yourself. This does NOT mark the task done, does " +
			"NOT modify tasks.md or `_Verified:`, and does NOT judge correctness -- a captured exitCode 0 means " +
			"the command ran and exited cleanly, not that the requirement is satisfied. You still update " +
			"tasks.md and write your own `_Verified:` note (referencing the evidence id this returns is a good " +
			"idea, but not required). Only meaningful during Apply, against the task currently being implemented.",
		parameters: pi.zod.object({
			taskId: pi.zod.string().describe("the task's id exactly as it appears in tasks.md (e.g. '2.1')"),
			command: pi.zod.string().describe("the command to run, exactly as you'd type it in a shell -- pipes/&&/redirects are fine"),
		}),
		approval: "exec",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { taskId, command } = params as ReadysetVerifyParams;
			const changeId = activeVerifyChangeId;
			if (!changeId) {
				return {
					content: [
						{
							type: "text",
							text:
								"readyset_verify isn't attached to an active Apply turn right now, so there's nowhere to record " +
								"this evidence. If you're implementing a task this turn, that's unexpected -- otherwise just run " +
								"the command directly instead of through this tool.",
						},
					],
				};
			}

			const cwd = (ctx as unknown as ReviewCtx).cwd;
			const startedAt = new Date().toISOString();
			const result = await runCommand(command, cwd, EVIDENCE_TIMEOUT_MS);
			const stdoutCap = truncateForCapture(result.stdout, EVIDENCE_MAX_OUTPUT_BYTES);
			const stderrCap = truncateForCapture(result.stderr, EVIDENCE_MAX_OUTPUT_BYTES);

			const record = await persistEvidence(cwd, changeId, {
				taskId,
				command,
				cwd,
				startedAt,
				durationMs: result.durationMs,
				exitCode: result.exitCode,
				timedOut: result.timedOut,
				signal: result.signal,
				stdout: stdoutCap.text,
				stderr: stderrCap.text,
				stdoutTruncated: stdoutCap.truncated,
				stderrTruncated: stderrCap.truncated,
			});

			const outcome = result.timedOut
				? `timed out after ${Math.round(EVIDENCE_TIMEOUT_MS / 1000)}s`
				: result.exitCode === null
					? "did not produce an exit code (process error -- see stderr in the evidence record)"
					: `exited ${result.exitCode}`;

			return {
				content: [
					{
						type: "text",
						text:
							`Evidence ${record.id} recorded for task ${taskId}: \`${command}\` ${outcome} in ` +
							`${result.durationMs}ms. This is a runtime-captured EXECUTION RESULT ONLY -- it does not by itself ` +
							"mean the task is done or the requirement is satisfied. You still need to update tasks.md and " +
							`write your own _Verified: note yourself (mentioning ${record.id} there is a good idea, but this ` +
							"tool never touches tasks.md itself).",
					},
				],
			};
		},
	});
}

export interface ReadysetArgs {
	all: boolean;
	fast: boolean;
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
 * `--idea` consumes every remaining token joined back with single spaces, so a raw idea needs no
 * quoting and can't be followed by other flags (which is why `--lang` must come before it).
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
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--all") parsed.all = true;
		else if (token === "--fast") parsed.fast = true;
		else if (token === "--lang") parsed.lang = tokens[i + 1];
		else if (token === "--model") parsed.model = tokens[i + 1];
		else if (token === "--fallback-model") parsed.fallbackModel = tokens[i + 1];
		else if (token === "--phase-model") {
			// `--phase-model <phase>=<spec>` (e.g. `--phase-model explore=cliproxy/glm-5.2`);
			// repeatable, one phase per flag. Unknown phases are rejected at use time, not
			// here, so a typo degrades to a warning rather than silently changing behavior.
			const pair = tokens[i + 1] ?? "";
			const eq = pair.indexOf("=");
			if (eq > 0) {
				phaseModels.push({ phase: pair.slice(0, eq).toLowerCase(), model: pair.slice(eq + 1) });
				i++;
			}
		}
		else if (token === "--idea") {
			const rest = tokens.slice(i + 1).join(" ").trim();
			if (rest !== "") parsed.idea = rest;
			break;
		}
	}
	if (phaseModels.length > 0) parsed.phaseModels = phaseModels;
	return parsed;
}

export default function (pi: ExtensionAPI) {
	registerAskTool(pi);
	registerVerifyTool(pi);
	pi.registerCommand("readyset", {
		description:
			"Readyset: propose + review + execute a brainstorm against real repo state, standalone — no /plan or external CLI required " +
			"(flags: --all, --fast, --idea <raw idea text> to grill a new brainstorm from scratch, --lang <language> to open " +
			"grilling's discussion in that language from round 1 (must come before --idea), --model <spec> to pin a model " +
			"for this run's turns, --fallback-model <spec> if the pin fails to apply)",
		handler: async (args, ctx) => {
			// `args` is the raw string omp hands a registered command (see parseReadysetArgs).
			const parsedArgs = parseReadysetArgs(args);
			const showAll = parsedArgs.all;
			const includeFast = parsedArgs.fast;

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
			const langFromFlag = parsedArgs.lang;
			const resolvedConfigLanguage = langFromFlag ? undefined : await readPreferredLanguage();
			const preferredLanguage = langFromFlag ?? resolvedConfigLanguage?.language;

			// --idea skips the picker entirely: everything after it is joined back into the raw idea
			// text (so it need not be quoted as a single arg), and grilling starts immediately. Must
			// come last among flags on the command line.
			const ideaFromFlag = parsedArgs.idea ?? "";
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
			// --phase-model <phase>=<spec> (repeatable) or readyset.model.phases.<phase> in config
			// overrides the pinned model for one phase only (grill|explore|propose|apply|review).
			// The run's pinned model is restored between phases. An override that fails to pin
			// warns and falls back to the run default — a phase model is a cost optimization, not
			// a correctness requirement, so it must never stop the run.
			//
			// --fallback-model <spec> (a single spec, not a chain) or readyset.model.fallbackChains
			// (an ordered list, tried in turn until one pins — legacy readyset.fallbackModel still
			// works too, as a one-element chain) is tried if pinning the resolved model above fails
			// outright (a bad/retired spec) — see withPinnedModel's doc comment for why this is
			// narrower than, and doesn't replace, omp's own retry.fallbackChains.
			const modelFromFlag = parsedArgs.model;
			const resolvedConfigModel = modelFromFlag ? undefined : await readPinnedModel();
			const pinnedModel = modelFromFlag ?? resolvedConfigModel?.model;
			const pinnedModelSource = modelFromFlag ? "--model flag" : (resolvedConfigModel?.source ?? "");

			const resolvedConfigPhases = await readPhaseModels();
			const phaseModelOverrides = new Map<string, { model: string; source: string }>();
			for (const e of resolvedConfigPhases.entries) {
				if (!phaseModelOverrides.has(e.phase)) phaseModelOverrides.set(e.phase, { model: e.model, source: e.source });
			}
			for (const e of parsedArgs.phaseModels ?? []) {
				phaseModelOverrides.set(e.phase, { model: e.model, source: "--phase-model flag" });
			}

			const fallbackFromFlag = parsedArgs.fallbackModel;
			const resolvedConfigFallback = fallbackFromFlag ? undefined : await readFallbackChain();
			const fallbackChain = fallbackFromFlag ? [fallbackFromFlag] : (resolvedConfigFallback?.chain ?? []);
			const fallbackChainSource = fallbackFromFlag ? "--fallback-model flag" : (resolvedConfigFallback?.source ?? "");

			await withPinnedModel(pi, reviewCtx, pinnedModel, pinnedModelSource, fallbackChain, fallbackChainSource, async () => {
				if (isProposed(chosen.status)) {
					await reviewAndMaybeExecute(pi, reviewCtx, chosen, budget, phaseModelOverrides);
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

				// Consumed here, one-shot -- see grillRoundState's doc comment for exactly what this
				// does and doesn't attest to.
				const grillingSkippedAsking = grillRoundState.active && grillRoundState.rounds === 0;
				grillRoundState.active = false;

				if (!contentCheck.ok || grillingSkippedAsking) {
					const issues: string[] = [];
					if (!contentCheck.ok) {
						// contentCheck.summary carries the "(structural check)" label deliberately -- same
						// wording validateChange uses below in the review gate, so neither reads as a
						// stronger guarantee than it actually is just because of how it's phrased here.
						const gapList = contentCheck.issues.map((i) => `${i.section} (${i.problem})`).join("; ");
						issues.push(`${contentCheck.summary}: ${gapList}`);
					}
					if (grillingSkippedAsking) {
						issues.push(
							"grilling was started this session but readyset_ask was never called before the brainstorm " +
								"was written -- the model may have answered every question itself instead of asking you",
						);
					}
					const proceed = await reviewCtx.ui.select(
						`${issues.join(". ")}.`,
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
				const exploreBudget = startPhaseBudget();
				const exploreFired = await withPhaseModel(pi, reviewCtx, "explore", phaseModelOverrides, () =>
					spendTurn(pi, reviewCtx, budget, "Explore", exploreTurnPrompt(chosen, submodules)),
				);
				if (!exploreFired) return;

				const explored = await hasExploration(ctx.cwd, chosen.changeId);
				await appendContext(
					ctx.cwd,
					chosen.changeId,
					"Explore",
					(explored
						? `EXPLORATION.md written. ${submodules.length} submodule(s) known from .gitmodules: ${submodules.map((s) => s.name).join(", ") || "(none)"}.`
						: "Explore turn ran but EXPLORATION.md is empty or missing — Propose will still run, but without grounded findings to lean on.") +
						` (phase wall time: ${Math.round(phaseBudgetElapsedMs(exploreBudget) / 1000)}s of ${Math.round(exploreBudget.maxMs / 1000)}s budget.)`,
				);
				if (phaseBudgetExceeded(exploreBudget)) {
					ctx.ui.notify(
						`Explore for "${chosen.changeId}" hit its phase budget without finishing — continuing anyway since ` +
							`${explored ? "EXPLORATION.md exists" : "Propose can still run ungrounded"}. Re-run /readyset to continue with a fresh budget if this stalls.`,
						"warning",
					);
				}
				if (!explored) {
					ctx.ui.notify(
						`Exploration for "${chosen.changeId}" didn't produce EXPLORATION.md — continuing to Propose anyway, but its ` +
							"grounding will be weaker than usual. Check the transcript above.",
						"warning",
					);
				}

				ctx.ui.notify(`Proposing change "${chosen.changeId}" — this can take a while...`, "info");
				const proposeBudget = startPhaseBudget();
				const proposeFired = await withPhaseModel(pi, reviewCtx, "propose", phaseModelOverrides, () =>
					spendTurn(pi, reviewCtx, budget, "Propose", proposeTurnPrompt(chosen)),
				);
				if (!proposeFired) return;
				// Gate invariant (R2): a planning turn may only leave planning artifacts. The
				// T11/T12 benchmark runs implemented the change out of the Propose turn and
				// archived it themselves, shipping with no approval. That is checked here —
				// structurally, from the working tree — before the gate is ever offered.
				const violations = await checkPhaseViolations(
					ctx.cwd,
					chosen.changeId,
					await changedPathsSinceBaseline(ctx.cwd).catch(() => []),
				);
				if (violations.length > 0) {
					await appendContext(
						ctx.cwd,
						chosen.changeId,
						"Propose",
						`STOPPED — planning turn wrote outside its boundary: ${violations
							.map((v) => `${v.path} (${v.detail})`)
							.join("; ")}. No review gate is offered for this state.`,
					);
					ctx.ui.notify(
						`Stopped: the Propose turn for "${chosen.changeId}" changed files outside the change ` +
							`directory (${violations.map((v) => v.path).join(", ")}). Readyset never implements without approval, ` +
							"so no review gate is offered — revert those files (or move them into the change dir) and run /readyset again.",
						"error",
					);
					return;
				}
				await appendContext(
					ctx.cwd,
					chosen.changeId,
					"Propose",
					`Propose turn ran; see proposal.md/design.md/specs/tasks.md. (phase wall time: ${Math.round(phaseBudgetElapsedMs(proposeBudget) / 1000)}s of ${Math.round(proposeBudget.maxMs / 1000)}s budget.)`,
				);
			if (phaseBudgetExceeded(proposeBudget)) {
				ctx.ui.notify(
					`Propose for "${chosen.changeId}" hit its phase budget (${Math.round(proposeBudget.maxMs / 60000)} min) — the artifacts exist but the turn ran long. ` +
						"Continuing to the gate; runaway cost like this is recorded in CONTEXT.md so you can see it.",
					"warning",
				);
			}

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

			await reviewAndMaybeExecute(pi, reviewCtx, after, budget, phaseModelOverrides);
		});
		},
	});
}
