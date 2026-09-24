import type { ExtensionAPI, ExtensionAskDialogQuestion, ExtensionAskDialogResult, ExtensionUISelectOption } from "@oh-my-pi/pi-coding-agent";
import {
	BRAINSTORM_DIR,
	type BrainstormMeta,
	changeState,
	isProposed,
	type Lane,
	loadBrainstorms,
	markApproved,
	parseFrontmatter,
	reconcileStatuses,
	readClaritySignal,
	recommendLane,
	validateBrainstormContent,
} from "../lib/readyset-brainstorm.ts";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join, relative } from "node:path";
import {
	appendContext,
	appendPhaseEvent,
	archiveChange,
	changePaths,
	checkPhaseViolations,
	checkScope,
	checkScopeRefs,
	checkTaskVerification,
	ensureDirtyBaseline,
	ensureReadysetRoot,
	brainstormRequestText,
	findDocFileWarnings,
	findMissingRequestedDocs,
	findSpecFiles,
	getProgress,
	hasBeenApplied,
	hasExploration,
	listSubmodules,
	type PhaseEvent,
	type PhaseName,
	readAssumedScenarios,
	readDirtyBaseline,
	readContext,
	readPhaseEvents,
	readChangeLane,
	readArtifactSizes,
	type ArtifactSizes,
	type ChangeLane,
	readOpenDecisions,
	readAssumptions,
	readReview,
	type OpenDecision,
	readScopeContract,
	readScopeDeviations,
	READYSET_ROOT,
	type ScopeDeviation,
	scaffoldChange,
	validateChange,
} from "../lib/readyset-spec.ts";
import {
	DEFAULT_ARTIFACT_BUDGETS,
	DEFAULT_COMPACT_MIN_CONTEXT_PERCENT,
	DEFAULT_REVIEW_THRESHOLDS,
	type ArtifactBudgets,
	type LaneDefault,
	readArtifactBudgets,
	readCompactMinContextPercent,
	readFallbackChain,
	readLaneDefault,
	readPhaseModels,
	readPinnedModel,
	readPreferredLanguage,
	readReviewFullLane,
	readReviewMode,
	readReviewThresholds,
	readScopeProtectedPaths,
	readTestPaths,
	type ParsedReviewThresholds,
	type ReviewFullLane,
	type ReviewMode,
} from "../lib/readyset-omp-config.ts";
import { matchesAnyGlob } from "../lib/readyset-glob.ts";
import {
	evaluateReviewTriggers,
	type ReviewTriggerInput,
	type ReviewTriggerResult,
} from "../lib/readyset-review-trigger.ts";
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
 * /readyset — Readyset's core command: grill a brainstorm, propose a change against real repo
 * state, and hold it at the Review Gate until a human approves it. Execution itself is handed
 * off to core omp; the code review and the archive offer stay here, on demand.
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
 *   on, and code review is its own turn with adversarial framing, writing REVIEW.md — not a
 *   fresh session, which omp's extension API does not offer, and not the same turn that wrote
 *   the code grading itself. It runs on demand (`/readyset --review <change-id>`) against the
 *   applied change rather than automatically after Apply, because execution itself now belongs
 *   to core omp. CONTEXT.md logs every phase
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
 * need judgment (writing proposal/design/spec/tasks) go through a triggered agent turn, which
 * is told the exact file paths and section shapes to use so it doesn't need any CLI either.
 * Implementation is not one of those steps any more: the gate dispatches the apply prompt into
 * core omp via `pi.sendUserMessage` and returns, so the executing turn is a normal omp turn
 * with subagents, parallelism, and live task updates rather than one this extension babysits.
 *
 * Review "screen": omp's extension API has no full-screen custom view (confirmed against
 * upstream docs — dialogs are limited to select/confirm/input/editor, plus a 10-line
 * setWidget panel). This uses setWidget as a persistent summary panel and ctx.ui.select
 * for the decision — the closest a third-party extension can get, not a recreation of
 * /plan's native Plan Review surface.
 */

/** One line, injected into every phase prompt and mirrored verbatim in src/skill/SKILL.md. Shared
 *  from this single constant so the wording cannot drift between phases. */
export const STAY_IN_REPO_RULE =
	"Work only inside the current repository (the working directory). Never search or read outside it " +
	"(no `find /`, no absolute paths outside the repo, no home-directory files, logs or notes), and never " +
	"inspect Readyset's own implementation, package or configuration. They are not part of the task.";

/** Appends the rule as the last paragraph of a phase prompt. */
const withRepoRule = (prompt: string): string => `${prompt}\n\n${STAY_IN_REPO_RULE}`;

const ARTIFACT_GUIDE_HEADER = `Write proposal.md with a YAML frontmatter block whose first line is \`lane: full\` or \`lane: fast\` matching this run's lane, then the required sections below.

Write exactly these files under readyset/changes/<id>/ (create directories as needed):
`;

const PROPOSAL_GUIDE_BULLET = `- proposal.md — must have a "## Why" section (1-2 paragraphs on the problem), a
  "## What Changes" section (bullet list of concrete changes), and a "## Files This Change
  Will Touch" section: an exhaustive repo-relative path list of every existing file Apply is
  allowed to modify plus every new file it may create. Mark each new file with a trailing
  "(new)" (e.g. "- src/lib/thing.ts (new)") so the gate can tell a file the change creates from
  one that must already exist — an unmarked path that doesn't exist is a dangling reference and
  gets flagged. Mark a file this change deletes with "(delete)" (e.g. "- src/legacy.ts (delete)");
  it must exist before Apply and is allowed to be gone afterward. This is the scope contract the gate
  and Apply are checked against — keep it tight (benchmark: readyset diffs ran 2x the plan
  arm's, and T12 grew an unasked-for 160-line bench file). List the minimum set of files
  the change actually needs — nothing speculative. A file not on this list may not
  be written during Apply without asking first. Every doc the user or brainstorm explicitly asked for
  must be in this contract — list it, marking a new file "(new)". For bugfix or refactor tasks, do
  NOT add or touch documentation files (README, docs) unless explicitly requested. Never cite
  nonexistent file paths with extensions like \`CHANGELOG.md\` when stating absence (write "no changelog entry",
  not "no CHANGELOG.md"), or the grounding scanner flags it as a dangling reference.
  Migration/release-note/deprecation mentions join the contract only when they match an existing file.
  Also add a \`## Open Decisions\` section (one \`### question\` block as specified in the prompt
  above, or the single line "none") and a \`## Assumptions\` section (one \`- <assumed decision> —
  <chosen behavior>\` line per brainstorm \`## Assumed\` item, or "none").`;

const FULL_LANE_GUIDE_BULLETS = `- design.md — "## Context", "## Goals / Non-Goals", "## Decisions" (numbered, each with
  Rationale and Alternatives considered), "## Risks / Trade-offs".
- specs/<capability-slug>/spec.md — "## Purpose", then "## ADDED Requirements" with one
  or more "### Requirement: <name>" blocks, each followed by one or more
  "#### Scenario: <name>" blocks written as:
    - **WHEN** <trigger>
    - **THEN** <observable outcome>
  Use MODIFIED/REMOVED Requirements sections instead of ADDED when changing or removing
  existing behavior already covered by an existing spec.`;

const FAST_LANE_ACCEPTANCE_GUIDE = `List every acceptance scenario under \`## Acceptance\` in proposal.md as
"- **WHEN** ... **THEN** ...", one per bullet, and give it an id in the form \`[S1]\`, \`[S2]\`,
... in document order; tasks.md references those ids.`;
const TASKS_GUIDE_BULLET = `- tasks.md — numbered sections, each task a "- [ ] N.M <description>" checkbox line with
  a verification note. Each task must map to an acceptance scenario (the fast lane's
  \`## Acceptance\` ids, or a spec scenario on the full lane); do NOT add
  "cleanup"/"improve"/refactor tasks the request didn't ask for. If you change a file outside
  the scope contract during Apply, record it under a "## Scope deviations" section here as
  "- <path> — <reason>". Mark a task that pins an (assumed) scenario's behavior with "(assumed)"
  in its description.`;

/** Builds the artifact guide for a run's lane and resolved budgets. The full lane lists all
 *  four artifacts; the fast lane lists only proposal.md and tasks.md (no design.md, no spec
 *  delta) and folds the acceptance scenarios into proposal.md's `## Acceptance` section. Both
 *  lanes end with the character budgets and the no-restating rules. */
function artifactGuide(lane: ChangeLane, budgets: ArtifactBudgets): string {
	const budgetOf = (n: number) => (Number.isFinite(n) ? String(n) : "unlimited");
	const bullets =
		lane === "fast"
			? [PROPOSAL_GUIDE_BULLET, FAST_LANE_ACCEPTANCE_GUIDE, TASKS_GUIDE_BULLET].join("\n")
			: [PROPOSAL_GUIDE_BULLET, FULL_LANE_GUIDE_BULLETS, TASKS_GUIDE_BULLET].join("\n");

	const budgetLines =
		lane === "fast"
			? [
					`- proposal.md <= ${budgetOf(budgets.proposal)}`,
					`- tasks.md <= ${budgetOf(budgets.tasks)}`,
				]
			: [
					`- proposal.md <= ${budgetOf(budgets.proposal)}`,
					`- design.md <= ${budgetOf(budgets.design)}`,
					`- specs/** total <= ${budgetOf(budgets.specs)}`,
					`- tasks.md <= ${budgetOf(budgets.tasks)}`,
				];

	return (
		ARTIFACT_GUIDE_HEADER +
		bullets +
		"\n\nBudgets (characters, hard guidance — stay under them):\n" +
		budgetLines.join("\n") +
		"\n\nMinimal diff: never modify seed data, fixtures or sample data in production paths; never add runtime self-checks/assertions to production code; never change an existing test's expectations unless the requested behavior changes them.\n" +
		"\nDo not restate another artifact's content:\n" +
		(lane === "fast"
			? ""
			: "- design.md explains decisions and risks only; never re-list `## What Changes`.\n") +
		"- tasks.md references scenario ids (`[S1]`, `[S2]`, ... assigned in order in the\n" +
		"  `## Acceptance` section) instead of restating their WHEN/THEN text.\n" +
		"- No prose summary of proposal.md" +
		(lane === "fast" ? "" : ", design.md, or specs/") +
		" inside any other artifact.\n\n" +
		"Write about the user's repo and request only. Never mention Readyset's own workflow (lanes, the " +
		"review gate, phase names, `readyset/changes/…` paths, spec deltas, this extension or its source), " +
		"and never a benchmark or task-definition file. Grounding anchors — exploration entry numbers or a " +
		`"verified during planning" note — go in a trailing \`## Grounding\` section at the end of each ` +
		"artifact, so the body stays about the change; the compiled review document still shows them."
	);
}

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
export function exploreTurnPrompt(b: BrainstormMeta, submodules: { name: string; path: string }[]): string {
	const paths = changePaths("", b.changeId);
	const submoduleLine =
		submodules.length > 0
			? `\n\nThis repo has ${submodules.length} git submodule(s) declared in .gitmodules — account for EVERY one of them ` +
				`by name in your findings, even if a given submodule turns out to be unaffected by this change (say so explicitly, ` +
				`don't just omit it):\n` +
				submodules.map((s) => `  - ${s.name} (path: ${s.path})`).join("\n")
			: "";
	return withRepoRule(
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

/**
 * Fast-lane constraints, appended to the Propose prompt when the run's lane is fast. The
 * baseline is explicit: the benchmark showed a 20-line change getting 3 grilling rounds, a
 * 25KB EXPLORATION.md, ~80KB of planning docs, 23 tasks, and a mutation-testing review.
 * Fast lane trims volume — Explore folded into Propose (no separate turn), at most ~8
 * tasks, review without mutation testing — but never the behavior-affecting questions:
 * grilling still asks them, and the T01/T10 wins came from exactly those questions.
 */
function fastLaneProposeSuffix(): string {
	return (
		"\n\nThis run is on the FAST lane: keep the planning tight. Explore was folded into this " +
		"turn (no separate EXPLORATION.md turn ran), so ground the key facts yourself with a few " +
		"targeted reads and note them inline. Write at most ~8 tasks, each independently " +
		"verifiable. Do not pad proposal/design/specs beyond what the change needs — a short " +
		"change gets a short plan. Behavior-affecting ambiguities are NOT trimmed: if the " +
		"brainstorm left one open, decide it here with a stated reason or carry it forward " +
		"explicitly, never silently. Run the same edge-case checklist grilling uses " +
		"(empty/case/boundaries/errors/compat/docs/verification) against your own grounding reads, " +
		"and decide each item; record every decision that changes behavior under the brainstorm's " +
		"`## Assumed` (or the proposal's `## Assumptions`)."
	);
}

export function proposeTurnPrompt(b: BrainstormMeta, lane: ChangeLane = "full", budgets: ArtifactBudgets = DEFAULT_ARTIFACT_BUDGETS.full): string {
	const paths = changePaths("", b.changeId);
	return withRepoRule(
		`Create a Readyset change named "${b.changeId}" from the brainstorm at ${b.file}. ` +
		`Read the brainstorm fully first, then read ${paths.exploration} — it holds this change's grounding findings, ` +
		"already checked against real repo state in a prior turn. Do not re-derive or contradict it; every claim in " +
		"proposal.md/design.md that touches something EXPLORATION.md covered should point back to that finding, not restate " +
		"a fresh guess.\n\n" +
		"If you need a fact this change depends on and EXPLORATION.md doesn't cover it — a submodule's gitlink vs. its " +
		"checked-out commit, an extra config file, anything load-bearing to a Decision or a blocking task — you may check " +
		"it yourself with a real command, but three things are not optional: (1) never write 'EXPLORATION.md recorded/found " +
		"this' for something EXPLORATION.md does not actually contain — say 'verified during planning' instead, so the " +
		"provenance in proposal.md/design.md/tasks.md is never false; (2) append what you checked and found to " +
		`${paths.exploration} itself (a new '## Additional findings (Propose turn)' section, same one-entry-per-thing-` +
		"checked format Explore used), so the next person reading EXPLORATION.md sees the complete grounding trail, not " +
		"just what the Explore turn happened to cover; (3) anchor every repo claim in proposal.md/design.md to a " +
		"numbered exploration entry or a 'verified during planning' note — file:line, helper name, test name — " +
		"under a trailing `## Grounding` section in that artifact rather than inline, " +
		"so a reviewer can check each claim without re-reading the repo. An unanchored claim about the repo is " +
		"indistinguishable from a guess, and the benchmark measured such plans as no better grounded than a " +
		"single read-only pass.\n\n" +
		artifactGuide(lane, budgets) +
		"\n\nCarry over the brainstorm's Decision, Seam, Scope and Acceptance Criteria (keep the criteria as WHEN/THEN " +
		"scenarios), and use its Spec Impact section to shape the delta specs. Do not reopen options the brainstorm " +
		"already decided. Instead:\n" +
		"(1) Answer every Open Question the repo, the brainstorm, or a web lookup can settle — look it up and " +
		"answer it. (2) Anything still undecided goes into a new `## Open Decisions` section of proposal.md, " +
		"one item per decision, in exactly this shape:\n" +
		"    ### <the question>\n" +
		"    - Options: <option A> | <option B> | ...\n" +
		"    - Recommended: <the option you recommend, and one line of why>\n" +
		"    - Changes per option: <what in this plan changes if each option is chosen>\n" +
		"(3) Nothing may be left \"carried open\" inside design.md, specs/, or tasks.md — an undecided item " +
		"lives in `## Open Decisions` and nowhere else. (4) The brainstorm's `## Assumed` items are decisions, " +
		"not open questions: restate each under a `## Assumptions` section of proposal.md with the concrete " +
		"behavior chosen, so a human can see what was assumed rather than asked. Every assumption that " +
		"changes behavior gets its own WHEN/THEN scenario, marked \"(assumed)\" in the scenario's name or " +
		"directly after the THEN (e.g. `#### Scenario: empty sort is default order (assumed)`). An " +
		"assumption with no scenario is a decision the tests cannot see.\n\n" +
		"If EXPLORATION.md surfaced something the brainstorm didn't anticipate (a submodule it didn't mention, a config " +
		"value that's already drifted), fold it into What Changes / tasks.md rather than silently dropping it." +
		"\n\nThe working tree may already be dirty: pre-existing uncommitted changes, stray comments " +
		"(e.g. `// user was editing...`, `// user note...`), and untracked files are the user's ACTIVE work " +
		"in progress, not leftovers. NEVER propose cleaning up, removing, or deleting them, and never add an " +
		"untouched dirty or untracked file to `## Files This Change Will Touch` just to tidy it — the " +
		"contract names files this change writes, not files that merely exist. Plan to edit AROUND them: " +
		"read the current file content and make your change fit it, leaving every pre-existing comment and " +
		"uncommitted hunk exactly as you found it.\n\n" +
		"Scope discipline: do NOT invent secondary systems that were not requested. If a task asks " +
		"for rate limiting, throttling, or grouping by a key/header (e.g. `x-api-key`) or by IP, treat that " +
		"key strictly as a bucket-identifier string used to group requests — do NOT implement key " +
		"validation, key registries, key lookup, or 401 UNAUTHORIZED responses unless authentication was an " +
		"explicit requirement. When in doubt, leave it out; an unrequested auth layer is a scope violation, " +
		"not thoroughness.\n\n" +
		"Bugfix and refactor doc boundary: if this change is a bugfix, refactor, or chore, NEVER touch " +
		"documentation files (`README.md`, `CHANGELOG.md`, `docs/*`) or add them to `## Files This Change Will Touch` " +
		"unless documentation was explicitly requested in the prompt. Do not invent doc updates for code fixes.\n\n" +
		"Negative plan grounding rule: every path mentioned in proposal.md, design.md, or tasks.md is parsed by " +
		"the grounding validator. When stating that something will NOT be changed or does not exist (e.g. no changelog, " +
		"no version bump, no new test files), NEVER write file names with extensions like `CHANGELOG.md` or `README.md` " +
		"or paths like `src/...` if that file does not exist in the repo. Mentioning a non-existent file name with an " +
		"extension — even when stating absence (e.g. 'no CHANGELOG.md') — flags it as a dangling plan reference. Write " +
		"'no changelog entry', 'no version bump', or 'no docs update' without file extensions.\n" +
		"Do not implement code in this turn — planning artifacts only." +
		(lane === "fast" ? fastLaneProposeSuffix() : "")
	);
}

export function refineTurnPrompt(changeId: string, feedback: string, issues: string[], lane: ChangeLane = "full", budgets: ArtifactBudgets = DEFAULT_ARTIFACT_BUDGETS.full): string {
	const issuesLine = issues.length > 0 ? `\n\nStructural check also flagged: ${issues.join("; ")}.` : "";
	return withRepoRule(
		`Revise the Readyset change "${changeId}" under readyset/changes/${changeId}/ per this feedback: ${feedback}` +
		issuesLine +
		"\n\nRead the existing proposal.md/design.md/specs/tasks.md first. " +
		"Keep proposal.md's existing `lane:` frontmatter line unchanged. " +
		artifactGuide(lane, budgets) +
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
export function applyTurnPrompt(changeId: string, openDecisions: OpenDecision[] = []): string {
	const paths = changePaths("", changeId); // relative paths only; cwd prefix stripped for the prompt
	const openDecisionsBlock = openDecisions.length > 0
		? "\n\nThis change was approved with " + openDecisions.length + " open decision(s) still unresolved. For each one below, apply the " +
			"RECOMMENDED option — the user approved on that basis — and record it in a `## Decisions made during Apply` section of tasks.md as " +
			"`- <decision> → <chosen option> → <why>`. Do not invent a different option.\n" +
			openDecisions.map((d) => `- ${d.question} — recommended: ${d.recommended ?? "(none stated)"}`).join("\n")
		: "";
	return withRepoRule(
		"MANDATORY: every task you complete — every `- [ ]` you turn into `- [x]` in " + paths.tasks + " — " +
		"MUST immediately have an indented `  _Verified: <command and result>_` note on the very next line. " +
		"A bare `- [x]` with no such note is a hard failure: the run will stop and send this change back for " +
		"another turn, burning wall-clock time. Never check a box you have not verified and annotated.\n\n" +
		`Implement the Readyset change "${changeId}". Read ${paths.proposal}, ${paths.design}, every ` +
		`specs/**/spec.md under ${paths.specsDir}, and ${paths.tasks} before starting. ` +
		"Loop through pending tasks in tasks.md: make the minimal focused change each task describes, then verify it — run " +
		"the relevant test, hit the endpoint, execute the script, whatever actually exercises the behavior the task " +
		"describes. Only mark a task complete (`- [ ]` -> `- [x]`) once you have a real result to point to, and immediately " +
		"below the checked line add an indented note in this exact format: `  _Verified: <what you ran or checked, and the " +
		"actual result>_` (e.g. `_Verified: ran \\`npm test\\`, 12/12 pass_` or `_Verified: curl'd /health, got 200_`). A task " +
		"with no real way to verify (e.g. a doc-only change) still gets a note explaining why: `_Verified: doc-only, no " +
		"behavior to check_` — never check a box with no note at all. A test that pins behavior decided under an " +
		"`(assumed)` scenario must say so in its name or an adjacent comment (e.g. `it(\"empty sort returns default " +
		"order (assumed)\")`), so a reader can tell a spec-mandated expectation from an assumed one.\n\n" +
		"Pause and ask if a task is unclear, needs scope beyond what the spec describes, or you hit an error or blocker — " +
		"never silently narrow or drop specified behavior, and never check a box to move on without actually verifying it. " +
		"\n\nScope discipline: touch ONLY files named in proposal.md's `## Files This Change Will Touch` " +
		"contract — you may create a `(new)` file and remove a `(delete)` file. Do NOT refactor, rename, " +
		"reformat, reorder, or rewrite comments in code a task doesn't require; do NOT add new helper " +
		"modules, scripts, benchmarks, or docs beyond what the contract lists, and every doc the contract " +
		"lists must be updated — a contract doc left untouched is a dropped requirement, not a saving. For " +
		"tests, add or modify only " +
		"what exercises the specs' WHEN/THEN scenarios — do not restructure existing tests. Prefer the " +
		"smallest change that satisfies the scenarios. Never modify seed data, fixtures, or sample data in " +
		"production paths unless the request asks for it. Never add runtime self-checks or assertions to " +
		"production code to verify your own change — that belongs in tests. Never change an existing test's " +
		"expectations unless the requested behavior changes them. If a file outside the contract is truly " +
		"required, you may change it, but in the SAME turn record it under `## Scope deviations` in tasks.md as " +
		"`- <path> — <one-line reason>`." +
		"\n\nPre-existing work is not yours to clean up: keep every pre-existing comment, user note " +
		"(e.g. `// user was editing...`, `// user note...`) and uncommitted hunk intact when you edit a " +
		"file — never strip, reword, reformat, or delete a stray comment or a hunk you did not write, and " +
		"never delete or stage away an untracked file that was already there. Edit AROUND it." +
		"Keep going until every task is complete or you are blocked, then report progress as N/M tasks." +
		openDecisionsBlock
	);
}

interface CompactBoundaryResult {
	/** `skipped-keep-context` is never returned by `compactForPhase`; the gate's keep-context
	 *  branch records it directly as the Apply boundary's compact outcome (it skipped compaction
	 *  by the user's own choice, not by mode/threshold). */
	outcome: "compacted" | "skipped-below-threshold" | "skipped-flag" | "skipped-keep-context" | "unavailable" | "failed";
	beforePercent?: number;
	afterPercent?: number;
}

/**
 * Compaction for one phase boundary. Whether it runs is governed by `mode`:
 * - "never":  always skip (the user asked for no compaction).
 * - "always": always compact (0.13.0 behavior).
 * - "auto":   compact only when the host reports context usage at or above `minContextPercent`;
 *             when `getContextUsage` is missing or returns undefined, compact anyway (today's
 *             behavior — we cannot measure, so we do not skip).
 * The summarization runs inside `withPhaseModel(..., phase, ...)` so it uses the phase's own
 * (usually cheaper) model. omp exposes NO compaction-model parameter (verified: CompactOptions
 * has no model field, the session.compacting/session_before_compact results have none, and
 * `compaction.*`/`modelRoles` settings have no model key), so this wrapper is the only supported
 * way to influence the model the summary is produced on. A missing `ctx.compact` or a throw
 * degrades to a plain continue — a cost optimization must never block the run.
 *
 * One outcome in the union, `skipped-keep-context`, is never produced here: the gate's
 * keep-context branch records it directly as the Apply boundary's compact event.
 */
async function compactForPhase(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	phaseModels: Map<string, { model: string; source: string }>,
	phase: "explore" | "propose" | "apply",
	changeId: string,
	phaseLabel: string,
	guidance: string,
	mode: "auto" | "always" | "never",
	minContextPercent: number,
): Promise<CompactBoundaryResult> {
	if (mode === "never") return { outcome: "skipped-flag" };
	if (typeof ctx.compact !== "function") {
		ctx.ui.notify(`Compact isn't available in this context — continuing ${phaseLabel} without it.`, "warning");
		return { outcome: "unavailable" };
	}
	const before = ctx.getContextUsage?.();
	const beforePercent = before?.percent;
	if (mode === "auto" && beforePercent !== undefined && beforePercent < minContextPercent) {
		ctx.ui.notify(
			`Context is at ${beforePercent.toFixed(0)}% (below the ${minContextPercent}% threshold) — skipping the compaction before ${phaseLabel}.`,
			"info",
		);
		return { outcome: "skipped-below-threshold", beforePercent };
	}
	ctx.ui.notify(`Compacting context before ${phaseLabel} for "${changeId}"...`, "info");
	try {
		await withPhaseModel(pi, ctx, phase, phaseModels, () =>
			ctx.compact!({ internalGuidance: guidance, suppressContinuation: true }).then(() => undefined),
		);
	} catch (err) {
		ctx.ui.notify(`Compact failed (${err instanceof Error ? err.message : String(err)}) — continuing without it.`, "warning");
		return { outcome: "failed", beforePercent };
	}
	const after = ctx.getContextUsage?.();
	return { outcome: "compacted", beforePercent, afterPercent: after?.percent };
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
 * Compaction before the Explore turn (the Grill→Explore boundary). Grilling's questions and the
 * user's answers produce the brainstorm file, which is already on disk at `brainstormFile` and is
 * re-read by Explore — the discussion that produced it is not load-bearing for grounding, so it can
 * be summarized away rather than carried forward at full cache-read cost.
 */
function compactBeforeExploreGuidance(changeId: string, brainstormFile: string): string {
	return (
		`Readyset change "${changeId}" is about to start Explore. The brainstorm it works from is ` +
		`persisted at ${brainstormFile} and will be re-read from there — the grilling discussion (including ` +
		"the user's answers) that produced it does not need to be retained. Keep the change id and the " +
		"brainstorm path; the rest of that discussion can be summarized away."
	);
}

/**
 * Compaction before the Propose turn (the Explore→Propose boundary). On the full lane Explore has
 * written `EXPLORATION.md`, which Propose re-reads; on the fast lane Explore is folded into Propose
 * and no such file exists, so only the brainstorm is relied on outside context.
 */
function compactBeforeProposeGuidance(changeId: string, brainstormFile: string, explored: boolean): string {
	const paths = changePaths("", changeId);
	return (
		`Readyset change "${changeId}" is about to start Propose. The brainstorm it works from is persisted ` +
		`at ${brainstormFile}` +
		(explored
			? `, and its grounding findings are persisted at ${paths.exploration} (EXPLORATION.md) — both are ` +
				"re-read from disk when Propose runs, so the Explore turn's discussion does not need to be retained."
			: " — Propose re-reads it from disk, so the prior discussion does not need to be retained.") +
		" Keep the change id and these file paths; the rest of that discussion can be summarized away."
	);
}

/**
 * Code-review turn — new in pipeline v2, fires after every task is done but before the
 * archive offer. This is the mattpocock/skills "review critically in a separate pass"
 * pattern: the same turn that just implemented the change is a poor judge of its own diff
 * (it already believes its choices were right), so review happens as its own turn with an
 * explicitly adversarial framing, writing REVIEW.md rather than silently approving.
 *
 * Deliberately NOT a fresh session: omp's extension API offers no subagent/detached-turn
 * surface (`newSession` swaps the user's live session mid-command — not usable here), so
 * the review turn shares the session context. The adversarial framing and the check-each-
 * WHEN/THEN-against-behavior instruction (see R12 direction in the prompt) are the
 * mitigation, not a claim of independence. Do not re-add "fresh context" wording here
 * without a mechanism that actually provides it.
 */
export function codeReviewTurnPrompt(
	changeId: string,
	lane: "full" | "fast" = "full",
	deviations: ScopeDeviation[] = [],
	triggerResult?: ReviewTriggerResult,
	changedPaths: string[] = [],
): string {
	const paths = changePaths("", changeId);
	const triggerLine = triggerResult && triggerResult.fired.length > 0
		? `This review was triggered by: ${triggerResult.fired.join(", ")}. Focus your findings on these.\n\n`
		: "";
	return withRepoRule(
		`Critically review the implementation of Readyset change "${changeId}". This review must start from the diff, not from the repo: ` +
		(changedPaths.length > 0
			? `the files this run changed are ${changedPaths.join(", ")}. `
			: "read the diff of the files this run changed. ") +
		`Then read ${paths.proposal}, ${paths.design}, every specs/**/spec.md under ${paths.specsDir}, and ${paths.tasks} ` +
		"(including its _Verified: notes) for the scenarios those files are supposed to satisfy. Read any other file only " +
		"when the diff needs context to be judged — do not read the whole repo. You did not write this implementation; " +
		"your job is to find problems " +
		"in it, not to confirm it's fine.\n\n" +
		triggerLine +
		"Write " +
		paths.review +
		" covering: (1) does the implementation actually match every requirement's WHEN/THEN scenarios, or does it narrow, " +
		"skip, or half-implement any of them — and check this against the BEHAVIOR (run the code, read the diff, " +
		"exercise the endpoint), never against the suite the Apply turn itself wrote: a test that asserts the " +
		"implementation's own wrong behavior proves nothing (a real case: a test that locked in " +
		"`process.emitWarning(msg, { code })` without `type: 'DeprecationWarning'`, asserting the bug). " +
		"Distrust any test whose expected value could only have come from the implementation under review — " +
		"re-derive the expectation from the spec scenario, not from the code; (2) are the _Verified: notes credible — do they describe something that would " +
		"actually catch a failure, or are they vague/self-serving (e.g. 'looks correct' is not a verification); (3) any " +
		"correctness bug, edge case, or regression risk you can see in the touched files, whether or not tasks.md " +
		"mentioned it. Structure it as a findings list; if you genuinely find nothing, say so plainly rather than padding " +
		"the file — but check hard before concluding that. Do not edit the implementation in this turn — findings only." +
		"\n\n" +
		`Also write a "## Scope" section in ${paths.review}: go through every file this change ` +
			`touched outside proposal.md's scope contract` +
			(deviations.length > 0
				? ` — these are declared deviations: ${deviations.map((d) => `${d.path}${d.reason ? ` (${d.reason})` : ""}`).join("; ")}`
				: " (none were declared)") +
			`. For each, judge whether it was NECESSARY or GOLD-PLATING (an unrequested refactor, extra ` +
			`test, or new file), and flag any unrequested change you find in the diff.` +
		(lane === "fast"
			? " Keep this review proportional: verify the WHEN/THEN scenarios against behavior and the scope contract, " +
				"but skip mutation-testing-style probes (removing code to see if tests catch it) — that depth belongs to the full lane."
			: "") +
		"\n\nFlag as blocking any doc the request, brainstorm or contract calls for that was not actually written or updated." +
		"\n\nEnd REVIEW.md with a `## Blocking` section: one bullet per finding that violates (a) a WHEN/THEN " +
		"scenario, (b) an explicit requirement from the brainstorm or proposal.md — including any doc the " +
		"request or brainstorm asked for (README/CHANGELOG/docs) or a doc file the " +
		"contract lists that was not actually written — or (c) a recorded decision (an `## Assumptions`/`## Open " +
		"Decisions` entry, or a `## Decisions made during Apply` entry). Write exactly \"none\" when there are none. " +
		"Every other remark goes in the sections above, never in `## Blocking`."
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

const OUTSIDE_REPO_TOOLS = new Set(["bash", "read", "grep", "glob"]);

/** `outside` counts toward the headline number; `tmp` is reported separately (scratch dirs are
 *  common and legitimate). */
export type OutsideRepoKind = "outside" | "tmp";

/** Memoized `existsSync('/<segment>')` — a top-level directory listing never changes mid-run. */
const topLevelDirCache = new Map<string, boolean>();
function isRealTopLevelDir(segment: string): boolean {
	const cached = topLevelDirCache.get(segment);
	if (cached !== undefined) return cached;
	let exists = false;
	try { exists = segment !== "" && existsSync(`/${segment}`); } catch { exists = false; }
	topLevelDirCache.set(segment, exists);
	return exists;
}

/** Classifies a tool call's arguments as reaching outside `cwd`; `undefined` when nothing does.
 *  - `~`/`$HOME` and a bare `/` (what `find /` reduces to) are always outside;
 *  - a leading redirection prefix (`>/x`, `2>/x`, `<`) is stripped before the test;
 *  - an absolute token counts only when its first segment is a real top-level directory on this
 *    host, so route strings like `/orders/:id` or `/products` drop out;
 *  - `/dev/*` is always ignored;
 *  - `/tmp/*` returns `"tmp"` (reported, not headline-counted). */
export function classifyOutsideRepoAccess(toolName: string, input: Record<string, unknown>, cwd: string): OutsideRepoKind | undefined {
	if (!OUTSIDE_REPO_TOOLS.has(toolName)) return undefined;
	const repoRoot = cwd.replace(/\/+$/, "");
	const texts: string[] = [];
	if (toolName === "bash") {
		if (typeof input.command === "string") texts.push(input.command);
		if (typeof input.cwd === "string" && input.cwd !== "") texts.push(input.cwd);
	} else if (toolName === "read" || toolName === "glob") {
		if (typeof input.path === "string") texts.push(input.path);
	} else if (toolName === "grep") {
		// Only `path` — `pattern` is a regex, never a path (`/orders/:id` is a route, not a dir).
		if (typeof input.path === "string") texts.push(input.path);
	}
	let sawTmp = false;
	for (const text of texts) {
		if (/\$HOME\b|\$\{HOME\}/.test(text)) return "outside";
		for (const raw of text.split(/[\s"'`;|&()]+/)) {
			const token = raw.replace(/^[0-9]*&?[<>]{1,2}/, ""); // strip a redirection prefix
			if (token === "") continue;
			if (token.startsWith("~")) return "outside";
			if (!token.startsWith("/")) continue;
			if (token === "/") return "outside";
			if (token === repoRoot || token.startsWith(`${repoRoot}/`)) continue;
			if (token === "/dev" || token.startsWith("/dev/")) continue;
			const segment = token.slice(1).split("/")[0];
			if (!isRealTopLevelDir(segment)) continue;
			if (segment === "tmp") { sawTmp = true; continue; }
			return "outside";
		}
	}
	return sawTmp ? "tmp" : undefined;
}

interface OutsideRepoEntry { kind: OutsideRepoKind; text: string; }
const outsideRepoState: { cwd: string | undefined; entries: OutsideRepoEntry[]; written: number } = {
	cwd: undefined, entries: [], written: 0,
};
export function outsideRepoCount(): number {
	return outsideRepoState.entries.filter((e) => e.kind === "outside").length;
}
export function outsideRepoTmpCount(): number {
	return outsideRepoState.entries.filter((e) => e.kind === "tmp").length;
}

export function resetOutsideRepoWatch(cwd: string): void {
	outsideRepoState.cwd = cwd;
	outsideRepoState.entries = [];
	outsideRepoState.written = 0;
}

function noteOutsideRepoCall(toolName: string, input: Record<string, unknown>, kind: OutsideRepoKind): void {
	if (outsideRepoState.entries.length >= 200) return; // bound memory; the counts below keep growing
	const text = toolName === "bash" ? String(input.command ?? "")
		: (typeof input.path === "string" ? input.path : ""); // grep: never the pattern
	outsideRepoState.entries.push({ kind, text: `${toolName}: ${text.slice(0, 140)}` });
}

/** Advisory CONTEXT.md flush: one entry per gate/archive pass, carrying only the calls observed
 *  since the previous flush. Never throws — a phase log is diagnostics, not control flow. */
async function flushOutsideRepoEntries(cwd: string, changeId: string): Promise<void> {
	const unwritten = outsideRepoState.entries.slice(outsideRepoState.written);
	if (unwritten.length === 0) return;
	outsideRepoState.written = outsideRepoState.entries.length;
	const outside = unwritten.filter((e) => e.kind === "outside").map((e) => e.text);
	const tmp = unwritten.filter((e) => e.kind === "tmp").map((e) => e.text);
	if (outside.length > 0) {
		await appendContext(
			cwd, changeId, "Outside-repo access",
			`⚠ outside-repo access: ${outside.length} tool call(s) reached outside the repository — advisory, never blocking` +
				(outside.length <= 10 ? `: ${outside.join("; ")}` : `; first 10: ${outside.slice(0, 10).join("; ")}`),
		).catch(() => {});
	}
	if (tmp.length > 0) {
		await appendContext(
			cwd, changeId, "Outside-repo access",
			`tmp-directory access: ${tmp.length} tool call(s) used a scratch directory under /tmp — reported separately, not counted in the outside-repo headline` +
				(tmp.length <= 10 ? `: ${tmp.join("; ")}` : `; first 10: ${tmp.slice(0, 10).join("; ")}`),
		).catch(() => {});
	}
}

export function grillTurnPrompt(ideaText: string, today: string, laneDefault: LaneDefault, preferredLanguage?: string): string {
	return withRepoRule(
		"Grill this raw idea into a decided Readyset brainstorm file — interrogate it, " +
			`don't just accept it. Ask only questions whose answer changes the plan. Raw idea from the user: "${ideaText}"\n\n` +
			"If the `readyset_ask` tool is available in your tools list, call it for questions with 2+ real options " +
			"per question and mark your own recommended one via recommendedIndex, so the user picks or overrides rather " +
			"than starting from a blank page. You can keep calling `readyset_ask` round after round in this same turn — " +
			"you don't need to end your turn between rounds. If `readyset_ask` is NOT in your available tools, or if it " +
			"reports that the structured picker is unavailable, ask your questions directly in plain chat text formatted " +
			"with numbered options and your recommended pick. NEVER search the filesystem, network, or process table " +
			"for `readyset_ask`.\n\n" +
			"Keep going until the design is genuinely settled, or until the tool tells you the round cap was hit (then check in: " +
			"summarize what's decided, name what's still open, ask in plain chat whether to keep grilling or write " +
			"the brainstorm now with the rest under Open Questions — pace check only, not permission to accept a " +
			"passive answer). Rules:\n" +
			"- Every `readyset_ask` question MUST carry a `decision` field naming the plan decision it changes and how " +
			"the plan differs per answer, in one short sentence. A question whose answers would all lead to the same " +
			"plan must NOT be asked — decide it yourself and record it under a `## Assumed` section in the brainstorm " +
			"(below), so the assumption is reviewable rather than silently held. The tool enforces this: a round with " +
			"a question missing `decision` is rejected without opening the picker and without consuming a round.\n" +
			"- Map out the decision branches this idea implies before asking anything (what's actually unresolved: " +
			"approach, scope boundary, the seam/module it touches, how success is observed), then ask only the " +
			"questions answerable right now, all in one round.\n" +
			"- Before asking anything, walk this edge-case checklist and note which items this idea actually " +
			"touches: empty/missing values; case sensitivity; boundaries (inclusive/exclusive, time zones, " +
			"rounding); error codes/messages for invalid input; backward compatibility/deprecation; release " +
			"artifacts (versioning or docs ONLY if explicitly requested by the user — never scope doc updates for " +
			"pure bugfixes); how verification is committed (tests in the suite vs a scratch script; relative vs " +
			"absolute perf thresholds). For each item that applies, ask only if the answer changes the plan AND the " +
			"repo cannot settle it — otherwise decide it yourself and record it under `## Assumed` with the concrete " +
			"behavior chosen (`- <decision> — <behavior> — because all answers led to the same plan`). This is the same " +
			"value-of-information rule as everywhere else in this prompt, applied to the checklist.\n" +
			"- After the fact-finding pass, count *open decisions* — choices facts cannot settle that change scope, " +
			"behavior, or interfaces. Stop as soon as no open decisions remain, even in round 1; the round cap is a " +
			"ceiling, not a target.\n" +
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
			"- Finding facts is your job, never the user's. A question about external platform behavior, API " +
			"rules/tiers, or anything else this session's web search tool could actually answer does not belong " +
			"in a round as an open question or a silent assumption — look it up first, then ask (or state) the " +
			"real thing. Reserve open questions for what only the user can decide or knows.\n" +
			"- Do NOT invent secondary systems that were not requested. If the idea asks for rate limiting, " +
			"throttling, or grouping/partitioning by a key or header (e.g. `x-api-key`) or by IP, treat that " +
			"key strictly as an opaque bucket-identifier STRING used to group/partition — do NOT implement key " +
			"validation, key registries, key lookup, or 401 UNAUTHORIZED responses unless authentication was an " +
			"explicit requirement of the idea. Ask if a real auth requirement seems implied; never " +
			"assume one into the plan.\n" +
			"- Working tree and scope discipline: pre-existing uncommitted changes, stray comments in code (e.g. " +
			"`// user note...`), and untracked files are the user's active work in progress — never treat them as noise " +
			"to clean up. For bugfix or refactor tasks, do NOT propose, scope, or assume updates to documentation " +
			"(README, notes, etc.) unless the user explicitly requested documentation. When recording assumed decisions, " +
			"never cite non-existent file names with extensions like `CHANGELOG.md` (write 'no changelog entry' without `.md`).\n" +
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
			"Before writing the file, explicitly close out: which option is decided (or explicitly " +
			"deferred), the seam, in/out of scope, and acceptance criteria as WHEN/THEN lines. Also write the " +
			"clarity signal into the frontmatter: `clarity` (`clear` = 0 open decisions after fact-finding, " +
			"`partial` = 1-2, `ambiguous` = 3+ or an undefined core behavior), `openDecisions` (that count), " +
			"`questionsAsked` (how many rounds you actually asked), and `riskFlag` — one of " +
			"`cross-cutting|migration|api-change|security` — but only when it genuinely applies (omit it " +
			"otherwise). " +
			(laneDefault === "ask"
				? "Then ask the user directly for the lane — propose one with a one-line reason (full for " +
					"feature/adjust/experimental, fast for bugfix/hotfix/refactor/chore/docs/test/release), and take " +
					"their pick. Write the chosen lane and that one-line reason into `lane` and `laneReason`. "
				: laneDefault === "auto"
					? "Do NOT ask the user for the lane. Derive it from the clarity score — `clarity: clear` → " +
						"`fast`, `clarity: ambiguous` → `full`, `clarity: partial` → `fast` unless a risk flag applies " +
						"(cross-cutting, migration/data-format, public API/deprecation, security/auth), in which case " +
						"`full`. Write that into `lane`, and put the one-line justification in `laneReason`. "
					: `Do NOT ask the user for the lane. Write \`lane: ${laneDefault}\` and a one-line reason in \`laneReason\`. `) +
			"The lane decides how " +
			"heavy the later phases run: fast means a lighter Explore folded into Propose, at most ~8 tasks, and " +
			"no mutation-testing review — so a wrong lane changes cost, not just a label. Behavior-affecting " +
			"ambiguities must still be asked either way; the lane trims volume, never the questions that change " +
			"behavior. Also auto-derive (don't ask) the branch type with a one-line reason, and do ask directly " +
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
			`clarity: clear|partial|ambiguous\n` +
			`openDecisions: <n>\n` +
			`questionsAsked: <n>\n` +
			`laneReason: "<one line>"\n` +
			`# riskFlag: cross-cutting|migration|api-change|security  (only when it applies; omit otherwise)\n` +
			"---\n\n" +
			"## Problem / Context\n## Options Explored\n### Option A: <name>\n### Option B: <name>\n" +
			"## Leaning Direction\n## Decision\n## Assumed\n- none\n## Seam\n## Scope\n## Acceptance Criteria\n## Spec Impact\n" +
			"## Git Workflow\n- Branch: <type>/<slug>\n- Inference reason: <one line>\n" +
			"- Lane: <full | fast> — <one line>\n- Per-task flow: <\"commit only\" | \"commit + merge request per task\">\n" +
			"## Open Questions\n## Technical Constraints & Notes from Repo\n## Next Step\n\n" +
			"Under `## Assumed`, list each decision you made yourself without asking — one per line as " +
			"`- <the decision> — because all answers led to the same plan` — or `- none` if there were none. " +
			"Once the file is written, tell the user its path and summarize the decisions made — do not " +
			"fire off Explore or Propose yourself in this turn."
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
		// content = undefined, so the summary panel never actually rendered. `content` is
		// `string[] | undefined` in the host type (`ExtensionWidgetContent`), so passing
		// `undefined` with the same key is how a widget is cleared.
		setWidget?: (key: string, content: string[] | undefined) => void;
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
	waitForIdle?: () => Promise<void>;
	// Both documented on the general handler ctx (see extensions.md "Handler Context
	// Capabilities"). Optional here because real-world timing means we'd rather degrade to
	// the old (racy) behavior than throw if a given omp build doesn't expose them.
	//
	// `waitForIdle` is optional for a second, sharper reason: omp has two ctx shapes and only
	// one of them has it. The `agent_end` hook ctx is the general `ExtensionContext`
	// (`runner.ts` `createContext()`), which exposes `isIdle`/`hasPendingMessages`/`compact`/
	// `models` but NO `waitForIdle`; `waitForIdle` is added only by `createCommandContext()`,
	// which spreads `createContext()` and adds it and is what a registered command handler
	// receives. Declaring it required here is exactly what let `ctx as unknown as ReviewCtx` in
	// the `agent_end` registration hide the mismatch from `tsc` -- the grill->propose transition
	// then died with `TypeError: ctx.waitForIdle is not a function` inside `fireTurnAndWait`,
	// out of sight (omp dispatches that notification detached). See `fireTurnAndWait` for the
	// fallback and `ActiveGrillSession.waitForIdle` for why the command ctx's own function is
	// stashed at grill-start time.
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
 * The host's `pi.setModel`, bound to `pi`, or `undefined` when this omp build doesn't expose it.
 *
 * Bound, not merely extracted: a bare `pi.setModel` reference loses its `this` when called
 * detached (`const f = obj.method; f()`), which a real terminal run (2026-09-18) hit as
 * "undefined is not an object (evaluating 'this.runtime')" on every call — the real
 * implementation reads state off `this` internally. `.bind(pi)` keeps the existence check
 * working (bind on undefined would throw, so the optional chain still yields `undefined`) while
 * fixing every call site at once. The cast is read once here instead of at each call site.
 */
function resolveHostSetModel(pi: ExtensionAPI): ((spec: unknown) => unknown) | undefined {
	// pi is the public ExtensionAPI; setModel exists on it per extensions.md but is not in this
	// build's published type surface, so the shape is asserted once, here, at the boundary.
	const host = pi as unknown as { setModel?: (spec: unknown) => unknown };
	return host.setModel?.bind(pi);
}

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

	const setModel = resolveHostSetModel(pi);
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

	const setModel = resolveHostSetModel(pi);
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
	handoffRestoreTarget = original;
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
		// The approve branch of the gate sets `pendingHandoff` before it fires the execution turn
		// and returns. Execution is handed to core omp fire-and-forget, so restoring here would
		// land exactly as the execution turn starts, making it run on the pre-run model instead of
		// the pinned/apply-phase one. The restore moves to the first terminal agent_end for this
		// cwd (the agent_end hook -> handlePendingHandoff).
		const handedOff = pendingHandoff !== undefined && pendingHandoff.cwd === ctx.cwd;
		if (!handedOff) {
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
 *
 * The wait itself is feature-detected, because `waitForIdle` only exists on the command ctx
 * (`ExtensionCommandContext`) and NOT on the `agent_end` hook ctx (`ExtensionContext`) this also
 * runs under during the grill->propose transition. Preference order: (1) `waitForIdle` when
 * present -- the command path, unchanged; (2) `isIdle`/`hasPendingMessages` polled until the
 * session is idle with nothing pending on two *consecutive* checks -- the agent_end safety net.
 * The fallback deliberately has no deadline: a planning turn legitimately runs for minutes, and
 * requiring two consecutive clean reads is what makes "idle" trustworthy (a single read can land
 * in the same instant a turn has not started yet, which is the race this whole function exists to
 * avoid). The loop exits the moment the session is genuinely settled, so it costs nothing on a
 * fast turn. (3) Neither API: fail loudly via `ctx.ui.notify` and return -- do NOT throw, because
 * omp dispatches the agent_end notification detached and would swallow it.
 */
async function fireTurnAndWait(pi: ExtensionAPI, ctx: ReviewCtx, prompt: string): Promise<void> {
	pi.sendUserMessage(prompt);

	const sleep = (ms: number): Promise<void> =>
		// `new Promise` rather than `Promise.withResolvers`: tsconfig targets ES2022, where
		// `withResolvers` is not in `lib` (same reason readyset-evidence.ts uses this form).
		new Promise((resolve) => setTimeout(resolve, ms));

	const pollStarted = ctx.isIdle || ctx.hasPendingMessages;
	if (pollStarted) {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const idle = ctx.isIdle ? ctx.isIdle() : true;
			const pending = ctx.hasPendingMessages ? ctx.hasPendingMessages() : false;
			if (!idle || pending) break;
			await sleep(100);
		}
	}

	if (typeof ctx.waitForIdle === "function") {
		await ctx.waitForIdle();
		return;
	}

	if (typeof ctx.isIdle === "function" && typeof ctx.hasPendingMessages === "function") {
		const isIdle = ctx.isIdle;
		const hasPendingMessages = ctx.hasPendingMessages;
		let consecutive = 0;
		while (consecutive < 2) {
			await sleep(200);
			consecutive = isIdle() && !hasPendingMessages() ? consecutive + 1 : 0;
		}
		return;
	}

	ctx.ui.notify(
		"Can't tell when this turn finished: this omp build's ctx exposes neither waitForIdle() nor isIdle()/hasPendingMessages(). " +
			"Re-run /readyset and pick the brainstorm to resume.",
		"error",
	);
	return;
}

export interface BrainstormExecutionOptions {
	laneOverride?: "fast" | "full";
	laneDefault: LaneDefault;
	parsedArgs: ReadysetArgs;
	compactMode: "auto" | "always" | "never";
	effectiveReviewMode: ReviewMode;
	reviewFullLane: ReviewFullLane;
	reviewThresholds: ParsedReviewThresholds;
	scopeProtected: { paths: string[] };
	testPathsResult: { paths: string[] };
}

export interface ActiveGrillSession {
	active: boolean;
	startedAt: number;
	ideaText: string;
	laneDefault: LaneDefault;
	preferredLanguage?: string;
	writtenBrainstormFile?: string;
	existingFiles: Set<string>;
	execOptions: BrainstormExecutionOptions;
	/** The command ctx's own waitForIdle, captured because the runner closure stays valid after
	 *  the command handler returns, while the agent_end hook ctx (ExtensionContext) has none. */
	waitForIdle?: () => Promise<void>;
}

export let activeGrillSession: ActiveGrillSession | undefined;

export function resetActiveGrillSession(): void {
	activeGrillSession = undefined;
}

/**
 * A pending execution handoff: the approve branch fires the apply turn fire-and-forget and
 * returns, so the run's model pin (withPinnedModel) must NOT be restored in its `finally` —
 * execution has to run on the pinned/apply model for its whole handed-off turn.
 * `restoreTo` is the model the session had before the run pinned anything (opaque, from
 * ctx.models.current(); `undefined` when nothing was ever pinned, in which case there is
 * nothing to restore).
 *
 * Single-session limitation: this is module-level process state, like `activeGrillSession`, so a
 * second /readyset run started in the same process before the first handoff settles would
 * overwrite it. Only the approve path sets it, and it is cleared on the first terminal agent_end
 * for the same cwd.
 */
export let pendingHandoff: { changeId: string; restoreTo: unknown; cwd: string } | undefined;

/**
 * The model the current run's `withPinnedModel` captured before it pinned anything. Only
 * `withPinnedModel` can observe this value, so the approve branch (which runs inside its `fn`)
 * reads it through here rather than calling `ctx.models.current()` again — that call would return
 * the already-pinned model, not the original. Left untouched (undefined) when no pin was
 * configured, which is exactly what `pendingHandoff.restoreTo` should be in that case.
 */
export let handoffRestoreTarget: unknown;

export function resetPendingHandoff(): void {
	pendingHandoff = undefined;
	handoffRestoreTarget = undefined;
}

/**
 * Kicks off grilling for a raw, directly-typed idea and returns immediately — deliberately not
 * awaited against `ctx.waitForIdle()` the way `spendTurn`/`fireTurnAndWait` are, because the
 * turns that follow are ordinary chat turns the user answers directly (see `grillTurnPrompt`'s
 * doc comment). Handler call sites `return` right after this.
 */
export function startGrilling(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	ideaText: string,
	laneDefault: LaneDefault,
	preferredLanguage?: string,
	execOptions?: BrainstormExecutionOptions,
): void {
	const today = new Date().toISOString().slice(0, 10);
	const preview = ideaText.length > 60 ? `${ideaText.slice(0, 57)}...` : ideaText;
	grillRoundState.rounds = 0;
	grillRoundState.active = true; // consumed by the command handler's zero-rounds check -- see grillRoundState's doc comment

	const files = new Set<string>();
	const brainstormDir = join(ctx.cwd, BRAINSTORM_DIR);
	if (existsSync(brainstormDir)) {
		try {
			for (const entry of readdirSync(brainstormDir)) {
				if (entry.endsWith(".md")) {
					files.add(join(brainstormDir, entry));
				}
			}
		} catch {}
	}

	if (execOptions) {
		activeGrillSession = {
			active: true,
			startedAt: Date.now(),
			ideaText,
			laneDefault,
			preferredLanguage,
			existingFiles: files,
			execOptions,
			waitForIdle: ctx.waitForIdle,
		};
	}

	ctx.ui.notify(
		`Grilling started for: "${preview}"${preferredLanguage ? ` in ${preferredLanguage}` : ""} — Readyset will ask questions ` +
			"right here in the chat (a structured picker where available); answer them, and it'll write the " +
			"brainstorm file once the design is genuinely resolved.",
		"info",
	);
	pi.sendUserMessage(grillTurnPrompt(ideaText, today, laneDefault, preferredLanguage));
}

export async function findNewlyWrittenBrainstorm(cwd: string, session: ActiveGrillSession): Promise<string | undefined> {
	if (session.writtenBrainstormFile && existsSync(session.writtenBrainstormFile)) {
		return session.writtenBrainstormFile;
	}
	const brainstormDir = join(cwd, BRAINSTORM_DIR);
	if (!existsSync(brainstormDir)) return undefined;
	try {
		const entries = await readdir(brainstormDir);
		let latestFile: string | undefined;
		let latestMtime = session.startedAt;
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const fullPath = join(brainstormDir, entry);
			if (!session.existingFiles.has(fullPath)) {
				return fullPath;
			}
			try {
				const st = await stat(fullPath);
				if (st.mtimeMs >= latestMtime) {
					latestMtime = st.mtimeMs;
					latestFile = fullPath;
				}
			} catch {}
		}
		return latestFile;
	} catch {
		return undefined;
	}
}

export async function handleGrillEndTransition(pi: ExtensionAPI, ctx: ReviewCtx): Promise<void> {
	try {
		await runGrillEndTransition(pi, ctx);
	} catch (err) {
		ctx.ui.notify(
			`Readyset couldn't continue from grilling: ${err instanceof Error ? err.message : String(err)}. ` +
				"Run /readyset and pick the brainstorm to resume.",
			"error",
		);
		return;
	}
}

async function runGrillEndTransition(pi: ExtensionAPI, ctx: ReviewCtx): Promise<void> {
	if (!activeGrillSession?.active) return;
	const session = activeGrillSession;
	// The ctx this run is driven with from here on. This function fires from two places: the
	// /readyset command handler (command ctx: has waitForIdle) and omp's agent_end hook (general
	// ExtensionContext: no waitForIdle). `session` was captured from the command ctx at
	// startGrilling time and carries that ctx's own waitForIdle, so spread it in when the hook
	// ctx lacks one. The spread also keeps cwd/ui/models/mode/isIdle/hasPendingMessages from the
	// hook ctx and replaces only the missing member; `session.waitForIdle` may itself be
	// undefined (a direct call with a non-command ctx), in which case fireTurnAndWait's polling
	// fallback takes over.
	const runCtx: ReviewCtx = ctx.waitForIdle ? ctx : { ...ctx, waitForIdle: session.waitForIdle };
	const newlyWritten = await findNewlyWrittenBrainstorm(ctx.cwd, session);
	if (!newlyWritten) {
		// Grilling still in progress (intermediate question round)
		return;
	}

	// Brainstorm file is written! Mark grilling complete.
	activeGrillSession = undefined;
	grillRoundState.active = false;

	const relativePath = relative(ctx.cwd, newlyWritten);
	ctx.ui.notify(`Brainstorm file created: ${relativePath}`, "info");

	const isIndonesian =
		session.preferredLanguage === "id" ||
		session.preferredLanguage === "indonesian" ||
		/indonesia/i.test(session.preferredLanguage ?? "");

	const promptText = isIndonesian
		? `Brainstorm selesai (${basename(newlyWritten)}). Lanjut ke tahap berikutnya?`
		: `Brainstorm complete (${basename(newlyWritten)}). Continue to next phase?`;

	const continueLabel = isIndonesian
		? "Lanjut ke Propose (Explore & Propose)"
		: "Continue to Explore & Propose (Recommended)";
	const finishLabel = isIndonesian
		? "Selesai di sini (Review file dulu)"
		: "Finish here (review brainstorm first)";

	const choice = await ctx.ui.select(promptText, [
		{
			label: continueLabel,
			description: isIndonesian
				? "Lanjutkan eksplorasi repo dan pembuatan proposal/spesifikasi secara otomatis"
				: "Grounded repo checks + proposal, design, specs, and tasks",
		},
		{
			label: finishLabel,
			description: isIndonesian
				? "Berhenti di sini untuk membaca atau mengedit file brainstorm sebelum propose"
				: "Stop here to inspect or edit the brainstorm file before proposing",
		},
	]);

	if (choice === continueLabel) {
		const all = await loadBrainstorms(ctx.cwd);
		await reconcileStatuses(ctx.cwd, all);
		const chosen = all.find((b) => b.file === newlyWritten || b.slug === basename(newlyWritten, ".md"));
		if (!chosen) {
			ctx.ui.notify(`Could not load brainstorm metadata for ${relativePath}`, "warning");
			return;
		}
		await executeBrainstorm(pi, runCtx, chosen, session.execOptions);
	} else {
		ctx.ui.notify(`Brainstorm saved at ${relativePath}. Run /readyset when you're ready to proceed.`, "info");
	}
}

/**
 * Reads this change's `apply` `start` phase event and returns the model it recorded, or
 * `undefined` when there is none (an unpinned run, or events that predate the field). That is the
 * honest value to carry onto the balancing `apply` `end` event — never a fabricated one.
 */
async function executionModelOf(cwd: string, changeId: string): Promise<string | undefined> {
	const events = await readPhaseEvents(cwd, changeId);
	return events.find((e) => e.phase === "apply" && e.edge === "start")?.model;
}

/**
 * Settles a pending execution handoff: records the balancing `apply` `end` phase event and
 * restores the model the session had before the run pinned anything. Shared by the terminal
 * `agent_end` path (handlePendingHandoff) and the command-start supersede path so the two cannot
 * drift on the event shape, the restore, or the notify.
 *
 * `handoff` is already detached from the module state by the caller, so a throw here cannot leave
 * a stale handoff armed. Never throws: the event write and the restore each degrade to a warning.
 */
export async function settleHandoff(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	handoff: { changeId: string; restoreTo: unknown },
	outcome: string,
): Promise<void> {
	await appendPhaseEvent(ctx.cwd, handoff.changeId, {
		phase: "apply",
		edge: "end",
		at: new Date().toISOString(),
		lane: (await readChangeLane(ctx.cwd, handoff.changeId)) ?? "full",
		laneSource: "brainstorm",
		model: await executionModelOf(ctx.cwd, handoff.changeId).catch(() => undefined),
		outcome,
	}).catch(() => {});

	if (handoff.restoreTo === undefined) return; // nothing was ever pinned; nothing to restore

	const setModel = resolveHostSetModel(pi);
	if (!setModel) {
		ctx.ui.notify("Couldn't restore the model this session had before the /readyset run — check /model if it looks off.", "warning");
		return;
	}
	try {
		await setModel(handoff.restoreTo);
	} catch {
		ctx.ui.notify("Couldn't restore the model this session had before the /readyset run — check /model if it looks off.", "warning");
		return;
	}
	if (outcome === "handoff-superseded") {
		ctx.ui.notify(
			"A new /readyset command superseded the handed-off execution — the model this session had before the run is restored (handoff-superseded).",
			"warning",
		);
	} else {
		ctx.ui.notify("Execution settled — restored the model this session had before the run.", "info");
	}
}

/**
 * True when the handed-off execution has run every task to completion. An unreadable tasks.md
 * counts as done, so a missing/renamed file cannot leave the handoff armed forever.
 * Reuses getProgress (readyset-spec.ts) — the same counting helper the gate and trigger input use,
 * so "all done" means the same thing everywhere.
 */
async function executionComplete(cwd: string, changeId: string): Promise<boolean> {
	const progress = await getProgress(cwd, changeId).catch(() => undefined);
	return progress === undefined || progress.total === 0 || progress.done === progress.total;
}

/**
 * Settles a pending execution handoff: records the balancing `apply` `end` phase event and
 * restores the model the session had before the run pinned anything.
 *
 * Runs from the `agent_end` hook, and only on a terminal settle — see the handler's comment for
 * why `agent_end` (`willContinue !== true`) and not `session_stop`. The hook ctx is the general
 * `ExtensionContext`, which is all this needs: cwd, ui, and (for the restore) `pi.setModel`.
 *
 * Pause-aware: a terminal `agent_end` with tasks still unfinished means execution paused to ask a
 * question or report a blocker (applyTurnPrompt tells the model to pause rather than guess), NOT
 * that it finished. In that case the handoff stays armed, the execution model stays active, and a
 * pause record is written; the model is restored when the tasks finish or on the next /readyset
 * command (supersede).
 *
 * The handoff state is cleared first, so a throw later cannot leave a stale handoff armed forever
 * and re-firing on every subsequent agent_end.
 */
export async function handlePendingHandoff(pi: ExtensionAPI, ctx: ReviewCtx): Promise<void> {
	const handoff = pendingHandoff;
	if (!handoff) return;
	if (handoff.cwd !== ctx.cwd) return; // a different session's settle: leave it
	if (!(await executionComplete(ctx.cwd, handoff.changeId))) {
		// Execution paused to ask a question / report a blocker. Keep the handoff armed and the
		// execution model active. The pause is recorded as an `apply` `start` event (the only legal
		// `edge` values are start|end — readyset-spec.ts), same phase as the original apply start,
		// so start/end stay balanced and executionModelOf (which finds the FIRST apply start) still
		// returns the execution model. handoffRestoreTarget is deliberately NOT cleared here: the
		// arm must survive until the real settle.
		const progress = await getProgress(ctx.cwd, handoff.changeId).catch(() => undefined);
		const done = progress?.done ?? 0;
		const total = progress?.total ?? 0;
		await appendPhaseEvent(ctx.cwd, handoff.changeId, {
			phase: "apply",
			edge: "start",
			at: new Date().toISOString(),
			lane: (await readChangeLane(ctx.cwd, handoff.changeId)) ?? "full",
			laneSource: "brainstorm",
			model: await executionModelOf(ctx.cwd, handoff.changeId).catch(() => undefined),
			outcome: "handoff-paused",
		}).catch(() => {});
		await appendContext(
			ctx.cwd,
			handoff.changeId,
			"Apply",
			`Execution paused at ${done}/${total} tasks — execution model stays active until all tasks are done or the next /readyset command.`,
		).catch(() => {});
		ctx.ui.notify(
			`Execution paused at ${done}/${total} tasks — execution model stays active. It is restored when all tasks are done or on the next /readyset command.`,
			"info",
		);
		return; // handoff stays armed; handoffRestoreTarget stays set
	}
	pendingHandoff = undefined;
	handoffRestoreTarget = undefined;
	await settleHandoff(pi, ctx, handoff, "handoff-settled");
}

/**
 * Settles a pending handoff that a new /readyset command is superseding, instead of dropping it.
 * The previous behavior (resetPendingHandoff) cleared the state with no model restore and no
 * balancing `apply` `end` event, so an abandoned or interleaved handoff left the session stuck on
 * the execution model forever and the phase log with an unclosed `apply`.
 *
 * Shares settleHandoff with the terminal-settle path. No-ops when nothing is pending.
 */
export async function supersedePendingHandoff(pi: ExtensionAPI, ctx: ReviewCtx): Promise<void> {
	const handoff = pendingHandoff;
	if (!handoff) return;
	pendingHandoff = undefined;
	handoffRestoreTarget = undefined;
	await settleHandoff(pi, ctx, handoff, "handoff-superseded");
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
 * True when this run can fire one more turn AND still leave `reserve` turns for the phases that
 * must not be starved. `spendTurn` only checks `spent >= max`, so a repair/reconcile turn fired
 * when `spent === max - 1` would consume the last unit; the code-review `spendTurn` then returns
 * false and the run ends with no REVIEW.md and no archive offer. Callers pass the number of later
 * phases that must still get a turn: 2 for contract repair (Apply + Review), 1 for scope
 * reconciliation (Review).
 */
function turnsAvailableFor(budget: TurnBudget, reserve: number): boolean {
	return budget.max - budget.spent > reserve;
}

/**
 * Runs `git status --porcelain` in the repo root and returns the repo-relative paths of every
 * currently dirty file (tracked modifications plus untracked files; renames are reported as
 * their destination). Despite the old name, this never diffed against a baseline — it is just
 * the raw current-dirty read; the subtraction happens in `pathsChangedThisRun`. Throws when
 * git is unavailable or the cwd is not a repo — a planning turn in a non-repo has no git
 * boundary to violate, so callers treat that as "nothing to check", not as a violation.
 */
async function currentDirtyPaths(cwd: string): Promise<string[]> {
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

/**
 * What this run itself changed: current dirty paths minus whatever was already dirty before
 * this change's planning turns ever ran (the baseline captured at scaffold time). Without
 * the subtraction, any file dirty for unrelated reasons — a WIP edit elsewhere, an
 * untracked scratch note — gets misattributed to the current change.
 */
async function pathsChangedThisRun(cwd: string, changeId: string): Promise<string[]> {
	const [current, baseline] = await Promise.all([
		currentDirtyPaths(cwd).catch(() => [] as string[]),
		readDirtyBaseline(cwd, changeId),
	]);
	return current.filter((p) => !baseline.has(p));
}

/** Final Apply diff size for the bench: files changed and lines added/deleted, from
 *  `git diff HEAD --numstat` (so staged changes count), falling back to plain `git diff` when there
 *  is no HEAD (a fresh repo), over the run's own changed paths, with untracked new files counted by
 *  their line count. Excludes readyset/ (planning artifacts) and .ai/brainstorms/**
 *  (.ai/brainstorms) so the number reflects product code. Returns zeros when git is unavailable. */
async function applyDiffStats(cwd: string, changedPaths: string[]): Promise<{ files: number; added: number; deleted: number }> {
	const product = changedPaths.filter(
		(p) => !p.startsWith(`${READYSET_ROOT}/`) && !p.startsWith(".ai/brainstorms/"),
	);
	if (product.length === 0) return { files: 0, added: 0, deleted: 0 };
	const run = promisify(execFile);
	let files = 0, added = 0, deleted = 0;
	try {
		let stdout: string;
		try {
			({ stdout } = await run("git", ["diff", "HEAD", "--numstat", "--", ...product], { cwd, timeout: 30000 }));
		} catch {
			// A repo with no commits yet has no HEAD: `git diff HEAD` errors ("unknown revision"),
			// so fall back to the plain working-tree diff.
			({ stdout } = await run("git", ["diff", "--numstat", "--", ...product], { cwd, timeout: 30000 }));
		}
		for (const line of stdout.split("\n")) {
			if (line.trim() === "") continue;
			const [a, d] = line.split("\t");
			files++;
			added += a === "-" ? 0 : Number(a) || 0;
			deleted += d === "-" ? 0 : Number(d) || 0;
		}
	} catch {
		return { files: 0, added: 0, deleted: 0 };
	}
	// Untracked new files: `git diff --numstat` omits them. Count their lines as additions.
	try {
		const { stdout } = await run("git", ["ls-files", "--others", "--exclude-standard", "--", ...product], { cwd, timeout: 30000 });
		for (const rel of stdout.split("\n")) {
			if (rel.trim() === "") continue;
			const text = await readFile(join(cwd, rel), "utf8").catch(() => "");
			files++;
			added += text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
		}
	} catch {
		/* ls-files unavailable — the tracked numbers still stand */
	}
	return { files, added, deleted };
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

/** The three problem kinds the contract-repair prompt can name, in the order it lists them. */
function scopeRefProblems(refs: Awaited<ReturnType<typeof checkScopeRefs>>): string[] {
	const lines: string[] = [];
	for (const p of refs.missing) lines.push(`${p} — named but does not exist (is it really the right path? or should it be marked (new)?)`);
	for (const p of refs.newButExists) lines.push(`${p} — marked (new) but the file already exists (drop the (new) if it will be modified)`);
	for (const p of refs.deleteButMissing) lines.push(`${p} — marked (delete) but there is no such file to remove`);
	return lines;
}

/** Prompt for the one-shot contract-repair turn: fix ONLY the scope contract, no code. */
export function contractRepairPrompt(problems: string[]): string {
	return withRepoRule(
		"Your `## Files This Change Will Touch` scope contract in proposal.md is wrong. Fix ONLY that " +
		"section — do not touch code, do not restructure any other part of proposal.md, design.md, " +
		"specs/, or tasks.md except to correct a path mention that matches a path you change here.\n\n" +
		"Problems:\n" +
		problems.map((p) => `- ${p}`).join("\n") +
		"\n\nFor each path above: verify the real file with a read or a directory listing, then either " +
		"correct the path to the real file, mark it `(new)` if this change truly creates it, drop the " +
		"`(new)` if the file exists and will be modified, mark it `(delete)` if this change removes it " +
		"(only if it exists now), or remove the line if the file isn't needed. Leave correctly-listed " +
		"paths alone."
	);
}

/**
 * Bounded, one-shot contract repair: if the scope contract has dangling refs, a `(new)` path that
 * already exists, or a `(delete)` path that doesn't, fire ONE repair turn (riding the propose phase
 * model), re-check the planning boundary, and re-check the contract. Never loops — one turn per
 * Propose/Refine. A `turn-needing` result is recorded as an appendContext entry and a
 * `contract-repair` phase event. Callers then take their snapshot as usual; whatever is still wrong
 * shows in the gate as a warning, exactly as today.
 *
 * `record` is the caller's `recordPhase` (the handler's factory-local one, or the module-scope loop
 * one) so the event carries the run's lane/laneSource. Returns the post-repair refs so the caller
 * does not re-check.
 *
 * Once the change has been applied (`hasBeenApplied`), the contract is read with post-Apply
 * semantics and the repair turn never fires: a `(new)` file Apply created and a `(delete)` file it
 * removed would otherwise look wrong, and "repairing" them would strip correct markers. Remaining
 * problems only warn. When not applied, the turn is additionally reserved — it fires only if Apply
 * and Review would still each get a turn (`turnsAvailableFor(budget, 2)`).
 */
async function runContractRepair(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	budget: TurnBudget,
	changeId: string,
	phaseModels: Map<string, { model: string; source: string }>,
	record: (phase: PhaseName, edge: "start" | "end", extra?: { model?: string; outcome?: string }) => Promise<void>,
	brainstormRaw = "",
): Promise<Awaited<ReturnType<typeof checkScopeRefs>>> {
	const applied = await hasBeenApplied(ctx.cwd, changeId);
	const appliedRefs = applied ? { afterApply: true as const } : {};
	const beforeRaw = await checkScopeRefs(ctx.cwd, changeId, appliedRefs);
	const before = applied ? { ...beforeRaw, newButExists: [] } : beforeRaw;
	// Doc mentions that the request/brainstorm asked for but the contract omits are folded into the
	// same one-shot repair turn, so a requested doc can never be silently dropped at planning time.
	const missingDocs = await findMissingRequestedDocs(ctx.cwd, changeId, brainstormRequestText(brainstormRaw), brainstormRaw);
	const problems = [
		...scopeRefProblems(before),
		...missingDocs.map((d) => `requested doc missing from contract: ${d} (add it to \`## Files This Change Will Touch\`, marked (new) if the file does not exist yet)`),
	];
	if (problems.length === 0) return before; // nothing to repair: no event, no turn

	if (applied) {
		ctx.ui.notify(
			`The scope contract for "${changeId}" has ${problems.length} problem(s), but this change has already been applied — not firing a repair turn (it would strip correct (new)/(delete) markers). Showing them in the gate instead.`,
			"warning",
		);
		return before;
	}

	if (!turnsAvailableFor(budget, 2)) {
		ctx.ui.notify(
			`The scope contract for "${changeId}" has ${problems.length} problem(s), but repairing them now would starve Apply/Review of their turns — keeping the turn and showing them in the gate instead.`,
			"warning",
		);
		await record("contract-repair", "end", { outcome: "skipped-budget" });
		return before;
	}

	ctx.ui.notify(`Repairing the scope contract for "${changeId}" (${problems.length} problem(s))...`, "info");
	await record("contract-repair", "start", { model: phaseModels.get("propose")?.model });
	await withPhaseModel(pi, ctx, "propose", phaseModels, () =>
		spendTurn(pi, ctx, budget, "Contract repair", contractRepairPrompt(problems)),
	);

	// The repair turn is a planning turn: it may only touch the change directory. Checked the same
	// way the Propose turn is, before the contract is trusted again.
	const violations = await checkPhaseViolations(ctx.cwd, changeId, await pathsChangedThisRun(ctx.cwd, changeId));
	if (violations.length > 0) {
		ctx.ui.notify(
			`The contract-repair turn for "${changeId}" changed files outside the change directory (${violations.map((v) => v.path).join(", ")}) — treating the repair as failed.`,
			"error",
		);
		await appendContext(ctx.cwd, changeId, "Contract repair", `Repair turn wrote outside the change dir: ${violations.map((v) => `${v.path} (${v.detail})`).join("; ")}.`);
		await record("contract-repair", "end", { model: phaseModels.get("propose")?.model, outcome: "partial" });
		return checkScopeRefs(ctx.cwd, changeId, appliedRefs);
	}

	const afterRaw = await checkScopeRefs(ctx.cwd, changeId, appliedRefs);
	const after = applied ? { ...afterRaw, newButExists: [] } : afterRaw;
	const remaining = scopeRefProblems(after).length;
	const fixed = problems.length - remaining;
	await appendContext(
		ctx.cwd,
		changeId,
		"Contract repair",
		`${problems.length} issue(s) before, ${remaining} after: ${scopeRefProblems(after).map((p) => p.split(" — ")[0]).join(", ") || "(all fixed)"}`,
	);
	await record("contract-repair", "end", { model: phaseModels.get("propose")?.model, outcome: remaining === 0 ? "fixed" : "partial" });
	return after;
}

/** A single over-budget artifact: its name (as it appears to the user), its measured size, and
 *  the budget it blew past. */
interface TrimOverrun { file: string; chars: number; budget: number }

/** The artifacts a lane can trim, in the order the prompt lists them. Fast lane: the fast lane
 *  writes no design.md and no spec delta, so only proposal.md and tasks.md are candidates. */
function trimmableSizes(sizes: ArtifactSizes, lane: ChangeLane): { file: keyof ArtifactBudgets; size: number | undefined }[] {
	const all: { file: keyof ArtifactBudgets; size: number | undefined }[] = [
		{ file: "proposal", size: sizes.proposal },
		{ file: "design", size: sizes.design },
		{ file: "specs", size: lane === "fast" ? undefined : sizes.specs },
		{ file: "tasks", size: sizes.tasks },
	];
	return all;
}

/** Which artifacts exceed `1.5 * budget` right now (the only ones that trigger a trim turn). */
function trimOverruns(sizes: ArtifactSizes, budgets: ArtifactBudgets, lane: ChangeLane): TrimOverrun[] {
	const out: TrimOverrun[] = [];
	for (const { file, size } of trimmableSizes(sizes, lane)) {
		const budget = budgets[file];
		if (!Number.isFinite(budget) || size === undefined) continue;
		if (size > 1.5 * budget) out.push({ file, chars: size, budget });
	}
	return out;
}

/** Prompt for the one-shot Trim turn: rewrite ONLY the over-budget planning artifacts down to
 *  their budget by removing restated content — never drop a scenario, a task, or a contract
 *  file. Reuses the exact "do not touch code" wording from contractRepairPrompt. */
export function trimPrompt(overruns: TrimOverrun[]): string {
	return withRepoRule(
		"Some planning artifacts for this Readyset change are far over their character budget. " +
		"Rewrite ONLY the files listed below so each is at or under its budget — do not touch code, " +
		"and do not restructure any other part of proposal.md, design.md, specs/, or tasks.md.\n\n" +
		"Over budget:\n" +
		overruns.map((o) => `- ${o.file}: ${o.chars} chars (budget ${o.budget})`).join("\n") +
		"\n\nTrim by removing restated content: prose that repeats another artifact, duplicated " +
		"WHEN/THEN text that tasks.md could reference by scenario id instead, and filler. Do NOT drop " +
		"a scenario, do NOT drop a task, and do NOT remove a file from the `## Files This Change Will " +
		"Touch` scope contract — the change must still describe the same work. Planning artifacts only, " +
		"no code in this turn."
	);
}

/**
 * Bounded, one-shot Trim turn: if a planning artifact exceeds 1.5x its budget, fire ONE turn
 * (riding the propose phase model) that rewrites it down to budget by removing restated content,
 * then re-check the planning boundary and re-measure. Never loops — one turn per Propose/Refine.
 * An ordinary overrun (<= 1.5x) does not reach here at all: it only warns in the gate panel.
 *
 * `record` is the caller's `recordPhase`/`recordRepair` so the event carries the run's
 * lane/laneSource. The turn is reserved — it fires only if Apply + Review + one spare turn would
 * still remain (`turnsAvailableFor(budget, 3)`); otherwise the overrun only warns in the gate.
 */
async function runTrim(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	budget: TurnBudget,
	changeId: string,
	phaseModels: Map<string, { model: string; source: string }>,
	budgets: ArtifactBudgets,
	lane: ChangeLane,
	record: (phase: PhaseName, edge: "start" | "end", extra?: { model?: string; outcome?: string; artifactChars?: PhaseEvent["artifactChars"] }) => Promise<void>,
): Promise<void> {
	const before = await readArtifactSizes(ctx.cwd, changeId);
	const overruns = trimOverruns(before, budgets, lane);
	if (overruns.length === 0) return; // nothing past 1.5x: no event, no turn

	if (!turnsAvailableFor(budget, 3)) {
		ctx.ui.notify(
			`The planning artifacts for "${changeId}" are far over budget (${overruns.map((o) => `${o.file} ${o.chars}/${o.budget}`).join(", ")}), ` +
				"but trimming them now would starve Apply/Review of their turns — keeping the turns and only warning in the gate.",
			"warning",
		);
		await record("trim", "end", { outcome: "skipped-budget", artifactChars: { before, after: before } });
		return;
	}

	ctx.ui.notify(`Trimming over-budget planning artifacts for "${changeId}" (${overruns.map((o) => o.file).join(", ")})...`, "info");
	await record("trim", "start", { model: phaseModels.get("propose")?.model });
	await withPhaseModel(pi, ctx, "propose", phaseModels, () =>
		spendTurn(pi, ctx, budget, "Trim", trimPrompt(overruns)),
	);

	// The trim turn is a planning turn: it may only touch the change directory. Checked the same
	// way the Propose turn is; a violation treats the trim as failed (mirrors runContractRepair).
	const violations = await checkPhaseViolations(ctx.cwd, changeId, await pathsChangedThisRun(ctx.cwd, changeId));
	const after = await readArtifactSizes(ctx.cwd, changeId);
	if (violations.length > 0) {
		ctx.ui.notify(
			`The trim turn for "${changeId}" changed files outside the change directory (${violations.map((v) => v.path).join(", ")}) — treating the trim as failed.`,
			"error",
		);
		await appendContext(ctx.cwd, changeId, "Trim", `Trim turn wrote outside the change dir: ${violations.map((v) => `${v.path} (${v.detail})`).join("; ")}.`);
		await record("trim", "end", { model: phaseModels.get("propose")?.model, outcome: "partial", artifactChars: { before, after } });
		return;
	}

	// Trimmed when every file that was over 1.5x is now at or under its budget.
	const remaining = trimOverruns(after, budgets, lane);
	await appendContext(
		ctx.cwd,
		changeId,
		"Trim",
		`${overruns.length} artifact(s) over 1.5x budget before: ${overruns.map((o) => `${o.file} ${o.chars}/${o.budget}`).join(", ")}; ` +
			`${remaining.length} still over after.`,
	);
	await record("trim", "end", {
		model: phaseModels.get("propose")?.model,
		outcome: remaining.length === 0 ? "trimmed" : "partial",
		artifactChars: { before, after },
	});
}

interface ReviewSnapshot {
	counted: { done: number; total: number } | undefined;
	validated: Awaited<ReturnType<typeof validateChange>>;
	verification: Awaited<ReturnType<typeof checkTaskVerification>>;
	scope: Awaited<ReturnType<typeof checkScope>>;
	/** Dangling file references: contract paths (not marked `(new)`) that don't exist on disk.
	 *  Advisory, like `scope` — surfaced in the gate, never blocks. */
	scopeRefs: Awaited<ReturnType<typeof checkScopeRefs>>;
	explored: boolean;
	reviewed: boolean;
	/** Runtime evidence (readyset_verify) — independent of, and never reconciled with,
	 *  `verification` (the self-reported _Verified: note check) above. See
	 *  `findEvidenceConflicts`'s doc comment for exactly what "conflict" means here. */
	evidenceTotal: number;
	evidenceConflicts: Awaited<ReturnType<typeof findEvidenceConflicts>>;
	/** Per-artifact character counts, for the gate's budget line. */
	sizes: ArtifactSizes;
	/** proposal.md's `## Open Decisions` items still unresolved at the gate. */
	openDecisions: OpenDecision[];
	/** proposal.md's `## Assumptions` body, or undefined when absent. */
	assumptions: string | undefined;
	/** Full-lane `(assumed)` scenario names or fast-lane `(assumed)` acceptance bullets. */
	assumedScenarios: string[];
	/** Doc mentions (from `chosen.raw`) that the contract does not name. */
	missingDocs: string[];
	/** Advisory warnings for migration/release/deprecation docs with no contract or on-disk match. */
	missingDocWarnings: string[];
	/** Outside-repo tripwire count: tool calls this run observed reaching outside the repository.
	 *  Advisory — surfaced in the gate, never blocks. */
	outsideRepoAccess: number;
	/** Tool calls using a scratch directory under /tmp — reported alongside the headline, never
	 *  counted in `outsideRepoAccess` (stay-in-repo tripwire). Advisory. */
	outsideRepoTmpAccess: number;
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
	const scope = await checkScope(ctx.cwd, chosen.changeId, await pathsChangedThisRun(ctx.cwd, chosen.changeId));
	// Post-Apply the gate reopens with the change already implemented: a `(new)` file that Apply
	// created now exists and a `(delete)` file is gone, so the contract must be read with
	// post-Apply semantics or every one of them reads as a false NEW-BUT-EXISTS/DELETE-BUT-MISSING.
	const applied = await hasBeenApplied(ctx.cwd, chosen.changeId);
	const scopeRefsRaw = await checkScopeRefs(ctx.cwd, chosen.changeId, applied ? { afterApply: true } : {});
	const scopeRefs = applied ? { ...scopeRefsRaw, newButExists: [] } : scopeRefsRaw;
	const explored = await hasExploration(ctx.cwd, chosen.changeId);
	const review = await readReview(ctx.cwd, chosen.changeId);
	const { totalRecords: evidenceTotal } = await checkTaskEvidence(ctx.cwd, chosen.changeId);
	const evidenceConflicts = await findEvidenceConflicts(ctx.cwd, chosen.changeId);
	const sizes = await readArtifactSizes(ctx.cwd, chosen.changeId);
	const openDecisions = await readOpenDecisions(ctx.cwd, chosen.changeId);
	const assumptions = await readAssumptions(ctx.cwd, chosen.changeId);
	const assumedScenarios = await readAssumedScenarios(ctx.cwd, chosen.changeId);
	const missingDocs = await findMissingRequestedDocs(ctx.cwd, chosen.changeId, brainstormRequestText(chosen.raw), chosen.raw);
	const missingDocWarnings = await findDocFileWarnings(ctx.cwd, chosen.changeId, brainstormRequestText(chosen.raw), chosen.raw);
	return {
		counted: progress ? { done: progress.done, total: progress.total } : undefined,
		validated,
		verification,
		scope,
		scopeRefs,
		explored,
		reviewed: !!review,
		evidenceTotal,
		evidenceConflicts,
		sizes,
		openDecisions,
		assumptions,
		assumedScenarios,
		missingDocs,
		missingDocWarnings,
		outsideRepoAccess: outsideRepoCount(),
		outsideRepoTmpAccess: outsideRepoTmpCount(),
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
	const lane = await readChangeLane(ctx.cwd, chosen.changeId);
	const specFiles = lane === "fast" ? [] : await findSpecFiles(paths.specsDir).catch(() => [] as string[]);

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
			id: "open-decisions",
			heading: "Open decisions",
			status: snapshot.openDecisions.length > 0 ? `${snapshot.openDecisions.length} unresolved` : "none",
			render: async () => {
				const parts: string[] = [];
				if (snapshot.openDecisions.length === 0) {
					parts.push("_(none.)_");
				} else {
					for (const d of snapshot.openDecisions) {
						parts.push(`### ${d.question}`, "", d.raw || "_(no detail.)_", "");
					}
				}
				parts.push(`Assumptions: ${snapshot.assumptions ?? "_(none.)_"}`);
				parts.push("", "Assumed scenarios:", ...(snapshot.assumedScenarios.length > 0 ? snapshot.assumedScenarios.map((scenario) => `- ${scenario}`) : ["_(none.)_"]));
				return parts.join("\n");
			},
		},
		{
			id: "scope",
			heading: "Scope",
			status: snapshot.scope.noContract
				? "no contract"
				: snapshot.scope.outside.length +
							snapshot.scopeRefs.missing.length +
							snapshot.scopeRefs.newButExists.length +
							snapshot.scopeRefs.deleteButMissing.length >
						0
					? `${snapshot.scope.outside.length} out-of-scope, ${snapshot.scopeRefs.missing.length + snapshot.scopeRefs.newButExists.length + snapshot.scopeRefs.deleteButMissing.length} ref problem(s)`
					: "clean",
			render: async () => {
				const contract = await readScopeContract(ctx.cwd, chosen.changeId);
				if (contract.files === undefined) {
					return "_(no 'Files This Change Will Touch' contract in proposal.md — scope unknown.)_";
				}
				const contextRaw = await readContext(ctx.cwd, chosen.changeId).catch(() => undefined);
				// The last appendContext entry whose phase is "Contract repair" looks like
				// "## Contract repair — <ts>\n\n<N> issue(s) before, <M> after: ..."
				const repairMatches = [...(contextRaw ?? "").matchAll(/## Contract repair —[^\n]*\n\n(\d+) issue\(s\) before, (\d+) after/g)];
				const lastRepair = repairMatches[repairMatches.length - 1];
				const repairLine = lastRepair
					? `contract repair: fixed ${Number(lastRepair[1]) - Number(lastRepair[2])} of ${lastRepair[1]}`
					: "contract repair: not run";
				return [
					"Contract:",
					"",
					contract.raw || "(empty)",
					"",
					snapshot.scope.outside.length > 0
						? `Working-tree drift (changed but not in the contract): ${snapshot.scope.outside.join(", ")}`
						: "Working-tree drift (changed but not in the contract): none",
					snapshot.scopeRefs.missing.length > 0
						? `Dangling refs (named but don't exist, not marked (new)): ${snapshot.scopeRefs.missing.join(", ")}`
						: "Dangling refs (named but don't exist, not marked (new)): none",
					snapshot.scopeRefs.newButExists.length > 0
						? `New-but-exists (marked (new) but already on disk): ${snapshot.scopeRefs.newButExists.join(", ")}`
						: "New-but-exists (marked (new) but already on disk): none",
					snapshot.scopeRefs.deleteButMissing.length > 0
						? `Delete-but-missing (marked (delete) but not on disk): ${snapshot.scopeRefs.deleteButMissing.join(", ")}`
						: "Delete-but-missing (marked (delete) but not on disk): none",
					repairLine,
					...(snapshot.missingDocs.length > 0
						? snapshot.missingDocs.map((d) => `requested doc missing from contract: ${d}`)
						: []),
					...snapshot.missingDocWarnings,
					...(snapshot.outsideRepoAccess > 0 ? [`⚠ outside-repo access: ${snapshot.outsideRepoAccess} tool call(s) outside the repository (advisory)`] : []),
					...(snapshot.outsideRepoTmpAccess > 0 ? [`/tmp access: ${snapshot.outsideRepoTmpAccess} tool call(s) used a scratch directory (advisory, not counted in the outside-repo headline)`] : []),
				].join("\n");
			},
		},
		...(lane === "fast"
			? [
					{
						id: "artifacts",
						heading: "Artifact set",
						status: "fast lane: proposal + tasks",
						render: async () =>
							"Fast lane — this change carries proposal.md and tasks.md only; no design.md and no spec delta.",
					} satisfies ReviewSection,
				]
			: [
					{
						id: "design",
						heading: "Design",
						status: "design.md",
						render: () => readOrPlaceholder(paths.design, "_(design.md not found.)_"),
					} satisfies ReviewSection,
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
					} satisfies ReviewSection,
				]),
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
			snapshot.openDecisions.length > 0,
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

/** One gate line per artifact that has a real budget and a measured size, e.g.
 *  `artifacts: proposal 3,120 chars (budget 4,000)`; an overrun appends ` — OVER by N`.
 *  Artifacts whose budget is `Infinity` or whose size key is absent are skipped. */
function artifactBudgetLines(sizes: ArtifactSizes, budgets: ArtifactBudgets, lane: ChangeLane): string[] {
	const lines: string[] = [];
	for (const { file, size } of trimmableSizes(sizes, lane)) {
		const budget = budgets[file];
		if (!Number.isFinite(budget) || size === undefined) continue;
		const over = size > budget ? ` — OVER by ${(size - budget).toLocaleString()}` : "";
		lines.push(`artifacts: ${file} ${size.toLocaleString()} chars (budget ${budget.toLocaleString()})${over}`);
	}
	return lines;
}

function showReviewPanel(ctx: ReviewCtx, chosen: BrainstormMeta, snapshot: ReviewSnapshot, budget: TurnBudget, lane: ChangeLane, budgets: ArtifactBudgets): void {
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
		// Only surface when there is a problem — a clean contract needs no line.
		...((snapshot.scopeRefs.missing.length > 0 || snapshot.scopeRefs.newButExists.length > 0 || snapshot.scopeRefs.deleteButMissing.length > 0)
			? [
					"scope refs: " +
						[
							snapshot.scopeRefs.missing.length > 0 ? `DANGLING ${snapshot.scopeRefs.missing.join(", ")}` : "",
							snapshot.scopeRefs.newButExists.length > 0 ? `NEW-BUT-EXISTS ${snapshot.scopeRefs.newButExists.join(", ")}` : "",
							snapshot.scopeRefs.deleteButMissing.length > 0 ? `DELETE-BUT-MISSING ${snapshot.scopeRefs.deleteButMissing.join(", ")}` : "",
						]
							.filter(Boolean)
							.join(" · "),
				]
			: []),
		...artifactBudgetLines(snapshot.sizes, budgets, lane),
		...((snapshot.openDecisions.length > 0 || snapshot.assumptions !== undefined)
			? [
					`open decisions: ${snapshot.openDecisions.length}`,
					...snapshot.openDecisions.map(
						(d) => `  - ${d.question}${d.recommended ? ` → ${d.recommended}` : " (no recommendation)"}`,
					),
					...(snapshot.assumptions !== undefined ? ["assumptions: see proposal.md `## Assumptions`"] : []),
					...snapshot.assumedScenarios.map((scenario) => `assumed scenario: ${scenario}`),
				]
			: snapshot.assumedScenarios.length > 0 ? snapshot.assumedScenarios.map((scenario) => `assumed scenario: ${scenario}`) : []),
		...snapshot.missingDocs.map((d) => `requested doc missing from contract: ${d}`),
		...snapshot.missingDocWarnings,
		...(outsideRepoCount() > 0 ? [`⚠ outside-repo access: ${outsideRepoCount()} tool call(s) outside the repository (advisory)`] : []),
		...(outsideRepoTmpCount() > 0 ? [`/tmp access: ${outsideRepoTmpCount()} tool call(s) used a scratch directory (advisory, not counted in the outside-repo headline)`] : []),
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
 *
 * Fail-closed by construction: "Discard" is the first option, and any falsy/missing
 * selection (cancel, Esc, a host that resolves `undefined`) falls through to `undefined`,
 * which the caller treats as discard. No approval path can be reached by default, by
 * omission, or by a host-side stub resolving the first entry.
 */
async function classicGateSelect(
	ctx: ReviewCtx,
	chosen: BrainstormMeta,
	snapshot: ReviewSnapshot,
	taskSummary: string,
	openDecisions: number,
): Promise<ReviewOverlayResult | "resolve-decisions"> {
	for (;;) {
		const options: ExtensionUISelectOption[] = [
			{ label: "Discard", description: "leave as proposed, do nothing (the safe default — nothing runs unless you pick an Approve option)" },
			{ label: "Approve & Execute", description: `compact context first, then implement per tasks.md — ${taskSummary}` },
			{ label: "Approve & Execute, keep context", description: "implement without compacting (keep the full Explore/Propose discussion in context)" },
			{ label: "Refine", description: "describe what to change; revises the artifacts and re-validates" },
		];
		if (openDecisions > 0) {
			options.push({
				label: "Resolve open decisions",
				description: `${openDecisions} decision(s) still open — refine with them listed so you can pick the recommended option for each`,
			});
		}
		options.push({ label: "Jump to section", description: "browse one section at a time (exploration/proposal/design/specs/tasks/…)" });

		const choice = await ctx.ui.select(`Review change "${chosen.changeId}" — ${snapshot.validated.summary}`, options, {
			helpText: "enter to choose · esc to cancel",
		});

		if (choice === "Jump to section") {
			await browseReviewSections(ctx, chosen, snapshot);
			continue; // stay in the loop; re-show this same menu after they're done browsing
		}
		if (choice === "Approve & Execute") return "approve";
		if (choice === "Approve & Execute, keep context") return "keep-context";
		if (choice === "Refine") return "refine";
		if (choice === "Resolve open decisions") return "resolve-decisions";
		if (choice === "Discard") return "discard";
		return undefined; // cancelled (no choice)
	}
}

/**
 * Assembles the trigger input from the change's own on-disk state plus the values the caller
 * already has in scope. One place, so the main path and `runOnDemandReview` cannot disagree
 * about what "this run's diff/changed paths" means.
 *
 * `changedPaths` is passed in rather than re-derived: the caller already subtracted the dirty
 * baseline (`pathsChangedThisRun`), and re-running it here could observe a different tree.
 */
async function buildReviewTriggerInput(
	cwd: string,
	changeId: string,
	unjustifiedDriftPaths: string[],
	changedPaths: string[],
	clarity: ReviewTriggerInput["clarity"],
	thresholds: ParsedReviewThresholds,
	openDecisions: number,
	protectedPatterns: string[],
	testPaths: string[],
): Promise<ReviewTriggerInput> {
	const [conflicts, evidence, verification, progress, events] = await Promise.all([
		findEvidenceConflicts(cwd, changeId),
		checkTaskEvidence(cwd, changeId),
		checkTaskVerification(cwd, changeId),
		getProgress(cwd, changeId),
		readPhaseEvents(cwd, changeId),
	]);
	// The Apply `end` event carries the run's diff stats. Take the LAST one with
	// outcome "applied" so a send-back/re-apply cycle reports the final implementation.
	const applyEnd = [...events].reverse().find((e) => e.phase === "apply" && e.edge === "end" && e.outcome === "applied" && e.diff !== undefined);
	return {
		unjustifiedDriftPaths,
		evidenceConflicts: conflicts,
		evidenceTotal: evidence.totalRecords,
		verification,
		checkedTasks: progress?.done ?? 0,
		diff: applyEnd?.diff ?? { files: 0, added: 0, deleted: 0 },
		changedPaths,
		clarity,
		openDecisions,
		protectedPatterns,
		testPaths,
		verifiedCommandNotes: verification?.withCommandNote ?? 0,
		thresholds,
	};
}

/**
 * Writes the honest skip stub in place of a review turn's findings: what policy decided this,
 * and every trigger the evaluator looked at with its observed value. The point is that a reader
 * of REVIEW.md can tell "nothing was checked" from "everything was checked and it was clean" —
 * a missing file would read as the former.
 */
async function writeReviewSkipStub(cwd: string, changeId: string, result: ReviewTriggerResult, mode: string): Promise<void> {
	const header = mode === "never"
		? "Review skipped (never): readyset.review.mode = never"
		: "Review skipped (auto): no risk trigger";
	const lines = result.evaluated.map((e) => `- ${e.name}: ${e.value} — ${e.fired ? "fired" : "not fired"}`);
	await writeFile(
		changePaths(cwd, changeId).review,
		`# Code review\n\n${header}\n\nMode: ${mode}\nTriggers evaluated:\n${lines.join("\n")}\n`,
		"utf8",
	);
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
	reviewLane: "full" | "fast" = "full",
	reviewLaneSource: PhaseEvent["laneSource"] = "brainstorm",
	compactMode: "auto" | "always" | "never" = "auto",
	minContextPercent: number = DEFAULT_COMPACT_MIN_CONTEXT_PERCENT,
	artifactBudgets: ArtifactBudgets = DEFAULT_ARTIFACT_BUDGETS.full,
	reviewMode: ReviewMode = "auto",
	reviewFullLane: ReviewFullLane = "always",
	reviewThresholds: ParsedReviewThresholds = { ...DEFAULT_REVIEW_THRESHOLDS, warning: undefined },
	protectedPaths: string[] = [],
	testPaths: string[] = [],
	// The run's pinned model (--model / readyset.model.default) and its source label. Carried
	// explicitly because the pin lives in `executeBrainstorm`'s closure, not in `phaseModels`, and
	// the approve branch needs it to work out which model the handed-off execution runs on.
	pinnedModel: string | undefined = undefined,
	pinnedModelSource: string = "",
): Promise<void> {
	let chosen = initial;

	// This loop owns the gate/refine/apply/review/archive boundaries. It is module-scope, so it
	// has no access to the handler's `recordPhase`; this local writer records the same shape.
	// Never throws -- a phase log is diagnostics, not control flow. The archive `end` event lands
	// *after* archiveChange moved the change directory away, so its write legitimately fails.
	const recordPhase = async (
		changeId: string,
		phase: PhaseName,
		edge: "start" | "end",
		extra: { model?: string; outcome?: string; diff?: PhaseEvent["diff"]; boundary?: PhaseEvent["boundary"]; context?: PhaseEvent["context"]; artifactChars?: PhaseEvent["artifactChars"]; review?: PhaseEvent["review"]; counts?: PhaseEvent["counts"]; openDecisions?: number; outsideRepo?: number; outsideRepoTmp?: number } = {},
	): Promise<void> => {
		await appendPhaseEvent(ctx.cwd, changeId, {
			phase,
			edge,
			at: new Date().toISOString(),
			lane: reviewLane,
			laneSource: reviewLaneSource,
			...extra,
		}).catch(() => {});
	};

	const recordRepair = (phase: PhaseName, edge: "start" | "end", extra: { model?: string; outcome?: string; artifactChars?: PhaseEvent["artifactChars"] } = {}) =>
		recordPhase(chosen.changeId, phase, edge, extra);

	const recordReconcile = (phase: PhaseName, edge: "start" | "end", extra: { model?: string; outcome?: string; counts?: PhaseEvent["counts"] } = {}) =>
		recordPhase(chosen.changeId, phase, edge, extra);

	for (;;) {
		// Gate boundary opens before the review snapshot is taken (the panel the user sees) and
		// closes once `choice` is resolved. The gate is UI, not a model turn, so no `model` field.
		await recordPhase(chosen.changeId, "gate", "start");
		const snapshot = await takeReviewSnapshot(ctx, chosen);
		await flushOutsideRepoEntries(ctx.cwd, chosen.changeId);
		showReviewPanel(ctx, chosen, snapshot, budget, reviewLane, artifactBudgets);
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
				choice = await classicGateSelect(ctx, chosen, snapshot, taskSummary, snapshot.openDecisions.length);
			}
		} else {
			choice = await classicGateSelect(ctx, chosen, snapshot, taskSummary, snapshot.openDecisions.length);
		}

		if (!choice || choice === "discard") {
			await recordPhase(chosen.changeId, "gate", "end", { outcome: "discard", outsideRepo: outsideRepoCount(), outsideRepoTmp: outsideRepoTmpCount() });
			return;
		}

		// "Resolve open decisions" is a Refine pre-filled with the still-open decision list, so
		// the user picks (or confirms) the recommended option for each. It routes through the
		// ordinary Refine branch below — no `ctx.ui.input` prompt, the list IS the feedback.
		let refineFeedback: string | undefined;
		if (choice === "resolve-decisions") {
			refineFeedback =
				"Resolve these open decisions by picking (or confirming) the recommended option for each, then" +
				" update proposal.md's `## Open Decisions` (move each resolved one into `## Assumptions` with the" +
				" chosen behavior) and the affected scenarios:\n" +
				snapshot.openDecisions.map((d, i) => `${i + 1}. ${d.question} — recommended: ${d.recommended ?? "(none stated)"}`).join("\n");
			choice = "refine";
		}

		// "Approve & Execute" compacts first when the context clears the threshold (see
		// compactForPhase for why this is safe for a Readyset change specifically: everything
		// Explore/Propose produced is already persisted under readyset/changes/<id>/, and Apply
		// re-reads those files from disk). "Approve & Execute, keep context" skips the compact
		// entirely — the escape hatch for when discussion nuance didn't make it into the
		// artifacts. `--compact never` suppresses this default too. A missing ctx.compact (older
		// omp build) or a failed compaction degrades to plain Approve & Execute rather than
		// blocking the user from proceeding at all. A scope mismatch (out-of-contract files
		// already changed in the tree) likewise warns, never blocks: it is shown in the gate panel
		// so approval happens with eyes open, not stopped for work the user can see. "compact"
		// is kept as an accepted result for older sidebar builds that still return it (defensive;
		// the current overlay no longer offers it).
		if (choice === "keep-context") {
			// Apply without compacting: the compact boundary is still recorded, marked as skipped,
			// so every gate path leaves a balanced pair of phase events (gate start/end, and a
			// compact boundary for the Apply boundary either way).
			await recordPhase(chosen.changeId, "compact", "end", {
				model: phaseModels.get("apply")?.model,
				outcome: "skipped-keep-context",
				boundary: "apply",
			});
			await recordPhase(chosen.changeId, "gate", "end", { outcome: "approve-keep-context", openDecisions: snapshot.openDecisions.length, outsideRepo: outsideRepoCount(), outsideRepoTmp: outsideRepoTmpCount() });
			choice = "approve"; // fall through to Apply, skipping compaction
		} else if (choice === "approve" || choice === "compact") {
			const compactResult = await compactForPhase(
				pi,
				ctx,
				phaseModels,
				"apply",
				chosen.changeId,
				"executing",
				compactBeforeExecuteGuidance(chosen.changeId),
				compactMode,
				minContextPercent,
			);
			await recordPhase(chosen.changeId, "compact", "end", {
				model: phaseModels.get("apply")?.model,
				outcome: compactResult.outcome,
				boundary: "apply",
				context: { beforePercent: compactResult.beforePercent, afterPercent: compactResult.afterPercent },
			});
			choice = "approve";
			// The recorded outcome names the action the user took. The legacy `"compact"` result
			// (from older sidebar builds) means "approve, keep context" in 0.12.0's note, but the
			// gate treats it as a plain approve here, so both record `approve`.
			await recordPhase(chosen.changeId, "gate", "end", { outcome: "approve", openDecisions: snapshot.openDecisions.length, outsideRepo: outsideRepoCount(), outsideRepoTmp: outsideRepoTmpCount() });
		}

		if (choice === "refine") {
			await recordPhase(chosen.changeId, "gate", "end", { outcome: "refine", openDecisions: snapshot.openDecisions.length, outsideRepo: outsideRepoCount(), outsideRepoTmp: outsideRepoTmpCount() });
			const feedback = refineFeedback ?? (ctx.ui.input ? await ctx.ui.input("What should change?") : undefined);
			if (!feedback) {
				ctx.ui.notify("No feedback given — nothing changed.", "info");
				continue;
			}
			ctx.ui.notify(`Revising "${chosen.changeId}"...`, "info");
			// Refine rides the propose override -- same as withPhaseModel(..., "propose", ...).
			let refineOutcome = "aborted";
			await recordPhase(chosen.changeId, "refine", "start", { model: phaseModels.get("propose")?.model });
			try {
				const refineFired = await withPhaseModel(pi, ctx, "propose", phaseModels, () =>
					spendTurn(
						pi,
						ctx,
						budget,
						"Refine",
						refineTurnPrompt(chosen.changeId, feedback, snapshot.validated.issues.map((i) => `${i.file}: ${i.problem}`), reviewLane, artifactBudgets),
					),
				);
				if (!refineFired) return;
				refineOutcome = "refined";
				await appendContext(ctx.cwd, chosen.changeId, "Refine", `User feedback: ${feedback}`);
				await runContractRepair(pi, ctx, budget, chosen.changeId, phaseModels, recordRepair, chosen.raw);
				await runTrim(pi, ctx, budget, chosen.changeId, phaseModels, artifactBudgets, reviewLane, recordRepair);
			} finally {
				await recordPhase(chosen.changeId, "refine", "end", { model: phaseModels.get("propose")?.model, outcome: refineOutcome });
			}
			continue; // loop back: re-validate and show the panel/gate again
		}

		// "approve". Readyset scopes strictly up to the Review Gate. Once approved, the change
		// is marked approved, recorded in CONTEXT.md and phase events, UI is cleared, and execution
		// is handed off directly to core omp via pi.sendUserMessage(applyTurnPrompt(...)).
		await markApproved(chosen);
		await appendContext(
			ctx.cwd,
			chosen.changeId,
			"Apply",
			"Change approved at the Review Gate. Handing off execution to core omp.",
		);

		// Precedence mirrors withPhaseModel: the apply phase override wins, else the run's pin, else
		// the session model untouched. This deliberately does NOT call withPhaseModel — that would
		// restore in its own `finally`, which is the bug this whole path exists to avoid.
		const applyOverride = phaseModels.get("apply");
		const executionSpec = applyOverride?.model ?? pinnedModel;
		const executionSource = applyOverride ? applyOverride.source : pinnedModelSource;

		await recordPhase(chosen.changeId, "apply", "start", {
			model: executionSpec,
			outcome: "handoff-omp",
		});

		// The execution handoff is fire-and-forget: `pi.sendUserMessage` starts the turn and this
		// branch returns immediately, so withPinnedModel's `finally` would restore the pre-run model
		// exactly as execution begins. Apply the execution model here and record the handoff so
		// withPinnedModel leaves the pin alone (see its `finally`) until the execution settles.
		// The restore target for this handoff: the pin's captured pre-pin model when there was a pin
		// (withPinnedModel stored it in `handoffRestoreTarget`), else the session model captured at the
		// capture site below just before the execution model is applied. Stays undefined when no
		// execution model was ever applied, so the settle has nothing to restore and short-circuits.
		let restoreTarget: unknown = handoffRestoreTarget;
		const setModel = resolveHostSetModel(pi);
		const models = ctx.models;
		let executionModelApplied = false;
		if (!executionSpec) {
			// Nothing pinned or overridden: leave the session model alone.
		} else if (!setModel || !models?.current) {
			ctx.ui.notify(
				`Execution model "${executionSpec}" (from ${executionSource}) can't be applied — this omp build doesn't expose ` +
					"pi.setModel/ctx.models.current. Running on the current model.",
				"warning",
			);
		} else {
			const resolved = models.resolve ? models.resolve(executionSpec) : executionSpec;
			if (resolved === undefined || resolved === null) {
				ctx.ui.notify(
					`Execution model "${executionSpec}" (from ${executionSource}) didn't resolve to any available model — ` +
						"running on the current model.",
					"warning",
				);
			} else {
				// Capture the pre-apply session model only when nothing has captured one yet (no pin) and
				// we are genuinely about to apply: this instant's models.current() is still the pre-run
				// session model. On a failed apply the capture is skipped, leaving restoreTarget undefined
				// so the settle short-circuits the restore (nothing changed, nothing to restore).
				if (restoreTarget === undefined) restoreTarget = models.current();
				try {
					executionModelApplied = (await setModel(resolved)) !== false;
				} catch {
					executionModelApplied = false;
				}
				if (!executionModelApplied) {
					ctx.ui.notify(
						`Execution model "${executionSpec}" (from ${executionSource}) couldn't be applied (usually: no API key) — ` +
							"running on the current model.",
						"warning",
					);
				} else {
					ctx.ui.notify(`Execution runs on "${executionSpec}" (from ${executionSource}).`, "info");
				}
			}
		}
		if (!executionSpec) {
			ctx.ui.notify("Execution runs on this session's current model (no --model pin and no apply phase model).", "info");
		}

		// Armed before the send below, so withPinnedModel's `finally` (which runs during the
		// `return` right after) observes it and skips its restore. `restoreTarget` is the pin's
		// capture when there was a pin, else the session model captured above just before the
		// execution model was applied — so an apply override alone still restores. It stays
		// undefined when no execution model was applied, in which case handlePendingHandoff has
		// nothing to restore and short-circuits.
		pendingHandoff = { changeId: chosen.changeId, restoreTo: restoreTarget, cwd: ctx.cwd };

		if (typeof ctx.ui.setEditorText === "function") {
			ctx.ui.setEditorText("");
		}
		if (typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget("readyset", undefined);
		}

		ctx.ui.notify(`Approved "${chosen.changeId}". Handing off execution to core omp...`, "info");

		const applyOpenDecisions = await readOpenDecisions(ctx.cwd, chosen.changeId).catch(() => []);
		pi.sendUserMessage(applyTurnPrompt(chosen.changeId, applyOpenDecisions));
		return;
	}
}

/**
 * The archive offer shared by the main path and `runOnDemandReview` — one implementation, so a
 * skipped review and an on-demand one cannot drift on wording, options, or the archive
 * start/end phase events. `skipReason` selects the leading sentence; the drift prefix and the
 * three options are identical either way.
 */
async function offerArchive(
	ctx: ReviewCtx,
	chosen: BrainstormMeta,
	reviewContent: string | undefined,
	archiveDriftPaths: string[],
	recordPhase: (
		changeId: string,
		phase: PhaseName,
		edge: "start" | "end",
		extra?: { outcome?: string },
	) => Promise<void>,
	skipReason: "skipped-flag" | "skipped-no-trigger" | undefined,
	restoredPaths: string[],
	findings: { found: number; fixed: number } | undefined,
): Promise<void> {
	await flushOutsideRepoEntries(ctx.cwd, chosen.changeId);
	const outsideLine = outsideRepoCount() > 0 ? `⚠ outside-repo access: ${outsideRepoCount()} tool call(s) outside the repository (advisory). ` : "";
	const tmpLine = outsideRepoTmpCount() > 0 ? `/tmp access: ${outsideRepoTmpCount()} tool call(s) (advisory, not counted). ` : "";
	const restoredLine = restoredPaths.length > 0
		? `⚠ ${restoredPaths.length} file(s) the reconciliation turn reverted out of list were RESTORED (${restoredPaths.join(", ")}). `
		: "";
	const findingsLine = findings ? `blocking: ${findings.found} found, ${findings.fixed} fixed. ` : "";
	const driftLine = archiveDriftPaths.length > 0
		? `Apply touched ${archiveDriftPaths.length} file(s) outside the contract (${archiveDriftPaths.join(", ")}). `
		: "";
	const reviewLine = reviewContent
		? `Code review done for "${chosen.changeId}" — see ${changePaths(ctx.cwd, chosen.changeId).review}.`
		: skipReason === "skipped-flag"
			? `Code review skipped (never): readyset.review.mode = never.`
			: `Code review skipped (auto): no risk trigger — see the stub in ${changePaths(ctx.cwd, chosen.changeId).review}.`;
	const archiveChoice = await ctx.ui.select(
		`${outsideLine}${tmpLine}${restoredLine}${findingsLine}${driftLine}${reviewLine} Archive now?`,
		[
			{ label: "Archive now", description: "moves the change to changes/archive/ and merges deltas into specs/ (append-only, best-effort — review after)" },
			{ label: "Address findings first", description: "leave it in readyset/changes/ so you can fix review findings, then re-run /readyset" },
			{ label: "Not yet", description: "leave it in readyset/changes/ for now" },
		],
	);

	if (archiveChoice !== "Archive now") {
		// Every non-archive path still closes the boundary, so the compile step sees a single
		// `end` per archive window. `archiveChoice` is falsy on Esc/dismissed.
		await recordPhase(chosen.changeId, "archive", "end", { outcome: archiveChoice || "dismissed" });
		return;
	}

	await recordPhase(chosen.changeId, "archive", "start");
	try {
		// The fast lane carries no spec delta. Record that in CONTEXT.md *before*
		// archiveChange runs — the rename moves the change dir, so the append must land
		// while the live path still exists (same ordering as the pre-archive phase events).
		const archiveLane = await readChangeLane(ctx.cwd, chosen.changeId);
		if (archiveLane === "fast") {
			await appendContext(ctx.cwd, chosen.changeId, "Archive", "Fast lane: no spec delta to merge (skipped by design).");
		}
		const result = await archiveChange(ctx.cwd, chosen.changeId);
		if (result.specsMergeSkipped) {
			// Fast lane: nothing was merged *by design*, not because something failed. The
			// usual baseNotice warning path reads as if a merge went wrong, so it is skipped.
			ctx.ui.notify(
				`Archived to ${result.archivedDir}. Fast lane: this change carried no spec delta, so nothing was merged into readyset/specs/.`,
				"info",
			);
		} else {
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
		// archiveChange renamed the change dir to changes/archive/<date>-<id>/, so the
		// archive `end` event must target that location — writing to the live id would
		// find no CONTEXT.md (the move already happened). READYSET_ROOT is "readyset".
		const archivedChangeId = result.archivedDir.slice(join(ctx.cwd, "readyset", "changes").length + 1);
		await recordPhase(archivedChangeId, "archive", "end", { outcome: "archived" });
	} catch (err) {
		// Close the archive boundary before rethrowing: the caller must still see the
		// original error, but the phase log should record that archive did not complete.
		await recordPhase(chosen.changeId, "archive", "end", { outcome: "error" });
		throw err;
	}
}


/**
 * `/readyset --review <change-id>`: fire exactly one code-review turn for an existing,
 * not-yet-archived change and then offer archive as usual. Used when `auto` skipped review but
 * the user wants it before opening a PR. Overwrites any REVIEW.md stub.
 *
 * Uses `fireTurnAndWait` rather than `spendTurn`: on-demand review has no run budget of its own,
 * and it must always fire exactly one turn — a budget check here could silently fire none.
 */
async function runOnDemandReview(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	changeId: string,
	phaseModels: Map<string, { model: string; source: string }>,
	mode: ReviewMode,
	thresholds: ParsedReviewThresholds,
	protectedPaths: string[],
	testPaths: string[],
): Promise<void> {
	const state = await changeState(ctx.cwd, changeId);
	if (state === "archived") {
		ctx.ui.notify(
			`Change "${changeId}" is already archived — review runs only on a not-yet-archived change. ` +
				"Run /readyset on a new brainstorm for follow-up work.",
			"error",
		);
		return;
	}
	if (state === "none") {
		ctx.ui.notify(
			`No active change "${changeId}" found under readyset/changes/ — check the id (it is the change directory name, not the brainstorm title).`,
			"error",
		);
		return;
	}

	const lane = (await readChangeLane(ctx.cwd, changeId)) ?? "full";
	const recordPhase = async (
		id: string,
		phase: PhaseName,
		edge: "start" | "end",
		extra: { model?: string; outcome?: string; review?: PhaseEvent["review"] } = {},
	): Promise<void> => {
		await appendPhaseEvent(ctx.cwd, id, { phase, edge, at: new Date().toISOString(), lane, laneSource: "brainstorm", ...extra }).catch(() => {});
	};

	const changedPaths = await pathsChangedThisRun(ctx.cwd, changeId);
	const scope = await checkScope(ctx.cwd, changeId, changedPaths);
	const justified = new Set((await readScopeDeviations(ctx.cwd, changeId)).map((d) => d.path));
	const driftPaths = (scope.noContract ? [] : scope.outside).filter((p) => !justified.has(p));
	const brainstorm = await loadBrainstorms(ctx.cwd).then((all) => all.find((b) => b.changeId === changeId));
	const triggerResult = evaluateReviewTriggers(
		await buildReviewTriggerInput(ctx.cwd, changeId, driftPaths, changedPaths, brainstorm?.clarity, thresholds, (await readOpenDecisions(ctx.cwd, changeId)).length, protectedPaths, testPaths),
	);

	let reviewContent: string | undefined;
	let reviewOutcome = "aborted";
	await recordPhase(changeId, "review", "start", { model: phaseModels.get("review")?.model });
	ctx.ui.notify(`Running code review for "${changeId}"...`, "info");
	try {
		const deviationsForReview = await readScopeDeviations(ctx.cwd, changeId);
		await withPhaseModel(pi, ctx, "review", phaseModels, () =>
			fireTurnAndWait(pi, ctx, codeReviewTurnPrompt(changeId, lane, deviationsForReview, triggerResult, changedPaths)),
		);
		reviewContent = await readReview(ctx.cwd, changeId);
		reviewOutcome = reviewContent ? "review-written" : "no-review";
		await appendContext(
			ctx.cwd,
			changeId,
			"Code review",
			reviewContent ? "On-demand review — REVIEW.md written." : "On-demand review turn ran but REVIEW.md is empty or missing.",
		);
	} finally {
		await recordPhase(changeId, "review", "end", {
			model: phaseModels.get("review")?.model,
			outcome: reviewOutcome,
			review: {
				mode,
				triggersEvaluated: triggerResult.evaluated,
				triggersFired: triggerResult.fired,
				outcome: "on-demand",
			},
		});
	}

	if (reviewContent) {
		ctx.ui.setWidget?.("readyset", [`Change: ${changeId}`, "REVIEW.md:", ...reviewContent.split("\n").slice(0, 8)]);
	}
	ctx.ui.notify(`Code review for "${changeId}" done — see ${changePaths(ctx.cwd, changeId).review}.`, "info");

	// offerArchive needs a BrainstormMeta; an on-demand target may have no matching brainstorm
	// (a change recorded outside the brainstorm flow), so fall back to a minimal shape carrying
	// only what the archive path actually reads: the change id.
	await offerArchive(
		ctx,
		brainstorm ?? ({ changeId } as BrainstormMeta),
		reviewContent,
		driftPaths,
		recordPhase,
		undefined,
		[],
		undefined,
	);
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
		decision: string;
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
						decision: pi.zod
							.string()
							.describe(
								"the plan decision this question changes, and how the plan differs per answer — one short " +
									"sentence; a question whose answers all lead to the same plan must not be asked",
							),
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
			// Value-of-information gate: every question must name the plan decision it changes.
			// A question whose answers all lead to the same plan must not be asked at all — the
			// model decides it and records it under the brainstorm's "Assumed" list instead. This
			// is checked BEFORE rounds++ so a rejected round neither opens the dialog nor consumes
			// the round budget (a malformed round can be corrected without burning the ceiling).
			const missingDecision = askedQuestions.filter((q) => !q.decision || q.decision.trim() === "");
			if (missingDecision.length > 0) {
				return {
					content: [
						{
							type: "text",
							text:
								`Rejected: ${missingDecision.length} question(s) had no \`decision\` field (${missingDecision.map((q) => q.id).join(", ")}). ` +
								"Every question must name the plan decision it changes and how the plan differs per answer, in the " +
								"question's `decision` field. If a question's answers would all lead to the same plan, do not ask it — " +
								"decide it yourself and record it under an \"Assumed\" list in the brainstorm instead. Re-send this round " +
								"with a `decision` on every question.",
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
		else if (token === "--lane") {
			const value = (tokens[i + 1] ?? "").toLowerCase();
			if (value === "fast" || value === "full") {
				parsed.lane = value;
				i++;
			}
		} else if (token === "--compact") {
			// Deliberately NOT defaulted here: leaving it undefined lets the handler tell "unset"
			// from an explicit bad value (same pattern as --lane), so the caller can warn.
			const value = (tokens[i + 1] ?? "").toLowerCase();
			if (value === "auto" || value === "always" || value === "never") {
				parsed.compact = value;
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
		} else if (token === "--lang") parsed.lang = tokens[i + 1];
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

export async function executeBrainstorm(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	chosen: BrainstormMeta,
	options: BrainstormExecutionOptions,
): Promise<void> {
	const {
		laneOverride,
		laneDefault,
		parsedArgs,
		compactMode,
		effectiveReviewMode,
		reviewFullLane,
		reviewThresholds,
		scopeProtected,
		testPathsResult,
	} = options;

	// resolveLane() in readyset-brainstorm.ts answers "what did the file say"; the run's
	// lane additionally honors --lane (set above) and readyset.lane.default (a configured
	// `fast`/`full` forces it; `auto` accepts code's clarity→lane recommendation recomputed
	// fresh from the file's frontmatter). From here on, effectiveLane is the only lane
	// value this run may act on — read b.lane directly and you silently drop the operator's
	// override or the config default.
	const claritySignal = readClaritySignal(parseFrontmatter(chosen.raw).meta);
	const recommendation = recommendLane(claritySignal);
	const configLane: Lane | undefined =
		laneDefault === "fast" || laneDefault === "full"
			? laneDefault
			: laneDefault === "auto"
				? recommendation.lane
				: undefined;
	const effectiveLane = laneOverride ?? configLane ?? chosen.lane;
	if (laneOverride && laneOverride !== chosen.lane) {
		ctx.ui.notify(
			`Running "${chosen.changeId}" on the ${effectiveLane} lane (--lane override; the brainstorm records ${chosen.lane}). ` +
				(effectiveLane === "fast"
					? "Fast lane: lighter Explore folded into Propose, at most ~8 tasks, no mutation-testing review. Behavior questions are still asked."
					: "Full lane: the complete Grill → Explore → Propose → Review → Execute pipeline."),
			"info",
		);
	} else if (laneDefault === "auto" && recommendation.lane !== chosen.lane) {
		ctx.ui.notify(
			`Auto lane: clarity ${recommendation.clarity}` +
				`${recommendation.escalatedBy ? ` (risk flag: ${recommendation.escalatedBy})` : ""} recommends the ` +
				`${recommendation.lane} lane; the brainstorm records ${chosen.lane}. Running ${effectiveLane}.`,
			"warning",
		);
	}

	// Lane context every `recordPhase` below reads. `--lane` is the operator's explicit,
	// per-run answer to the lane question, so its source is "flag"; a configured
	// readyset.lane.default decides the lane, so its source is "config-auto"; under `ask`,
	// a brainstorm that carries the new clarity signal came from grilling just asking the
	// user, so its source is "user-pick"; an older/pre-existing file with no clarity signal
	// falls back to "brainstorm" (today's meaning, unchanged).
	const phaseLane: "fast" | "full" = effectiveLane;
	const phaseLaneSource: PhaseEvent["laneSource"] = laneOverride
		? "flag"
		: laneDefault === "auto" || laneDefault === "fast" || laneDefault === "full"
			? "config-auto"
			: chosen.clarity !== undefined
				? "user-pick"
				: "brainstorm";

	if (chosen.status === "archived") {
		ctx.ui.notify(`Change "${chosen.changeId}" is already archived. Start a new brainstorm for follow-up work.`, "warning");
		return;
	}

	const reviewCtx = ctx;
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

	// A phase's effective model, mirroring withPhaseModel's own precedence
	// (phaseModelOverrides wins, else the run's pinned model). withPhaseModel cannot report
	// back whether the override actually pinned, so the phase log records the spec that
	// *would* have been used: the override when one exists, else pinnedModel.
	const phaseModelFor = (phase: string): string | undefined =>
		phaseModelOverrides.get(phase)?.model ?? pinnedModel;

	// The `auto` threshold: a boundary compacts only when the host reports context usage
	// at or above this share of the window (see compactForPhase). A warning about an
	// invalid stored value is surfaced once, here, rather than per boundary.
	const resolvedCompactMin = await readCompactMinContextPercent();
	if (resolvedCompactMin.warning) ctx.ui.notify(resolvedCompactMin.warning, "warning");
	const minContextPercent = resolvedCompactMin.percent;

	// Per-artifact character budgets, resolved once for the run. The lane's own set is
	// picked once `effectiveLane` is known (it is by this point): the fast lane only
	// budgets proposal.md and tasks.md.
	const artifactBudgetsByLane = await readArtifactBudgets();
	const artifactBudgets = artifactBudgetsByLane[effectiveLane];

	// Writes one phase boundary event. Never throws: a phase log is diagnostics, not control
	// flow -- a write failure must not abort the run (mirrors appendContext's callers, which
	// also never guard). Notably the archive `end` event lands *after* archiveChange moved
	// the change directory away, so its write legitimately fails; that must not fail the run.
	const recordPhase = async (
		changeId: string,
		phase: PhaseName,
		edge: "start" | "end",
		lane: "fast" | "full",
		laneSource: PhaseEvent["laneSource"],
		extra: { model?: string; outcome?: string; diff?: PhaseEvent["diff"]; boundary?: PhaseEvent["boundary"]; context?: PhaseEvent["context"]; grill?: PhaseEvent["grill"]; artifactChars?: PhaseEvent["artifactChars"]; review?: PhaseEvent["review"] } = {},
	): Promise<void> => {
		await appendPhaseEvent(ctx.cwd, changeId, { phase, edge, at: new Date().toISOString(), lane, laneSource, ...extra }).catch(() => {});
	};

	const recordPhaseFor = async (phase: PhaseName, edge: "start" | "end", extra: { model?: string; outcome?: string; artifactChars?: PhaseEvent["artifactChars"] } = {}) =>
		recordPhase(chosen.changeId, phase, edge, phaseLane, phaseLaneSource, extra);

	const fallbackFromFlag = parsedArgs.fallbackModel;
	const resolvedConfigFallback = fallbackFromFlag ? undefined : await readFallbackChain();
	const fallbackChain = fallbackFromFlag ? [fallbackFromFlag] : (resolvedConfigFallback?.chain ?? []);
	const fallbackChainSource = fallbackFromFlag ? "--fallback-model flag" : (resolvedConfigFallback?.source ?? "");

	await withPinnedModel(pi, reviewCtx, pinnedModel, pinnedModelSource, fallbackChain, fallbackChainSource, async () => {
		if (isProposed(chosen.status)) {
			// Defensive: a change that predates the baseline mechanism has no capture
			// yet. This never overwrites an existing baseline (first capture wins).
			await ensureDirtyBaseline(ctx.cwd, chosen.changeId, await currentDirtyPaths(ctx.cwd).catch(() => []));
			await reviewAndMaybeExecute(pi, reviewCtx, chosen, budget, phaseModelOverrides, effectiveLane, phaseLaneSource, compactMode, minContextPercent, artifactBudgets, effectiveReviewMode, reviewFullLane, reviewThresholds, scopeProtected.paths, testPathsResult.paths, pinnedModel, pinnedModelSource);
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
		// Capture what was already dirty before this change's own planning turns ever
		// run, so the gate invariant and scope check subtract it rather than blaming
		// this change for unrelated repo state. First capture wins; later, dirtier
		// trees must not widen it.
		await ensureDirtyBaseline(ctx.cwd, chosen.changeId, await currentDirtyPaths(ctx.cwd).catch(() => []));

		// Grill boundary, recorded at the first opportunity: the change directory does not
		// exist during grilling (scaffoldChange above just created it), so a grill `start`
		// timestamp is not recoverable from CONTEXT.md. Only the boundary at which grilling
		// completed is written -- never synthesized from the brainstorm's date-only `created`
		// frontmatter, which would be a fabricated time.
		await recordPhase(chosen.changeId, "grill", "end", phaseLane, phaseLaneSource, {
			model: phaseModelFor("grill"),
			outcome: "grilled",
			grill: {
				clarity: recommendation.clarity,
				openDecisions: claritySignal.openDecisions,
				questionsAsked: chosen.questionsAsked,
				recommendedLane: recommendation.lane,
				laneReason: chosen.laneReason,
				riskFlag: claritySignal.riskFlag,
			},
		});

		// Fast lane folds Explore into Propose: no separate turn, no EXPLORATION.md turn.
		// The full-lane path (separate grounding turn that must produce EXPLORATION.md)
		// is unchanged below.
		const isFastLane = effectiveLane === "fast";
		let explored = false;
		const exploreBudget = startPhaseBudget();
		if (isFastLane) {
			await recordPhase(chosen.changeId, "explore", "start", phaseLane, phaseLaneSource, { model: phaseModelFor("explore") });
			await appendContext(
				ctx.cwd,
				chosen.changeId,
				"Explore",
				"Skipped as a separate turn — fast lane folds grounding into Propose (a few targeted reads, noted inline).",
			);
			await recordPhase(chosen.changeId, "explore", "end", phaseLane, phaseLaneSource, { model: phaseModelFor("explore"), outcome: "skipped-fast-lane" });
		} else {
			const submodules = await listSubmodules(ctx.cwd);
			ctx.ui.notify(`Exploring ground truth for "${chosen.changeId}" — this can take a while...`, "info");
			const exploreCompact = await compactForPhase(
				pi,
				reviewCtx,
				phaseModelOverrides,
				"explore",
				chosen.changeId,
				"Explore",
				compactBeforeExploreGuidance(chosen.changeId, chosen.file),
				compactMode,
				minContextPercent,
			);
			await recordPhase(chosen.changeId, "compact", "end", phaseLane, phaseLaneSource, {
				model: phaseModelFor("explore"),
				outcome: exploreCompact.outcome,
				boundary: "explore",
				context: { beforePercent: exploreCompact.beforePercent, afterPercent: exploreCompact.afterPercent },
			});
			let exploreOutcome = "aborted";
			await recordPhase(chosen.changeId, "explore", "start", phaseLane, phaseLaneSource, { model: phaseModelFor("explore") });
			try {
				const exploreFired = await withPhaseModel(pi, reviewCtx, "explore", phaseModelOverrides, () =>
					spendTurn(pi, reviewCtx, budget, "Explore", exploreTurnPrompt(chosen, submodules)),
				);
				if (!exploreFired) return;

				explored = await hasExploration(ctx.cwd, chosen.changeId);
				exploreOutcome = explored ? "exploration-written" : "no-exploration";
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
			} finally {
				await recordPhase(chosen.changeId, "explore", "end", phaseLane, phaseLaneSource, { model: phaseModelFor("explore"), outcome: exploreOutcome });
			}
		}

		ctx.ui.notify(`Proposing change "${chosen.changeId}"${isFastLane ? " (fast lane — grounding folded in)" : ""} — this can take a while...`, "info");
		const proposeCompact = await compactForPhase(
			pi,
			reviewCtx,
			phaseModelOverrides,
			"propose",
			chosen.changeId,
			"Propose",
			compactBeforeProposeGuidance(chosen.changeId, chosen.file, !isFastLane),
			compactMode,
			minContextPercent,
		);
		await recordPhase(chosen.changeId, "compact", "end", phaseLane, phaseLaneSource, {
			model: phaseModelFor("propose"),
			outcome: proposeCompact.outcome,
			boundary: "propose",
			context: { beforePercent: proposeCompact.beforePercent, afterPercent: proposeCompact.afterPercent },
		});
		const proposeBudget = startPhaseBudget();
		let proposeOutcome = "aborted";
		let proposeSizes: ArtifactSizes | undefined;
		await recordPhase(chosen.changeId, "propose", "start", phaseLane, phaseLaneSource, { model: phaseModelFor("propose") });
		try {
			const proposeFired = await withPhaseModel(pi, reviewCtx, "propose", phaseModelOverrides, () =>
				spendTurn(pi, reviewCtx, budget, "Propose", proposeTurnPrompt(chosen, effectiveLane, artifactBudgets)),
			);
			if (!proposeFired) return;
			proposeSizes = await readArtifactSizes(ctx.cwd, chosen.changeId);
			const violations = await checkPhaseViolations(
				ctx.cwd,
				chosen.changeId,
				await pathsChangedThisRun(ctx.cwd, chosen.changeId),
			);
			if (violations.length > 0) {
				proposeOutcome = "stopped-violation";
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
			proposeOutcome = "proposed";
			await appendContext(
				ctx.cwd,
				chosen.changeId,
				"Propose",
				`Propose turn ran; see proposal.md/design.md/specs/tasks.md.` +
					(proposeSizes ? ` Planning size: proposal ${proposeSizes.proposal ?? 0}, design ${proposeSizes.design ?? 0}, specs ${proposeSizes.specs}, tasks ${proposeSizes.tasks ?? 0} chars (lane ${phaseLane}).` : "") +
					` (phase wall time: ${Math.round(phaseBudgetElapsedMs(proposeBudget) / 1000)}s of ${Math.round(proposeBudget.maxMs / 1000)}s budget.)`,
			);
		} finally {
			await recordPhase(chosen.changeId, "propose", "end", phaseLane, phaseLaneSource, {
				model: phaseModelFor("propose"),
				outcome: proposeOutcome,
				artifactChars: proposeSizes ? { before: proposeSizes, after: proposeSizes } : undefined,
			});
		}
		if (phaseBudgetExceeded(proposeBudget)) {
			ctx.ui.notify(
				`Propose for "${chosen.changeId}" hit its phase budget (${Math.round(proposeBudget.maxMs / 60000)} min) — the artifacts exist but the turn ran long. ` +
					"Continuing to the gate; runaway cost like this is recorded in CONTEXT.md so you can see it.",
				"warning",
			);
		}

		await runContractRepair(pi, reviewCtx, budget, chosen.changeId, phaseModelOverrides, recordPhaseFor, chosen.raw);
		await runTrim(pi, reviewCtx, budget, chosen.changeId, phaseModelOverrides, artifactBudgets, effectiveLane, recordPhaseFor);

		const reloaded = await loadBrainstorms(ctx.cwd);
		await reconcileStatuses(ctx.cwd, reloaded);
		const after = reloaded.find((b) => b.changeId === chosen.changeId);

		const wroteProposal = after ? (await validateChange(ctx.cwd, after.changeId)).issues.every((i) => !(i.file === "proposal.md" && i.problem === "missing")) : false;

		if (!after || !isProposed(after.status) || !wroteProposal) {
			const why = !after
				? `no brainstorm matches the change id "${chosen.changeId}"`
				: !isProposed(after.status)
					? `its brainstorm status is "${after.status}", not proposed`
					: "proposal.md is missing or empty";
			ctx.ui.notify(
				`Propose for "${chosen.changeId}" doesn't look finished (${why}) — check the transcript above for errors, then run /readyset again.`,
				"warning",
			);
			return;
		}

		await reviewAndMaybeExecute(pi, reviewCtx, after, budget, phaseModelOverrides, effectiveLane, phaseLaneSource, compactMode, minContextPercent, artifactBudgets, effectiveReviewMode, reviewFullLane, reviewThresholds, scopeProtected.paths, testPathsResult.paths, pinnedModel, pinnedModelSource);
	});
}

export default function (pi: ExtensionAPI) {
	// Outside-repo tripwire (advisory). omp fires `tool_call` before every tool executes; older
	// builds and the test fakes have no `on`, so registration is feature-detected and no-ops.
	// The host surface is read through a named const on purpose (see the OverlayKeybindings note
	// above): this file takes zero type dependency on host internals, so the hook shape is cast
	// rather than imported.
	const toolCallHost = pi as unknown as {
		on?: (
			event: string,
			handler: (
				event: unknown,
				ctx: {
					cwd?: string;
					ui?: unknown;
					mode?: string;
					waitForIdle?: () => Promise<void>;
					isIdle?: () => boolean;
					hasPendingMessages?: () => boolean;
					models?: { current?: () => unknown; resolve?: (spec: string) => unknown };
				},
			) => void,
		) => void;
	};
	if (typeof toolCallHost.on === "function") {
		toolCallHost.on("tool_call", (event, ctx) => {
			if (outsideRepoState.cwd !== undefined && ctx?.cwd === outsideRepoState.cwd) {
				const call = event as { toolName?: string; input?: Record<string, unknown> };
				const kind = classifyOutsideRepoAccess(call.toolName ?? "", call.input ?? {}, outsideRepoState.cwd);
				if (kind) noteOutsideRepoCall(call.toolName ?? "", call.input ?? {}, kind);
			}
			if (activeGrillSession?.active) {
				const call = event as { toolName?: string; input?: Record<string, unknown> };
				if ((call.toolName === "write" || call.toolName === "write_file") && typeof call.input?.path === "string") {
					const p = call.input.path;
					if (p.includes(".ai/brainstorms") && p.endsWith(".md")) {
						activeGrillSession.writtenBrainstormFile = p;
					}
				}
			}
		});
		toolCallHost.on("agent_end", async (event, ctx) => {
			const endEv = event as { willContinue?: boolean } | undefined;
			// Terminal settles only. omp fires `agent_end` with `willContinue: true` whenever it has
			// already scheduled an automatic continuation (auto-retry, empty/unexpected-stop retry),
			// and documents that subscribers "must not treat this as a user-visible terminal settle"
			// (`AgentEndEvent.willContinue`, shared-events.ts). `session_stop` is deliberately NOT used
			// here: it is a *control* hook whose return value can schedule a hidden continuation turn,
			// so "settled" would be ambiguous, whereas a handler returning nothing is only consulted
			// when the session is already settling. `agent_end` fires once per genuinely settled run.
			if (endEv?.willContinue) return;
			// A settled execution handoff is handled first, before the grill block, so it still runs
			// when activeGrillSession is unset (the usual case: approve fires long after grilling).
			// We await it so *our own* restore and `apply` `end` write complete before this handler
			// returns — nothing externally waits on this handler: omp dispatches the extension
			// `agent_end` notification detached (`void this.#emitAgentEndNotification(...)` in
			// agent-session.ts, whose `.catch(logger.error)` only logs), so a throw here would be
			// invisible. The try/catch below exists for exactly that reason, and keeps a failure from
			// taking down the grill-transition block.
			try {
				await handlePendingHandoff(pi, ctx as unknown as ReviewCtx);
			} catch (err) {
				(ctx.ui as { notify?: (m: string, l?: string) => void } | undefined)?.notify?.(
					`Readyset: restoring the model after the handed-off execution failed: ${err instanceof Error ? err.message : String(err)}. ` +
						"Check /model if it looks off.",
					"warning",
				);
			}
			if (activeGrillSession?.active) {
				// Belt and braces: omp dispatches this handler detached (`void ...catch(logger.error)`
				// in agent-session.ts), so a throw here would be invisible to the user. The inner
				// notify in handleGrillEndTransition handles the common case; this outer one covers a
				// failure in the notify path itself or in the guard above.
				try {
					await handleGrillEndTransition(pi, ctx as unknown as ReviewCtx);
				} catch (err) {
					(ctx.ui as { notify?: (m: string, l?: string) => void } | undefined)?.notify?.(
						`Readyset: the grill→propose transition failed: ${err instanceof Error ? err.message : String(err)}. ` +
							"Run /readyset and pick the brainstorm to resume.",
						"error",
					);
				}
			}
		});
	}
	registerAskTool(pi);
	registerVerifyTool(pi);
	pi.registerCommand("readyset", {
		description:
			"Readyset: propose + review + execute a brainstorm against real repo state, standalone — no /plan or external CLI required " +
			"(flags: --all, --fast, --idea <raw idea text> to grill a new brainstorm from scratch, --lang <language> to open " +
			"grilling's discussion in that language from round 1 (must come before --idea), --model <spec> to pin a model " +
			"for this run's turns, --fallback-model <spec> if the pin fails to apply, " +
			"--lane <fast|full> to force the lane for the run and list fast-lane brainstorms in the picker (--fast only filters the picker; neither flag alone forces a lane), " +
			"--review auto|always|never|<change-id> to control (or re-run) the code-review turn)",
		handler: async (args, ctx) => {
			// `args` is the raw string omp hands a registered command (see parseReadysetArgs).
			const parsedArgs = parseReadysetArgs(args);
			const showAll = parsedArgs.all;

			// Standalone: bootstrap readyset/{changes,specs} ourselves if missing — there is no
			// separate init step or CLI to run first.
			await ensureReadysetRoot(ctx.cwd);
			resetOutsideRepoWatch(ctx.cwd);
			// A handoff whose execution turn never settled (user aborted the process, or a different
			// session's settle was never observed) must not linger. Settle it instead of dropping it:
			// settling restores the model this session had before the run and closes the `apply`
			// boundary (handoff-superseded), where the old resetPendingHandoff cleared the state with
			// no restore and left the session stuck on the execution model.
			await supersedePendingHandoff(pi, ctx as unknown as ReviewCtx);

			// Risk-based code-review policy, resolved once for the run. `--review
			// auto|always|never` (flag) wins over readyset.review.mode (config); the trigger
			// thresholds and the full-lane exemption come from config only. Read here, before
			// the picker, so the on-demand `--review <change-id>` path below can use them too.
			const resolvedReviewMode = await readReviewMode();
			if (resolvedReviewMode.warning) ctx.ui.notify(resolvedReviewMode.warning, "warning");
			const resolvedReviewFullLane = await readReviewFullLane();
			if (resolvedReviewFullLane.warning) ctx.ui.notify(resolvedReviewFullLane.warning, "warning");
			const reviewThresholds = await readReviewThresholds();
			if (reviewThresholds.warning) ctx.ui.notify(reviewThresholds.warning, "warning");
			const scopeProtected = await readScopeProtectedPaths();
			if (scopeProtected.warning) ctx.ui.notify(scopeProtected.warning, "warning");
			const testPathsResult = await readTestPaths();
			if (testPathsResult.warning) ctx.ui.notify(testPathsResult.warning, "warning");
			const effectiveReviewMode: ReviewMode = parsedArgs.review ?? resolvedReviewMode.mode;
			const reviewFullLane: ReviewFullLane = resolvedReviewFullLane.fullLane;
			if (parsedArgs.review === undefined && /(^|\s)--review(\s|$)/.test(args)) {
				ctx.ui.notify(
					"Ignoring --review with no mode or change id — expected auto, always, never, or a change id.",
					"warning",
				);
			}

			// `--review <change-id>`: on-demand, exactly one code-review turn for an existing
			// change, then the usual archive offer. Used when `auto` skipped review but the user
			// wants it before opening a PR. Handled before the brainstorm picker so it never
			// needs one.
			if (parsedArgs.reviewTarget !== undefined) {
				const reviewCtxForTarget = ctx as unknown as ReviewCtx;
				const resolvedPhaseModels = new Map<string, { model: string; source: string }>();
				for (const e of (await readPhaseModels()).entries) {
					if (!resolvedPhaseModels.has(e.phase)) resolvedPhaseModels.set(e.phase, { model: e.model, source: e.source });
				}
				await runOnDemandReview(
					pi,
					reviewCtxForTarget,
					parsedArgs.reviewTarget,
					resolvedPhaseModels,
					effectiveReviewMode,
					reviewThresholds,
					scopeProtected.paths,
					testPathsResult.paths,
				);
				return;
			}

			// --lane fast|full forces the lane for this run, bypassing the brainstorm's recorded
			// lane. It is the operator's explicit answer to the same question grilling asks at
			// close-out; a flag wins over the file for the same reason --model wins over config.
			// Anything else is ignored (never a silent default: an unknown --lane value must not
			// quietly run the wrong lane).
			const laneOverride = parsedArgs.lane === "fast" || parsedArgs.lane === "full" ? parsedArgs.lane : undefined;
			if (parsedArgs.lane !== undefined && laneOverride === undefined) {
				ctx.ui.notify(`Ignoring --lane "${parsedArgs.lane}" — expected fast or full. Running on the brainstorm's recorded lane.`, "warning");
			}

			// The picker filter must agree with the lane the run is about to use. An explicit
			// --lane (fast or full) IS the operator's lane answer, so a fast-lane brainstorm is
			// exactly what a `--lane fast` run asked for and `--lane full` must still let it be
			// listed — the operator picks it and the override decides the lane that actually runs.
			// Only the bare `/readyset` (no --fast, no --lane) hides fast-lane brainstorms.
			// Declared here, after laneOverride: reading `laneOverride` before its `const` would be
			// a temporal-dead-zone ReferenceError.
			const includeFast = parsedArgs.fast || laneOverride !== undefined;

			// --compact auto|always|never controls when a phase boundary actually compacts.
			// Anything else (or a bare --compact with no value) warns and uses "auto". The raw
			// `--compact` text test covers both "no value" and "bad value", since the parser only
			// sets `parsed.compact` on a valid mode.
			const compactMode: "auto" | "always" | "never" = parsedArgs.compact ?? "auto";
			if (parsedArgs.compact === undefined && /(^|\s)--compact(\s|$)/.test(args)) {
				ctx.ui.notify(`Ignoring --compact with no valid mode — expected auto, always, or never. Using "auto".`, "warning");
			}

			// readyset.lane.default decides whether the lane is asked by hand during grilling
			// (ask, today's behavior), auto-accepted from code's clarity→lane recommendation, or
			// forced. Resolved once here and threaded into both grilling and the effective lane.
			const resolvedLaneDefault = await readLaneDefault();
			if (resolvedLaneDefault.warning) ctx.ui.notify(resolvedLaneDefault.warning, "warning");
			const laneDefault = resolvedLaneDefault.laneDefault;

			const execOptions: BrainstormExecutionOptions = {
				laneOverride,
				laneDefault,
				parsedArgs,
				compactMode,
				effectiveReviewMode,
				reviewFullLane,
				reviewThresholds,
				scopeProtected,
				testPathsResult,
			};

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
				startGrilling(pi, ctx as unknown as ReviewCtx, ideaFromFlag, laneDefault, preferredLanguage, execOptions);
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
					`No full-lane brainstorms found in ${BRAINSTORM_DIR}/ (--fast or --lane includes fast-lane, --all includes archived)` +
						(canGrillFromScratch ? ` -- or run /readyset --idea "<your raw idea>" to grill a new one into existence.` : ""),
					"warning",
				);
				return;
			}

			const byLabel = new Map<string, BrainstormMeta>();
			const options: ExtensionUISelectOption[] = items.map((b) => {
				const label = `${b.created ?? "?"} · ${b.title}`;
				const effectiveLane = laneOverride ?? b.lane;
				const lane = laneOverride
					? `${effectiveLane} lane (--lane override)`
					: b.laneSource === "default"
						? "full lane (assumed)"
						: `${b.lane} lane`;
				const next = b.status === "archived" ? "done" : isProposed(b.status) ? "→ review" : "→ propose + review";
				const clarityTag = b.clarity
					? `clarity ${b.clarity}${b.recommendedLane && b.recommendedLane !== b.lane ? ` → ${b.recommendedLane}` : ""}`
					: undefined;
				byLabel.set(label, b);
				return { label, description: [next, lane, b.namespace, clarityTag].filter(Boolean).join(" · ") };
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
				startGrilling(pi, reviewCtxForInput, idea, laneDefault, preferredLanguage, execOptions);
				return;
			}

			const chosen = byLabel.get(picked);
			if (!chosen) return;

			await executeBrainstorm(pi, ctx as unknown as ReviewCtx, chosen, execOptions);
		},
	});
}
