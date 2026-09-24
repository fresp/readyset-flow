# Changelog

Every version from `0.2.0` on now has a real git tag. Entries at `0.9.0` and below were
reconstructed from `package.json`'s `version` field across git history (`git log -p --
package.json`), grouped by the commit that bumped it, and describe real commits rather than a
rewritten narrative — a version with very few commits between it and the previous bump genuinely
only had that much change in it.

## Unreleased (planned 0.18.0)

Execution now ends on an explicit signal instead of an inference, verification claims are checked against the evidence they cite, the phase budget actually stops a runaway turn, and the extension is split into focused modules with its machine state out of `CONTEXT.md`.

### Added
- **`readyset_done`**: the executing model signals the end of a handed-off execution. `done` is accepted only when every task is checked, has a `_Verified:` note and no evidence conflict, and it settles the handoff as `handoff-done`. `blocked` carries the exact question for the user and counts as an explicit pause, never a stall. The checkbox/fingerprint inference remains the fallback.
- **Evidence citations**: the apply prompt recommends `readyset_verify` and asks for the record to be cited as `evidence E00N` in the task's note. A citation of a missing record, another task's record, or a failed run is an evidence conflict, shown in the gate and refused by `readyset_done`.
- **`readyset.phaseBudget.minutes`** (default 20, fractions allowed, `0` = measure only): the wall-clock ceiling per Explore/Propose turn.
- The `apply` `end` event records how the execution got there (`handoff`: pauses, blocks, verification blocks, rehydrated, signal) and the review policy's decision at settle (`reviewPolicy`).

### Changed
- **The phase budget is enforced**: a turn past its ceiling is aborted (`ctx.abort()`), recorded as `budget-aborted` / `budget-aborted-partial`, and the run continues with what it wrote. It used to be checked only after the turn returned.
- **Turn reserves**: contract repair and trim no longer reserve turns for Apply/Review, which stopped drawing on the turn budget in 0.16; they keep exactly one turn free for a Refine.
- **Machine state moved out of `CONTEXT.md`**: phase events go to the change's `events.jsonl` (append-only), the dirty baseline and approve base to `state.json`. `CONTEXT.md` is human-readable only. Legacy markers are still read, so in-flight changes survive the upgrade. readyset-bench reads both formats.
- **Internal**: the 5k-line extension is split into `src/lib/readyset-{types,runtime,prompts,host,gate-ui,repair,review-policy,git,budget,outside-repo,args}.ts`; state is one per-instance `ReadysetState`; host objects are cast in two adapter functions instead of 15 places. No behavior change from the split itself.

### Fixed
- `/readyset --review <id>` looked for an `apply` `end` event with outcome `applied`, which the handoff never writes, so its `diff-size` trigger always saw an empty diff. The diff is now measured live against the approve base.

### Lite without the artifact changes (branch `lite-no4`, pending a benchmark)
- **Verification is deterministic** (`readyset.verify`): Readyset runs the project's test command itself (auto-detected `npm test`, or `readyset.verify.command`; `none` disables) when `readyset_done` says done, at settle, and before `/readyset --review`. A failing run refuses "done" with the output tail, fires the new `tests-failing` review trigger, and is recorded on the `apply`/`review` end events. `_Verified:` notes, evidence citations and the session_stop gate are only required with `readyset.verify.requireNotes: true`; the apply prompt is correspondingly shorter.
- **No more settle inference**: an unfinished execution pauses until it signals `readyset_done`, checks every task, or the next `/readyset` command supersedes it. The pause fingerprint and `handoff-stalled` are gone.
- **Verification hardening**: the test command runs once right after approve as a baseline (recorded in `state.json`); only failures that were not in it refuse `done` or fire `tests-failing`, and the apply prompt tells the model to leave the old ones alone. Detection covers pnpm / yarn / bun lockfiles, go, cargo, pytest and a Makefile `test:` target; with nothing detected, `_Verified:` notes are required instead. The gate panel names the command that Approve lets Readyset run.
- The brainstorm validator accepts a grilled `## Decision` that names its chosen option (`Chosen option: …`), so the brainstorm-gap warning no longer fires on every grilled run.

## 0.17.0 - 2026-09-24

Makes the handed-off execution trustworthy: it runs on the model you pinned, pauses and settles correctly, survives an omp restart, has to show verification before it stops, and gets the risk-based review policy applied when it is done.

### Added
- **Verification gate at session stop**: while a handed-off execution is live, the session that approved it cannot stop with a checked task in `tasks.md` that lacks a `_Verified:` note — it is sent back at most twice per change, then allowed to stop. Subagents spawned during the execution are never gated.
- **Approve-base tracking**: `HEAD` at approve time is recorded; scope checks, review triggers and the Apply diff stats measure against it, so commits the execution makes mid-run are no longer invisible.
- **Review policy at settle**: when a handed-off execution settles, `readyset.review.mode` is applied — a skip stub in `REVIEW.md` with the reason, or a notice recommending `/readyset --review <change-id>` that names the triggers that fired.
- **Handoff survives an omp restart**: the unsettled handoff is mirrored to `readyset/changes/<id>/handoff.json`; the same session re-attaches it after a restart or resume, and `/readyset --review <id>` closes one left behind by another session as `handoff-orphaned`.
- **`readyset_verify` is live for the whole handed-off execution** again.

### Changed
- **Execution runs on the pinned model**: the apply phase model (else the run's `--model` pin) is applied before the handoff and the session's previous model is restored once the execution settles — also when only an apply override was set.
- **Pause-aware settle**: a terminal turn with tasks still unfinished is a pause (the execution model stays active), two pauses with no observable progress settle as `handoff-stalled`, and a new `/readyset` command supersedes an unsettled handoff (restoring the model and closing the `apply` window).
- **Session identity, not directory**, keys the handoff and the grill session, so a subagent's own settle can never end the parent's.
- **Grilling runs on the grill model**: `--phase-model grill=` / `readyset.model.phases.grill`, else the run pin, is applied before the grill turn and restored once the brainstorm is written. With `readyset.model` or `modelRoles.default` configured, grilling now runs on that model instead of whatever the session had.
- **Prompts**: benchmark-specific text removed from the product prompts; grounding is lane-aware; the fast-lane review reads only `proposal.md`'s Acceptance scenarios and `tasks.md`; grilling no longer asks the unused per-task git-flow question.
- **Benchmark table withdrawn** from the README; `docs/BENCHMARK.md` is labeled as not a verified claim about the current version.

### Fixed
- The grill→propose transition crashed because the `agent_end` context has no `waitForIdle`.
- A `_Verified:` note written as a `- _Verified: …` sub-bullet was counted as missing.
- The `grill` phase event recorded a model grilling never ran on.
- The archive offer left an unbalanced `archive` `end` event when the change was not archived, and claimed a review stub existed after an on-demand review that wrote nothing.
- Two sentences in the apply prompt were glued together.

**Full Changelog**: https://github.com/fresp/readyset-flow/compare/v0.16.0...v0.17.0

## 0.16.0 - 2026-09-24

Narrows Readyset to the planning half of the workflow — Grill → Explore → Propose → Review Gate — and hands execution off to omp's native runtime instead of running its own apply/review loop.

### Added
- **Seamless Grilling → Propose transition**: When a grilling turn finishes and writes its brainstorm, Readyset immediately offers to continue with Explore & Propose in the same session. No second `/readyset` invocation and no re-picking the brainstorm from the picker — the turn sequence keeps the same prompt cache prefix.
- **Native core omp handoff at the Review Gate**: Approving a change (either **Approve & Execute** or **Approve & Execute, keep context**) now marks it approved, appends the handoff to `CONTEXT.md` and records `outcome: "handoff-omp"` on the apply phase event, clears the editor and widget, dispatches the apply prompt through `pi.sendUserMessage`, and exits the extension command immediately. Execution runs on core omp, so subagents, parallel tool calls, and live task-checklist updates work as they normally do.
- **On-demand code review & archiving**: `/readyset --review <change-id>` runs the review path explicitly against an existing change — evaluating the risk triggers against the working tree, firing the adversarial review turn, writing `REVIEW.md`, and offering to archive.

### Changed
- **De-scoped execution runtime**: Removed the internal `applyLoop` — Apply, verification retries, scope reconciliation, and the review turn no longer run inside the extension's own command loop. Readyset now ends at the Review Gate; the change's `tasks.md` stays the source of truth omp executes against.
- **Post-Apply contract semantics**: Reopening the gate on an already-applied change no longer reports false `NEW-BUT-EXISTS` / `DELETE-BUT-MISSING` warnings, and no longer fires a contract-repair turn against an executed change.

### Fixed
- **`--review` argument parsing**: A flag following `--review` (e.g. `--review <change-id> --lane fast`) is no longer swallowed as a target change id.

**Full Changelog**: https://github.com/fresp/readyset-flow/compare/v0.15.0...v0.16.0

## 0.15.0 - 2026-09-23

Introduces risk-based code review, open decision handling, bounded review repairs, and safe scope reconciliation.

### Added
- **Risk-based code review**: Added `readyset.review.mode: auto | always | never` and `--review <mode>` CLI flag. In `auto` mode, review triggers on high-risk conditions: scope drift, evidence conflicts, diff size thresholds, sensitive paths, or low clarity.
- **On-demand review**: Added `--review <change-id>` to run a single review turn on demand for existing unarchived changes.
- **Open decisions & assumptions**: Added `## Open Decisions` and `## Assumptions` tracking to proposals. Decisions reaching execution are applied cleanly with explicit rationale.
- **Single bounded review fix**: If `REVIEW.md` reports blocking findings, fires exactly one bounded fix turn to resolve them without looping.
- **Safe scope reconciliation**: Automatically reverts unintended modifications outside the scope contract after Apply while strictly preserving pre-existing WIP and untracked files.
- **Bugfix doc scope discipline & negative plan grounding**: Barred bugfixes and refactors from modifying or adding documentation files unless explicitly requested. Negative plan references avoid citing concrete file extensions to prevent dangling reference false positives.
- **Headless tool discovery fallback**: Grilling falls back immediately to structured chat questions when `readyset_ask` is absent, preventing extraneous tool discovery loops.
- **Zero-dependency glob matcher**: Added `readyset-glob.ts` for sensitive and protected path pattern matching.

### Changed
- **Diff-first review**: The code-review prompt now analyzes changed file diffs directly against acceptance criteria rather than re-exploring the whole repo.
- **Transparent review stubs**: When review is skipped under `auto` mode, writes an auditable stub documenting evaluated triggers instead of claiming a review completed.

### Fixed
- **Requested-doc repair accuracy**: Scans only request text and decision sections with action verbs, avoiding false positives on docs cited as context.
- **Outside-repo tripwire**: Eliminated false positives on regex patterns, `/dev/*`, and URL route strings.
- **Fast-lane picker visibility**: An explicit `--lane fast` now properly surfaces fast-lane brainstorms in the interactive picker.

**Full Changelog**: https://github.com/fresp/readyset-flow/compare/0.14.0...v0.15.0

## 0.14.0

Introduces dual execution lanes (Fast vs Full), value-of-information grilling, and per-artifact character budgets.

### Added
- **Dual execution lanes**: Brainstorms classify into `fast` (clear bugfixes/small tasks) and `full` (complex features/migrations). Fast lane writes compact artifacts (`proposal.md` and `tasks.md` only) and skips Explore.
- **Value-of-information grilling**: Every grilling question must change a plan decision; non-differentiating questions are recorded as assumptions instead.
- **Clarity-to-lane heuristics**: Automatically maps brainstorm clarity (`clear`, `partial`, `ambiguous`) to recommended execution lanes.
- **Per-artifact character budgets**: Configurable character limits on planning artifacts with an automated single-turn trim when exceeded by 1.5×.
- **Conditional boundary compaction**: Automatically compacts context at phase boundaries when context usage exceeds a configured threshold.

### Changed
- **Fast-lane artifact compactness**: Replaced multi-file specifications with inline `## Acceptance` WHEN/THEN scenarios in `proposal.md`.
- **Minimal-diff Apply discipline**: Enforced strict minimal-diff rules during Apply to minimize unneeded edits outside the scope contract.

### Fixed
- **Reserved turns for Apply & Review**: Prevented repair turns from consuming the final turns required for execution and review.
- **Post-Apply contract semantics**: Corrected contract checks so existing created files are not flagged as duplicates on gate reopen.

**Full Changelog**: https://github.com/fresp/readyset-flow/compare/0.13.0...0.14.0

## 0.13.0

Implements automated scope contracts, dangling reference repair, and prep-phase context compaction.

### Added
- **Scope contract enforcement**: Added `## Files This Change Will Touch` to proposals, distinguishing new files with `(new)` and deletions with `(delete)`.
- **Dangling reference detection & repair**: Automatically repairs invalid or missing file references in proposal contracts before reaching the review gate.
- **Post-Apply scope accountability**: Validates working-tree changes against the proposal contract after Apply and surfaces deviations.
- **Phase boundary telemetry**: Appends machine-parseable phase event markers in `CONTEXT.md` for benchmarking and auditability.

### Changed
- **Prep-phase compaction**: Compaction enabled before Explore and Propose to reduce context bloat from accumulated discussion.

### Fixed
- **Multi-language and non-JS path parsing**: Scope parser accepts any repository path structure regardless of file extension or directory naming.

**Full Changelog**: https://github.com/fresp/readyset-flow/compare/0.12.1...0.13.0

## 0.12.1

### Fixed
- **Fast-lane gate reachability**: Fixed status reconciliation bug that prevented fast-lane changes from displaying the review gate.
- **Clear failure diagnostics**: Improved error messaging when proposal files are missing or incomplete.

**Full Changelog**: https://github.com/fresp/readyset-flow/compare/0.12.0...0.12.1

## 0.12.0

Hardens workflow integrity with structural gate invariants, fail-closed review decisions, and per-phase cost controls.

### Added
- **Fail-closed review gate**: Default action at the review gate is Discard, ensuring deliberate operator approval before any code executes.
- **Propose phase boundary invariant**: Enforces that planning turns write only to designated change directories; unauthorized workspace modifications immediately abort the run.
- **Per-phase model overrides**: Added `--phase-model` to assign different models to Grill, Explore, Propose, Apply, and Review.
- **Automatic compaction before Apply**: Clears planning turn history while retaining disk artifacts, cutting cache-read token costs.
- **Unobservable acceptance criteria checks**: Flags WHEN/THEN scenarios that assert internal code state rather than externally verifiable behavior.
- **Scope contract foundation**: Added `## Files This Change Will Touch` section to proposals with working-tree change validation at the gate.
- **Dual lane foundation**: Fast lane folds Explore into Propose and trims artifact overhead for small changes.

### Changed
- **Behavioral code review**: Evaluates diffs and acceptance scenarios against external behavior rather than checking unit test suite self-reports alone.
- **Evidence-based grounding trail**: `EXPLORATION.md` logs commands and findings as an auditable trail for proposal claims.

### Fixed
- **Pre-existing repo state isolation**: Working-tree checks subtract the pre-existing dirty baseline so unrelated WIP files are not attributed to the current change.

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
