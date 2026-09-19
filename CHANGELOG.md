# Changelog

Every version from `0.2.0` on now has a real git tag. Entries at `0.9.0` and below were
reconstructed from `package.json`'s `version` field across git history (`git log -p --
package.json`), grouped by the commit that bumped it, and describe real commits rather than a
rewritten narrative — a version with very few commits between it and the previous bump genuinely
only had that much change in it.

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
