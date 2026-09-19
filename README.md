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
npm install --save-dev readyset-flow
npx readyset-flow install
```

Readyset installs **globally**, tied to `~/.omp/` — not into any one repo. It's a personal
workflow extension meant to be available in every repo you work in, not scoped to one.

It does **not** copy `.ts` files into `~/.omp/agent/`. Instead it references its own extension
module in place: omp's native config provider reads `~/.omp/agent/settings.json`'s top-level
`"extensions"` array, and when an entry resolves to a *file* (not a directory), it loads that
file as a full extension module wherever it actually sits on disk — no requirement that it live
under `~/.omp/agent/extensions/` first. This is real, source-verified omp behavior (its
`loadExtensionModules`, in the native `.omp` discovery provider), not a convention this package
invented. So `install` merges one absolute path —
`<this package>/src/extensions/readyset-review.ts` — into that array. `readyset-review.ts`'s own
imports (`../lib/readyset-*.ts`) resolve against its real location on disk, so every other `.ts`
file in this package needs no install step at all — updating the package is enough, since
nothing was copied to go stale.

The one thing `install` does still copy is the skill doc, to `~/.omp/agent/skills/readyset/`
— skills have no `settings.json`-array equivalent in omp (only a fixed directory scan), and
being a reference doc with no import graph, a stale copy is a much smaller problem than stale
runtime code would be. `install` re-copies it every run regardless.

Existing entries in `settings.json` — anything belonging to another extension — are left
untouched; `install` only ever touches the one entry that resolves to a file named
`readyset-review.ts`; re-running it is a no-op once that entry is already correct.

Pass `--target <path>` to install somewhere else instead — a scratch directory for testing, or
`<repo>/.omp` if you'd rather scope this to one project (omp supports that layout too; this
installer just doesn't default to it).

Since nothing runtime is copied, code changes need no re-install to take effect. Re-run
`npx readyset-flow install` only after moving the package itself (the settings.json entry
would otherwise point at a path that no longer exists) or to refresh the installed skill doc.
If you have leftover files from an older, copy-based version of this installer under
`~/.omp/agent/lib/readyset-*.ts` / `~/.omp/agent/extensions/readyset-review.ts`, they're inert
once `settings.json` points at the package directly — safe to delete by hand.

## Validate from the CLI

```
readyset-flow validate <change-id> [--cwd <path>]
```

Runs the exact same structural check (`validateChange`) the omp gate runs before every Approve &
Execute / Refine / Sidebar view — but from a plain terminal, no omp session needed. Exit code is
`0` on pass, `1` on structural issues found, so it composes directly into CI or a pre-commit hook:

```
readyset-flow validate complete-embedded-signup-onboarding || exit 1
```

`install`/`version` only need whatever Node the `engines` field promises (`>=18`) — `install.mjs`
deliberately never imports a `.ts` file itself. `validate` is the exception: it needs to run
`readyset-spec.ts`'s real check, not a re-implementation that could drift from what the gate
actually enforces, so it spawns a small subprocess (`validate-runner.mts`) with
`--experimental-strip-types` — Node 22.6+, same requirement this package's own test suite already
has. If that subprocess can't start, `validate` says so plainly rather than failing silently;
`install`/`version` are unaffected either way.

## Use

With Readyset installed, run:

```
/readyset
/readyset --idea "let users export their data as CSV"   # grill a new brainstorm from a raw idea
/readyset --model anthropic/claude-opus-5   # pin a model for this run's turns (optional)
```

A brainstorm under `.ai/brainstorms/` is no longer a hard prerequisite. `--idea <text>` (or
picking **"Type a new idea"** at the top of the normal picker, when nothing was typed after
`--idea`) starts a **grilling** turn instead: mattpocock/skills-style interrogation — map the
open decision branches, ask one numbered round of frontier questions with a recommended answer
for each, never accept a passive "okay"/"terserah" as a real decision on anything load-bearing,
repeat until the design tree actually resolves. This deliberately matches the closing discipline
of the separate, standalone `brainstorm-ai` skill (Decision, Seam, Scope, Acceptance Criteria,
auto-derived branch type and lane) rather than inventing a second brainstorm format: whichever
tool actually wrote a given `.ai/brainstorms/*.md` file, Readyset's own picker and reconciliation
treat it identically.

The prompt driving this (`grillTurnPrompt` in `src/extensions/readyset-review.ts`) is adapted
from mattpocock/skills' actual `grilling` skill, not a from-scratch guess at what that style
means — the real thing is vendored verbatim (MIT-licensed) at `src/skill/mattpocock-grilling.md`
for anyone tuning the wording to check against. One of its rules carried over close to verbatim
because a real grilling run exposed exactly the gap it closes: **"finding facts is your job,
never the user's."** An early run left a checkable external fact (a WhatsApp Business Platform
tier requirement) as an open question instead of looking it up, even though a web search tool is
a baseline part of the omp setup it ran in. The prompt now says so explicitly: a question a web
search (or the repo) could actually answer doesn't belong in a round as an open question or a
silent assumption — open questions are reserved for what only the user can decide or knows.

Each round of questions is a real structured picker, not raw "❓ Q1 ..." chat text you have to
type a reply to — the model calls a `readyset_ask` tool that opens omp's own native multi-question
dialog (`ctx.ui.askDialog`), with your recommended answer highlighted per question and room to
type your own answer or say "let's discuss this instead" if you'd rather talk it through in plain
chat. Because that dialog blocks for real input, the model keeps calling it round after round
inside one continuous turn — you don't wait for it to "end its turn" between rounds the way an
ordinary back-and-forth would. The round cap (4 rounds by default) is enforced in code now, not
just a prompt convention: once hit, the tool stops opening the dialog and the model checks in via
plain text instead — summarizes what's decided, names what's open, asks whether to keep going.
This structured picker is Interactive-mode only (the same surface native `/plan`'s own dialogs use);
in RPC/ACP/print modes, or any omp build without it, grilling falls back to the previous plain-chat
back-and-forth automatically, same rules, same content. Either way it ends once the model writes the
brainstorm file and tells you to run `/readyset` again to pick it up (Explore, then Propose). If
you'd rather hand-write or dictate the brainstorm to a separate tool first, that path still works
exactly as before.

By default, grilling's own reactive rule kicks in: reply in whatever language you use, once you
use it — so round 1 itself still arrives in English, since there's no signal yet of what
language you'd rather use. `--lang <language>` (placed *before* `--idea` — `--idea` joins
everything after it into the idea text, so a `--lang` placed after it would just become part of
that text) opens the discussion in that language from round 1 instead:

```
/readyset --lang Indonesian --idea "let users export their data as CSV"
```

Or set a default once in `~/.omp/agent/config.yml` so you don't have to type it every run
(`--lang` the flag still wins if given). `readyset.lang` also works as an alias for
`readyset.language` — pick whichever reads better to you, both are read the same way:

```yaml
readyset:
  language: Indonesian   # or: lang: Indonesian
```

Either way, only the *discussion* changes language — the brainstorm FILE `/readyset --idea`
eventually writes is always entirely in English, same structure either way, since that's what
the rest of Readyset (and most tooling reading `.ai/brainstorms/*.md`) expects.

`--model` pins one model for every turn this run fires (Explore through Code-review), so a run
is reproducible independent of whatever model happened to be active in the chat session that
invoked it. The session's original model is restored once the run finishes, whether it
completes normally, stops early, or throws.

Without `--model`, Readyset reads a default out of omp's own `~/.omp/agent/config.yml` — it
doesn't invent a second, separate config file. Two places it looks, in order:

```yaml
readyset:                    # Readyset's own section, nested the same shape as omp's own
  model:                     # retry.fallbackChains (a default plus an ordered list of
    default: anthropic/claude-opus-5     # fallbacks) rather than a bespoke shape of its own —
    fallbackChains:                      # omp itself doesn't read or validate this section,
      - anthropic/claude-sonnet-5        # it's meaningful only to Readyset. See "if the pin
      - spark/minimax-m3                 # itself fails" below.

modelRoles:         # omp's own general default (confirmed against omp's docs), used as the
  default: spark/minimax-m3            # fallback if readyset.model.default isn't set
```

`readyset.model.default` wins if both are set — it lets you pin a model for `/readyset`
specifically without changing what everything else in omp defaults to. If neither is set,
Readyset just runs with whatever model the session already has (no pinning at all). A bare
`readyset.model: <spec>` (no nested `default`/`fallbackChains`) still works too, for anyone who
set this up before the nested shape existed.

**If the pin itself fails** — `readyset.model.default`/`modelRoles.default` names a spec that's
wrong, retired, or otherwise rejected when Readyset tries to switch to it — Readyset tries every
entry in `readyset.model.fallbackChains` next, **in order, until one actually pins**, and only
once every entry has failed does it give up and run unpinned rather than aborting the whole
command. `--fallback-model <spec>` on the command line is a single spec, not a chain (it wins
over the config-derived chain entirely when given). A bare `readyset.fallbackModel: <spec>`
(legacy shape, a single fallback rather than a chain) still works too. This whole mechanism is
deliberately narrow: it only covers the pin failing to apply before any turn starts, not a model
that goes down mid-turn. For that — a transient provider outage during generation — configure
omp's own `retry.fallbackChains` in `~/.omp/agent/config.yml` (per-role/per-model chains that
kick in automatically on 429s/quota errors, restored on cooldown); that already applies to
whatever model is active, Readyset-pinned or not, and this package doesn't try to duplicate it.

Every run also has a hard turn budget (10 agent turns by default) — a guardrail against an
unbounded Refine or verification-retry loop burning cost with no natural stopping point, not a
precise cost estimate. The review panel shows `agent turns this run: N/10`; hitting the ceiling
stops the run with a warning rather than firing another turn, and `/readyset` can simply be
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

- `validateChange` is a **structural check** (required sections exist, every requirement
  individually carries an ADDED/MODIFIED/REMOVED delta header and its own WHEN/THEN, at least
  one task) — not a real schema validator. It's scoped *per requirement*, not per file: a
  spec.md with three requirements and only one scenario fails, it doesn't pass on the strength
  of its one good sibling. But it still catches an empty or malformed artifact, not a
  semantically wrong one. A "validate: pass" in the review panel is not a claim the plan is
  correct, only that every requirement is structurally complete — which is why its summary text
  always carries the literal suffix `(structural check)`, everywhere it's shown (review panel,
  the gate prompt, `readyset-flow validate`'s CLI output). `validateBrainstormContent`
  (checked before Explore ever runs — see below) uses the exact same wording for the exact same
  reason: neither check should read as a stronger guarantee than it actually gives just because
  of how it happens to be phrased — enforced by construction now, via a shared
  `structuralCheckSummary` helper (`readyset-structural-check.ts`) both checks call, rather than
  by two files independently spelling out the same literal string and hoping they stay in sync.
  The only check in this package that *is* a semantic pass is
  the separate Code-review turn (`REVIEW.md`) — its line in the panel says "done" or "not run
  yet", deliberately not sharing the `(structural check)` wording, since it's the one place a
  real judgment call, not a presence check, actually happened.
- `archiveChange` merges delta specs into the main spec **append-only** — never a real
  ADDED/MODIFIED/REMOVED diff-merge. Safe (nothing is deleted or silently rewritten), but cruder
  than a proper schema-aware archiver; review the merged spec afterward.
- Grilling's round cap (4 by default) **is enforced in code**, via the `readyset_ask` tool's own
  `execute()` — once the cap is hit it simply refuses to open the dialog again and tells the model
  to check in via plain text instead, a real ceiling rather than a prompt-followed convention.
  This only covers rounds asked through `readyset_ask`, though: in the plain-chat fallback (no
  `ctx.ui.askDialog` on this omp build/mode), rounds go back to being ordinary chat turns the
  extension never sees, so the cap there is prompt-level only again, same as grilling always was
  before this tool existed — there's no `TurnBudget`-style code ceiling possible on a chat turn
  the extension isn't driving. What's always enforced in code, either way, is
  `validateBrainstormContent` (readyset-brainstorm.ts): before Explore spends a single turn on
  whatever grilling (or anyone else) wrote, it checks Decision/Seam/Scope/Acceptance Criteria
  actually got filled in, not left as the brainstorm-ai skill's own template placeholders —
  "Continue anyway" is always available if the gaps are acceptable, but it's a deliberate extra
  step, not silently skipped.
- Nothing forces the model to actually call `readyset_ask` — that's a prompt-level instruction,
  not something extension code can require. Note that `tools.approvalMode: yolo` in omp's own
  config does **not** change this either way: it only auto-approves tool-call permission prompts
  (the "Allow tool: eval/bash/write" gate) — `ctx.ui.select`/`ctx.ui.askDialog` always render a
  real dialog and block for real input in Interactive mode, with no code path that skips showing
  them based on approval mode. The actual risk is a model that just races ahead and writes a
  brainstorm from its own assumptions without asking anything — a real failure mode seen with
  native `/plan` before. The content-check gate above catches this partially: if the model
  invents a plausible-sounding Decision/Seam/Scope, `validateBrainstormContent` sees filled-in
  sections and passes it. What actually catches "the model never asked" specifically is a
  zero-rounds check in the same gate — if grilling was started this session
  (`grillRoundState.active`) and `readyset_ask` was never called before the brainstorm showed up
  for review, the gate adds that as an extra line and still requires "Continue anyway". This is
  deliberately scoped tight to avoid nagging on every unrelated brainstorm: it only fires for a
  grilling run that started and finished in this same omp process without ever calling
  `readyset_ask` — a brainstorm that's hand-written, or was grilled in an earlier session, leaves
  no signal either way and triggers nothing.
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
    readyset-structural-check.ts  the shared "(structural check)" summary wording validateChange
                             and validateBrainstormContent both use
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
