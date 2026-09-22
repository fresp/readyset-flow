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
  - [Per-phase models](#per-phase-models)
- [The lane](#the-lane)
- [The review gate](#the-review-gate)
- [Uninstall](#uninstall)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)
- [Files a change accumulates](#files-a-change-accumulates)
- [Package layout](#package-layout)

## Why "Readyset"

The name is the point: a plan you can audit is anchored to the real state of the repo — real file
contents, real commit hashes, real test runs — not assumptions. That is a claim about evidence,
not about quality: two independent benchmarks measured Readyset's plans as no better grounded
than a single read-only pass (grounding ~50% in blind judging, twice). What EXPLORATION.md
provides is an auditable trail — every repo claim in proposal/design/specs/tasks should point
back to a numbered exploration entry, so a reviewer can check each one. Readyset fuses three sources:

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
| Repo grounding depends on whatever the current turn checks | Explore is a dedicated phase, logged to `EXPLORATION.md` — an auditable trail, not a quality guarantee (see "Why Readyset") |
| Planning artifacts scatter across a chat | Each change gets its own `readyset/changes/<id>/` directory |
| Review can be informal, or skipped under pressure | A review gate structurally separates proposal from execution |
| "Done" is whatever the model claims | A required `_Verified:` note, optionally backed by captured runtime evidence |
| Implementation and review share the same context | A separate code-review turn — told to find problems, not confirm the work — runs after execution |
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
- **Implementer-facing artifacts describe the user's change, not Readyset.** Planning bodies stay
  about the repo and request; exploration-entry or `verified during planning` anchors go in a
  trailing `## Grounding` section. Workflow vocabulary outside that section is flagged
  warning-only, never blocking.
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
| **2. Explore** | Reads the real repo and writes what it found to `EXPLORATION.md`, before anything gets proposed. | Never skipped for a not-yet-proposed brainstorm — **except on the fast lane**, which folds it into Propose. |
| **3. Propose** | Writes `proposal.md` / `design.md` / `specs/**/spec.md` / `tasks.md`, grounded in Explore's findings, plus the `## Files This Change Will Touch` scope contract. | Never skipped. |
| **4. Review gate** | Approve, **Refine**, or **Discard** — Discard is the default. Nothing executes without a deliberate approval first. | Never skipped — the gate Readyset exists to enforce. |
| **5. Execute** | Implements `tasks.md`. Every finished task needs a `_Verified:` note, optionally backed by `readyset_verify` evidence. A separate **code-review** turn runs before archiving. | Never skipped. |

**Refine** sends you back to Propose; a failed verification at Execute sends you back to the
review gate — either way you land on a stage above, never off into an unrecoverable branch.

Phase discipline is enforced, not just requested. After the Propose turn fires, Readyset snapshots
the working tree and **stops the run with no gate offered** if anything outside
`readyset/changes/<id>/` and `.ai/brainstorms/` changed — a planning turn may only leave planning
artifacts. See [What it deliberately does not do](#what-it-deliberately-does-not-do) for the exact
boundary of that check. Each of Explore and Propose also runs under a wall-clock budget (20 min by
default); a breach warns visibly in `CONTEXT.md` rather than failing silently.

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

Grilling asks only questions whose answer changes the plan. Every `readyset_ask` question carries
a `decision` field naming the plan decision it changes and how the plan differs per answer; a
round with any question missing it is refused before the picker opens, and does not consume a
round. Before asking anything, grilling walks an edge-case checklist — empty/missing values, case
sensitivity, boundaries, error codes/messages, backward compatibility/deprecation, docs/release
artifacts, and how verification is committed — and asks about an item only when its answer changes
the plan and the repo cannot settle it. Anything else is decided directly and recorded under
`## Assumed` with the concrete behavior chosen. The fast lane applies the same checklist to its
own grounding reads and records behavior-changing decisions under the brainstorm's `## Assumed`
(or the proposal's `## Assumptions`).

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

Alongside `lane`, grilling writes the clarity signal into the frontmatter: `clarity`
(`clear` = 0 open decisions after fact-finding, `partial` = 1–2, `ambiguous` = 3+ or an undefined
core behavior), `openDecisions`, `questionsAsked`, a one-line `laneReason`, and — only when it
genuinely applies — `riskFlag` (`cross-cutting`, `migration`, `api-change`, `security`). Code
validates these and recomputes a recommended lane from them (see [The lane](#the-lane)); an older
brainstorm without them loads and runs exactly as before.

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
the review panel — a guardrail against an unbounded Refine loop, not a cost estimate. It counts
fired turns, so it does not bound the tool calls *inside* one turn; the per-phase wall-clock
budgets (see [How it works](#how-it-works)) cover that gap.

### Per-phase models

`--model` pins one model for the whole run, so there is no way to spend a cheap model on the
phases that don't need a strong one. `--phase-model <phase>=<spec>` (repeatable) and
`readyset.model.phases.<phase>` in config fix that — resolved per phase as **flag > config > run
pin**:

```
/readyset --phase-model grill=spark/minimax-m3 --phase-model explore=spark/minimax-m3 \
  --idea "let users export their data as CSV"
```

```yaml
readyset:
  model:
    default: anthropic/claude-opus-5
    phases:
      grill: spark/minimax-m3
      explore: spark/minimax-m3
```

Covers `grill|explore|propose|apply|review`; **Refine rides the propose override**, since it
re-proposes. An override that fails to resolve or pin warns and falls back to the run model — a
phase model is a cost optimization, never a reason to stop the run.

The `configure` wizard does **not** cover phase models (it stays limited to language, default
model, and fallback chain) — `readyset.model.phases` is hand-edited YAML.

## The lane

A change runs on one of two lanes. The lane decides how heavy the later phases are, and it is a
real run input — not just a label on the brainstorm picker.

- **Full** (default) — the five stages as described above, including a separate Explore turn. It
  writes the full artifact set: `proposal.md`, `design.md`, `specs/**/spec.md`, `tasks.md`.
- **Fast** — for a small, well-understood change. Explore is folded into Propose (no separate turn;
  a few targeted reads, noted inline in `CONTEXT.md`), Propose carries a tight-planning suffix
  (roughly 8 tasks, no padding), and the code-review turn skips mutation-testing-style probes.
  It also writes a **smaller artifact set**: `proposal.md` and `tasks.md` only — **no `design.md`
  and no spec delta**. The acceptance scenarios that a spec delta would carry live under a
  `## Acceptance` section in `proposal.md` instead, one `- **WHEN** … **THEN** …` bullet per
  scenario, each given an id (`[S1]`, `[S2]`, … in document order) that `tasks.md` references.

Whichever lane runs, `proposal.md` opens with a small YAML frontmatter block whose first line
records the lane (`lane: full` or `lane: fast`). That line is the on-disk source of truth for the
lane: `validateChange`, `archiveChange`, the review overlay, and the standalone `readyset-flow
validate` CLI all read it, so they agree without any run context or phase log. A proposal with no
`lane:` line (an older change) reads as **full**.

The lane follows the grilling signal. Grilling writes a clarity score onto the brainstorm
(`clear` = 0 open decisions after fact-finding, `partial` = 1–2, `ambiguous` = 3+ or an undefined
core behavior), and code maps it to a recommended lane: `clear` → fast, `ambiguous` → full,
`partial` → **fast unless a risk flag applies**, in which case full. The risk flags are
`cross-cutting`, `migration` (data/format), `api-change` (public API/deprecation), and `security`
(auth). A narrow-looking rename with a deprecation path is exactly the case the risk flag exists
for: it reads small but is cross-cutting, so `partial` escalates to full.

By default (`readyset.lane.default: ask`) grilling proposes a lane with a one-line reason and you
confirm or override it; that pick is recorded on the brainstorm. `readyset.lane.default` decides
otherwise:

```yaml
readyset:
  lane:
    default: auto   # ask | auto | fast | full
```

- `ask` (default) — ask the user during grilling, as above.
- `auto` — accept code's clarity → lane recommendation without prompting; if it differs from the
  lane the file records, the run warns and uses the recommendation.
- `fast` / `full` — force that lane.

Precedence is `--lane` > `readyset.lane.default` > the brainstorm's recorded lane, so `--lane
fast|full` still forces the lane for one run (`--fast` is only a picker filter — it decides which
brainstorms are *listed*, and never forces a lane). The picker shows the clarity score and the
recommendation when they disagree, and the effective lane so an override is visible before
anything runs. `readyset.lane.default` is hand-edited YAML — the `configure` wizard covers only
language, model, and fallback chain.

The lane trims **volume**, never the questions that change behavior: grilling still asks everything
whose answer would change what gets built on either lane.

### Artifact budgets

Each planning artifact has a character budget. The Propose prompt states them (and the rules that
keep the artifacts from restating each other), the gate panel shows a measured line per artifact
(`artifacts: proposal 3,120 chars (budget 4,000)`, with `— OVER by N` when it runs long), and an
overrun is only ever a **warning** — it never blocks the gate.

The defaults, per lane:

| artifact | full lane | fast lane |
| --- | --- | --- |
| `proposal.md` | 4,000 | 4,000 |
| `design.md` | 5,000 | unlimited (no design.md) |
| `specs/**` **total** | 6,000 | unlimited (no spec delta) |
| `tasks.md` | 4,000 | 3,000 |

`specs` is a **total** across every `specs/**/spec.md` file, not a per-file cap. Override any of
them under `readyset.artifacts.budget.<file>` in `~/.omp/agent/config.yml`:

```yaml
readyset:
  artifacts:
    budget:
      proposal: 3000
      specs: 8000
```

The key is not lane-scoped: one block sets the same value on both lanes, so a fast-lane
`design`/`specs` budget (which defaults to unlimited) can only be *lowered* by config, never
raised to a real budget. An invalid value (non-numeric, `0`, negative, empty) silently keeps the
default — a budget is a soft signal, so a typo must not block a run.

A file that runs **more than 1.5× its budget** fires at most **one** Trim turn (planning-only,
never code; skipped when the turn budget is too tight to keep Apply and Review), which rewrites
just the over-budget artifacts down to budget by removing restated content. The turn is recorded
as a `trim` phase event carrying the before/after sizes.

## The review gate

Picks a brainstorm, then depending on its status:

- **Not proposed yet** — fires **Explore** first (writes `EXPLORATION.md`, every `.gitmodules`
  submodule listed explicitly), then **Propose**, grounded in what Explore found. Drops straight
  into the review gate below.
- **Already proposed** — the sidebar overlay opens automatically, with **Approve & Execute** (or
  **Approve & Execute, keep context**) / **Refine** (loops into another revision) / **Discard** as
  CTAs inside it (`[A]`/`[K]`/`[R]`/`[D]`) — Up/Down scroll the open section's content, Left/Right
  jump between sections. Contexts without a real TUI fall back to a classic select menu with the
  same choices, **Discard listed first**: the gate is fail-closed, so nothing runs unless an
  Approve option is deliberately picked. Cancelling fires no agent turn at all.
- **Approve & Execute** compacts the planning context first — Explore/Propose history is already
  persisted under `readyset/changes/<id>/`, so Apply re-reads the artifacts from disk instead of
  paying for that history twice. Pick **keep context** when discussion nuance didn't make it into
  the artifacts, so the model still has it; **keep context** never compacts. A failed or
  unavailable `ctx.compact` degrades to plain execution.
  - Planning phases also compact at their own boundaries — after grilling before **Explore**
    (the brainstorm is on disk), and after Explore before **Propose** (`EXPLORATION.md` is). These
    boundaries (and the Apply default above) only compact **when the reported context usage is at
    or above `readyset.compact.minContextPercent` (default 25%)**, so a fresh session with almost
    nothing to summarize skips the turn. `--compact always` forces every boundary; `--compact never`
    disables them all (including the Apply default — only a future compaction CTA would then
    compact). Because everything each phase relies on is on disk, this is **expected** to reduce
    prep token cost (mostly cache reads), but that effect is **unmeasured** — it is pending the next
    benchmark, as is the effect on plan quality. The summarization runs under the phase's own
    configured model where one is set (omp exposes no compaction-model parameter); each boundary
    records a `compact` phase event so the effect can be measured.
- The panel also shows the **scope check** — the working tree against `proposal.md`'s
  `## Files This Change Will Touch` contract. Anything changed that the contract doesn't name is
  listed as **OUT OF SCOPE** (paths under `readyset/` and `.ai/brainstorms/` are always in scope). An
  absent contract reads as "no contract", not a silent pass. It **warns, never blocks**.
  - The contract is also checked for three kinds of reference problem, and Readyset now tries to
    **fix them automatically, once, before the gate**: an unmarked path that doesn't exist
    (**dangling**), a path marked `(new)` that already exists on disk (**new-but-exists** — the plan
    would overwrite a real file believing it creates one), and a path marked `(delete)` that doesn't
    exist (**delete-but-missing**). If any are present, one repair turn rewrites only the
    `## Files This Change Will Touch` section (and matching path mentions) to correct them, then the
    check re-runs. The repair **runs at most once per Propose or Refine** and is skipped when the run
    has no turn budget left. Anything it could not fix is still shown — `scope refs: DANGLING …
    · NEW-BUT-EXISTS … · DELETE-BUT-MISSING …` in the panel, and all three listed in the review
    document's **Scope** section, which also shows `contract repair: fixed N of M` when a repair ran.
    Mark files the change will *create* with `(new)` and files it will *delete* with `(delete)` so
    each absence or presence reads as expected.
  - The panel also shows the **open decisions**: `proposal.md`'s `## Open Decisions` section (one
    `### <question>` block per decision, each with `Options` / `Recommended` / `Changes per option`)
    and the `## Assumptions` section (each brainstorm `## Assumed` item restated with the chosen
    behavior). The panel states the count and lists each question with its recommendation, and the
    compiled review document gets an **Open decisions** section showing the raw blocks and the
    assumptions. When any decision is unresolved, the gate offers a **Resolve open decisions** CTA
    (`[O]` in the sidebar, a menu item otherwise) that refines the change with the list so you can
    pick (or confirm) the recommended option for each; the refinement moves each resolved item into
    `## Assumptions` and updates the affected scenarios. Approving with open decisions is still
    allowed — warn, never block — recorded as `openDecisions` on the `gate` `end` phase event, and
    any still open at approval are applied using the **recommended** option and recorded under
    `## Decisions made during Apply` in `tasks.md`. Behavior-changing assumptions also get their own
    WHEN/THEN scenarios marked `(assumed)`; the gate lists each as `assumed scenario: <text>` and
    the review document shows them alongside the open decisions, while a task that pins one carries
    `(assumed)` in its description and a test that pins one says so in its name or an adjacent
    comment.
- Scope is checked **again after Execute**: the gate's check runs before Execute, so it only sees
  what Propose changed. A file touched outside the contract during Execute is named at the
  **Archive now?** prompt (and recorded in `CONTEXT.md`) — advisory, not a block, since
  implementation legitimately touches more files than planning.
  - Apply is also told to keep the **diff minimal**: touch only files in the scope contract and
    update every doc it lists (a listed doc left untouched is a dropped requirement, not a saving).
    Make no refactors/renames/reformatting the task doesn't need, add no unrequested helper
    modules, scripts, benchmarks, or docs beyond what the contract lists, and only add or modify
    tests that exercise the specs' WHEN/THEN scenarios. Never modify seed data, fixtures, or
    sample data in production paths unless the request asks for it; never add runtime self-checks
    or assertions to production code to verify your own change (that belongs in tests); and never
    change an existing test's expectations unless the requested behavior changes them. Changes to
    protected seed/fixture/sample paths are also warned after Execute (see
    `readyset.scope.protectedPaths`), even when the contract lists them with a reason. If a file
    outside the contract is genuinely required, Apply must record it under a
    `## Scope deviations` section in `tasks.md` as `- <path> — <reason>`.
  - After Execute, a file touched outside the contract with **no** deviation entry is
    **reconciled once**: one bounded turn reverts it (`git checkout -- <path>`, or deletes it if
    this run created it — never `git checkout .`/`git stash`/`git reset`/`git clean`) or keeps it
    and writes a `## Scope deviations` entry. It re-runs the affected tests and updates their
    `_Verified:` notes after any revert. **Only a path that is (a) outside the contract, (b) changed
    by this run (baseline-subtracted), and (c) *not* in the change's dirty baseline — i.e. not dirty
    before the run started — is ever offered for revert or deletion**, and that candidate list is
    computed in code and handed to the turn; with **no dirty baseline at all** (an older change, or
    a failed capture) no revert is offered and the turn may only justify. Before the turn, every
    candidate is copied to `readyset/changes/<id>/reverted/<path>` and the backup is recorded in
    `CONTEXT.md`; after it, a hash of every baseline-dirty and contract file is compared against a
    pre-turn snapshot, and **anything the turn changed or deleted outside its candidate list is
    restored byte-for-byte**, logged loudly, and surfaced at the archive prompt. The turn **runs at
    most once per Execute**, and is skipped when the run has no turn budget left. Anything still
    unjustified is named at the **Archive now?** prompt and in `CONTEXT.md` — a **warning, never a
    block**. If the reconciliation turn itself touches a new out-of-contract file, that is surfaced
    too. The code-review turn also gets the deviation list and writes a `## Scope` section of
    `REVIEW.md` judging each deviation necessary-or-gold-plating.
- **Approve & Execute** implements the tasks. Each completed task needs an indented `_Verified:`
  note, or the gate sends it back. It can optionally call `readyset_verify({taskId, command})` to
  back that note with more than a self-report — the command runs for real, and an immutable record
  of its exit code, stdout/stderr, and duration is persisted to `readyset/changes/<id>/evidence/`.
  The panel's **Runtime evidence** section lists those records and flags a **conflict** when a
  task is checked `[x]` but its latest evidence exited non-zero — surfaced passively, never
  auto-blocking. Once every task is verifiably done, a separate **code review** turn runs (told
  to find problems, not confirm the work) and writes `REVIEW.md`. Only then does Readyset offer to
  archive — merging delta specs into `readyset/specs/` append-only, now warning explicitly if a
  delta held a MODIFIED/REMOVED requirement the merge couldn't apply.
  - **Risk-based code review.** The code-review turn is not unconditional: it is gated by
    `readyset.review.mode` (default `auto`) and the `--review auto|always|never` flag (the flag
    wins over config for that run). `always` keeps the pre-0.14 behavior — review every run;
    `never` skips it and writes a stub; `auto` reviews only when at least one **trigger** fires:
    (1) **scope drift** — a post-Execute path outside the contract with no deviation entry;
    (2) **evidence conflict** — a checked `[x]` task whose latest `readyset_verify` record exited
    non-zero; (3) **no evidence** — at least one task checked, but the change has *zero*
    `readyset_verify` records *and* no command-bearing `_Verified:` note (a note naming a runnable
    command, such as ``npm test``, also satisfies this); (4) **diff size** — more than
    `readyset.review.maxLines` (default 150) changed lines *or* more than
    `readyset.review.maxFiles` (default 5) **non-test** files (`readyset.review.testPaths`,
    default: `test/**`, `tests/**`, `**/*.test.*`, `**/*.spec.*`, `__tests__/**`);
    (5) **sensitive path** — any changed path matching `readyset.review.sensitivePaths`
    (default list: `auth/**`, `**/auth/**`, `security/**`, `**/security/**`,
    `**/migrations/**`, `**/*migration*`, `schema/**`, `**/schema/**`, `payment/**`,
    `**/payment/**`, `crypto/**`, `**/crypto/**`, `**/*.pem`, `**/*.key`, `.github/**`,
    `Dockerfile`, `**/Dockerfile`, `docker-compose*.yml`, `**/docker-compose*.yml`);
    (6) **protected path** — any changed path matching `readyset.scope.protectedPaths`
    (default seed/fixture/sample patterns: `**/seed*`, `**/seeds/**`, `**/fixtures/**`,
    `**/*.fixture.*`), even when the contract lists it with a reason — the contract may name a
    protected path only alongside that reason, and review judges whether the change was warranted;
    (7) **clarity** — the brainstorm's `clarity` is `partial` or `ambiguous`;
    (8) **open decisions** — `proposal.md`'s `## Open Decisions` still carries one or
    more unresolved items at review time. `readyset.review.fullLane` (default `always`) keeps a
    full-lane change reviewed regardless of triggers; set it to `auto` to let the triggers decide
    on the full lane too.
    - **Review policy.** Every trigger is recorded, fired or not, in the `review` `end` phase
      event (and in the stub) so the mode/triggers/outcome are auditable. A skipped run writes an
      honest stub — `Review skipped (auto): no risk trigger` with the full evaluated list — in
      place of findings, so "nothing was checked" is distinguishable from "checked and clean."
      `--review <change-id>` runs the review **on demand** for an existing, not-yet-archived
      change (overwriting any stub), which is the escape hatch when `auto` skipped it but you want
      a review before opening a PR. The default values here are **initial, pending benchmark
      data — not measured optima**.
    - **The review-fix turn.** `REVIEW.md` must end with a `## Blocking` section — one bullet per
      finding that violates a WHEN/THEN scenario, an explicit requirement (including a doc the
      request or contract asked for that was never written), or a recorded decision; the literal
      `none` when there are none. When it is non-empty, the run fires **exactly one** bounded
      review-fix turn (on the apply phase model) that fixes only those findings and appends a
      `## Fix turn` section recording each one fixed or not-fixed. No second review runs. The fix
      turn obeys the same minimal-diff rules as Apply and gets the same post-Apply scope check
      re-run (warning only — no second reconciliation turn). Its `review-fix` phase event carries
      `fixed` / `partial` / `skipped-budget` / `not-needed`, and the archive prompt states
      `blocking: N found, M fixed`. With no turn budget left it records `skipped-budget` and only
      warns.

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
  - The unobservable-THEN check follows the same rule: it flags a requirement whose THEN names only
    a code property, by looking for an externally checkable signal (exit code, stdout/stderr, HTTP
    status, file content, a command result). It is signal words, not understanding — its job is
    catching the *uncheckable* kind, not certifying the good kind.
- The gate invariant (see [How it works](#how-it-works)) is a **boundary** check, not a full phase
  audit: it catches a planning turn that wrote outside `readyset/changes/<id>/` and
  `.ai/brainstorms/`, from the working tree, after the turn has already run. It cannot see what a
  turn did inside those paths, and a repo whose working tree is not under git has no boundary to
  check at all. What was already dirty before the change started is captured once and subtracted,
  so unrelated WIP never counts against it.
- The per-phase budgets (wall-clock) **warn, they do not kill** a phase. A model that is slow or
  looping is recorded in `CONTEXT.md` and surfaced, not forcibly interrupted mid-turn.
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

Under `readyset/changes/<id>/`. On the **full lane**, in the order they get written:

```
EXPLORATION.md   Explore phase findings — what was actually checked, and what was found
proposal.md      Why / What Changes, plus the `## Files This Change Will Touch` scope contract
                 (mark files the change will create with `(new)` and files it will delete with
                 `(delete)`, so the gate can tell them from files that must already exist; Readyset
                 repairs a wrong contract once, automatically, before the gate). Opens with a
                 `lane: full|fast` frontmatter line — the on-disk source of truth for the lane
design.md        Context / Goals-Non-Goals / Decisions / Risks
specs/**/spec.md ADDED/MODIFIED/REMOVED Requirements as WHEN/THEN scenarios
tasks.md         checkbox tasks; each `- [x]` carries an indented `_Verified:` note
evidence/E*.md   optional runtime-evidence records from `readyset_verify` — one per call,
                 numbered E001, E002, ...; never auto-created, never mutated once written
CONTEXT.md       append-only audit trail — one entry per phase transition, written by the
                 extension itself (not the model), so it can't be skipped or misremembered.
                 As well as the human-readable phase entries, it carries a machine-parseable
                 phase-event log — one `<!-- readyset-phase -->` marker followed by a one-line
                 `json` fence per phase boundary, recording the phase, `start`/`end` edge, an ISO
                 timestamp, the effective lane (`fast`/`full`) and its source (`flag`/`brainstorm`),
                 and where relevant the phase model and an outcome. readyset-bench's compile step
                 reads these to split runs by lane and attribute tokens/wall time to phases.
                 A `propose`/`trim` event also carries per-artifact character counts, so the bench
                 can report planning size by lane. Also carries the once-written pre-existing-dirty
                 baseline the gate invariant and scope check subtract (see "What it deliberately
                 does not do")
REVIEW.md        code-review phase findings, written after implementation, before archive
```

The **fast lane** carries a smaller set — no `design.md` and no spec delta:

```
proposal.md      Why / What Changes / `## Files This Change Will Touch`, plus a `## Acceptance`
                 section holding the acceptance scenarios (one `- **WHEN** … **THEN** …` bullet
                 each, with `[S1]`, `[S2]`, … ids that `tasks.md` references). Opens with a
                 `lane: fast` frontmatter line
tasks.md         checkbox tasks; each `[Sn]` maps back to a proposal `## Acceptance` scenario and
                 each `- [x]` carries an indented `_Verified:` note
evidence/E*.md   same as the full lane
CONTEXT.md       same as the full lane
REVIEW.md        same as the full lane
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
