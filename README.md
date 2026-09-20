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

- **Grill** interrogates the idea until it's unambiguous — a real Q&A, not a rubber stamp.
- **Explore** greps the actual repo before anything gets proposed, instead of assuming.
- **Propose** writes a proposal, design, specs, and tasks — grounded in what Explore found.
- **Review** stops for your Approve / Refine / Discard. Nothing executes without a look.
- **Execute** implements the tasks; each one needs a `_Verified:` note, and a separate
  code-review turn runs before the change is archived.

Already have a brainstorm sitting in `.ai/brainstorms/`? Run `/readyset` with no `--idea` and pick
it — Grill is skipped, since the ambiguity's already resolved.

## Why

Plans drift from the repo, reviews get skipped under pressure, and "done" ends up meaning "the
model said so." Readyset turns each of those into a structural gate instead of a habit:
ambiguity gets interrogated before anything is written, every claim about the repo is grounded in
a dedicated explore phase, nothing executes without an explicit human approve, and "done" needs
verification, not just a claim.

## Learn more

- **[Full guide](docs/GUIDE.md)** — design philosophy, configuration, model/language settings,
  the review gate in detail, CLI validation, uninstalling, what Readyset deliberately doesn't do,
  and the full file/package layout.
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
