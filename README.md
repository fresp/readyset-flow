# Readyset

Readyset is a standalone omp extension. It turns a brainstorm sitting in `.ai/brainstorms/*.md`
into a grounded, reviewable, executable change under Readyset's own `readyset/changes/<id>/`
directory — without depending on omp's native `/plan`, or any external spec-driven-development
CLI, at runtime. The proposal/design/spec/tasks split is a well-established shape for this kind
of work, but Readyset's directory layout, file format, and validation are its own — it does not
read from, write to, or stay compatible with any other tool's files.

## Why "Readyset"

The name is the point: the one thing that consistently separates a plan you can trust from one
you can't is whether it's actually anchored to the real state of the repo — real file contents,
real commit hashes, real test runs — instead of assumptions. Readyset fuses three sources, each
filling a gap the others leave:

- **omp `/plan`'s grounding discipline** — cite real files/line numbers/commit hashes, catch
  actual drift (a stale config default, a submodule pinned to the wrong commit), give a
  procedure an engineer can literally run. This is the harshest, most valuable habit of the
  three, and the easiest for a model to skip under time/context pressure. Enforced by a
  dedicated **Explore** phase (below), not just a prompt instruction.
- **The structured-spec workflow** popularized by spec-driven-development tooling — a
  proposal/design/spec/tasks split, requirements written as WHEN/THEN scenarios, Open Questions
  carried forward rather than silently resolved, and a review gate between "written" and
  "executing".
- **mattpocock/skills' prompting hygiene** — interrogate ambiguity before writing anything down,
  never mark work done without something that actually verifies it, and review a diff critically
  in a separate pass rather than trusting the same turn that wrote it. Enforced by the
  **`_Verified:` note requirement** and the separate **code-review** phase (below).

Each of these is a structural gate in the code (a phase that has to run, a machine-checkable
condition that has to hold), not just something described in a prompt — a prompt alone already
proved insufficient once: an earlier version of the propose turn was told in prose to check
`.gitmodules`, and still silently dropped one of two submodules from its output. Prose is a
request; a gate is a requirement.

## Install

```
npm install --save-dev readyset-review
npx readyset-review install
```

This copies Readyset's `.ts` source into `.omp/lib/` and `.omp/extensions/`, and the skill doc
into `.agent/skills/`, in the current directory (or pass `--target <path>` for a different repo
root). There is no build step — omp loads extensions as `.ts` files directly, so the source is
what gets installed. These are omp's own documented project-level discovery paths — extensions
auto-discover from `<cwd>/.omp/extensions` (`docs/extension-loading.md`), skills from the
canonical `.agent[s]/skills/<name>/SKILL.md` location (`docs/skills.md`) — not a guess: an
earlier version of this installer used an undotted `agent/` convention that omp never actually
scanned, so nothing installed with it was ever loaded. If you installed with that older version,
re-run install and delete the stale `agent/` directory.

Re-run `npx readyset-review install` after bumping the `readyset-review` version in a consuming repo to pick
up changes. **Don't hand-edit the installed files** — they get overwritten on the next install.
If a repo needs different behavior, change it here and re-publish, not in the copy.

## Use

Inside a repo with Readyset installed and at least one brainstorm under `.ai/brainstorms/`, run:

```
/readyset-review
/readyset-review --model anthropic/claude-opus-5   # pin a model for this run's turns (optional)
```

`--model` pins one model for every turn this run fires (Explore through Code-review), so a run
is reproducible independent of whatever model happened to be active in the chat session that
invoked it. The session's original model is restored once the run finishes, whether it
completes normally, stops early, or throws.

Without `--model`, Readyset reads a default out of omp's own `~/.omp/agent/config.yml` — it
doesn't invent a second, separate config file. Two places it looks, in order:

```yaml
readyset:            # Readyset's own section, same style as modelRoles — omp itself doesn't
  model: anthropic/claude-opus-5       # read or validate this section, it's meaningful only
  fallbackModel: anthropic/claude-sonnet-5   # to Readyset. See "if the pin itself fails" below.

modelRoles:         # omp's own general default (confirmed against omp's docs), used as the
  default: spark/minimax-m3            # fallback if readyset.model isn't set
```

`readyset.model` wins if both are set — it lets you pin a model for `/readyset-review` specifically
without changing what everything else in omp defaults to. If neither is set, Readyset just runs
with whatever model the session already has (no pinning at all).

**If the pin itself fails** — `readyset.model`/`modelRoles.default` names a spec that's wrong,
retired, or otherwise rejected when Readyset tries to switch to it — Readyset tries
`readyset.fallbackModel` (or `--fallback-model <spec>`) next, and if that also fails, runs unpinned
rather than aborting the whole command. This is deliberately narrow: it only covers the pin
failing to apply before any turn starts, not a model that goes down mid-turn. For that — a
transient provider outage during generation — configure omp's own `retry.fallbackChains` in
`~/.omp/agent/config.yml` (per-role/per-model chains that kick in automatically on 429s/quota
errors, restored on cooldown); that already applies to whatever model is active, Readyset-pinned
or not, and this package doesn't try to duplicate it.

Every run also has a hard turn budget (10 agent turns by default) — a guardrail against an
unbounded Refine or verification-retry loop burning cost with no natural stopping point, not a
precise cost estimate. The review panel shows `agent turns this run: N/10`; hitting the ceiling
stops the run with a warning rather than firing another turn, and `/readyset-review` can simply be
re-run for a fresh budget.

It picks a brainstorm, and depending on its status:

- **Not proposed yet** — fires an **Explore** turn first: it writes
  `readyset/changes/<id>/EXPLORATION.md`, with every submodule from `.gitmodules` (if any) listed
  explicitly in its prompt so none can be silently skipped. Only after that does the **Propose**
  turn run, told to ground its proposal/design/specs in what Explore already found rather than
  re-deriving it. Both phases are logged to `CONTEXT.md` as they happen. This then drops straight
  into the review gate below (no manual re-invocation needed).
- **Already proposed** — goes straight to the review gate: **Approve & Execute** / **Refine**
  (describe what to change, loops back into another revision turn) / **Jump to section** (browse
  one section at a time — see below) / **Buka untuk direview** (pushes the full compiled document
  into the editor pane, nothing changed) / **Discard**.
- **Approve & Execute** implements the tasks. Each completed task must carry an indented
  `_Verified: <what was checked, and the result>` note under it — if the implementation checks a
  box without one, the review gate stops and offers to send it back for another pass rather than
  silently trusting the self-report. Once every task is verifiably done, a separate **code
  review** turn runs (fresh context, told explicitly that its job is to find problems, not
  confirm the work) and writes `REVIEW.md`. Only then does Readyset offer to archive (moves the
  change under `readyset/changes/archive/`, merges its delta specs into `readyset/specs/`
  append-only).

## What it deliberately does not do

- `validateChange` is a **shallow structural check** (required sections exist, at least one
  requirement+scenario, at least one task) — not a real schema validator. It catches an empty or
  malformed artifact, not a semantically wrong one. A "validate: pass" in the review panel is not
  a claim the plan is correct, only that it's structurally complete.
- `archiveChange` merges delta specs into the main spec **append-only** — never a real
  ADDED/MODIFIED/REMOVED diff-merge. Safe (nothing is deleted or silently rewritten), but cruder
  than a proper schema-aware archiver; review the merged spec afterward.
- The review screen is a `ctx.ui.select` picker plus a `setWidget` summary (capped at 10 lines)
  — the ceiling of what omp's extension API exposes to third-party extensions. Extensions cannot
  register a sidebar, tree view, webview, or any other persistent navigable region — UI is
  confined to modal dialogs (`select`/`confirm`/`input`/`editor`) and single stacked regions
  above/below the editor. So the review gate does the closest thing available instead: it pushes
  the whole change as one compiled document into the editor pane via `setEditorText` — a numbered
  table of contents with a status tag per section (`[done]`, `[2/3 ticked]`, etc.), then every
  section body below it, separated by `═`/`─` rules instead of bare markdown headers (the editor
  pane doesn't render markdown, so visual rules read better than `##`/`###` as plain text) — and
  adds a **Jump to section** option on the gate that opens a `select` menu of just the section
  headings/status, so a section can be viewed in isolation instead of scrolling the whole thing;
  picking "◂ Back to full document" restores the compiled view. It is a menu-driven stand-in for
  a sidebar, not a sidebar — there's no persistent list of sections next to the content the way
  `/plan`'s native Plan Review shows one; each jump is a full swap of what's in the editor pane.

## Files a change accumulates

Under `readyset/changes/<id>/`, in the order they get written:

```
EXPLORATION.md   Explore phase findings — what was actually checked, and what was found
proposal.md      Why / What Changes
design.md        Context / Goals-Non-Goals / Decisions / Risks
specs/**/spec.md ADDED/MODIFIED/REMOVED Requirements as WHEN/THEN scenarios
tasks.md         checkbox tasks; each `- [x]` carries an indented `_Verified:` note
CONTEXT.md       append-only audit trail — one entry per phase transition, written by the
                 extension itself (not the model), so it can't be skipped or misremembered
REVIEW.md        code-review phase findings, written after implementation, before archive
```

## Package layout

```
src/
  lib/
    brainstorm.ts       shared helpers: frontmatter parsing, status reconciliation, lane detection
    readyset-spec.ts        Readyset's own change-artifact format: scaffold/validate/progress/archive
    omp-config.ts           reads omp's own ~/.omp/agent/config.yml for a default --model fallback
  extensions/
    readyset-review.ts      the /readyset-review command itself
  skill/
    SKILL.md                reference doc for the phase order + file formats; read by an agent
                             working a Readyset change directly, not loaded by the extension —
                             installed to .agent/skills/readyset/SKILL.md (see note below)
  cli/
    install.mjs            `readyset-review install` — copies src/lib + src/extensions + src/skill into a target repo
```

Installed layout in a target repo, once `readyset-review install` has run:

```
.omp/
  lib/brainstorm.ts, readyset-spec.ts, omp-config.ts
  extensions/readyset-review.ts
.agent/
  skills/readyset/SKILL.md
```

Both destinations are omp's own documented project-level discovery paths, confirmed against
`docs/extension-loading.md` (`<cwd>/.omp/extensions`, non-recursive, cwd only) and `docs/skills.md`
(canonical `.agent[s]/skills/<name>/SKILL.md`, `.agent/` or `.agents/` both accepted) — not a
guess, unlike an earlier version of this installer which used an undotted `agent/` convention
that omp never actually scanned.
