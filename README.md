<p align="center">
  <img src="assets/banner.png" alt="Readyset — grounded, reviewable, executable changes for omp" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/readyset-flow"><img src="https://img.shields.io/npm/v/readyset-flow.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/readyset-flow"><img src="https://img.shields.io/npm/dm/readyset-flow.svg" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/readyset-flow.svg" alt="license"></a>
</p>

Readyset is a standalone [omp](https://github.com/oh-my-pi) extension, invoked as `/readyset`. It
turns a rough idea into a grounded, reviewable, executable change — with a code-enforced review
gate between "written" and "executing", not just a prompt asking nicely.

```text
Rough idea → GRILL → EXPLORE → PROPOSE → REVIEW → EXECUTE → ARCHIVE
```

## Install

```
npm install --save-dev readyset-flow
npx readyset-flow install
```

Installs globally, tied to `~/.omp/` — available in every repo you work in. Run
`npx readyset-flow configure` afterward to set a default language or model (optional), or
`npx readyset-flow uninstall` to remove it later.

## Use

```
/readyset --idea "let users export their data as CSV"
```

- **Grill** interrogates the idea until it's unambiguous — a real Q&A, not a rubber stamp. It also
  proposes a **lane** (`--lane fast|full` to force one): fast folds Explore into Propose, caps the
  plan, skips the heavier review probes, and writes a smaller artifact set (proposal + tasks only);
  full is the workflow below. When it finishes, Readyset offers to carry straight on into Explore &
  Propose — no second `/readyset` run, no re-picking the brainstorm.
- **Explore** greps the actual repo before anything gets proposed, instead of assuming.
- **Propose** writes a proposal, design, specs, and tasks — grounded in what Explore found, and
  with a `## Files This Change Will Touch` scope contract the gate checks against. (The fast lane
  writes just `proposal.md` and `tasks.md`, with acceptance scenarios under `## Acceptance`.)
- **Review** stops for your Approve / Refine / Discard — **Discard is the default**, so nothing
  executes without a deliberate look. Approve & Execute compacts first (Explore/Propose context is
  already persisted to disk); "keep context" is the escape hatch.
- **Execute** is handed off to core omp: approving captures the approve-base commit and the
  execution model, dispatches the change's `tasks.md` to omp's native runtime, and Readyset exits,
  so subagents, parallel tool calls, and live task-checklist updates work as usual. The execution
  ends when the model calls `readyset_done` (or every task is checked); a turn that stops mid-work
  just pauses, and the next `/readyset` closes an abandoned one. It is keyed by session id, so a
  subagent's own settle can never end the parent session's handoff. When it's done, Readyset's risk-based review policy
  decides whether to recommend `/readyset --review <change-id>` or skip it with an honest reason.

Pin a cheaper model per phase with `--phase-model grill=... --phase-model explore=...` (see the
[full guide](docs/GUIDE.md#per-phase-models)).

Already have a brainstorm sitting in `.ai/brainstorms/`? Run `/readyset` with no `--idea` and pick
it — Grill is skipped, since the ambiguity's already resolved.

## Why

Plans drift from the repo, reviews get skipped under pressure, and "done" ends up meaning "the
model said so." Readyset turns each of those into a structural gate instead of a habit:
ambiguity gets interrogated before anything is written, every claim about the repo is grounded in
a dedicated explore phase, nothing executes without an explicit human approve, and "done" needs
verification, not just a claim. The code-review turn is risk-based and on demand: it evaluates its
triggers against the working tree and runs when `/readyset --review <change-id>` asks for it,
skipping with an honest stub when nothing raises a flag.

## Benchmark

Readyset has a headless benchmark harness (`readyset-bench`) comparing it against native `/plan`
across bugfixes, storage migrations, cross-cutting refactors, and ambiguous feature requests. The
numbers from the last run are **not currently trusted as a measurement of the current version** —
see [docs/BENCHMARK.md](docs/BENCHMARK.md) for why, and for the methodology a clean rerun would
use.


## Learn more

- **[Full guide](docs/GUIDE.md)** — design philosophy, configuration, model/language settings,
  the review gate in detail, CLI validation, uninstalling, what Readyset deliberately doesn't do,
  and the full file/package layout.
- **[Benchmark deep-dive](docs/BENCHMARK.md)** — methodology, per-task breakdown (T01–T12),
  judge dimensions, request clarity impact, and resource trade-offs.
- **[Brainstorming outside omp](resources/brainstorm-ai/README.md)** — write a brainstorm in
  Claude Cowork before you ever open omp.

## License

[MIT](LICENSE) — see the `LICENSE` file. `src/skill/mattpocock-grilling.md` is vendored
separately under its own MIT license (Matt Pocock, full text kept in the file itself).

---

> Resolve ambiguity before planning. Ground the plan in the real repo. Make the proposal
> reviewable. Require human approval before execution. Keep runtime evidence separate from
> claims of correctness. Then:
>
> ```
> /readyset
> ```
