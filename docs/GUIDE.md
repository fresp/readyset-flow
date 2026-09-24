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
not about quality: an early, pre-EXPLORATION.md version of Readyset was measured as no better
grounded than a single read-only pass, which is exactly the gap EXPLORATION.md exists to close.
What EXPLORATION.md provides is an auditable trail — every repo claim in proposal/design/specs/
tasks should point back to a numbered exploration entry, so a reviewer can check each one. See
[BENCHMARK.md](BENCHMARK.md) for the numbers this claim used to cite, and its note on why they are
not currently trusted as a live measurement of the current version. Readyset fuses three sources:

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
  marks a task done or touches `_Verified:`. The apply prompt recommends it and asks the model to
  cite the record as `evidence E00N` in the task's note. A citation is a checkable claim: one that
  names a missing record, another task's record, or a failed run is an evidence conflict, and
  `readyset_done` refuses "done" while any conflict remains.
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
| **1. Grill** | Only for a raw idea (`--idea "..."`). Interrogates ambiguity until Decision/Seam/Scope/Acceptance Criteria resolve. Immediately offers to proceed with Explore & Propose upon completion. | Skipped if a brainstorm already exists in `.ai/brainstorms/`. |
| **2. Explore** | Reads the real repo and writes what it found to `EXPLORATION.md`, before anything gets proposed. | Never skipped for a not-yet-proposed brainstorm — **except on the fast lane**, which folds it into Propose. |
| **3. Propose** | Writes `proposal.md` / `design.md` / `specs/**/spec.md` / `tasks.md`, grounded in Explore's findings, plus the `## Files This Change Will Touch` scope contract. | Never skipped. |
| **4. Review gate** | Approve, **Refine**, or **Discard** — Discard is the default. Approving hands off execution directly to native core omp. | Never skipped — the gate Readyset exists to enforce. |
| **5. Execute** | Implemented directly by core omp with native runtime support (subagents, parallel execution). Once complete, run `/readyset --review <change-id>` for on-demand review and archiving. | Never skipped. |

**Refine** sends you back to Propose; **Approve & Execute** hands off the change to core omp for
implementation. Once execution completes, run `/readyset --review <change-id>` to evaluate risk triggers,
run code review, and archive.

Phase discipline is enforced, not just requested. After the Propose turn fires, Readyset snapshots
the working tree and **stops the run with no gate offered** if anything outside
`readyset/changes/<id>/` and `.ai/brainstorms/` changed — a planning turn may only leave planning
artifacts. See [What it deliberately does not do](#what-it-deliberately-does-not-do) for the exact
boundary of that check. Each Explore and Propose turn also runs under a wall-clock budget
(`readyset.phaseBudget.minutes`, 20 by default). When the budget runs out, Readyset **aborts the
turn** (`ctx.abort()`) and continues with whatever the turn wrote so far. The phase event records
`outcome: "budget-aborted"` (or `"budget-aborted-partial"` when Explore still left an
EXPLORATION.md), and the elapsed time is logged in `CONTEXT.md`. Set it to `0` to only measure and
report without aborting. Fractions are allowed.

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
When `readyset_ask` is absent from the model's available tools, grilling falls back immediately to
asking structured questions directly in chat with explicit options and recommended picks — the prompt
expressly forbids searching the filesystem, process table, or network for the missing tool.
Once the model writes the brainstorm file, Readyset immediately prompts you with a confirmation
dialog asking whether to proceed with Explore & Propose in the active session. Choosing to proceed
continues without re-invoking `/readyset` or manually re-selecting the file, preserving prompt cache
prefixes and context continuity.

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
budgets (see [How it works](#how-it-works)) cover that gap. Since execution and review no longer
draw on this budget, the only turn it protects is a Refine you ask for. Automatic follow-up turns
(contract repair, trim) therefore never take the last turn.

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

**Grill** is a chat turn rather than a fired-and-awaited one, so its model is pinned right before
the grill turn fires (grill override, else the run pin) and restored as soon as the brainstorm is
written — before Explore starts — or on the next `/readyset` command if grilling is abandoned.
The `grill` phase event records the model grilling actually ran on, and records none when
grilling ran on the session model or happened in an earlier run.

The **apply** override does one thing the others don't: it decides the model the *handed-off
execution* runs on. On Approve & Execute the execution model is, in order:

1. the apply phase override (`--phase-model apply=<spec>` / `readyset.model.phases.apply`),
2. else the run pin (`--model` / `readyset.model.default`),
3. else the session's current model, untouched.

That model stays active for the whole handed-off execution turn, and the model the session had
before `/readyset` is restored once that execution actually finishes. Three details matter here:

- **Where the restore target comes from.** When a pin exists (`--model` / `readyset.model.default`)
  the pre-pin model is captured when the pin is applied. When only the apply override exists,
  the pre-apply session model is captured in the approve branch, immediately before the execution
  model is applied — so `--phase-model apply=<spec>` on its own still restores. If applying the
  execution model fails (no key, unresolved spec, host without `pi.setModel`), nothing is captured
  and the settle has nothing to restore.
- **The executing model signals the end with `readyset_done`.** The apply prompt tells it to call
  `readyset_done` as its last action:
  - `status: "done"` is accepted only when every task in `tasks.md` is checked and has its
    `_Verified:` note. Otherwise the call is refused with the reason, so a premature "done" costs
    one tool call rather than a wrong settle. The next terminal `agent_end` then closes the handoff
    as `outcome: "handoff-done"`.
  - `status: "blocked"` needs the exact question as its summary. It is an explicit pause: the
    question is surfaced to you, the execution model stays active, and it never counts toward a
    stall.

  Only the arming session can signal; a subagent is told to report to its parent. When no signal
  arrives, the checkbox/fingerprint inference below is the fallback. The balancing `apply` `end`
  event records how the execution got there (`handoff: { pauses, blocks, verificationBlocks,
  rehydrated, signal }`) and the review policy's decision (`reviewPolicy: { mode, decision,
  triggersFired }`), so the bench can score handoff outcomes directly.
- **Settling is pause-aware and idempotent.** A *terminal* `agent_end` with tasks still unfinished
  means execution paused to ask a question or report a blocker, not that it finished: the execution
  model stays active, the handoff stays armed, and the pause is recorded as a `CONTEXT.md` line
  only — never a new phase event, so N pauses never leave N unbalanced `apply` `start` events.
  Each pause is fingerprinted (tasks.md's done/total count plus the raw `git status` text); if the
  *next* pause's fingerprint is identical to the last one, nothing observably happened in between —
  the run has genuinely stalled — and it settles right there as `outcome: "handoff-stalled"` rather
  than arming forever. Real progress between two pauses just updates the fingerprint and the
  `CONTEXT.md` note. The restore also happens once all tasks are done (`outcome:
  "handoff-settled"`), or when the next `/readyset` command **supersedes** the handoff — that path
  restores the pre-run model and records `outcome: "handoff-superseded"`, so an interleaved run can
  never leave the session stuck. An automatic continuation (`willContinue`, e.g. an auto-retry) is
  never a terminal settle, so it neither pauses nor settles.
- **Matching is by session, not directory.** omp rebinds a parent-imported extension factory into
  subagent runtimes in the same process, so a `task` subagent's own terminal `agent_end` shares the
  parent's working directory. The handoff is keyed by the arming session's id, so a subagent's
  settle cannot restore the parent's model, close its `apply` window, or spend its
  `session_stop` verification budget (below). Host builds without `sessionManager` fall back to
  matching on the working directory.
- **The approve-base commit is captured too.** `git rev-parse HEAD` at approve time is recorded in
  the change's `state.json` alongside the handoff. Scope, review triggers and the diff stats on the balancing
  `apply` `end` event are all measured against that commit — the current dirty worktree UNIONED
  with whatever has been committed since (`git diff --name-only <base>..HEAD`) — so a commit the
  handed-off execution makes mid-run (leaving the tree clean again) is never invisible.
- **`readyset_verify` is live for the whole handoff**, and the risk-based review policy
  (`readyset.review.mode`/`fullLane`) is actually applied once it settles for real (not on a pause
  or a supersede): `never`, or `auto` with no trigger, writes `REVIEW.md`'s skip stub explaining
  why; `always`, or `auto` on a full-lane change (`fullLane: always`, the default), or `auto` with
  a trigger firing, notifies that review is recommended and names `/readyset --review <id>`.
  Planning-only paths (`readyset/**`, `.ai/brainstorms/**`) never count toward a trigger — the model
  updating its own `tasks.md`/`CONTEXT.md` is not a reason to recommend review.
- **A `session_stop` verification gate** blocks the session that approved the change from ending
  (up to twice per change) while a checked task in the armed change lacks a `_Verified:` note
  (plain or as a `- _Verified: …` sub-bullet), so "forgot to annotate, moved on" doesn't slip past
  silently. Subagents spawned during the execution are never gated.
- **The handoff survives an omp restart.** It is mirrored to `readyset/changes/<id>/handoff.json`
  while unsettled; the same session re-attaches it after a restart or resume, and
  `/readyset --review <id>` closes one another session left behind as `handoff-orphaned`.

Readyset notifies which model execution runs on and where it came from.

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
never code; skipped when it would take the run's last turn, which stays free for a Refine), which rewrites
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
    check re-runs. The repair **runs at most once per Propose or Refine** and is skipped when it
    would take the run's last turn, which stays free for a Refine. Anything it could not fix is still
    shown — `scope refs: DANGLING …
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
- **Stay-in-repo, with an outside-repo tripwire.** Every phase prompt and `src/skill/SKILL.md`
  carry one stay-in-repo rule from a single shared constant: work only inside the current
  repository, never search or read outside it (no `find /`, no absolute paths outside the repo, no
  home-directory files, logs or notes), and never inspect Readyset's own implementation, package or
  configuration. Because omp's extension API fires `pi.on("tool_call")` before every tool runs,
  the rule is also **observed, not just asked for**: `bash`/`read`/`grep`/`glob` calls whose
  arguments name an absolute path outside the repo (or use `find /`, `~` or `$HOME`) are counted.
  To keep the signal meaningful on an API repo — where nearly every run would otherwise warn — the
  check is deliberately narrow: an absolute token counts only when its first segment is a real
  top-level directory on the host (checked once with `existsSync` and cached), so `grep`'s
  `pattern` (a regex, never a path), `/dev/*`, a redirection target like `> /dev/null`, and
  route-like strings whose first segment is not a real host directory (`/orders/:id`, `/products`)
  are all excluded. A path under `/tmp` is a separate **tmp** category (scratch directories are
  legitimate): reported alongside the headline but never counted in it, riding the same sinks as
  `outsideRepoTmp` on the `gate` `end` event. The count surfaces in four places — a
  `⚠ outside-repo access` entry in `CONTEXT.md`, an
  `outsideRepo` field on the `gate` `end` phase event, a line in the gate panel, and a prefix on
  the **Archive now?** prompt. **Advisory only** — nothing is blocked and no phase fails; a host
  without the hook (older omp builds) simply no-ops.
- Scope is checked **again after Execute**: the gate's check runs before Execute, so it only sees
  what Propose changed. A file touched outside the contract during Execute is named at the
  **Archive now?** prompt (and recorded in `CONTEXT.md`) — advisory, not a block, since
  implementation legitimately touches more files than planning. What counts as "changed this run"
  is the dirty worktree UNIONED with whatever has been committed since the approve-base commit
  (see [Per-phase models](#per-phase-models)'s handoff section) — a commit the handed-off execution
  makes mid-run, leaving the tree clean again, is still counted. Because execution is omp's turn,
  not Readyset's, Readyset does not revert or repair anything here: the deviations are surfaced
  when you run the review, and judged there.
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
  - The code-review turn gets that deviation list and writes a `## Scope` section of `REVIEW.md`
    judging each deviation necessary-or-gold-plating.
- **Approve & Execute** hands off implementation of the change directly to core omp's native runtime.
  Readyset marks the change approved, logs the handoff in `CONTEXT.md` and phase events (`outcome: "handoff-omp"`),
  clears editor and widget state, sends the execution prompt (`applyTurnPrompt`) to omp via `pi.sendUserMessage`,
  and exits immediately. Before that send it applies the execution model (apply phase override → run pin, see
  [Per-phase models](#per-phase-models)), keeps the session's pre-`/readyset` model pinned back until the handed-off
  execution settles, then restores it and records the balancing `apply` `end` phase event
  (`outcome: "handoff-settled"`, carrying the model execution actually ran on). "Settles" is
  pause-aware and session-keyed: a terminal `agent_end` with tasks still unfinished keeps the
  execution model active (`outcome: "handoff-paused"`), a subagent's own settle cannot end the
  parent's handoff, and a new `/readyset` before the handoff settles restores the model itself
  (`outcome: "handoff-superseded"`).
  Core omp executes the tasks natively, with full support for subagents, parallel tool
  calls, and real-time task checklist updates.
- **On-demand Code Review & Archiving**. After omp finishes implementing the tasks, run
  `/readyset --review <change-id>` on demand. Readyset evaluates risk triggers against working tree changes,
  fires an adversarial code-review turn, writes `REVIEW.md`, and prompts to archive the change (merging delta
  specs into `readyset/specs/` append-only, with warnings if MODIFIED/REMOVED requirements cannot be merged).
  - **Risk-based code review.** The code-review turn is not unconditional: it is gated by
    `readyset.review.mode` (default `auto`) and the `--review auto|always|never` flag (the flag
    wins over config for that run). `always` keeps the pre-0.14 behavior — review every run;
    `never` skips it and writes a stub; `auto` reviews only when at least one **trigger** fires:
    (1) **scope drift** — a post-Execute path outside the contract with no deviation entry;
    (2) **evidence conflict** — a checked `[x]` task whose latest `readyset_verify` record exited
    non-zero, or whose `_Verified:` note cites a record (`evidence E003` / `see E003`) that does not
    exist, was recorded for another task, or failed; (3) **no evidence** — at least one task checked, but the change has *zero*
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
    - **`REVIEW.md`'s `## Blocking` section.** The review turn is told to end `REVIEW.md` with a
      `## Blocking` section — one bullet per finding that violates a WHEN/THEN scenario, an
      explicit requirement (including a doc the request or contract asked for that was never
      written), or a recorded decision; the literal `none` when there are none. Readyset records
      the section as-is: since execution is omp's turn, there is **no automatic fix turn** — the
      findings are yours to act on (the archive prompt and the change directory leave them where
      you can read them), and a non-empty section is a signal to fix before archiving, not a
      trigger for another turn.
    - **Bugfix doc boundaries & negative grounding.** For bugfixes and targeted refactors, prompt
      rules explicitly bar modifying or adding documentation files (`README.md`, `docs/*`) to
      `## Files This Change Will Touch` unless the user explicitly requested doc updates.
      Additionally, negative plan assertions (confirming that an unrelated file will not be changed)
      avoid citing real file extensions (e.g. stating "no changelog entry" rather than "no CHANGELOG.md")
      so automated grounding scanners do not falsely report dangling path references.

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
CONTEXT.md       append-only, human-readable audit trail — one entry per phase transition,
                 written by the extension itself (not the model), so it can't be skipped or
                 misremembered. Machine state no longer lives here (0.18+); changes from earlier
                 versions keep their fenced-JSON markers, and every reader still falls back to them
events.jsonl     the machine-parseable phase-event log, one JSON object per line, append-only:
                 the phase, `start`/`end` edge, an ISO timestamp, the effective lane (`fast`/`full`)
                 and its source, and where relevant the phase model and an outcome (plus diff,
                 handoff and review-policy data on the `apply` `end` event, per-artifact character
                 counts on `propose`/`trim`). readyset-bench reads these to split runs by lane and
                 attribute tokens/wall time to phases
state.json       write-once facts about the change: the pre-existing-dirty baseline the gate
                 invariant and scope check subtract (see "What it deliberately does not do"), and
                 the approve-base commit
REVIEW.md        code-review phase findings, written after implementation, before archive
handoff.json     transient: exists only while an approved change's handed-off execution is
                 unsettled (session id, approve time, last pause fingerprint, review policy).
                 Lets a restarted/resumed omp process re-attach the handoff so the `apply`
                 window still closes; deleted when it settles. `/readyset --review <id>` closes
                 one left behind by another session as `handoff-orphaned`
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
    readyset-review-trigger.ts  risk-based review trigger evaluation and policy (auto/always/never)
    readyset-glob.ts         zero-dependency glob pattern matching for sensitive/protected paths
    readyset-review-overlay.ts  the Sidebar view Component — pure layout function + a
                             ctx.ui.custom()-driven overlay, zero runtime dependency on @oh-my-pi/pi-tui
    readyset-structural-check.ts  the shared "(structural check)" summary wording validateChange
                             and validateBrainstormContent both use
    readyset-evidence.ts    readyset_verify's runtime — spawns the command, persists the
                             immutable evidence record, correlates it back to tasks.md and to
                             the `evidence E00N` citations in its _Verified: notes
    readyset-types.ts       shared types, and the one mutable store: ReadysetState /
                             createReadysetState() (created once per extension instance)
    readyset-runtime.ts     createRuntime(state): everything that reads or writes that state —
                             model pin, grilling, the execution handoff (arm/pause/settle/persist/
                             rehydrate), the session_stop check, and the readyset_ask/verify/done tools
    readyset-prompts.ts     every phase prompt and compaction guidance — pure string builders
    readyset-host.ts        the omp host seam: asReviewCtx/asHostEvents (the only host casts),
                             model switching, firing a turn and waiting for it, compaction
    readyset-gate-ui.ts     the Review Gate: snapshot, panel, review document, sidebar, classic menu
    readyset-repair.ts      the automatic follow-up turns: scope-contract repair and trim
    readyset-review-policy.ts  review-trigger inputs and the honest REVIEW.md skip stub
    readyset-git.ts         what a run changed, diff stats against the approve base, pause fingerprint
    readyset-budget.ts      turn and wall-clock budgets
    readyset-outside-repo.ts  the stay-in-repo tripwire's classifier
    readyset-args.ts        `/readyset` argument parsing
  extensions/
    readyset-review.ts      the /readyset command: the gate loop, executeBrainstorm, on-demand
                             review/archive, and hook wiring. The only file omp loads directly;
                             it creates the state and the runtime and imports everything else
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
