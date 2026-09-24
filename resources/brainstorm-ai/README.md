# brainstorm-ai

Authored by Freza (this package's maintainer), vendored here (originally verbatim, 2026-09-19,
then given a cosmetic `language` frontmatter field on 2026-09-19 — see below). It's meant to be
copied out and actually used, so its frontmatter has to stay the very first thing in the file
for a Claude Skill parser to accept it. Any provenance/usage notes belong here, in this sibling
file, not inside `SKILL.md` itself.

If you also have this skill uploaded as an account-level Skill at claude.ai (see "How to use it"
below), that copy won't pick up this change on its own — re-upload this `SKILL.md` there to get
the `language` field.

### `language` frontmatter field

The skill's session Q&A (questions, options, trade-off discussion, confirmations) was originally
hardcoded to Bahasa Indonesia. It now reads a `language: Indonesian` field in `SKILL.md`'s own
frontmatter instead — change that one line to switch the session's language, or remove the field
entirely to fall back to English. The saved `.ai/brainstorms/*.md` file itself is unaffected
either way: it's always written in English, so any downstream harness can pick it up without
translation.

## How to use it

Create/upload it as an account-level Skill at **claude.ai → Settings → Skills**. It then syncs
down to every surface that reads your synced skills (Claude Cowork, and Claude Code sessions
too — confirmed, not assumed: this package's own vendored copy was found by grepping a live
Claude Code session's `~/.claude/skills/synced/` directory, which is exactly where an
account-level Skill lands once synced). There's no per-repo copy step, and `readyset-flow
install` deliberately doesn't touch this folder at all — it's Claude account plumbing,
orthogonal to omp, not something the installer reads.

## Why it's here, not in `src/`

`src/skill/mattpocock-grilling.md` earns its place under `src/` because it's provenance
material: `grillTurnPrompt` in `src/extensions/readyset-review.ts` is literally adapted from
it. This skill has no such relationship to this package's code — nothing here is loaded,
installed, or adapted from it at runtime. It's a companion artifact for a different platform
(a Claude Skill, not an omp extension), kept here purely for discoverability, so it lives
outside `src/` on purpose.

## Sequence: Claude Cowork → `/readyset`

```mermaid
sequenceDiagram
    actor User
    participant Cowork as Claude Cowork<br/>(/brainstorm-ai)
    participant Repo as Repo<br/>.ai/brainstorms/*.md
    participant Omp as omp (/readyset)

    Note over User,Cowork: one-time setup
    User->>Cowork: create/upload SKILL.md at<br/>claude.ai → Settings → Skills

    Note over User,Cowork: per brainstorm — entirely outside omp
    User->>Cowork: /brainstorm-ai <topic>
    Cowork->>Repo: read-only research<br/>(Read/Grep/Glob, git log/diff/status, openspec list/show)
    loop until design settles (configured session language, one question per turn)
        Cowork->>User: question + ≥2 options
        User->>Cowork: answer
    end
    Cowork->>User: closing checklist —<br/>Decision, Seam, Scope, Acceptance Criteria,<br/>commit-only vs. commit+MR per task
    User->>Cowork: confirms / decides
    Cowork->>Cowork: auto-derive branch type + lane<br/>(not asked — stated inference)
    Cowork->>Repo: write .ai/brainstorms/<date>-<slug>.md<br/>(English, status: open, change_id: empty)
    Cowork->>User: path + summary + lane +<br/>"ready for another harness to pick up"

    Note over User,Omp: back inside omp, a separate session
    User->>Omp: /readyset
    Omp->>Repo: list brainstorms
    Omp->>User: picker — the new file appears<br/>alongside anything grilled in-session
    User->>Omp: pick it
    Note over Omp: Grill is skipped entirely —<br/>Decision/Seam/Scope/AC already resolved
    Omp->>Omp: content-check gate<br/>(same one that catches a thin in-session grill)
    Omp->>Repo: Explore → EXPLORATION.md
    Omp->>Repo: Propose → proposal.md / design.md / specs / tasks.md
    Omp->>User: review gate
```

## Relationship to Readyset's own grilling

Readyset's own grilling turn (`/readyset <idea>`, see the README's "Grilling from outside omp")
matches this skill's closing discipline and file shape deliberately: Decision/Seam/Scope/
Acceptance Criteria, the same auto-derived branch-type/lane rules, the same `.ai/brainstorms/`
file shape. A brainstorm this skill writes and one Readyset's own grilling writes are
indistinguishable to Readyset's picker — either is a legitimate way to arrive at a
`.ai/brainstorms/*.md` file for `/readyset` to pick up.

## Portability

The YAML frontmatter in `SKILL.md` (`allowed-tools`, `disable-model-invocation`,
`argument-hint`, and the `$ARGUMENTS`/`` !`command` `` substitution syntax) is Claude Skill
plumbing — on a Claude surface it actually restricts which tools the skill can call. Using this
on a non-Claude assistant (ChatGPT desktop, say) hasn't actually been tried: in principle only
the body below the closing `---` fence would carry over, as plain instructions with no tool
restriction enforced. Untested theory, not a documented path.
