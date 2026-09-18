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

Readyset installs **globally**, into `~/.omp/agent/` — not into any one repo. It's a personal
workflow extension, like the other extensions that may already live in `~/.omp/agent/extensions/`,
meant to be available in every repo you work in, not scoped to one. This is omp's own documented
user-level discovery path (`~/.omp/agent/extensions`, `~/.omp/agent/lib`, confirmed against
`docs/extension-loading.md` and against a real `~/.omp` already running other extensions, not
guessed): `.ts` source goes to `~/.omp/agent/lib/` and `~/.omp/agent/extensions/`, the skill doc
to `~/.omp/agent/skills/`. There's no build step — omp loads extensions as `.ts` files directly.

`~/.omp/agent/` is a shared namespace — other extensions' files already live there. Every file
this package installs is prefixed `readyset-` (`readyset-brainstorm.ts`, `readyset-omp-config.ts`,
`readyset-spec.ts`, `readyset-review-overlay.ts`, `readyset-review.ts`) specifically so it can
never collide with or silently
overwrite something already installed there, regardless of what else you have running.

Pass `--target <path>` to install somewhere else instead — a scratch directory for testing, or
`<repo>/.omp` if you'd rather scope this to one project (omp supports that layout too; this
installer just doesn't default to it).

Re-run `npx readyset-review install` after bumping the `readyset-review` version to pick up
changes. **Don't hand-edit the installed files** — they get overwritten on the next install. If
you need different behavior, change it here and re-publish, not in the installed copy.

## Use

With Readyset installed and at least one brainstorm under `.ai/brainstorms/` in a repo, run:

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
  (describe what to change, loops back into another revision turn) / **Sidebar view** (a
  persistent section list + content pane, like native `/plan`'s review — see below) or **Jump to
  section** as a fallback where `Sidebar view` isn't available / **Discard**. The full compiled
  document is always pushed into the editor pane too, on every pass through the gate, so it's
  never more than one pane-switch away regardless of which option is picked.
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
- The review screen has two tiers, chosen automatically by feature-detecting `ctx.ui.custom` at
  gate time. Where it's available (an interactive terminal session — the normal way `omp` is
  actually run), **Sidebar view** renders a real persistent two-pane overlay via `ctx.ui.custom()`
  — the same mechanism native `/plan`'s own review sidebar is built from, not a simulation of one:
  a section list on the left (`↑`/`↓` to switch), that section's content on the right, `PgUp`/
  `PgDn` to scroll it, `Esc` to close. Where `ctx.ui.custom` isn't available (RPC/ACP/print
  contexts, or an older omp without it), the gate falls back to **Jump to section** — a
  `select` menu of just the section headings/status, swapping the editor pane's full content
  one section at a time; picking "◂ Back to full document" restores the compiled view. Either
  way, the full change is also always pushed into the editor pane as one compiled document via
  `setEditorText` — a numbered table of contents with a status tag per section (`[done]`,
  `[2/3 ticked]`, etc.), then every section body below it, separated by `═`/`─` rules instead of
  bare markdown headers (the editor pane doesn't render markdown, so visual rules read better than
  `##`/`###` as plain text) — so it's on screen regardless of which navigation mode is active.

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
    readyset-brainstorm.ts   shared helpers: frontmatter parsing, status reconciliation, lane detection
    readyset-spec.ts         Readyset's own change-artifact format: scaffold/validate/progress/archive
    readyset-omp-config.ts   reads omp's own ~/.omp/agent/config.yml for a default --model fallback
    readyset-review-overlay.ts  the Sidebar view Component — pure layout function + a
                             ctx.ui.custom()-driven overlay, zero runtime dependency on @oh-my-pi/pi-tui
  extensions/
    readyset-review.ts      the /readyset-review command itself
  skill/
    SKILL.md                reference doc for the phase order + file formats; read by an agent
                             working a Readyset change directly, not loaded by the extension —
                             installed to ~/.omp/agent/skills/readyset/SKILL.md (see note below)
  cli/
    install.mjs            `readyset-review install` — copies src/lib + src/extensions + src/skill into ~/.omp/agent/
```

Installed layout, once `readyset-review install` has run (default target `~/.omp`):

```
~/.omp/agent/
  lib/readyset-brainstorm.ts, readyset-spec.ts, readyset-omp-config.ts, readyset-review-overlay.ts
  extensions/readyset-review.ts
  skills/readyset/SKILL.md
```

This is omp's own documented user-level discovery path, confirmed against `docs/extension-loading.md`
("User-level (global): the active agent directory's extensions/", which resolves to
`~/.omp/agent/extensions` by default) and against a real `~/.omp` already running other
extensions — not a guess. Every filename here is prefixed `readyset-` on purpose: `~/.omp/agent/`
is shared with whatever else you already have installed there, and an earlier, unprefixed version
of this installer (`brainstorm.ts`, `omp-config.ts`) would have collided with an existing,
unrelated `~/.omp/agent/lib/brainstorm.ts` in active use by other extensions on the machine this
was verified against, silently overwriting it and breaking them.
