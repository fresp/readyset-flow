---
name: readyset
description: Use when working with Readyset changes (readyset/changes/<id>/) — writing or reading EXPLORATION.md, proposal.md, design.md, specs/**/spec.md, tasks.md, CONTEXT.md, or REVIEW.md, whether inside /readyset or in a manual turn (e.g. "check readyset/changes/foo", "why did the propose turn skip X").
---

# Readyset

Readyset turns a brainstorm into a grounded, reviewable, executable change under
`readyset/changes/<id>/`. This skill is the reference for the file formats and phase
discipline `/readyset` enforces in code — read it whenever you're working with a Readyset
change directly (reading one to answer a question, hand-editing an artifact, or picking up a
change that got interrupted mid-phase) rather than only through the command's own triggered
turns.

## The phase order, and why it's in this order

```
Explore -> Propose -> (Review gate: Approve / Refine / Discard) -> Apply -> Code review -> Archive
```

On the **fast lane** (a small, well-understood change) Explore is folded into Propose — no
separate turn, just a few targeted reads noted inline in `CONTEXT.md` — and the code-review turn
skips mutation-testing-style probes. Everything else is the same.

Each phase exists to catch something the previous one is bad at catching on its own:

1. **Explore** (`EXPLORATION.md`) — grounds the change in real repo state *before* any
   planning prose gets written. Read any docker-compose/.env.example for config keys the
   change touches, check `.gitmodules` and submodule commits against superproject gitlinks,
   run relevant tests. Write one entry per thing actually checked: what you checked (exact
   file/command/commit) and what you found (the real value or output, not a paraphrase). "I
   checked X, found nothing relevant" is a legitimate entry — don't force a problem into
   existence to have something to report. In `proposal.md`/`design.md`, anchor every repo claim
   to one of these entries (or a "verified during planning" note) — an unanchored claim is
   indistinguishable from a guess.

   This phase exists because prose alone is not enough: an earlier version of Propose was
   told, in its own prompt, to check `.gitmodules` — and still silently dropped a submodule
   from its output under the combined load of writing proposal + design + specs + tasks in
   one turn. Making Explore its own turn, with the submodule list already extracted and
   handed to it, is a structural fix; a stronger sentence in the same crowded prompt was not.

2. **Propose** (`proposal.md`, `design.md`, `specs/**/spec.md`, `tasks.md`) — the planning
   artifacts, grounded in Explore's findings rather than re-deriving them. See "File formats"
   below for the required shape of each file. This turn may **only** write planning artifacts
   under `readyset/changes/<id>/` — writing implementation code here stops the run with no gate
   offered.

3. **Review gate** — a human decides: Approve & Execute, Refine (describe what's wrong, loops
   back into another Propose-equivalent turn), or Discard. Nothing executes without this, and
   Discard is the default: the gate is fail-closed, so cancelling runs nothing.

4. **Apply** — implements `tasks.md` one task at a time. Keep the diff minimal: touch only files
   in the scope contract, update every doc it lists (an untouched listed doc is a dropped
   requirement, not a saving), make no unrequested refactors/renames/reformatting/helpers, and
   change tests only to exercise the specs' WHEN/THEN scenarios. Never modify seed data,
   fixtures, or sample data in production paths unless the request asks for it; never add runtime
   self-checks/assertions to production code; and never change an existing test's expectations
   unless the requested behavior changes them. A task is only checked off once something actually
   verified it (a test run, a curl, a script execution) — not once code was written that's
   expected to work. See "The `_Verified:` note" below.

5. **Code review** (`REVIEW.md`) — its own turn, after Apply, before Archive. It is told
   explicitly that its job is to find problems, not confirm the work — the turn that just
   implemented something is a poor judge of its own diff, since it already believes its
   choices were correct. (Not a fresh session — omp's extension API offers none — so the
   adversarial framing is the mitigation.) If this phase finds nothing, it says so plainly
   rather than padding the file to look thorough.

6. **Archive** — moves the change to `readyset/changes/archive/<id>/` and merges its delta
   specs into `readyset/specs/` (append-only — never a real ADDED/MODIFIED/REMOVED diff-merge;
   review the merged spec afterward).

`CONTEXT.md` is appended to after every phase transition, deterministically, by the
extension itself — not by the model. If you're picking up a change mid-flight, read
`CONTEXT.md` first; it's the ground truth for what phases have actually run, in order, with a
one-line summary of each.

## File formats

**Which artifacts exist depends on the lane**, recorded as the first line of `proposal.md`'s
frontmatter (`lane: full` or `lane: fast`; a missing line reads as `full`). The **full lane**
writes `proposal.md` / `design.md` / `specs/**/spec.md` / `tasks.md`. The **fast lane** writes
`proposal.md` and `tasks.md` only — no `design.md`, no spec delta — and puts its acceptance
scenarios under a `## Acceptance` section in `proposal.md` instead (each bullet
`- **WHEN** … **THEN** …`, with a `[S1]`, `[S2]`, … id in document order that `tasks.md` references
rather than restating).

Each implementer-facing artifact ends with a trailing `## Grounding` section for exploration-entry
or `verified during planning` anchors. Artifact bodies never mention Readyset's own workflow;
workflow terms outside `## Grounding` are flagged warning-only.

**`EXPLORATION.md`** — a findings log. One entry per thing checked: what was checked (exact
file path / command / commit), what was found (the actual value/output). No fixed section
headers required, but every entry needs a checked-vs-found pair — a claim with no "here's what
I actually looked at" attached does not belong in this file.

**`proposal.md`**
- `lane:` frontmatter line (`full` or `fast`) — the on-disk source of truth for the lane.
- `## Why` — 1-2 paragraphs on the problem.
- `## What Changes` — bullet list of concrete changes.
- `## Files This Change Will Touch` — exhaustive repo-relative list. This is the **scope
  contract**: the review gate checks the working tree against it and flags anything changed that
  isn't named. Omitting the section means "no contract", never "everything allowed". Every doc
  the request or brainstorm asks for (README, CHANGELOG, docs/…) must be listed here, marked
  `(new)` when the change creates it; migration/release-note/deprecation mentions join the
  contract only when they match an existing file. During Apply, every listed doc must actually
  be updated.
- `## Acceptance` — **fast lane only**; the spec delta's replacement. One `- **WHEN** … **THEN** …`
  bullet per scenario, each with a `[S1]`, `[S2]`, … id.
- `## Open Decisions` — every decision that is still undecided, one `### <question>` block each
  with `- Options:` / `- Recommended:` / `- Changes per option:` lines (or the single line
  `none`). Anything the repo, the brainstorm or a lookup can settle must be answered instead of
  listed here, and nothing may be left "carried open" in `design.md`/`specs/`/`tasks.md`. A
  decision with no `- Recommended:` line is flagged (warning-only) in the gate.
- `## Assumptions` — each brainstorm `## Assumed` item restated as
  `- <assumed decision> — <chosen behavior>` (or `none`), so what was assumed rather than asked is
  visible at approval.

**`design.md`** — **full lane only**
- `## Context`
- `## Goals / Non-Goals`
- `## Decisions` — numbered, each with Rationale and Alternatives considered.
- `## Risks / Trade-offs`

**`specs/<capability-slug>/spec.md`** — **full lane only**
- `## Purpose`
- `## ADDED Requirements` (or `MODIFIED`/`REMOVED` when changing existing behavior already
  covered by an existing spec under `readyset/specs/`) — one or more `### Requirement: <name>`
  blocks, each followed by one or more `#### Scenario: <name>` blocks written as:
  - `**WHEN** <trigger>`
  - `**THEN** <observable outcome>`
  - Every behavior-changing assumption gets its own scenario marked `(assumed)`; the gate lists
    each before approval.

**`tasks.md`** — numbered sections, each task a `- [ ] N.M <description>` checkbox line. Each task
maps to a scenario (a proposal `## Acceptance` id on the fast lane, a spec scenario on the full
lane) rather than restating its WHEN/THEN text. A task that pins an `(assumed)` scenario's behavior
carries `(assumed)` in its description, and a test that pins one says so in its name or an adjacent
comment. A `## Scope deviations` section records any file changed outside the scope contract
(`- <path> — <reason>`), and a `## Decisions made during Apply` section records each open decision
applied at the recommended option (`- <decision> → <chosen option> → <why>`).

### The `_Verified:` note

Immediately below a checked task line, add an indented note in this exact format:

```
- [x] 1.1 Add rate limiting to the webhook endpoint
  _Verified: ran `npm test`, 12/12 pass; curl'd the endpoint 15x in 1s, got 429 on the 11th_
```

For a task with no real way to verify (a doc-only change, say), still add a note explaining
why rather than leaving the box unexplained:

```
- [x] 2.3 Update README with the new config key
  _Verified: doc-only, no behavior to check_
```

A checked box with no `_Verified:` note under it means the task was marked done without
anything that actually checked it — `checkTaskVerification()` in `readyset-spec.ts` counts
these, and the review gate in `/readyset` will stop and offer to send the change back
for another pass if any are missing. Don't check a box you haven't verified just to look
further along.

**`REVIEW.md`** — a findings list from the code-review phase: does the implementation
actually match every requirement's WHEN/THEN scenarios (or does it narrow/skip/half-implement
any of them), are the `_Verified:` notes credible (a vague note like "looks correct" is not a
verification), and any correctness bug or regression risk visible in the touched files,
whether or not `tasks.md` mentioned it. It ends with a `## Blocking` section — one bullet per
finding that violates a WHEN/THEN scenario, an explicit requirement (including a doc the request
or the contract asked for that was never written), or a recorded decision, or the literal `none`.
A non-empty `## Blocking` fires **exactly one** bounded *review-fix* turn (on the apply phase
model) that fixes only those findings and appends a `## Fix turn` section recording each one fixed
or not-fixed; no second review runs. That turn's `review-fix` phase event carries `fixed` /
`partial` / `skipped-budget` / `not-needed`, it re-runs the post-Apply scope check (warning only),
and the archive prompt states `blocking: N found, M fixed`.

**`CONTEXT.md`** — append-only, one `## <Phase> — <ISO timestamp>` entry per phase
transition, written by the extension automatically. Never hand-edit this file; it's an audit
trail, not a planning document. It also carries a one-time `readyset-baseline-dirty` block —
the repo paths that were already dirty before the change started — which the gate invariant and
scope check subtract so unrelated WIP isn't blamed on this change.

The post-Apply **scope reconciliation** turn may only touch this run's *own* out-of-contract
files — those changed by this run and absent from the dirty baseline; files already dirty before
the run are never candidates, and with no dirty baseline at all no revert is offered. Its
candidates are copied to `readyset/changes/<id>/reverted/<path>` before the turn and recorded in
`CONTEXT.md`, and any file it changes or deletes outside that list is restored byte-for-byte from
a pre-turn snapshot and logged loudly.

## What Readyset deliberately does not do

- `validateChange` is a shallow structural check (required sections exist, at least one
  requirement+scenario, at least one task, each requirement's THEN names an externally checkable
  signal) — not a real schema validator. A "validate: pass" in the review panel means structurally
  complete, not semantically correct.
- The gate invariant is a boundary check, not a phase audit: it catches a Propose turn writing
  outside `readyset/changes/<id>/`, from the working tree, after the turn has run. It can't see
  what a turn did inside those paths.
- Per-phase wall-clock budgets warn and record; they don't kill a phase mid-turn.
- `archiveChange`'s spec merge is append-only, never a real diff-merge. Review the merged
  spec after archiving.
- None of Readyset's own file-format or phase logic is a fork of, or stays compatible with, any
  other spec-driven-development tool. It doesn't read from or write to any other tool's files.
