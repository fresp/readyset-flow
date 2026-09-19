---
name: brainstorm-ai
description: Read-only interactive brainstorming session (idea/option exploration, NOT detailed planning) whose output is saved as a markdown file in .ai/brainstorms/ at the project root. This file is meant to be picked up by another harness (e.g. omp) that will handle implementation planning or an OpenSpec proposal. Invoke manually via /brainstorm-ai — do not auto-trigger.
argument-hint: [topic/problem to brainstorm]
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash(git log:*), Bash(git diff:*), Bash(git status:*), Bash(find:*), Bash(ls:*), Bash(openspec list:*), Bash(openspec show:*), Bash(mkdir -p .ai/brainstorms), Write
---
# /brainstorm-ai
Topic from user: **$ARGUMENTS**
Today's date: !`date +%Y-%m-%d`

## This is NOT planning mode
The goal of this session is divergent thinking — exploring the solution space before anything is decided. Do not close the session with a single ready-to-execute implementation plan with step 1-2-3. Detailed planning is intentionally left to another harness (outside Claude Code) that will read this brainstorm file as starting context.

## Ground rules
1. **Fully read-only.** No Edit, no Write except to `.ai/brainstorms/*.md` at the end of the session. No commands that mutate repo state — this skill never runs `git branch`, `git commit`, `openspec new change`, or creates merge requests itself; it only records the intended git workflow and spec impact for whichever harness does the actual execution. Repo research (Read/Grep/Glob/read-only Bash) is only to understand real technical context & constraints — not to prepare implementation steps.
2. **Use existing conversation context first.** `$ARGUMENTS` may just be a short topic label, not the full picture. Before asking the user anything, check what has already been discussed earlier in this chat session — problem framing, constraints, options already floated, decisions leaning one way, technical details already surfaced. Treat all of that as part of the brainstorm's starting context, the same way you'd treat a repo research finding. Only ask the user about what's genuinely still missing or ambiguous — don't re-ask something already covered earlier in the conversation.
3. **Interactive, not one-shot.** Don't write the file on the first turn. Discuss with the user first:
   - Offer at least 2 different options/approaches if the problem has more than one reasonable way in.
   - Ask about unclear constraints or preferences (one question per turn, don't bundle them).
   - Explore the trade-offs of each option together with the user, not just conclude on your own.
   - Before writing the file, confirm with the user: is this enough to write, or do they want to keep exploring.
4. **Rough/unfinished is fine.** If by the end of the session some questions are still unanswered or options haven't converged, that's normal — write it as-is under "Open questions," don't force a conclusion just to look tidy.
5. **Session language:** every question, answer, and output shown to the user during the Q&A — options offered, trade-off discussion, confirmations — is in Bahasa Indonesia (technical terms may stay in English), so the user stays comfortable and familiar throughout the session. **The saved brainstorm file, however, is written entirely in English** — headers, prose, everything — so it reads as a standard, portable doc that any downstream AI harness (not just Indonesian-fluent ones) can pick up without translation. Treat this as a language switch at the very last step: think and converse in Indonesian the whole session, then translate/write the final `.ai/brainstorms/*.md` content in English only when actually saving it.
6. **Close with a decision, not just a lean.** Before writing the file, don't let the session end on a soft "leaning toward X." Explicitly ask the user (in Indonesian):
   - Which option is chosen — or should the planning harness decide based on the trade-offs listed?
   - Seam: which module/boundary will this change touch or be tested at — ideally just one? Prefer an existing seam over inventing a new one; if a new seam is genuinely needed, confirm that with the user too.
   - What's in-scope vs out-of-scope for this brainstorm?
   - What are the acceptance criteria / how do we know this is done?
   If the user says "let the planning harness decide," write that explicitly — don't leave it blank. This can take a few more turns; don't skip it just because the user already said the exploration part is "enough."
7. **Auto-derive the git workflow, don't ask.** Once the brainstorm content is settled (Problem/Context, Decision, Seam), infer the branch type yourself from what the file actually says — don't ask the user to pick one:
   - `feature` — new capability being added
   - `bugfix` — fixing broken existing behavior
   - `hotfix` — urgent production issue, needs fast turnaround
   - `refactor` — restructuring existing code, no behavior change
   - `chore` — tooling, config, dependency, non-product work
   - `docs` — documentation only
   - `test` — test coverage only, no production code change
   - `adjust` — small tweak to existing behavior, not a new capability or a fix
   - `experimental` — exploratory spike, uncertain if it ships
   - `release` — preparing a release (version bump, changelog, tagging)
   - `main` / `develop` — reserved for repo baseline branches; never auto-picked for a brainstorm's own branch
   Branch name is `<type>/<slug>`. State the inferred type and a one-line reason in the file — this is a stated inference, not a question, so no back-and-forth needed unless the user objects to it when reviewing the file.
   Per-task flow (commit only vs commit + merge request per task) is still asked directly, since that's a workflow preference the content itself can't reveal.
8. **Derive the lane from the branch type, don't ask.** The lane tells the downstream harness whether this change needs a spec/proposal gate before code:
   - `full` — branch type is `feature`, `adjust`, or `experimental`. New or changed behavior, so it goes through an OpenSpec proposal and review before implementation.
   - `fast` — branch type is `bugfix`, `hotfix`, `refactor`, `chore`, `docs`, `test`, or `release`. Restores or preserves behavior that is already specified, so it goes straight to implementation.
   Write the resolved value into the `lane` frontmatter field. When a `fast` type nevertheless changes user-visible behavior (e.g. a "bugfix" that is really a behavior change), say so in one line under Spec Impact and set `lane: full` instead — the type stays as inferred, the lane is the override.
9. **Record spec impact when the repo uses OpenSpec.** If an `openspec/` directory exists at the project root, use the read-only `openspec list` and `openspec show` commands during repo research to see which capabilities already have specs, and fill in the Spec Impact section. Keep it at gist level — one line per capability, naming what changes and how. Do **not** write requirements, scenarios, or delta spec syntax here; that is the proposal step's job, and pre-writing it defeats the point of an exploratory session. If there is no `openspec/` directory, write `Not applicable — this project does not use OpenSpec.` and move on.

## File structure (written once the user confirms the session is done)
```markdown
---
title: <short topic title>
slug: <slug>
status: open
lane: full/fast
change_id:
created: <date>
namespace: <e.g. oca-ai/voip-asterisk, or cross-namespace>
---

## Problem / Context
<what's being solved, why it's relevant now — pull this from earlier conversation context if it was already discussed, not just from the short $ARGUMENTS topic>

## Options Explored
### Option A: <approach name>
- Pros: ...
- Cons: ...

### Option B: <approach name>
- Pros: ...
- Cons: ...

(add more options if any)

## Leaning Direction
<if the discussion leaned toward one option, state it here with reasoning. If not yet, write "Not yet decided.">

## Decision
- Chosen option: <Option A / Option B / "Deferred to planning harness">
- Rationale: <why, if chosen>

## Seam
<the module/boundary where this change will be built and tested — ideally just one. State why an existing seam was reused, or why a new one was necessary.>

## Scope
- In scope: ...
- Out of scope: ...

## Acceptance Criteria
- WHEN <trigger/condition> THEN <observable outcome>
- WHEN <trigger/condition> THEN <observable outcome>

## Spec Impact
- Existing capabilities touched: <spec-id> — MODIFIED: <one line on what changes>
- New capabilities: <proposed-id> — ADDED: <one line on what it covers>
- Removed behavior: <none, or one line>

## Git Workflow
- Branch: <type>/<slug> — type auto-inferred from this brainstorm's content (feature, bugfix, hotfix, refactor, chore, docs, test, adjust, experimental, or release; never main/develop)
- Inference reason: <one line on why this type fits — e.g. "new capability, no existing behavior touched" → feature>
- Lane: <full | fast> — <one line: derived from branch type, or why it was overridden>
- Per-task flow: <"commit only" | "commit + merge request per task">

## Open Questions
- <things left unanswered / to be decided during planning>

## Technical Constraints & Notes from Repo
- <concrete findings from read-only research, e.g. existing event contracts, existing patterns, cross-service dependencies>

## Next Step
<see "Next Step wording" below — depends on the lane>
```
Frontmatter field notes:
- `slug`: kebab-case, short, same slug used in the filename. Downstream harnesses derive the OpenSpec change id from this, so keep it a valid id: lowercase letters, digits, and hyphens only.
- `status`: always `open` when this skill creates the file. Later values (`proposed`, `archived`) are set by whichever harness picks it up, never by this skill. `planned` is a legacy value from the pre-OpenSpec flow and is equivalent to `proposed`.
- `lane`: `full` or `fast`, per rule #8. Always write it explicitly — a missing value makes the downstream harness assume `full`.
- `change_id`: leave **empty** when this skill writes the file. The harness fills it in once an OpenSpec change actually exists.
- `namespace`: repo/project path if the topic is scoped to one, otherwise `cross-namespace`.

Acceptance criteria format notes:
- Write each criterion as `WHEN <trigger> THEN <observable outcome>`. This is the shape a spec scenario and a verify step both need, so it carries through without rewriting.
- Keep them observable from outside the seam — an outcome someone (or a test) can check. "Retry logic is correct" is not a criterion; "WHEN the upstream returns 503 three times THEN the request fails with a 504 and one log line per attempt" is.
- If a criterion cannot be made observable yet, leave it in Open Questions rather than writing a vague one.

Next Step wording:
- `lane: full` → `Continue with an OpenSpec proposal in another harness, using this file as starting context.`
- `lane: fast` → `Continue to detailed planning in another harness, using this file as starting context.`

## Execution steps
1. Read the topic from `$ARGUMENTS`, and scan back through this chat session for anything already discussed that's relevant — problem context, constraints, options, technical findings, any leaning already expressed. Merge that into your working understanding of the topic before doing anything else. If needed, also do light read-only repo research for real context (not to prepare a plan). If an `openspec/` directory exists, include `openspec list` in that research per rule #9.
2. Start the interactive brainstorming discussion with the user per the ground rules above — all questions, options, and back-and-forth in Bahasa Indonesia. Skip questions already answered by earlier conversation context; only ask about what's still open. This may take several conversation turns — don't rush to close it.
3. Before writing the file, run the closing questions from rule #6 — decision (or explicit deferral), seam, scope, acceptance criteria — and ask the per-task git flow from rule #7 (commit only vs commit + merge request). Auto-infer the branch type per rule #7 and the lane per rule #8 yourself rather than asking. Don't skip straight to writing just because the user said the exploration part is enough.
4. Once decision/seam/scope/acceptance/git workflow are captured (or explicitly deferred):
   - Derive a slug from the title (kebab-case, short) — this same slug goes into both the filename and the `slug` frontmatter field.
   - Resolve `lane` per rule #8, and fill Spec Impact per rule #9.
   - Run `mkdir -p .ai/brainstorms`.
   - Write the result to `.ai/brainstorms/<date>-<slug>.md`, in full English, following the structure above, with `status: open` and an empty `change_id`.
5. Report back to the user (in Indonesian, matching the session): the path of the file created, a 2-3 sentence summary of the brainstorm's content, the resolved lane and what that means for the next step (`full` → proposal first, `fast` → straight to planning), and a reminder that this file is ready to be picked up by another harness — not by this session.
