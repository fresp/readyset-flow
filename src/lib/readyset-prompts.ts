import type { BrainstormMeta } from "./readyset-brainstorm.ts";
import { type ArtifactBudgets, DEFAULT_ARTIFACT_BUDGETS, type LaneDefault } from "./readyset-omp-config.ts";
import type { ReviewTriggerResult } from "./readyset-review-trigger.ts";
import { type ChangeLane, type OpenDecision, type ScopeDeviation, changePaths } from "./readyset-spec.ts";
import type { TestRun, VerifySettings } from "./readyset-verify.ts";

/** Every prompt /readyset fires (grill, explore, propose, refine, apply, review, repair, trim)
 *  and the compaction guidance for each phase boundary. Pure string builders. */
/** One line, injected into every phase prompt and mirrored verbatim in src/skill/SKILL.md. Shared
 *  from this single constant so the wording cannot drift between phases. */
export const STAY_IN_REPO_RULE =
	"Work only inside the current repository (the working directory). Never search or read outside it " +
	"(no `find /`, no absolute paths outside the repo, no home-directory files, logs or notes), and never " +
	"inspect Readyset's own implementation, package or configuration. They are not part of the task.";

/** Appends the rule as the last paragraph of a phase prompt. */
export const withRepoRule = (prompt: string): string => `${prompt}\n\n${STAY_IN_REPO_RULE}`;

export const ARTIFACT_GUIDE_HEADER = `Write proposal.md with a YAML frontmatter block whose first line is \`lane: full\` or \`lane: fast\` matching this run's lane, then the required sections below.

Write exactly these files under readyset/changes/<id>/ (create directories as needed):
`;

export const PROPOSAL_GUIDE_BULLET = `- proposal.md — must have a "## Why" section (1-2 paragraphs on the problem), a
  "## What Changes" section (bullet list of concrete changes), and a "## Files This Change
  Will Touch" section: an exhaustive repo-relative path list of every existing file Apply is
  allowed to modify plus every new file it may create. Mark each new file with a trailing
  "(new)" (e.g. "- src/lib/thing.ts (new)") so the gate can tell a file the change creates from
  one that must already exist — an unmarked path that doesn't exist is a dangling reference and
  gets flagged. Mark a file this change deletes with "(delete)" (e.g. "- src/legacy.ts (delete)");
  it must exist before Apply and is allowed to be gone afterward. This is the scope contract the gate
  and Apply are checked against — keep it tight: an over-wide contract routinely grows files nobody
  asked for. List the minimum set of files
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

export const FULL_LANE_GUIDE_BULLETS = `- design.md — "## Context", "## Goals / Non-Goals", "## Decisions" (numbered, each with
  Rationale and Alternatives considered), "## Risks / Trade-offs".
- specs/<capability-slug>/spec.md — "## Purpose", then "## ADDED Requirements" with one
  or more "### Requirement: <name>" blocks, each followed by one or more
  "#### Scenario: <name>" blocks written as:
    - **WHEN** <trigger>
    - **THEN** <observable outcome>
  Use MODIFIED/REMOVED Requirements sections instead of ADDED when changing or removing
  existing behavior already covered by an existing spec.`;

export const FAST_LANE_ACCEPTANCE_GUIDE = `List every acceptance scenario under \`## Acceptance\` in proposal.md as
"- **WHEN** ... **THEN** ...", one per bullet, and give it an id in the form \`[S1]\`, \`[S2]\`,
... in document order; tasks.md references those ids.`;
export const TASKS_GUIDE_BULLET = `- tasks.md — numbered sections, each task a "- [ ] N.M <description>" checkbox line with
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
export function artifactGuide(lane: ChangeLane, budgets: ArtifactBudgets): string {
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
 * grilling still asks them, and real runs' wins came from exactly those questions.
 */
export function fastLaneProposeSuffix(): string {
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
	// Lane-aware grounding: on the full lane, a prior Explore turn already wrote EXPLORATION.md,
	// so Propose re-reads and anchors to it. On the fast lane, Explore is folded into THIS turn —
	// no separate turn ran, so telling the model to read a file that does not exist yet (and to
	// anchor claims to entries in it) is a direct contradiction fastLaneProposeSuffix then has to
	// paper over. The fast lane instead grounds inline and anchors to its own reads, entirely via
	// fastLaneProposeSuffix below.
	const groundingBlock =
		lane === "fast"
			? `Create a Readyset change named "${b.changeId}" from the brainstorm at ${b.file}. Read the brainstorm fully first.\n\n`
			: `Create a Readyset change named "${b.changeId}" from the brainstorm at ${b.file}. ` +
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
				"indistinguishable from a guess.\n\n";
	return withRepoRule(
		groundingBlock +
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
		(lane === "fast"
			? ""
			: "If EXPLORATION.md surfaced something the brainstorm didn't anticipate (a submodule it didn't mention, a config " +
				"value that's already drifted), fold it into What Changes / tasks.md rather than silently dropping it.\n\n") +
		"The working tree may already be dirty: pre-existing uncommitted changes, stray comments " +
		"(e.g. an inline `// TODO` or a short user note left by the person working in this repo), and untracked files " +
		"are the user's ACTIVE work " +
		"in progress, not leftovers. NEVER propose cleaning up, removing, or deleting them, and never add an " +
		"untouched dirty or untracked file to `## Files This Change Will Touch` just to tidy it — the " +
		"contract names files this change writes, not files that merely exist. Plan to edit AROUND them: " +
		"read the current file content and make your change fit it, leaving every pre-existing comment and " +
		"uncommitted hunk exactly as you found it.\n\n" +
		"Scope discipline: do NOT invent secondary systems that were not requested — for example, don't add " +
		"authentication, authorization, or credential-validation logic to satisfy an unrelated feature (e.g. rate " +
		"limiting or grouping requests by some key) unless it was explicitly asked for. When in doubt, leave it out; " +
		"an unrequested system is a scope violation, not thoroughness.\n\n" +
		"Bugfix and refactor doc boundary: if this change is a bugfix, refactor, or chore, NEVER touch " +
		"documentation files (`README.md`, `CHANGELOG.md`, `docs/*`) or add them to `## Files This Change Will Touch` " +
		"unless documentation was explicitly requested in the prompt. Do not invent doc updates for code fixes.\n\n" +
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
export function applyTurnPrompt(
	changeId: string,
	openDecisions: OpenDecision[] = [],
	lane: ChangeLane = "full",
	// Default keeps the pre-lite contract (notes required, no test command) for any caller that does
	// not pass readyset.verify; executeBrainstorm always passes the resolved settings.
	verify: VerifySettings = { requireNotes: true },
): string {
	if (!verify.requireNotes) return applyTurnPromptVerified(changeId, openDecisions, lane, verify.command);
	return applyTurnPromptWithNotes(changeId, openDecisions, lane);
}

/** The apply prompt when Readyset verifies deterministically (readyset.verify.requireNotes: false):
 *  it runs the project's test command itself at readyset_done, so the prompt asks for working code
 *  and a real check, not for a note ritual or evidence citations. */
function applyTurnPromptVerified(changeId: string, openDecisions: OpenDecision[], lane: ChangeLane, testCommand: string | undefined): string {
	const paths = changePaths("", changeId);
	const readList = lane === "fast"
		? `${paths.proposal} and ${paths.tasks}`
		: `${paths.proposal}, ${paths.tasks}, and ${paths.design} / specs under ${paths.specsDir} where they exist`;
	const openDecisionsBlock = openDecisions.length > 0
		? "\n\nThis change was approved with " + openDecisions.length + " open decision(s) still unresolved. For each one below, apply the " +
			"RECOMMENDED option — the user approved on that basis — and record it in a `## Decisions made during Apply` section of tasks.md as " +
			"`- <decision> → <chosen option> → <why>`.\n" +
			openDecisions.map((d) => `- ${d.question} — recommended: ${d.recommended ?? "(none stated)"}`).join("\n")
		: "";
	const doneCheck = testCommand
		? `Readyset then runs \`${testCommand}\` itself and refuses "done" if it fails, so run it yourself first.`
		: "Readyset then closes the execution.";
	return withRepoRule(
		`Implement the Readyset change "${changeId}". Read ${readList} first.\n\n` +
		"Work through the tasks in tasks.md. For each: make the smallest change that satisfies it, check that it " +
		"actually works (run the relevant test, hit the endpoint, run the script), then tick it `- [ ]` -> `- [x]`. " +
		"A short `_Verified: …_` note under a task is welcome where the check is not obvious; it is not required. " +
		"If a test pins behavior that came from an `(assumed)` scenario, say so in its name or a comment.\n\n" +
		"Stay inside the scope contract (proposal.md `## Files This Change Will Touch`, plus its `(new)`/`(delete)` " +
		"files). If another file is truly required, change it and record it under `## Scope deviations` in tasks.md " +
		"as `- <path> — <reason>`. Leave the user's existing edits, comments and untracked files as they are, and do " +
		"not refactor or reformat code a task does not need.\n\n" +
		"If a task is unclear or you are blocked, stop and ask — call `readyset_done` with status \"blocked\" and the " +
		"exact question, ask it, and end your turn. When every task is done, call `readyset_done` with status " +
		`"done" and a one-line summary as your last action. ${doneCheck}` +
		openDecisionsBlock
	);
}

/** The pre-lite apply prompt, used when readyset.verify.requireNotes is true. */
function applyTurnPromptWithNotes(changeId: string, openDecisions: OpenDecision[], lane: ChangeLane): string {
	const paths = changePaths("", changeId); // relative paths only; cwd prefix stripped for the prompt
	// Fast lane carries no design.md and no spec delta (artifactGuide/ARTIFACT_GUIDE_HEADER never
	// asked Propose to write them) -- telling Apply to read files a fast-lane run never produced
	// is the same lane contradiction proposeTurnPrompt's grounding block avoids.
	const readList = lane === "fast" ? `${paths.proposal} and ${paths.tasks}` : `${paths.proposal}, ${paths.design}, every specs/**/spec.md under ${paths.specsDir}, and ${paths.tasks}`;
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
		`Implement the Readyset change "${changeId}". Read ${readList} before starting. ` +
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
		"(e.g. an inline TODO or a short note left by the person working in this repo) and uncommitted hunk intact when you edit a " +
		"file — never strip, reword, reformat, or delete a stray comment or a hunk you did not write, and " +
		"never delete or stage away an untracked file that was already there. Edit AROUND it." +
		"\n\nKeep going until every task is complete or you are blocked, then report progress as N/M tasks." +
		"\n\nPrefer verifying through the `readyset_verify` tool: give it the task id and the command, and it runs " +
		"the command and stores the real exit code and output as an evidence record (E001, E002, ...). Cite that " +
		"record in the task's note as `evidence E00N`, e.g. `_Verified: evidence E003 — \\`npm test\\`, 12/12 pass_`. " +
		"A cited record is checked: one that does not exist, belongs to another task, or failed is flagged as a " +
		"conflict, and readyset_done will not accept \"done\" while any conflict remains." +
		"\n\nSignal the outcome with the `readyset_done` tool — it is how Readyset knows execution is over, " +
		"instead of guessing from checkboxes. When every task is checked and has its `_Verified:` note, call " +
		"`readyset_done` with status \"done\" and a one-line summary as your last action. If you cannot continue " +
		"without the user (an unclear requirement, missing access, a decision outside the spec), call it with " +
		"status \"blocked\" and the exact question, then ask that question and end your turn." +
		openDecisionsBlock
	);
}

export function compactBeforeExecuteGuidance(changeId: string): string {
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
export function compactBeforeExploreGuidance(changeId: string, brainstormFile: string): string {
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
export function compactBeforeProposeGuidance(changeId: string, brainstormFile: string, explored: boolean): string {
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
 * Code-review turn — fired on demand by `/readyset --review <change-id>` (runOnDemandReview)
 * once a handed-off execution is done, before the archive offer; the settle only recommends it
 * (applyReviewPolicyAtSettle). This is the mattpocock/skills "review critically in a separate pass"
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
	tests?: TestRun,
): string {
	const paths = changePaths("", changeId);
	// The one deterministic fact the review starts from: Readyset ran the project's test command.
	const testsLine = tests
		? tests.passed
			? `Readyset ran \`${tests.command}\` just before this review and it passed; do not re-run the whole suite just to confirm that — spend the effort on what the tests do not cover.\n\n`
			: `Readyset ran \`${tests.command}\` just before this review and it FAILED (${tests.timedOut ? "timed out" : `exit ${tests.exitCode ?? "none"}`}). A failure caused by this change is blocking. Last output:\n\`\`\`\n${tests.tail}\n\`\`\`\n\n`
		: "";
	// Lane-aware read list, same reasoning as applyTurnPrompt's: the fast lane never writes
	// design.md or a spec delta, and its scenarios live under proposal.md's `## Acceptance`.
	const readList = lane === "fast"
		? `${paths.proposal} (its \`## Acceptance\` scenarios) and ${paths.tasks}`
		: `${paths.proposal}, ${paths.design}, every specs/**/spec.md under ${paths.specsDir}, and ${paths.tasks}`;
	const triggerLine = triggerResult && triggerResult.fired.length > 0
		? `This review was triggered by: ${triggerResult.fired.join(", ")}. Focus your findings on these.\n\n`
		: "";
	return withRepoRule(
		`Critically review the implementation of Readyset change "${changeId}". This review must start from the diff, not from the repo: ` +
		(changedPaths.length > 0
			? `the files this run changed are ${changedPaths.join(", ")}. `
			: "read the diff of the files this run changed. ") +
		`Then read ${readList} ` +
		"(including tasks.md's _Verified: notes) for the scenarios those files are supposed to satisfy. Read any other file only " +
		"when the diff needs context to be judged — do not read the whole repo. You did not write this implementation; " +
		"your job is to find problems " +
		"in it, not to confirm it's fine.\n\n" +
		triggerLine +
		testsLine +
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
 * tracks how many rounds have run for the current grilling session (`state.grillRounds`, reset by
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
export const GRILL_ROUND_CAP = 4;

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
 * entirely and just write a brainstorm from its own assumptions. `state.grillRounds.active` is
 * deliberately scoped tight to avoid false alarms: it only means "grilling was started THIS
 * session and the gate hasn't looked yet" — a brainstorm hand-written, or grilled in an earlier
 * omp process, leaves `active` at its default `false` and triggers no warning, since this
 * session genuinely has no signal either way about it. It only fires for the one scenario it can
 * actually attest to: a grilling run that started and finished (or was abandoned) in this same
 * process without ever calling `readyset_ask`. See the gate's call site (in the command handler)
 * for how this combines with `validateBrainstormContent`. */

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
			"- Do NOT invent secondary systems that were not requested — for example, don't add authentication, " +
			"authorization, or credential-validation logic to satisfy an unrelated feature unless it was explicitly " +
			"required by the idea. Ask if a real auth requirement seems implied; never " +
			"assume one into the plan.\n" +
			"- Working tree and scope discipline: pre-existing uncommitted changes, stray comments in code (e.g. " +
			"an inline TODO or a short user note left by the person working in this repo), " +
			"and untracked files are the user's active work in progress — never treat them as noise " +
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
			"behavior. Also auto-derive (don't ask) the branch type with a one-line reason.\n\n" +
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
			"## Leaning Direction\n## Decision\n- Chosen option: <Option A / Option B>\n- Rationale: <one line>\n## Assumed\n- none\n## Seam\n## Scope\n## Acceptance Criteria\n## Spec Impact\n" +
			"## Git Workflow\n- Branch: <type>/<slug>\n- Inference reason: <one line>\n" +
			"- Lane: <full | fast> — <one line>\n" +
			"## Open Questions\n## Technical Constraints & Notes from Repo\n## Next Step\n\n" +
			"Under `## Assumed`, list each decision you made yourself without asking — one per line as " +
			"`- <the decision> — because all answers led to the same plan` — or `- none` if there were none. " +
			"Once the file is written, tell the user its path and summarize the decisions made — do not " +
			"fire off Explore or Propose yourself in this turn."
	);
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

/** A single over-budget artifact: its name (as it appears to the user), its measured size, and
 *  the budget it blew past. */
export interface TrimOverrun { file: string; chars: number; budget: number }

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
