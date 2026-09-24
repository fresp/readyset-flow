# Benchmark: /plan vs /readyset (0.15.0)

> **⚠ Not a verified claim about the current version.** Everything below is labelled "0.15.0", but
> the numbers themselves match an earlier v0.12 run — they were never actually regenerated for
> 0.15.0. They also measure a code path (an internal apply/reconciliation loop, and an
> unconditional post-Apply review turn) that 0.16's handoff-based execution model removed
> entirely, so even taken at face value they no longer describe how the current version behaves.
> Treat this document as historical methodology and a template for a clean rerun, not as a current
> performance claim — a fresh benchmark run against the present version is still pending.

An empirical, end-to-end evaluation comparing native `omp` **`/plan`** against **`/readyset` (0.15.0)** across 12 realistic software engineering tasks on three distinct Node repositories.

---

## 1. Overview & Evaluation Setup

To evaluate whether structured grounding, proactive clarification, and human-in-the-loop gates improve coding outcomes, Readyset is tested using a headless benchmark harness (`readyset-bench`).

Both arms run:
- **Same Model**: `eai1/cbai/deepseek-v4.1-flash` for all planning, exploration, and execution phases.
- **Same Workspace**: Sandboxed Linux containers (`bwrap`) with identical repository baselines.
- **Same User Interaction**: An autonomous simulated user driven by an LLM with access to private persona facts. Questions are answered strictly from the persona; if a workflow doesn't ask, the persona facts remain hidden.
- **Isolated State**: Memory, autolearn, and cross-session advisors disabled so no run learns from another.

### Benchmark Fixtures & Tasks

The evaluation suite spans three production-style, zero-dependency Node codebases:
1. **`shoplite-api`**: An HTTP REST API with routing, middleware, controllers, and in-memory persistence.
2. **`taskflow-cli`**: A CLI task management tool with local JSON file persistence, atomic writes, and command handlers.
3. **`ledger-lib`**: An accounting library featuring financial posting rules, double-entry ledgers, and CSV export/import logic.

Across these fixtures, 12 realistic engineering tasks are evaluated:

| ID | Fixture | Category | Clarity | Hidden Tests | Description |
|---|---|---|---|---:|---|
| **T01** | `shoplite-api` | Feature | Clear | 7 | Sort products by price or name |
| **T02** | `shoplite-api` | Feature | Partial | 12 | Coupon codes on order checkout |
| **T03** | `shoplite-api` | Bugfix | Clear | 5 | Order totals off by cents on discounted multi-quantity lines |
| **T04** | `shoplite-api` | Feature | Ambiguous | 9 | Rate limiting before public launch |
| **T05** | `taskflow-cli` | Feature | Clear | 8 | Task priorities and priority-based listing |
| **T06** | `taskflow-cli` | Refactor | Clear | 6 | Storage repository consolidation with atomic writes |
| **T07** | `taskflow-cli` | Feature | Ambiguous | 12 | Recurring tasks scheduling |
| **T08** | `taskflow-cli` | Migration | Clear | 8 | Storage format v2 with automatic migration |
| **T09** | `ledger-lib` | Bugfix | Clear | 9 | CSV import breaks on quoted commas and escaped quotes |
| **T10** | `ledger-lib` | Feature | Ambiguous | 6 | Monthly income vs expense report |
| **T11** | `ledger-lib` | Refactor | Clear | 6 | Rename `Ledger.post()` to `record()` with deprecation path |
| **T12** | `ledger-lib` | Performance | Partial | 4 | Optimize slow balance queries on large ledgers |

**Clarity levels define requirement elicitation demands:**
- **Clear**: The request specifies the public interface and expected behavior. The persona holds only minor edge-case clarifications.
- **Partial**: The interface is specified, but critical business rules (rounding, bounds, expiry) must be clarified.
- **Ambiguous**: A brief prompt. Core requirements and acceptance criteria reside in the persona and must be elicited through grilling.

---

## 2. Headline Results

| Metric | `/plan` (native) | `/readyset` (0.15.0) | Delta | Statistical Significance |
|---|---:|---:|---:|---|
| **Code Judge Win Rate** | — | **91%** | — | 65 wins, 1 tie, 6 losses (blind normalized judging) |
| **Planning Judge Win Rate** | — | **82%** | — | 56 wins, 6 ties, 10 losses |
| **Hidden Test Pass Rate** | 69% | **91%** | **+23 pt** | 95% CI [10%, 36%]; sign test p=0.021 |
| **Tasks Fully Solved (100% pass)** | 17% | **53%** | **+36 pt** | 95% CI [17%, 58%] |
| **Repo Suite Regressions** | 0% | **0%** | 0 pt | Fixture unit test suites remained 100% green |
| **User Work Preservation** | — | **100%** | — | Byte-identical SHA-256 match on pre-existing WIP & untracked files |
| **Dangling Plan References** | 0.03 | **0.00** | **-0.03** | Automated repair eliminated all hallucinated paths (down from 0.53 in v0.12) |
| **Clarification Questions Asked** | 0.1 | **3.0** | +2.9 | Elicits unspoken assumptions before planning |

---

## 3. Detailed Task Breakdown

Objective hidden-test score and blind pairwise code judging per task:

| Task | Category | Clarity | `/plan` Hidden | `/readyset` Hidden | Hidden Δ | Code Judge (W / T / L) |
|---|---|---|---:|---:|---:|:---:|
| **T01** Sort products | Feature | Clear | 86% | **90%** | +5 pt | **6 / 0 / 0** |
| **T02** Coupon codes | Feature | Partial | 67% | **100%** | **+33 pt** | **6 / 0 / 0** |
| **T03** Discount rounding bug | Bugfix | Clear | 100% | **100%** | +0 pt | 2 / 0 / 4 |
| **T04** Rate limiting | Feature | Ambiguous | 26% | **93%** | **+67 pt** | **6 / 0 / 0** |
| **T05** Task priorities | Feature | Clear | 83% | **88%** | +4 pt | **5 / 1 / 0** |
| **T06** Storage repository | Refactor | Clear | 67% | **100%** | **+33 pt** | **6 / 0 / 0** |
| **T07** Recurring tasks | Feature | Ambiguous | 47% | **78%** | **+31 pt** | **6 / 0 / 0** |
| **T08** Storage v2 migration | Migration | Clear | 75% | **88%** | +13 pt | **6 / 0 / 0** |
| **T09** CSV quoting bug | Bugfix | Clear | 56% | **93%** | **+37 pt** | **6 / 0 / 0** |
| **T10** Monthly report | Feature | Ambiguous | 33% | **94%** | **+61 pt** | **6 / 0 / 0** |
| **T11** Rename `post()` → `record()` | Refactor | Clear | 83% | 72% | −11 pt | 4 / 0 / 2 |
| **T12** Balance query performance | Perf | Partial | 100% | **100%** | +0 pt | **6 / 0 / 0** |

---

## 4. Impact by Request Clarity

The value of Readyset's grilling phase scales directly with problem ambiguity:

| Request Clarity | Tasks | `/plan` Pass | `/readyset` Pass | Gain (Δ) | Questions Asked (`/plan` vs `/readyset`) | Code Judge Win Rate |
|---|---:|---:|---:|---:|---:|---:|
| **Ambiguous** | 3 | 35% | **88%** | **+53 pt** | 0.4 vs 3.4 | **100%** |
| **Partial** | 2 | 83% | **100%** | **+17 pt** | 0.0 vs 3.2 | **100%** |
| **Clear** | 7 | 79% | **90%** | **+12 pt** | 0.0 vs 2.8 | **85%** |

- **Ambiguous requests (+53 pt gain)**: Native `/plan` rarely asks clarifying questions (0.4 questions on average) and guesses critical requirements incorrectly, leading to severe test failures (e.g. 26% on T04 rate limiting, 33% on T10 monthly report). Readyset asks an average of 3.4 targeted questions, discovering hidden business logic and achieving 88% pass rate.
- **Clear requests (+12 pt gain)**: Even when requests are well-specified, Readyset's ground-first exploration and scope contracts prevent subtle regressions (e.g. T09 CSV quoting rose from 56% to 93%).

---

## 5. Blind Pairwise LLM Judging

Code diffs and planning documents were evaluated blindly by independent judge models (`glm-5.2` and `muse-spark-1.3`). Position bias is neutralized by evaluating each pair twice with swapped A/B ordering; a win is awarded only when both orientations agree.

### Implemented Code Judge (Diffs Only)

Judges evaluated the git diffs against task acceptance criteria without knowing which tool generated them:

| Dimension | `/readyset` Win Rate | 95% Confidence Interval | Wins / Ties / Losses |
|---|---:|---|:---:|
| **Test Quality** | **95%** | [87%, 100%] | 67 / 3 / 2 |
| **Requirement Coverage** | **88%** | [78%, 97%] | 57 / 13 / 2 |
| **Correctness** | **81%** | [67%, 93%] | 47 / 22 / 3 |
| **Codebase Fit** | **76%** | [63%, 89%] | 43 / 24 / 5 |
| **Scope Discipline** | **58%** | [45%, 72%] | 23 / 38 / 11 |
| **Overall** | **91%** | [78%, 100%] | **65 / 1 / 6** |

Inter-judge agreement was **97%**, with position consistency exceeding 89%.

### Planning Output Judge

Planning artifacts were normalized to strip tool-specific keywords ("readyset", "plan mode", change directory paths):

| Dimension | `/readyset` Win Rate | 95% Confidence Interval | Wins / Ties / Losses |
|---|---:|---|:---:|
| **Completeness** | **94%** | [81%, 100%] | 64 / 5 / 2 |
| **Verification Planning** | **87%** | [76%, 94%] | 56 / 13 / 3 |
| **Requirement Fidelity** | **82%** | [63%, 94%] | 53 / 10 / 8 |
| **Actionability** | **64%** | [46%, 81%] | 33 / 26 / 13 |
| **Grounding** | **66%** | [50%, 79%] | 32 / 30 / 9 |
| **Scope Discipline** | **57%** | [41%, 73%] | 25 / 32 / 15 |
| **Overall** | **82%** | [63%, 96%] | **56 / 6 / 10** |

---

## 6. Execution Trade-Offs: Wall Time & Cost

Readyset trades raw speed for correctness, verification, and human control. Understanding this trade-off is central to deciding when to use `/readyset`:

| Phase / Resource | `/plan` (native) | `/readyset` (Full Lane) | `/readyset` (Fast Lane, 0.15.0) |
|---|---:|---:|---:|
| **Preparation Wall Time** | 0.7 min | 9.7 min | ~3–5 min |
| **Execution Wall Time** | 1.7 min | 10.1 min | ~4–7 min |
| **Total Wall Time** | **~2.4 min** | **~19.8 min** | **~7–12 min** |
| **Total Tokens** | **774.9k** | **8.37M** | **~3.2–4.5M** |
| **Cache Read Share** | 69% | 72% | ~75% |
| **Clarification Questions** | 0.1 | 3.0 | 1–2 (value-of-information) |
| **Code Review Turn** | None | Risk-based (diff-first) | Conditional / stubbed |

### Why Native `/plan` is Faster
Native `/plan` operates as a rapid single-pass workflow:
- Asks almost no clarifying questions (0.1 avg).
- Does not explore the disk or grep repo seams before generating steps.
- Generates a concise plan without formal WHEN/THEN behavioral specifications.
- Runs execution immediately without post-apply scope validation or code review.
- **Outcome**: Finishes in under 3 minutes, but fails 31% of hidden tests and fully solves only 17% of tasks.

### Why `/readyset` Takes Longer (and How Fast-Lane Optimizes It)
`/readyset` enforces structural rigor:
- **Grilling**: Validates edge cases and clarifies ambiguities before writing code.
- **Exploration**: Verifies file paths and dependencies against the live repository.
- **Scope Contract**: Explicitly defines allowed touches (`(new)`, `(delete)`).
- **Execution & Review**: Re-verifies tasks with empirical test commands and runs risk-based code review.
- **Fast-Lane Optimization**: For clear bugfixes and small tasks, `--lane fast` skips the separate Explore turn, emits only `proposal.md` and `tasks.md`, and trims overhead—reducing wall time by **~40–54%** compared to the full-lane baseline.

---

## 7. 0.15.0 Hardening & Architectural Guarantees

Version 0.15.0 introduces several structural improvements verified during benchmark waves:

1. **Pre-existing Workspace Preservation**:
   - The harness verified byte-identical SHA-256 integrity on pre-existing modified files and untracked scratch notes across all benchmark runs.
2. **Safe Scope Reconciliation**:
   - Post-Apply reconciliation automatically reverts unauthorized edits outside the proposal scope contract without touching pre-existing user work.
3. **Negative Plan Grounding**:
   - Prevents false-positive dangling reference warnings by forbidding file extensions in negative assertions (e.g. stating "no changelog entry" rather than "no CHANGELOG.md").
4. **Headless Tool Discovery Fallback**:
   - When running over headless RPC where interactive dialogs (`readyset_ask`) are unavailable, grilling falls back immediately to structured chat questions without looping through filesystem or process searches.
5. **Zero Dangling Plan References**:
   - Automated repair loops catch and fix phantom paths during planning, achieving a **0.00** dangling reference rate.
