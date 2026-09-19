<p align="center">
  <img src="assets/banner.png" alt="Readyset — grounded, reviewable, executable changes for omp" width="100%">
</p>

<p align="center">
  <a href="#install"><b>Install</b></a> ·
  <a href="#use"><b>Use</b></a> ·
  <a href="#how-it-works"><b>How it works</b></a> ·
  <a href="#configure-a-model"><b>Configure a model</b></a> ·
  <a href="#what-it-deliberately-does-not-do"><b>Limitations</b></a>
</p>

Readyset is a standalone [omp](https://github.com/oh-my-pi) extension, invoked as `/readyset`.
It turns a rough idea — or a brainstorm already sitting in `.ai/brainstorms/*.md` — into a
grounded, reviewable, executable change under its own `readyset/changes/<id>/` directory. It
doesn't depend on omp's native `/plan`, or any external spec-driven-development CLI, at runtime.
The proposal/design/spec/tasks split is a well-established shape, but Readyset's directory
layout, file format, and validation are its own.

**In one sentence:** `/readyset` asks the questions a plan needs answered *before* it writes
anything (grilling), grounds what it writes in the real repo instead of assumptions (Explore),
and won't let you execute a change that's structurally incomplete or skipped review — each of
those is a code-enforced gate, not a prompt asking nicely.

## Table of contents

- [Why "Readyset"](#why-readyset)
- [Design philosophy](#design-philosophy)
- [How it works](#how-it-works)
- [Install](#install)
- [Validate from the CLI](#validate-from-the-cli)
- [Use](#use)
  - [Grilling — turning an idea into a brainstorm](#grilling--turning-an-idea-into-a-brainstorm)
  - [Language](#language)
  - [Configure a model](#configure-a-model)
  - [The review gate](#the-review-gate)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)
- [Files a change accumulates](#files-a-change-accumulates)
- [Package layout](#package-layout)

## Why "Readyset"

The name is the point: a plan you can trust is one anchored to the real state of the repo — real
file contents, real commit hashes, real test runs — not assumptions. Readyset fuses three
sources, each filling a gap the others leave:

- **omp `/plan`'s grounding discipline** — cite real files/line numbers/commit hashes, catch
  actual drift (a stale config default, a submodule pinned to the wrong commit), leave behind a
  procedure an engineer can literally run. The harshest habit of the three, and the easiest for a
  model to skip under pressure — so it's enforced by a dedicated **Explore** phase, not just a
  prompt.
- **The structured-spec workflow** popularized by spec-driven-development tooling — a
  proposal/design/spec/tasks split, requirements as WHEN/THEN scenarios, open questions carried
  forward rather than silently resolved, and a review gate between "written" and "executing".
- **mattpocock/skills' prompting hygiene** — interrogate ambiguity before writing anything down,
  never mark work done without something that actually verifies it, review a diff critically in a
  separate pass rather than trusting the turn that wrote it. Enforced by the **`_Verified:` note
  requirement** and a separate **code-review** phase.

Each is a structural gate — a phase that has to run, a machine-checkable condition that has to
hold — not just prose in a prompt. Prose already proved insufficient once: an earlier propose
turn was told to check `.gitmodules` and still silently dropped a submodule. Prose is a request;
a gate is a requirement.

## Design philosophy

Four rules that shape which features Readyset gets, and how they're built:

- **Finding facts is your job, never the user's.** A question the repo or a web search could
  answer doesn't belong to the user as an open question, and it doesn't belong in a brainstorm as
  a silent assumption either. This came from a real failure: an early grilling run left a
  checkable fact (a WhatsApp Business Platform tier requirement) as an open question instead of
  looking it up, even with a search tool available. Grilling's prompt now says so explicitly —
  see [Grilling](#grilling--turning-an-idea-into-a-brainstorm).
- **Runtime evidence is not proof of correctness.** `readyset_verify` runs a command and records
  exactly what happened — exit code, stdout/stderr, whether it timed out. `exitCode: 0` means
  "the command ran and exited clean," never "the requirement is satisfied" — judging that stays
  the separate code-review turn's job. Blurring this would let a model self-certify by running
  something trivially true (`echo ok`) and pointing at the green exit code, so the two are kept
  structurally apart: `readyset_verify` never marks a task done and never touches `_Verified:`.
- **Smallest useful primitive, not the cleanest architecture.** Evidence Capture could have
  shipped bigger — structured review findings, an explicit state machine, a `ReadysetChange`
  domain object. All deferred. What shipped is one tool that runs a command and writes down what
  happened, wired into the review panel just enough to be visible: the smallest thing that's
  actually observable, with regression tests around it, so the next iteration is informed by real
  usage instead of a guess.
- **Trust and blast-radius beat cleanliness when they conflict.** The archive step still merges
  delta specs append-only, not a real diff-merge, because "never silently deletes or rewrites a
  requirement" matters more than "the archive is a proper merge" — it just now also discloses
  when that merge couldn't apply a MODIFIED/REMOVED requirement, instead of dropping it quietly.
  Same logic elsewhere: `_Verified:` notes are a human-readable self-report, not a schema, and the
  review gate would rather over-trust a well-formed note than force a rigid format.

## How it works

A `/readyset` change moves through five stages. You only ever see the ones that still apply —
running `/readyset` again on an already-proposed change skips straight to review.

| Stage | What happens | Who can skip it |
|---|---|---|
| **1. Grill** | Only for a raw idea (`--idea "..."`). Interrogates ambiguity in a structured Q&A picker until Decision/Seam/Scope/Acceptance Criteria actually resolve. | Skipped if you already hand-wrote a brainstorm in `.ai/brainstorms/`. |
| **2. Explore** | Reads the real repo — file contents, `.gitmodules`, commit hashes — and writes what it found to `EXPLORATION.md`, before anything gets proposed. | Never skipped for a not-yet-proposed brainstorm. |
| **3. Propose** | Writes `proposal.md` / `design.md` / `specs/**/spec.md` / `tasks.md`, grounded in what Explore found. | Never skipped. |
| **4. Review gate** | Approve, **Refine**, or **Discard**. Nothing executes without you looking at it first. | Never skipped — the one gate Readyset exists to enforce. |
| **5. Execute** | Implements `tasks.md`. Every finished task needs a `_Verified:` note, optionally backed by a `readyset_verify` evidence record (see [Design philosophy](#design-philosophy)), or the gate sends it back. A fresh-context **code-review** pass runs after, before archiving. | Never skipped. |

The one loop: **Refine** sends you back to Propose, and a failed verification at Execute sends
you back to the review gate — either way you land on a stage above, never off into an
unrecoverable branch.

## Install

```
npm install --save-dev readyset-flow
npx readyset-flow install
```

Readyset installs **globally**, tied to `~/.omp/` — a personal workflow extension meant to be
available in every repo, not scoped to one.

It does **not** copy `.ts` files into `~/.omp/agent/`. omp's native config provider reads
`~/.omp/agent/settings.json`'s `"extensions"` array, and when an entry resolves to a *file* (not
a directory), it loads that file as a full extension module wherever it actually sits on disk —
no requirement that it live under `~/.omp/agent/extensions/`. This is real, source-verified omp
behavior (`loadExtensionModules`), not a convention this package invented. So `install` merges
one absolute path — `<this package>/src/extensions/readyset-review.ts` — into that array. Its own
imports (`../lib/readyset-*.ts`) resolve against its real location on disk, so no other file in
this package needs an install step: updating the package is enough, since nothing was copied to
go stale.

The one thing `install` does still copy is the skill doc, to `~/.omp/agent/skills/readyset/` —
skills have no array equivalent in omp (only a fixed directory scan), and a stale copy of a
reference doc is a much smaller problem than stale runtime code would be. It's re-copied every
run.

Existing `settings.json` entries belonging to another extension are left untouched; `install`
only ever touches the one entry resolving to `readyset-review.ts`, and re-running it is a no-op
once that entry is already correct.

Pass `--target <path>` to install somewhere else — a scratch directory for testing, or
`<repo>/.omp` to scope this to one project instead (omp supports that layout; this installer just
doesn't default to it).

Since nothing runtime is copied, code changes need no re-install. Re-run
`npx readyset-flow install` only after moving the package itself, or to refresh the installed
skill doc. Leftover files from an older, copy-based installer under
`~/.omp/agent/lib/readyset-*.ts` / `~/.omp/agent/extensions/readyset-review.ts` are inert once
`settings.json` points at the package directly — safe to delete by hand.

## Validate from the CLI

```
readyset-flow validate <change-id> [--cwd <path>]
```

Runs the same structural check (`validateChange`) the omp gate runs before every Approve &
Execute / Refine / Sidebar view — from a plain terminal, no omp session needed. Exit code `0` on
pass, `1` on structural issues, so it composes into CI or a pre-commit hook:

```
readyset-flow validate complete-embedded-signup-onboarding || exit 1
```

`install`/`version` only need whatever Node `engines` promises (`>=18`) — `install.mjs`
deliberately never imports a `.ts` file. `validate` is the exception: it needs `readyset-spec.ts`'s
real check, not a re-implementation that could drift, so it spawns a small subprocess
(`validate-runner.mts`) with `--experimental-strip-types` — Node 22.6+, same requirement this
package's own test suite has. If that subprocess can't start, `validate` says so plainly;
`install`/`version` are unaffected.

## Use

With Readyset installed, run:

```
/readyset
/readyset --idea "let users export their data as CSV"   # grill a new brainstorm from a raw idea
/readyset --model anthropic/claude-opus-5   # pin a model for this run's turns (optional)
```

### Grilling — turning an idea into a brainstorm

A brainstorm under `.ai/brainstorms/` is no longer a hard prerequisite. `--idea <text>` (or
picking **"Type a new idea"** at the top of the normal picker) starts a **grilling** turn
instead: mattpocock/skills-style interrogation — map the open decision branches, ask one numbered
round of frontier questions with a recommended answer each, never accept a passive "okay" as a
real decision on anything load-bearing, repeat until the design tree resolves. This matches the
closing discipline of the standalone `brainstorm-ai` skill (Decision, Seam, Scope, Acceptance
Criteria) rather than inventing a second format: whichever tool wrote a given
`.ai/brainstorms/*.md` file, Readyset treats it identically.

The driving prompt (`grillTurnPrompt`) is adapted from mattpocock/skills' actual `grilling`
skill, vendored verbatim (MIT-licensed) at `src/skill/mattpocock-grilling.md` to check wording
against. One of its rules — "finding facts is your job, never the user's" (see
[Design philosophy](#design-philosophy)) — is carried over close to verbatim: a question the repo
or a web search could actually answer doesn't belong in a round as an open question.

Each round is a real structured picker, not raw chat text you have to type a reply to — the model
calls a `readyset_ask` tool that opens omp's own native multi-question dialog
(`ctx.ui.askDialog`), your recommended answer highlighted per question, with room to type your
own or say "let's discuss this instead." Because that dialog blocks for real input, the model
keeps calling it round after round inside one continuous turn. The round cap (4 by default) is
enforced in code: once hit, the tool stops opening the dialog and the model checks in via plain
text instead. This picker is Interactive-mode only (the surface native `/plan`'s dialogs use); in
RPC/ACP/print modes, or any omp build without it, grilling falls back to the previous plain-chat
back-and-forth automatically, same rules and content. Either way it ends once the model writes the
brainstorm file and tells you to run `/readyset` again to pick it up. Hand-writing or dictating
the brainstorm to a separate tool first still works exactly as before.

### Language

By default, grilling's reactive rule kicks in: reply in whatever language you use, once you use
it — so round 1 arrives in English, since there's no signal yet. `--lang <language>` (placed
*before* `--idea`, which joins everything after it into the idea text) opens the discussion in
that language from round 1:

```
/readyset --lang Indonesian --idea "let users export their data as CSV"
```

Or set a default once in `~/.omp/agent/config.yml` (`--lang` still wins if given).
`readyset.lang` works as an alias for `readyset.language`:

```yaml
readyset:
  language: Indonesian   # or: lang: Indonesian
```

Only the *discussion* changes language — the brainstorm file `--idea` eventually writes is always
in English, since that's what the rest of Readyset expects. Each `readyset_ask` question's
`header` (the short chip label above it) also stays in English on purpose — it reads like fixed
UI chrome, and a picker with some tabs translated and some not is more jarring than keeping all of
them consistent.

### Configure a model

`--model` pins one model for every turn this run fires (Explore through Code-review), so a run is
reproducible independent of whatever model was active in the invoking session. The original model
is restored once the run finishes, however it ends.

Without `--model`, Readyset reads a default from omp's own `~/.omp/agent/config.yml`, in order:

```yaml
readyset:                    # Readyset's own section, nested the same shape as omp's own
  model:                     # retry.fallbackChains (a default plus an ordered list of
    default: anthropic/claude-opus-5     # fallbacks) — omp itself doesn't read this section,
    fallbackChains:                      # it's meaningful only to Readyset. See "if the pin
      - anthropic/claude-sonnet-5        # itself fails" below.
      - spark/minimax-m3

modelRoles:         # omp's own general default (confirmed against omp's docs), used as the
  default: spark/minimax-m3            # fallback if readyset.model.default isn't set
```

`readyset.model.default` wins if both are set, letting you pin a model for `/readyset` without
changing omp's overall default. If neither is set, Readyset runs with whatever model the session
already has. A bare `readyset.model: <spec>` (no nested shape) still works for older configs.

**If the pin itself fails** — the named spec is wrong, retired, or rejected — Readyset tries
every entry in `readyset.model.fallbackChains` in order, and only once all fail does it run
unpinned rather than aborting. `--fallback-model <spec>` is a single spec that wins over the
config chain entirely. A bare `readyset.fallbackModel: <spec>` (legacy, single fallback) still
works too. This only covers the pin failing before any turn starts, not a model going down
mid-turn — for that, configure omp's own `retry.fallbackChains`, which already applies regardless
of whether Readyset pinned anything.

Every run also has a hard turn budget (10 by default) — a guardrail against an unbounded Refine
or verification-retry loop, not a precise cost estimate. The review panel shows
`agent turns this run: N/10`; hitting it stops the run with a warning, and `/readyset` can simply
be re-run for a fresh budget.

### The review gate

Picks a brainstorm, and depending on its status:

- **Not proposed yet** — fires **Explore** first: writes `EXPLORATION.md`, with every submodule
  from `.gitmodules` listed explicitly so none is silently skipped. Then **Propose** runs, told to
  ground its output in what Explore found. Both phases log to `CONTEXT.md`, then drop straight
  into the review gate below.
- **Already proposed** — goes straight to the gate: **Approve & Execute** / **Refine** (describe
  what to change, loops into another revision) / **Sidebar view** (a persistent section list +
  content pane, like native `/plan`'s review) or **Jump to section** as a fallback / **Discard**.
  The full compiled document is always pushed into the editor pane too, on every pass.
- **Approve & Execute** implements the tasks. Each completed task needs an indented
  `_Verified: <what was checked, and the result>` note, or the gate sends it back. It can
  optionally call `readyset_verify({taskId, command})` to back that note with more than a
  self-report: the command runs for real (via a real shell, so `&&`/pipes work), and an immutable
  record of its exit code, stdout/stderr, and duration is persisted to
  `readyset/changes/<id>/evidence/`. The panel's **Runtime evidence** section lists those records
  and flags a **conflict** when a task is checked `[x]` but its latest evidence exited non-zero —
  surfaced passively, never auto-blocking, since a captured exit code is evidence for the next
  review to weigh, not a verdict Readyset hands down itself. Once every task is verifiably done, a
  separate **code review** turn runs (fresh context, told to find problems, not confirm the work)
  and writes `REVIEW.md`. Only then does Readyset offer to archive — moving the change under
  `readyset/changes/archive/`, merging its delta specs into `readyset/specs/` append-only, now
  warning explicitly if that delta contained a MODIFIED/REMOVED requirement the merge can't apply.

## What it deliberately does not do

- `validateChange` is a **structural check** (required sections exist, every requirement carries
  an ADDED/MODIFIED/REMOVED header and its own WHEN/THEN, at least one task) — not a schema
  validator, and scoped per requirement, not per file. It catches an empty or malformed artifact,
  never a semantically wrong one — which is why its summary always carries the literal suffix
  `(structural check)`, everywhere it's shown. `validateBrainstormContent` (checked before Explore
  runs) uses the same wording for the same reason, enforced by a shared `structuralCheckSummary`
  helper rather than two files independently hoping to stay in sync. The one check that *is*
  semantic is the code-review turn (`REVIEW.md`) — its panel line says "done" or "not run yet,"
  deliberately not sharing the `(structural check)` wording, since a real judgment call happened
  there.
- `archiveChange` merges delta specs append-only — never a real diff-merge. Safe (nothing deleted
  or silently rewritten), but cruder than a schema-aware archiver; review the merged spec
  afterward.
- Grilling's round cap is enforced in code via `readyset_ask`'s own `execute()` — but only for
  rounds asked through that tool. In the plain-chat fallback (no `ctx.ui.askDialog` available),
  rounds are ordinary chat turns the extension never sees, so the cap there is prompt-level only —
  there's no code ceiling possible on a turn the extension isn't driving. Always enforced either
  way: `validateBrainstormContent`, which checks Decision/Seam/Scope/Acceptance Criteria actually
  got filled in (not left as template placeholders) before Explore spends a turn on it —
  "Continue anyway" is always available, but it's a deliberate extra step.
- Nothing forces the model to actually call `readyset_ask` — that's prompt-level, not something
  extension code can require. `tools.approvalMode: yolo` doesn't change this: it only
  auto-approves tool-call permission prompts, not `ctx.ui.select`/`ctx.ui.askDialog`, which always
  block for real input in Interactive mode. The real risk is a model that races ahead and writes a
  brainstorm from its own assumptions — a failure mode seen with native `/plan` before. The
  content-check gate catches this partially (a plausible-sounding but invented Decision/Seam/Scope
  still passes `validateBrainstormContent`); what actually catches "the model never asked" is a
  zero-rounds check — if grilling started this session and `readyset_ask` was never called, the
  gate flags it and still requires "Continue anyway." Scoped tight on purpose: it only fires for a
  grilling run that started and finished in the same omp process without ever asking — a
  hand-written brainstorm, or one grilled in an earlier session, triggers nothing.
- The review screen has two tiers, chosen by feature-detecting `ctx.ui.custom` at gate time. Where
  available (a normal interactive `omp` session), **Sidebar view** renders a real persistent
  two-pane overlay via `ctx.ui.custom()` — the same mechanism native `/plan`'s review sidebar uses,
  not a simulation: a section list on the left, content on the right, `PgUp`/`PgDn` to scroll,
  `Esc` to close. Where it isn't (RPC/ACP/print, or an older omp), the gate falls back to
  **Jump to section** — a `select` menu swapping the editor pane one section at a time, with
  "◂ Back to full document" to restore the compiled view. Either way, the full change is also
  always pushed into the editor pane as one compiled document — a numbered table of contents with
  a status tag per section, then every section body below, separated by `═`/`─` rules instead of
  markdown headers (the editor pane doesn't render markdown).

## Files a change accumulates

Under `readyset/changes/<id>/`, in the order they get written:

```
EXPLORATION.md   Explore phase findings — what was actually checked, and what was found
proposal.md      Why / What Changes
design.md        Context / Goals-Non-Goals / Decisions / Risks
specs/**/spec.md ADDED/MODIFIED/REMOVED Requirements as WHEN/THEN scenarios
tasks.md         checkbox tasks; each `- [x]` carries an indented `_Verified:` note
evidence/E*.md   optional runtime-evidence records from `readyset_verify` — one per call,
                 numbered E001, E002, ...; never auto-created, never mutated once written
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
    readyset-structural-check.ts  the shared "(structural check)" summary wording validateChange
                             and validateBrainstormContent both use
    readyset-evidence.ts    readyset_verify's runtime — spawns the command, persists the
                             immutable evidence record, correlates it back to tasks.md
  extensions/
    readyset-review.ts      the /readyset command itself
  skill/
    SKILL.md                reference doc for the phase order + file formats; read by an agent
                             working a Readyset change directly, not loaded by the extension —
                             copied to ~/.omp/agent/skills/readyset/SKILL.md (see note below)
    mattpocock-grilling.md  mattpocock/skills' actual `grilling` skill, vendored verbatim
                             (MIT-licensed) — the real source grillTurnPrompt is adapted from,
                             kept here to check wording against rather than a paraphrase of a
                             paraphrase. Repo-internal reference only, not installed.
  cli/
    install.mjs            `readyset-flow install`/`version`/`validate` — the CLI entry point
    validate-runner.mts    subprocess `validate` spawns with --experimental-strip-types (see README)
```

What `readyset-flow install` actually touches on disk (default target `~/.omp`):

```
~/.omp/agent/
  settings.json     "extensions" array gets one entry merged in: the absolute path to this
                     package's own src/extensions/readyset-review.ts -- not a copy of it
  skills/readyset/SKILL.md   copied (see note below; this one file has no reference-in-place option)
```

Everything under `src/lib/` and `src/extensions/` stays exactly where the package itself lives
(a git clone, or `node_modules/readyset-flow/` after `npm install`) and is read from there —
confirmed against omp's own native discovery provider (`loadExtensionModules`), which resolves a
`settings.json` `"extensions"` array entry that points at a file, not a directory, and loads it
in place; not a guess. Skills have no such array in omp (only a fixed
`~/.omp/agent/skills/` directory scan), so the skill doc is still copied rather than referenced.
