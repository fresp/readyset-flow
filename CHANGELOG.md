# Changelog

Every version from `0.2.0` on now has a real git tag. Entries at `0.9.0` and below were
reconstructed from `package.json`'s `version` field across git history (`git log -p --
package.json`), grouped by the commit that bumped it, and describe real commits rather than a
rewritten narrative — a version with very few commits between it and the previous bump genuinely
only had that much change in it.

## 0.13.0

A quality-and-cost pass driven by the `v0.12` full-matrix benchmark (12 tasks × 3 reps × 2 arms).
It tightens the one dimension Readyset still didn't win — scope discipline — at the two places it
was still unchecked, closes the largest objective gap in the report (dangling file references), and
cuts the biggest number in the cost breakdown (prep-phase tokens). Nothing here changes what the
gate blocks on; where a check is added it warns, as the scope contract already did.

### Added

- **Dangling file references in the scope contract are now flagged.** Readyset named files it would
  modify that didn't exist at **0.53/run vs 0.03/run** for `/plan` — the largest relative gap of any
  objective metric in the v0.12 report. A `## Files This Change Will Touch` path that isn't marked
  `(new)` and doesn't exist on disk is now reported as `scope refs: DANGLING …` in the gate panel
  and listed in a new **Scope** section of the review document. Advisory, like the OUT-OF-SCOPE
  check: it flags, it never blocks.
- **Files the change will create must be marked `(new)`.** The section already listed existing
  files and to-be-created files together with nothing distinguishing them, which is why an
  existence check needs a marker. A trailing `(new)` (e.g. `- src/lib/thing.ts (new)`) now marks a
  file the change creates; an unmarked path still means "must already exist", and the Propose prompt
  teaches the convention.
- **Scope is checked again after Apply.** The gate's scope check runs before Apply, so it only ever
  saw what Propose changed — and Apply is where most of a change's file touches happen. A
  post-Apply working-tree check now warns and names any out-of-contract file at the **Archive now?**
  prompt, and records it in `CONTEXT.md`. Advisory: implementation legitimately touches more files
  than planning did, so archive is still offered rather than blocked.
- **Every run records its effective lane and phase boundaries in `CONTEXT.md`.** The v0.12 benchmark
  ran `/readyset --fast`, but `--fast` only filters the picker — `--lane fast|full` is what forces
  the lane, and nothing recorded which lane a run actually used. Each phase boundary (Grill, Explore,
  Propose, Refine, gate, Apply, Review, Archive) is now written as its own
  `<!-- readyset-phase -->` marker plus a one-line `json` fence, recording the phase, a `start`/`end`
  edge, an ISO timestamp, the effective lane and its source (`flag`/`brainstorm`), and where relevant
  the phase model and an outcome. readyset-bench's compile step can now split results by lane and
  attribute session tokens/wall time to phases by timestamp. Advisory only — the existing
  human-readable phase entries are unchanged and additional.
- **Dangling contract references are repaired once, automatically, before the gate.** 0.13.0 only
  *flagged* a `## Files This Change Will Touch` path that didn't exist; the v0.12 data showed
  warnings alone barely move model behavior, so after the Propose turn (and after every Refine turn)
  Readyset now fires **at most one** repair turn that rewrites only that section to fix the
  offending paths, re-checks the planning boundary, and re-checks the contract. The check now
  reports three kinds — dangling, `(new)` on a file that already exists, and `(delete)` on a file
  that doesn't — and the gate panel and review document show all three. A `(delete)` marker is now
  understood (a `(delete)` path must exist before Apply and is allowed to be gone afterward). The
  repair never loops and is skipped when the run has no turn budget left; whatever remains still
  only warns. Recorded in `CONTEXT.md` and as a `contract-repair` phase event.

### Changed

- **Planning phases compact at every boundary now, not only before Apply.** Prep (Grill → Explore →
  Propose) was **16×** the plan arm's entire run in tokens — the single biggest number in the cost
  breakdown — because each phase carried every prior phase's conversation forward at full cache-read
  cost. Compaction now also fires before Explore (the brainstorm is already on disk) and before
  Propose (`EXPLORATION.md` is), mirroring the pre-Apply compaction. Cost-only: neither boundary's
  correctness depends on keeping history, since both phases re-read their artifacts from disk.

### Fixed

- **The scope contract no longer drops non-JS paths.** The parser gated every line on a hard-coded
  directory whitelist (`src|test|tests|bin|examples|lib|docs|scripts|assets|resources|config`) plus
  a root-level JS/MD/YAML extension whitelist, and only ever stripped commentary after a literal
  ` -- `. So `app/handler.go`, `packages/core/index.ts`, `.github/workflows/ci.yml`, `Makefile`, and
  any path with other trailing commentary (`— modified`, `(modified)`, `: note`) never entered the
  contract at all — which meant the post-Apply check reported them OUT OF SCOPE the moment
  implementation touched them, and the dangling check never saw them. The parser now reads the
  first token as the path and treats everything after it as commentary, accepting any path shape
  (directory separators, dotfiles, `name.ext`, known extensionless files and extensionless paths
  inside a directory), recognizing numbered list items (`1. src/x.ts`), and finding `(new)` anywhere
  in that commentary.

**Full Changelog**: https://github.com/fresp/readyset-flow/compare/0.12.1...0.13.0

## 0.12.1

- **The fast lane can reach the review gate again.** `reconcileStatuses` skipped every
  brainstorm whose lane wasn't `full`, on the stated theory that a fast-lane brainstorm has no
  change to reconcile against. The fast lane as it actually runs does write a change directory and
  a proposal — and the skip was not harmless: the post-Propose gate check only opens the gate for a
  brainstorm whose status is `proposed`, so **every fast-lane change dead-ended at "Propose doesn't
  look finished" with no gate ever offered**. Measured on `readyset-bench` label `b1-subset-0.12`
  (4 tasks × 3 reps): `lane=full → gate shown` in 7/7 runs, `lane=fast → gate shown` in 0/5 — a
  perfect split. This is the actual source of the historical T11/T12 "gate bypass": the gate was
  never shown, so the only way those runs reached code was the model continuing on its own.
  The reconciliation now derives from the filesystem alone; the existing `changeState` guard already
  leaves a fast-lane brainstorm with no change directory untouched, so the lane filter bought
  nothing.
- **That failure message now names the real cause.** It claimed "proposal.md not found or empty"
  for all three failing conditions (no matching brainstorm / status not proposed / empty proposal),
  which sent a live investigation hunting for a file that was on disk the whole time.

**Full Changelog**: https://github.com/fresp/readyset-flow/compare/0.12.0...0.12.1

## 0.12.0

A hardening release driven by end-to-end benchmarking (`/readyset` vs omp `/plan` vs Command Code
plan mode, plus a 9-task paired run): phase discipline is now enforced structurally instead of by
prompt text alone, the review gate fails closed, per-phase cost has real ceilings, and the docs say
only what the measurements support. Every item below is a behavior or prompt change traced to a
specific benchmark observation.

### Gate integrity

- **The Propose turn can no longer implement and ship the change.** Two benchmark runs (T11, T12)
  wrote implementation code out of the Propose turn, archived the change themselves, and finished
  with no approval — the prompt said "planning artifacts only", nothing enforced it. After Propose
  fires, Readyset now snapshots the working tree (`git status --porcelain`) and stops with an error
  if anything outside `readyset/changes/<id>/` and `.ai/brainstorms/` changed, or if the change
  directory moved into `archive/` on its own. A violation writes a `STOPPED` entry to `CONTEXT.md`
  naming the exact paths and **offers no review gate** — the run is over.
- **The review gate is fail-closed.** "Discard" is now the first option in the classic menu, and
  nothing runs unless an Approve option is deliberately picked. Previously "Approve & Execute" was
  first and relied on falsy/missing selections falling through to discard — safe only while every
  host resolves a selection explicitly. A test pins it: cancelling at the gate fires zero agent
  turns and leaves `tasks.md` untouched.
- **Phase budgets, and honest phase accounting in `CONTEXT.md`.** The turn budget counts fired
  turns, but one turn can churn millions of tokens in tool calls without spending more budget
  (T12's Explore alone was 51% of a 17.6M-token run). Each phase now has a wall-clock ceiling
  (default 20 min); Explore and Propose record their elapsed time, and a breach warns visibly
  instead of failing silently. `CONTEXT.md` entries can no longer claim a clean Propose when the
  working tree says otherwise.

### Cost

- **Per-phase model overrides.** Grill+Explore produced 39% of fresh input at the worst
  cost-per-value in the benchmark, and `--model` pinned one model for the whole run. New
  `--phase-model <phase>=<spec>` (repeatable) and `readyset.model.phases.<phase>` config, resolved
  per phase as flag > config > run pin, for `grill|explore|propose|apply|review` (Refine rides the
  propose override). An override that fails to resolve warns and falls back to the run model — a
  phase model is a cost optimization, never a reason to stop the run.
- **Approve & Execute compacts by default.** Explore/Propose context dominated Apply and Review
  cost (T01: max context 154k, ~76% of all tokens as cache reads) while everything those phases
  produced is already persisted under `readyset/changes/<id>/` — Apply re-reads artifacts from
  disk. **`Approve & Compact` is replaced by `Approve & Execute, keep context`**, the escape hatch
  in the other direction; sidebar CTAs move from `A/C/R/D` to `A/K/R/D` (`compact` is still
  accepted from older sidebar builds). A missing or failed `ctx.compact` degrades to plain
  execution.
- **Grilling researches once up front, not every round.** One session made 17 bash + 16 read calls
  spread across rounds for what one upfront pass covers; rounds already batch up to 4 questions, so
  the cost was per-round research, not round count. Rounds, options, and the no-passive-answer rule
  are unchanged.

### Claims, scope, and quality

- **The scope contract.** Readyset diffs ran 2× the plan arm's lines, 0.89 files outside expected
  scope vs 0.42, and one run grew an unasked-for 160-line file — `scope_discipline` was the one
  dimension Readyset did not win. `proposal.md` must now carry a `## Files This Change Will Touch`
  section; the gate checks the working tree against it and shows match / OUT OF SCOPE / unknown.
  Paths under `readyset/` and `.ai/brainstorms/` are always in scope; an absent section is "no
  contract", never a silent pass. It **warns, never blocks**.
- **Unobservable acceptance criteria are flagged.** A run shipped "WHEN src/registry.ts is
  inspected THEN it contains no direct filesystem calls" and validation passed it, though no test
  could ever check it. `validateChange` now flags requirements whose THEN names only a code
  property, with no externally checkable signal (exit code, stdout/stderr, HTTP status, file
  content, command result). Still structural, and the summary keeps its `(structural check)`
  suffix.
- **The code review checks behavior, not the suite.** One run's own test asserted the bug it
  introduced, so "do the tests pass" would confirm it. The review turn now checks scenario
  conformance against the WHEN/THEN behavior — run the code, read the diff, exercise the endpoint
  — and distrusts any expected value that could only have come from the implementation under
  review.
- **Grounding is documented as auditability, not quality.** Two independent benchmarks measured
  Readyset's plans as no better grounded than a single read-only pass (~50% in blind judging,
  twice). The README/GUIDE no longer imply otherwise: `EXPLORATION.md` is an auditable trail, and
  the Propose prompt requires every repo claim to anchor to a numbered exploration entry or a
  "verified during planning" note.
- **"Fresh-context code review" was never true, and is no longer claimed.** The review turn shares
  the session context — omp's extension API offers no subagent/detached-turn surface. README,
  GUIDE, SKILL.md and code comments now say "separate turn with adversarial framing", which is the
  actual mitigation.

### The lane

- **The lane is a real run input, and fast lane actually runs light.** Previously the lane only
  filtered the brainstorm picker and labeled it — the workflow was identical either way. Grilling
  now proposes a lane with a one-line reason and the user picks; `--lane fast|full` forces it for
  the run (flag wins over the file); the picker shows the effective lane. Fast lane folds Explore
  into Propose (no separate turn; targeted reads noted inline), caps Propose at a tight plan, and
  skips mutation-testing-style review probes. Full lane is unchanged. The lane trims **volume**,
  never the behavior-changing questions — the T01/T10 wins came from exactly those.

### Fixes

- **The gate invariant and scope check no longer flag pre-existing repo state as this change's
  own.** The helper feeding both never diffed against a baseline — it was a raw `git status` read —
  so any file dirty for unrelated reasons (a WIP edit elsewhere, an untracked scratch note) got
  misattributed to the current change: a hard stop at the gate for a well-behaved run, or a false
  OUT-OF-SCOPE warning on every gate render. What was already dirty is now captured once, right
  after the change directory is scaffolded (first capture wins; never widened), stored inside
  `CONTEXT.md` so it rides the existing append path and archives with the change. Old changes with
  no baseline keep the old behavior rather than crashing.
- **The baseline survives later `CONTEXT.md` writes.** The baseline JSON is now parsed between the
  fence markers the writer itself created, instead of from the first `{` to the last `}` in the
  rest of the file. That "last brace" scan would break the moment anything appended later contained
  a `}` — and Refine appends raw user feedback verbatim, so *"make it return `{status:'ok'}`"*
  silently emptied the baseline and restored the bug above for the rest of the run.

**Full Changelog**: https://github.com/fresp/readyset-flow/compare/0.11.2...0.12.0

## 0.11.2

- **The review gate was silently discarded under omp's RPC host.** Readyset opened its review
  overlay whenever `ctx.ui.custom` existed as a function. omp's RPC mode does define it, but only
  as a stub that resolves `undefined` straight away ("Custom UI not supported in RPC mode"), and
  Readyset read that `undefined` as Esc, i.e. Discard. So a `/readyset` driven over RPC (an editor
  integration, an orchestrator, a benchmark harness) wrote proposal/design/specs/tasks and then
  stopped without ever asking for approval or executing anything. The overlay is now used only
  when `ctx.mode` is `"tui"` (or absent on older omp builds, which were TUI-only); every other
  host gets the classic Approve & Execute / Approve & Compact / Refine / Discard menu through
  `ctx.ui.select`, which RPC forwards to the client. Found by running `/readyset` headless in an
  end-to-end benchmark against omp 18.2.0; covered by a new test that stubs `ui.custom` exactly as
  the RPC host does.

## 0.11.1

Host-integration fixes — all of these were invisible to the test suite as it stood, because the
suite stubbed the same wrong API shapes the code called (see the last bullet).

- **`--idea`, `--lang`, `--model` and `--fallback-model` were broken against the real command
  API.** omp hands a registered command its arguments as the raw remainder *string*
  (`handler: (args: string, ctx)` — `RegisteredCommand`, and `#tryExecuteExtensionCommand`'s
  `text.slice(spaceIndex + 1)`), not a pre-split array. Treating it as one made `--idea` throw
  `(args ?? []).slice(...).join is not a function` on every invocation, so grilling could never
  start at all; and made `--lang`/`--model`/`--fallback-model` silently read the single character
  `"-"` (string indexing instead of array indexing) instead of the value the user typed. Only
  `--all`/`--fast` ever worked, by accident, because `String.includes` matches substrings. Args are
  now tokenized by an exported `parseReadysetArgs` (quote-aware; `--idea` takes the rest).
- **A failed model pin looked successful, so the fallback chain never ran.** `pi.setModel` is
  `(model) => Promise<boolean>` and its real implementation returns `false` — without throwing —
  when there is no API key for the model (`runExtensionSetModel`: `if (!key) return false;`). Only
  rejections were treated as failure, so Readyset could report `Pinned model "..."` for a session
  model that never changed. A `false` return and an unresolved spec now both count as a failed pin
  and fall through to `readyset.model.fallbackChains`.
- **`sendUserMessage` was passed options that don't belong to it.** `{ deliverAs: "nextTurn",
  triggerTurn: true }` is `pi.sendMessage`'s shape — `SendUserMessageOptions.deliverAs` is `"steer"
  | "followUp" | "aside"`. It was ignored and the call fell through to the host's plain prompt
  path, so the turn still started (the documented rationale was wrong, the outcome happened to be
  right). The call now omits options, which is exactly what starts a turn when the session is idle.
- **The review panel's `setWidget` call used the wrong shape.** The real signature is
  `setWidget(key: string, content, options?)`; the extension called `setWidget(lines)`, so the host
  received key = the lines array and content = `undefined` and the summary panel never rendered.
- **`Theme` was imported as a type from `@oh-my-pi/pi-tui`, which doesn't export one.** Harmless at
  runtime (type-only, erased at strip-time), but it was a standing type error; the overlay now
  declares the minimal theme shape it actually calls.
- **`npm run typecheck` added, and wired into CI and `prepublishOnly`.** `src/` is now typechecked
  against `@oh-my-pi/pi-coding-agent`'s real types (added as a devDependency — the contract
  `src/extensions/` is written against, and the one area the suite could not reach). The default
  `npm test` suite still needs no install at all, which is why the two steps stay separate. The
  suite's own fakes were updated to the real signatures, and it grew tests pinning down the `args`
  contract, a `false` from `setModel`, and the `setWidget` key.

**Full Changelog**: https://github.com/fresp/readyset-flow/compare/0.11.0...0.11.1

## 0.11.0

- **New: `readyset-flow update` and `readyset-flow uninstall`.** `update` is an alias for
  `install`, so refreshing the linked extension and skill docs doesn't require remembering
  `install`'s exact name. `uninstall [--target <path>] [--keep-config]` reverses everything
  `install` sets up: it removes the extension entry from `~/.omp/agent/settings.json`
  (`unlinkExtension`, matched by basename so it works regardless of which copy of the package
  wrote it), deletes the installed skill docs from the target project, and strips the
  readyset-managed block out of `~/.omp/agent/config.yml` (`clearConfigBlock`, reusing
  `spliceReadysetBlock` from `configure.mjs`) unless `--keep-config` is passed. It does not touch
  project-level `readyset/changes/` directories.

**Full Changelog**: https://github.com/fresp/readyset-flow/compare/0.10.0...0.11.0

## 0.10.0

- **The review gate's sidebar overlay opens automatically -- it IS the gate now, not a "Sidebar
  view" choice on a separate menu.** Previously `ctx.ui.select()` showed Approve & Execute /
  Refine / Sidebar view / Discard first, and picking "Sidebar view" opened a read-only overlay
  you then Esc'd out of to get back to that same menu to actually act. Now, whenever
  `ctx.ui.custom` is available, the overlay opens directly as soon as the review artifacts are
  ready, with Approve & Execute / Refine / Discard baked into it as CTAs (`[A]`/`[R]`/`[D]`
  keystrokes, or Tab onto the CTA bar and use it like a real `select()`: Left/Right to move the
  highlight, Enter -- `tui.select.confirm` -- to confirm). Contexts without a real TUI
  (RPC/ACP/print-headless) still get the classic select() menu as a fallback.
- **The overlay renders at 90% of the terminal's width instead of capping at ~80 columns.**
  Read `@oh-my-pi/pi-tui`'s actual published source (`src/tui.ts`) to confirm why it was narrow:
  `overlayOptions.fullscreen` only controls the alt-screen buffer, not sizing -- width defaults
  to `min(80, terminalWidth)` unless `overlayOptions.width` is set explicitly.
- **Up/Down now scroll the selected section's content, not the section list.** They move one
  line at a time through whatever's open (design.md, a spec, tasks.md, ...), and only cross into
  the next/previous section once that content is exhausted -- landing at the top when advancing,
  or at the *bottom* of the previous section when going back (a continuous-scroll feel, not a
  reset). Left/Right take over the section list's old job: jump straight to a section, bypassing
  its content, always landing at the top. PgUp/PgDn are unchanged (a bigger scroll step within
  the current section).

**Full Changelog**: https://github.com/fresp/readyset-flow/compare/0.9.2...0.10.0

## 0.9.2

- **Fix: the CLI silently did nothing under a real `npm install -g` / `npx` invocation.**
  `install`/`configure`/`validate`/`version` all gate on an "is this the entry module" check
  (`import.meta.url === file://${process.argv[1]}`), which breaks the moment this runs through
  npm's own bin symlink: Node resolves `import.meta.url` to the symlink's real target, but leaves
  `process.argv[1]` as the symlink path exactly as invoked, so the two never match. Confirmed
  live — packed the tarball, `npm install -g` from it into a scratch prefix, ran the resulting
  `bin/readyset-flow` symlink, got silent success with zero output. Fixed by resolving
  `process.argv[1]` to its real path (`fs.realpathSync`) before comparing. Every version before
  this one has the bug; anyone who installed `readyset-flow` the normal way (not by pointing
  `node` at the file directly) got a CLI that did nothing.

## 0.9.1

- **Publish readiness**: MIT `LICENSE`, `package.json` metadata (`repository`, `homepage`,
  `bugs`, `author`), `package-lock.json`, a `prepublishOnly` test gate, a CI workflow
  (`npm ci && npm test && npm pack --dry-run` on push/PR), a Node compatibility table in the
  README, and this changelog itself (backfilled from `package.json`'s real version history).
  No runtime behavior changed — this version is release hygiene only.

## 0.9.0

- **`readyset-flow configure`** — an interactive wizard for the `readyset:` section of
  `~/.omp/agent/config.yml` (language, default model, fallback chain), prefilling whatever's
  already set. Writes back with a plain-text splice, not a YAML library, so nothing else in the
  file is touched. Kept separate from `install`, which stays non-interactive and script-safe.
- **`brainstorm-ai` companion skill** (`resources/brainstorm-ai/`) — a vendored Claude Skill for
  running the grilling/brainstorming step outside omp entirely (e.g. in Claude Cowork), whose
  output feeds `/readyset`'s brainstorm picker. Its session language is now a `language`
  frontmatter field (defaults to English if unset) instead of being hardcoded.

## 0.8.0

- **Evidence capture v1** — `readyset_verify` runs a command for real and persists an immutable
  record (exit code, stdout/stderr, duration) instead of relying on a self-reported `_Verified:`
  note alone; a fix for an archive-disclosure issue landed in the same commit.
- **`brainstorm-ai` vendored for the first time** — the outside-omp brainstorming path (Claude
  Cowork) documented and its companion skill added, moved out of `src/` into `resources/` once
  it became clear it's not code this package loads at runtime (its `SKILL.md` frontmatter had to
  stay parser-clean, which the move also fixed).
- README: banner switched from SVG to PNG, a pipeline diagram, a comparison table, a "Design
  philosophy" section, and a general restructure/simplification pass, plus a Mermaid sequence
  diagram for the Cowork → `/readyset` handoff.

## 0.7.3

- README: added a banner, restructured for scannability.

## 0.7.2

- `readyset_ask`'s question headers stay in English even when `--lang` is set.

## 0.7.1

- A code-enforced guard against grilling silently skipping the `readyset_ask` round entirely
  (a "zero-rounds" gate, not just a convention).

## 0.7.0

- Grilling's picker rebuilt on omp's native `askDialog` instead of raw chat text.
- `readyset.lang` accepted as an alias for `readyset.language` in config.

## 0.6.0

- `readyset.model` restructured into a nested `{ default, fallbackChains }` shape (was flatter
  before).

## 0.5.0

- Package renamed from `readyset-review` to `readyset-flow`; command simplified to `/readyset`.

## 0.4.1

- Grilling rules vendored from mattpocock/skills' actual `grilling` skill (real source, not a
  paraphrase); added a fact-finding/websearch rule.

## 0.4.0

- Grilling for raw ideas (`--idea`) added; structural-check duplication tuned; `install`
  documented as the reference install path for the extension.

## 0.2.0

- **Initial release** — `readyset-review` (the package's original name) introduced as a
  standalone omp extension: CLI installer, workflow libraries, a first 48-test suite, a real
  Sidebar view (`ctx.ui.custom()`), the `validate <change-id>` CLI command, and install-path
  fixes (global `~/.omp/agent/`, `readyset-`-prefixed filenames to avoid clobbering other
  extensions).
