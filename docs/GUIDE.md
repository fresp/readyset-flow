# Readyset — full guide

This is the detailed reference. For the two-minute version, see the [README](../README.md).

## Table of contents

- [Why "Readyset"](#why-readyset)
- [What Readyset adds to omp](#what-readyset-adds-to-omp)
- [Design philosophy](#design-philosophy)
- [How it works](#how-it-works)
- [Configure](#configure)
- [Validate from the CLI](#validate-from-the-cli)
  - [Node compatibility](#node-compatibility)
- [Grilling — turning an idea into a brainstorm](#grilling--turning-an-idea-into-a-brainstorm)
  - [Grilling from outside omp](#grilling-from-outside-omp)
  - [Language](#language)
- [Configure a model](#configure-a-model)
- [The review gate](#the-review-gate)
- [Uninstall](#uninstall)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)
- [Files a change accumulates](#files-a-change-accumulates)
- [Package layout](#package-layout)

## Why "Readyset"

The name is the point: a plan you can trust is anchored to the real state of the repo — real file
contents, real commit hashes, real test runs — not assumptions. Readyset fuses three sources:

- **omp `/plan`'s grounding discipline** — cite real files/line numbers/commit hashes, catch
  actual drift. The harshest habit of the three, and the easiest to skip under pressure — so it's
  a dedicated **Explore** phase, not just a prompt.
- **The structured-spec workflow** popularized by spec-driven-development tooling — a
  proposal/design/spec/tasks split, requirements as WHEN/THEN scenarios, open questions carried
  forward, a review gate between "written" and "executing".
- **mattpocock/skills' prompting hygiene** — interrogate ambiguity before writing, never mark work
  done without verification, review a diff separately from the turn that wrote it. Enforced by
  the **`_Verified:` note requirement** and a separate **code-review** phase.

Each is a structural gate, not prose in a prompt — prose already proved insufficient once: an
earlier propose turn was told to check `.gitmodules` and still silently dropped a submodule.
Prose is a request; a gate is a requirement.

## What Readyset adds to omp

| Without a dedicated workflow | With Readyset |
|---|---|
| An idea can jump straight into implementation | Idea passes through Grill → Explore → Propose → Review → Execute |
| Repo grounding depends on whatever the current turn checks | Explore is a dedicated phase, logged to `EXPLORATION.md` |
| Planning artifacts scatter across a chat | Each change gets its own `readyset/changes/<id>/` directory |
| Review can be informal, or skipped under pressure | A review gate structurally separates proposal from execution |
| "Done" is whatever the model claims | A required `_Verified:` note, optionally backed by captured runtime evidence |
| Implementation and review share the same context | A fresh-context code-review pass runs after execution |
| Change history is hard to reconstruct | Proposal, design, specs, tasks, exploration, review, and evidence accumulate as files |

## Design philosophy

- **Finding facts is your job, never the user's.** A question the repo or a web search could
  answer doesn't belong as an open question, or a silent assumption. An early grilling run left a
  lookupable fact (a WhatsApp Business Platform tier requirement) as an open question instead —
  see [Grilling](#grilling--turning-an-idea-into-a-brainstorm).
- **Runtime evidence is not proof of correctness.** `readyset_verify` records what a command did
  — exit code, stdout/stderr, timeout — nothing more. `exitCode: 0` means the command ran clean,
  never that the requirement is satisfied; that judgment stays the code-review turn's. It never
  marks a task done or touches `_Verified:`.
- **Smallest useful primitive, not the cleanest architecture.** Evidence Capture could have
  shipped with structured findings, a state machine, a `ReadysetChange` domain object — all
  deferred. What shipped is one tool, observable, with tests, so the next iteration is informed by
  real usage rather than a guess.
- **Trust and blast-radius beat cleanliness when they conflict.** The archive step still merges
  delta specs append-only, not a real diff-merge, because never silently rewriting a requirement
  matters more than a tidy merge — it just now discloses what it couldn't apply, instead of
  dropping it quietly.

## How it works

A `/readyset` change moves through five stages — you only see the ones that still apply.

| Stage | What happens | Who can skip it |
|---|---|---|
| **1. Grill** | Only for a raw idea (`--idea "..."`). Interrogates ambiguity until Decision/Seam/Scope/Acceptance Criteria resolve. | Skipped if a brainstorm already exists in `.ai/brainstorms/`. |
| **2. Explore** | Reads the real repo and writes what it found to `EXPLORATION.md`, before anything gets proposed. | Never skipped for a not-yet-proposed brainstorm. |
| **3. Propose** | Writes `proposal.md` / `design.md` / `specs/**/spec.md` / `tasks.md`, grounded in Explore's findings. | Never skipped. |
| **4. Review gate** | Approve, **Refine**, or **Discard**. Nothing executes without a look first. | Never skipped — the gate Readyset exists to enforce. |
| **5. Execute** | Implements `tasks.md`. Every finished task needs a `_Verified:` note, optionally backed by `readyset_verify` evidence. A fresh-context **code-review** pass runs before archiving. | Never skipped. |

**Refine** sends you back to Propose; a failed verification at Execute sends you back to the
review gate — either way you land on a stage above, never off into an unrecoverable branch.

## Configure

`/readyset`'s grilling language, default model, and fallback chain live in a `readyset:` section
of `~/.omp/agent/config.yml` — the same file for every repo, independent of `--target`. Set it up
with a wizard instead of hand-editing YAML:

```
npx readyset-flow configure
```

Walks through language, default model, and fallback chain one at a time, showing whatever's
already set as the current value. Blank keeps it, a single `-` clears it, anything else replaces
it. Answer `n` at the first prompt (or Ctrl-C) and nothing is written — you get the block printed
back to paste in by hand instead. A separate command from `install` on purpose: `install` stays
non-interactive and script-safe; `configure` is the only command in this package that blocks on
stdin, so it only runs when you actually ask for it.

Writing this back never touches anything else in `config.yml` — no YAML re-serialization, just a
plain-text splice of the existing `readyset:` block (or an append if there isn't one yet), so
comments, key order, and every other section survive untouched.

## Validate from the CLI

```
readyset-flow validate <change-id> [--cwd <path>]
```

Runs the same structural check (`validateChange`) the omp gate runs before every Approve &
Execute / Refine / Sidebar view — from a plain terminal, no omp session needed. Exit `0` on pass,
`1` on structural issues, so it composes into CI or a pre-commit hook:

```
readyset-flow validate complete-embedded-signup-onboarding || exit 1
```

`install`/`version` only need Node `>=18` and never import a `.ts` file. `validate` is the
exception: it spawns a small subprocess (`validate-runner.mts`) with `--experimental-strip-types`
(Node 22.6+) to run `readyset-spec.ts`'s real check rather than a re-implementation that could
drift.

### Node compatibility

| Command | Minimum Node | Why |
|---|---|---|
| `install`, `update`, `version`, `uninstall` | `>=18` | Plain `.mjs`, no `.ts` import. |
| `configure` | `22.6+` | Reads current config via a subprocess (`configure-runner.mts`) with `--experimental-strip-types`, same reasoning as `validate`. Without it, the wizard still runs, just without prefill. |
| `validate` | `22.6+` | Same subprocess pattern (`validate-runner.mts`), no fallback — it's the whole command. |
| `/readyset` itself, inside omp | whatever Node omp itself requires | Not spawned by this package's CLI at all. |

`package.json`'s `engines` field states the package-wide floor (`>=18`) since `install` has to
work there; individual commands that need more say so themselves (above, and in each command's
own section).

## Grilling — turning an idea into a brainstorm

A brainstorm under `.ai/brainstorms/` is no longer a hard prerequisite. `--idea <text>` (or
picking **"Type a new idea"** in the normal picker) starts a **grilling** turn instead:
mattpocock/skills-style interrogation — map the open decision branches, ask a round of frontier
questions with a recommended answer each, never accept a passive "okay" on anything load-bearing,
repeat until the design tree resolves.

The driving prompt is adapted from mattpocock/skills' actual `grilling` skill, vendored verbatim
(MIT-licensed) at `src/skill/mattpocock-grilling.md`. One of its rules — "finding facts is your
job, never the user's" (see [Design philosophy](#design-philosophy)) — carries over close to
verbatim.

Each round is a real structured picker — the model calls a `readyset_ask` tool that opens omp's
own native multi-question dialog, your recommended answer highlighted, with room to type your own
or discuss instead. The round cap (4 by default) is enforced in code: once hit, the tool stops
opening the dialog and the model checks in via plain text. Interactive-mode only; in RPC/ACP/print
modes, or an omp build without it, grilling falls back to a plain-chat back-and-forth, same rules.
Either way it ends once the model writes the brainstorm file and tells you to run `/readyset`
again to pick it up.

### Grilling from outside omp

A brainstorm doesn't have to come from `--idea` — grilling deliberately writes the same shape a
separate, standalone **`brainstorm-ai`** skill does, so Readyset's picker can't tell which one
produced a file, and doesn't try to. That skill runs its own read-only, interactive session
entirely outside omp — commonly in **Claude Cowork** — before you ever open `omp`.

A byte-identical copy ships at **[`resources/brainstorm-ai/`](../resources/brainstorm-ai/README.md)**,
with the full setup steps, a sequence diagram of the Cowork → `/readyset` handoff, and its
portability boundary outside Claude surfaces — worth reading if you want that path.

The short version: once it writes `.ai/brainstorms/<date>-<slug>.md`, bring that file into the
repo and run `/readyset`. It shows up in the normal picker, **Grill is skipped entirely** (Decision/
Seam/Scope/Acceptance Criteria are already resolved), and picking it goes straight to Explore,
then Propose — the same content-check gate that catches an under-filled grilling result (see
[What it deliberately does not do](#what-it-deliberately-does-not-do)) applies here too.

### Language

By default, grilling's reactive rule kicks in: reply in whatever language you use, once you use
it — round 1 itself arrives in English. `--lang <language>` (before `--idea`) opens the discussion
in that language from round 1:

```
/readyset --lang Indonesian --idea "let users export their data as CSV"
```

Or set a default once (`--lang` still wins if given); `readyset.lang` works as an alias:

```yaml
readyset:
  language: Indonesian   # or: lang: Indonesian
```

Only the *discussion* changes language — the brainstorm file is always English. Each
`readyset_ask` question's `header` also stays English on purpose, since it reads like fixed UI
chrome rather than conversation.

## Configure a model

`--model` pins one model for every turn this run fires, reproducible regardless of whatever model
was active in the invoking session. The original model is restored once the run finishes.

Without `--model`, Readyset reads a default from omp's own `~/.omp/agent/config.yml`. Set it with
`npx readyset-flow configure` (see [Configure](#configure)) instead of hand-editing YAML, or edit
it directly:

```yaml
readyset:
  model:
    default: anthropic/claude-opus-5
    fallbackChains:                      # tried in order if the default fails to pin
      - anthropic/claude-sonnet-5
      - spark/minimax-m3

modelRoles:                    # omp's own general default, used if readyset.model isn't set
  default: spark/minimax-m3
```

`readyset.model.default` wins if both are set. If the pin itself fails (bad/retired spec),
Readyset tries `readyset.model.fallbackChains` in order before giving up and running unpinned.
`--fallback-model <spec>` is a single spec that wins over the config chain. This only covers the
pin failing before a turn starts, not a model going down mid-turn — for that, configure omp's own
`retry.fallbackChains`.

Every run also has a hard turn budget (10 by default), shown as `agent turns this run: N/10` in
the review panel — a guardrail against an unbounded Refine loop, not a cost estimate.

## The review gate

Picks a brainstorm, then depending on its status:

- **Not proposed yet** — fires **Explore** first (writes `EXPLORATION.md`, every `.gitmodules`
  submodule listed explicitly), then **Propose**, grounded in what Explore found. Drops straight
  into the review gate below.
- **Already proposed** — the sidebar overlay opens automatically, with **Approve & Execute** /
  **Refine** (loops into another revision) / **Discard** as CTAs inside it — Up/Down scroll the
  open section's content, Left/Right jump between sections. Contexts without a real TUI fall back
  to a classic select menu with the same three choices.
- **Approve & Execute** implements the tasks. Each completed task needs an indented `_Verified:`
  note, or the gate sends it back. It can optionally call `readyset_verify({taskId, command})` to
  back that note with more than a self-report — the command runs for real, and an immutable record
  of its exit code, stdout/stderr, and duration is persisted to `readyset/changes/<id>/evidence/`.
  The panel's **Runtime evidence** section lists those records and flags a **conflict** when a
  task is checked `[x]` but its latest evidence exited non-zero — surfaced passively, never
  auto-blocking. Once every task is verifiably done, a separate **code review** turn runs (fresh
  context, told to find problems) and writes `REVIEW.md`. Only then does Readyset offer to
  archive — merging delta specs into `readyset/specs/` append-only, now warning explicitly if a
  delta held a MODIFIED/REMOVED requirement the merge couldn't apply.

## Uninstall

```
npx readyset-flow uninstall
```

Reverses what `install` set up: removes the extension entry from `~/.omp/agent/settings.json`,
deletes the installed skill docs, and clears the `readyset:` block from `~/.omp/agent/config.yml`.
Pass `--keep-config` to leave `config.yml` untouched. Project-level `readyset/changes/`
directories are never touched — your change history stays put. `npx readyset-flow update` is the
opposite direction: an alias for `install`, to refresh the linked extension and skill docs.

## What it deliberately does not do

- `validateChange` is a **structural check** — required sections exist, every requirement carries
  an ADDED/MODIFIED/REMOVED header and its own WHEN/THEN — not a schema validator, and it catches
  an empty or malformed artifact, never a semantically wrong one. Its summary always carries the
  literal suffix `(structural check)`, everywhere it's shown, so it never reads as a stronger
  guarantee than it is. `validateBrainstormContent` (checked before Explore runs) uses the same
  wording for the same reason. The one check that *is* semantic is the code-review turn
  (`REVIEW.md`) — its panel line deliberately doesn't share that suffix.
- `archiveChange` merges delta specs append-only — never a real diff-merge. Safe, but cruder than
  a schema-aware archiver; review the merged spec afterward.
- Grilling's round cap is enforced in code only for rounds asked through `readyset_ask`. In the
  plain-chat fallback, rounds are ordinary chat turns the extension never sees, so the cap there
  is prompt-level only. Always enforced either way: `validateBrainstormContent`, which checks
  Decision/Seam/Scope/Acceptance Criteria actually got filled in before Explore spends a turn on
  it — "Continue anyway" is always available, but it's a deliberate extra step.
- Nothing forces the model to actually call `readyset_ask` — that's prompt-level. The real risk is
  a model racing ahead and writing a brainstorm from its own assumptions. A zero-rounds check
  catches "the model never asked" specifically: if grilling started this session and `readyset_ask`
  was never called, the gate flags it and still requires "Continue anyway" — scoped tight, so a
  hand-written or previously-grilled brainstorm triggers nothing.
- The review screen has two tiers, chosen by feature-detecting `ctx.ui.custom`. Where available,
  the sidebar overlay renders a real persistent two-pane view — the same mechanism native
  `/plan`'s review sidebar uses. Where it isn't, the gate falls back to a classic select menu.
  Either way, the full change is always also pushed into the editor pane as one compiled document.

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
                             kept here to check wording against. Repo-internal reference only.
  cli/
    install.mjs             `readyset-flow install`/`update`/`uninstall`/`version`/`validate`/
                             `configure` — the CLI entry point
    validate-runner.mts     subprocess `validate` spawns with --experimental-strip-types (see above)
    configure.mjs           `readyset-flow configure`'s interactive wizard + the plain-text
                             splice that writes ~/.omp/agent/config.yml's readyset: block back
                             without a YAML library or touching anything else in the file
    configure-runner.mts    subprocess `configure` spawns to read the *current* readyset: values
                             via the real parser in readyset-omp-config.ts, so the wizard's
                             prefill can never drift from what /readyset itself resolves

resources/
  brainstorm-ai/           a companion Claude Skill for brainstorming outside omp entirely (see
                             "Grilling from outside omp") — deliberately outside src/, since
                             nothing in this package's code loads or depends on it
```

`readyset-flow install` only touches `~/.omp/agent/settings.json` (merges one absolute path into
its `"extensions"` array) and `~/.omp/agent/skills/readyset/SKILL.md` (copied — skills have no
array equivalent in omp). Everything under `src/lib/` and `src/extensions/` stays exactly where
the package lives and is read from there in place — confirmed against omp's own native discovery
provider (`loadExtensionModules`), not a guess.
