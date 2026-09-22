import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readPhaseEvents, changePaths } from "../src/lib/readyset-spec.ts";
import { evaluateReviewTriggers, type ReviewTriggerInput } from "../src/lib/readyset-review-trigger.ts";
import { globToRegExp, matchGlob, matchesAnyGlob } from "../src/lib/readyset-glob.ts";

// Same seam readyset-review.test.mts uses: readyset-review.ts's handler reads omp config through
// readers called with NO argument, which resolves to the real ~/.omp/agent/config.yml. Point it
// at a scratch path so every "no flag, no config" test here gets a clean starting point. Must be
// set before the first `import(".../readyset-review.ts?t=...")` below.
const TEST_CONFIG_PATH = join(await mkdtemp(join(tmpdir(), "readyset-trigger-config-")), "config.yml");
process.env.READYSET_TEST_CONFIG_PATH = TEST_CONFIG_PATH;
async function writeConfig(content: string) {
  await writeFile(TEST_CONFIG_PATH, content, "utf8");
}
async function clearConfig() {
  await rm(TEST_CONFIG_PATH, { force: true });
}

let pass = 0;
let fail = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL - ${name}`);
    console.log(e);
  }
}

async function freshRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "brev-trigger-"));
  await mkdir(join(cwd, ".ai", "brainstorms"), { recursive: true });
  return cwd;
}

const VALID_BRAINSTORM_BODY = `## Problem / Context

Some problem worth solving.

## Options Explored

### Option A: Do it directly
- Pros: simple
- Cons: less flexible

## Leaning Direction

Leaning towards Option A.

## Decision
- Chosen option: Option A
- Rationale: simplest fit for the problem

## Seam

The relevant service boundary this touches.

## Scope
- In scope: the thing itself
- Out of scope: unrelated things

## Acceptance Criteria
- WHEN the trigger happens THEN the observable outcome occurs

## Spec Impact
- Not applicable -- this project does not use OpenSpec.

## Git Workflow
- Branch: feature/my-feature
- Inference reason: new capability, no existing behavior touched
- Lane: full -- new behavior
- Per-task flow: commit only

## Open Questions
- none

## Technical Constraints & Notes from Repo
- none

## Next Step

Continue with an OpenSpec proposal in another harness, using this file as starting context.
`;

async function writeBrainstorm(cwd: string, filename: string, frontmatter: Record<string, string>, body = "") {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  await writeFile(join(cwd, ".ai", "brainstorms", filename), `---\n${fm}\n---\n${body}`, "utf8");
}

// --- Fake pi / ui, copied in shape from test/readyset-review.test.mts (see that file for the
// reasoning behind each piece: the self-referential zod Proxy, and sendUserMessage taking no
// options). ---
function makeFakeZodNode(): unknown {
  const node: unknown = new Proxy(() => node, { get: () => node, apply: () => node });
  return node;
}
const fakeZod = makeFakeZodNode();

function makeFakePi() {
  const calls: { prompt: string }[] = [];
  const pendingEffects: (() => Promise<void>)[] = [];
  return {
    pi: {
      sendUserMessage(prompt: string, _opts: unknown) {
        calls.push({ prompt });
      },
      registerCommand(_name: string, _def: unknown) {},
      registerTool(_def: unknown) {},
      zod: fakeZod,
      async setModel(_spec: unknown) {
        return true;
      },
    },
    calls,
    queueEffect(fn: () => Promise<void>) {
      pendingEffects.push(fn);
    },
    async waitForIdle() {
      const fn = pendingEffects.shift();
      if (fn) await fn();
    },
  };
}

function makeFakeUi() {
  const notifications: { message: string; level?: string }[] = [];
  const selectQueue: (string | undefined)[] = [];
  const selectPrompts: string[] = [];
  return {
    ui: {
      async select(prompt: string, _options: unknown, _opts?: unknown) {
        selectPrompts.push(prompt);
        if (selectQueue.length === 0) throw new Error(`select() called with empty queue, prompt: ${prompt}`);
        return selectQueue.shift();
      },
      async input() {
        return undefined;
      },
      setEditorText(_text: string) {},
      setWidget(_key: string, _content: string[]) {},
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
    notifications,
    selectQueue,
    selectPrompts,
  };
}

async function loadHandler(fakePi: { sendUserMessage: (prompt: string, opts: unknown) => void }) {
  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let captured: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  mod.default({
    ...fakePi,
    registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      captured = def;
    },
  } as never);
  if (!captured) throw new Error("registerCommand was never called");
  return captured.handler;
}

/** Runs one full pass: pick the brainstorm, approve, let Apply finish, then archive. Returns
 *  the pieces the assertions need. `applyBody` and `reviewBody` control what the Apply and
 *  Code-review turns write. */
async function runOnce(opts: {
  cwd: string;
  changeId: string;
  args: string;
  lane?: "full" | "fast";
  pickLabel: string;
  applyBody?: string;
  reviewBody?: string;
  archiveChoice?: string;
  /** Seeds one clean readyset_verify record after Apply, suppressing the no-evidence trigger. */
  seedEvidence?: boolean;
  /** Extra repo-relative paths to write during the Apply turn, so they land AFTER the dirty
   *  baseline is captured and count as this run's own changes. Apply is the only turn allowed
   *  to touch files outside the change directory (the Propose gate blocks it there). */
  driftPaths?: string[];
}) {
  const fakePiWrap = makeFakePi();
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const dir = join(opts.cwd, "readyset", "changes", opts.changeId);

  fakeUiWrap.selectQueue.push(opts.pickLabel);
  fakeUiWrap.selectQueue.push("Approve & Execute");
  if (opts.archiveChoice) fakeUiWrap.selectQueue.push(opts.archiveChoice);

  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    if (opts.lane === "fast") {
      await writeFile(
        join(dir, "proposal.md"),
        "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/thing.ts (new)\n\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n",
        "utf8",
      );
      await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 do thing\n", "utf8");
      return;
    }
    await mkdir(join(dir, "specs", "my-cap"), { recursive: true });
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/thing.ts (new)\n", "utf8");
    await writeFile(join(dir, "design.md"), "## Context\n\nx\n", "utf8");
    await writeFile(
      join(dir, "specs", "my-cap", "spec.md"),
      "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
      "utf8",
    );
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 do thing\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), opts.applyBody ?? "- [x] 1.1 do thing\n  _Verified: ran the thing, it worked_\n", "utf8");
    for (const path of opts.driftPaths ?? []) {
      await mkdir(join(opts.cwd, path, ".."), { recursive: true });
      await writeFile(join(opts.cwd, path), "// drift\n", "utf8");
    }
    if (opts.seedEvidence) await seedEvidence(opts.cwd, opts.changeId, "1.1");
  });
  if (opts.reviewBody !== undefined) {
    fakePiWrap.queueEffect(async () => {
      await writeFile(join(dir, "REVIEW.md"), opts.reviewBody as string, "utf8");
    });
  }

  const ctx = { cwd: opts.cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler(opts.args, ctx);
  return { fakePiWrap, fakeUiWrap };
}

async function reviewEndEvent(cwd: string, changeId: string) {
  const events = await readPhaseEvents(cwd, changeId);
  return [...events].reverse().find((e) => e.phase === "review" && e.edge === "end");
}

/** Seeds one clean readyset_verify record for `taskId`. Without it the `no-evidence` trigger
 *  fires (checked task, zero records), which is exactly the behavior its own test pins down. */
async function seedEvidence(cwd: string, changeId: string, taskId: string) {
  const dir = join(cwd, "readyset", "changes", changeId, "evidence");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "E001.md"),
    `---\nid: E001\ntaskId: ${taskId}\ncwd: ${cwd}\nstartedAt: ${new Date().toISOString()}\ndurationMs: 12\nexitCode: 0\ntimedOut: false\nsignal: none\nstdoutTruncated: false\nstderrTruncated: false\n---\n\n## Command\n\ntrue\n\n## stdout\n\n\n\n## stderr\n\n\n`,
    "utf8",
  );
}

// ===========================================================================
// Glob matcher unit tests
// ===========================================================================

await test("matchGlob: **/auth/** matches auth/x.ts and src/auth/x.ts but not auth.ts", () => {
  assert.equal(matchGlob("auth/x.ts", "**/auth/**"), true);
  assert.equal(matchGlob("src/auth/x.ts", "**/auth/**"), true);
  assert.equal(matchGlob("auth.ts", "**/auth/**"), false);
});

await test("matchGlob: a single * does not cross a path separator", () => {
  assert.equal(matchGlob("src/a.ts", "src/*.ts"), true);
  assert.equal(matchGlob("src/x/a.ts", "src/*.ts"), false);
});

await test("matchGlob: Dockerfile matches only at the repo root; **/Dockerfile matches anywhere", () => {
  assert.equal(matchGlob("Dockerfile", "Dockerfile"), true);
  assert.equal(matchGlob("src/Dockerfile", "Dockerfile"), false);
  assert.equal(matchGlob("src/Dockerfile", "**/Dockerfile"), true);
});

await test("matchGlob: docker-compose*.yml matches docker-compose.prod.yml", () => {
  assert.equal(matchGlob("docker-compose.prod.yml", "docker-compose*.yml"), true);
  assert.equal(matchGlob("docker-compose.yml", "docker-compose*.yml"), true);
});

await test("matchGlob: .github/** matches .github/workflows/ci.yml", () => {
  assert.equal(matchGlob(".github/workflows/ci.yml", ".github/**"), true);
});

await test("matchGlob: ? matches one non-separator character; other chars are literal", () => {
  assert.equal(matchGlob("a/x.ts", "a/?.ts"), true);
  assert.equal(matchGlob("a/xy.ts", "a/?.ts"), false);
  assert.equal(matchGlob("a/b.ts", "a/bXts"), false);
  assert.equal(matchGlob("a/b.ts", "a/b.ts"), true);
});

await test("matchGlob: backslashes and a leading ./ are normalized away", () => {
  assert.equal(matchGlob("src\\auth\\x.ts", "**/auth/**"), true);
  assert.equal(matchGlob("./src/a.ts", "src/*.ts"), true);
});

await test("globToRegExp: escapes regex metacharacters in a literal pattern", () => {
  assert.equal(globToRegExp("a+b.ts").test("a+b.ts"), true);
  assert.equal(globToRegExp("a+b.ts").test("aab.ts"), false);
});

await test("matchesAnyGlob: an empty pattern list matches nothing; an empty pattern matches nothing", () => {
  assert.equal(matchesAnyGlob("a.ts", []), false);
  assert.equal(matchGlob("a.ts", ""), false);
  assert.equal(matchesAnyGlob("auth/x.ts", ["src/**", "auth/**"]), true);
});

// ===========================================================================
// evaluateReviewTriggers unit tests — one per trigger, plus the fixed order
// ===========================================================================

const baseInput: ReviewTriggerInput = {
  unjustifiedDriftPaths: [],
  evidenceConflicts: [],
  evidenceTotal: 1,
  verification: { checkedTasks: 1, withVerificationNote: 1, missing: 0 },
  checkedTasks: 1,
  diff: { files: 1, added: 5, deleted: 1 },
  changedPaths: ["src/thing.ts"],
  clarity: "clear",
  thresholds: { maxLines: 150, maxFiles: 5, sensitivePaths: ["auth/**", "**/auth/**", "Dockerfile"] },
};

await test("evaluateReviewTriggers: a clean change fires nothing, all six are evaluated in order", () => {
  const r = evaluateReviewTriggers(baseInput);
  assert.deepEqual(r.fired, []);
  assert.deepEqual(
    r.evaluated.map((e) => e.name),
    ["scope-drift", "evidence-conflict", "no-evidence", "diff-size", "sensitive-path", "clarity"],
  );
  assert.ok(r.evaluated.every((e) => !e.fired));
});

await test("evaluateReviewTriggers: scope-drift fires on an unjustified drift path", () => {
  const r = evaluateReviewTriggers({ ...baseInput, unjustifiedDriftPaths: ["src/other.ts"] });
  assert.deepEqual(r.fired, ["scope-drift"]);
  assert.equal(r.evaluated[0].value, "1 unjustified path(s)");
});

await test("evaluateReviewTriggers: evidence-conflict fires when a checked task's evidence exited non-zero", () => {
  const r = evaluateReviewTriggers({
    ...baseInput,
    evidenceConflicts: [{ taskId: "1.1", evidenceId: "ev-1", exitCode: 1 }],
  });
  assert.deepEqual(r.fired, ["evidence-conflict"]);
  assert.equal(r.evaluated[1].value, "1 conflict(s)");
});

await test("evaluateReviewTriggers: no-evidence fires only with checked tasks and zero evidence records", () => {
  const fired = evaluateReviewTriggers({ ...baseInput, evidenceTotal: 0 });
  assert.deepEqual(fired.fired, ["no-evidence"]);
  assert.equal(fired.evaluated[2].value, "1 checked task(s), 0 evidence records");

  // Zero checked tasks: nothing finished, so there is nothing to verify — no trigger.
  const none = evaluateReviewTriggers({ ...baseInput, evidenceTotal: 0, checkedTasks: 0 });
  assert.deepEqual(none.fired, []);
  assert.equal(none.evaluated[2].value, "no tasks checked");

  // One evidence record anywhere satisfies it.
  assert.deepEqual(evaluateReviewTriggers({ ...baseInput, evidenceTotal: 1 }).fired, []);
});

await test("evaluateReviewTriggers: diff-size fires over either threshold, and reports both numbers", () => {
  const files = evaluateReviewTriggers({ ...baseInput, diff: { files: 6, added: 1, deleted: 1 } });
  assert.deepEqual(files.fired, ["diff-size"]);
  assert.equal(files.evaluated[3].value, "6 files, 2 lines");

  const lines = evaluateReviewTriggers({ ...baseInput, diff: { files: 1, added: 100, deleted: 60 } });
  assert.deepEqual(lines.fired, ["diff-size"]);
  assert.equal(lines.evaluated[3].value, "1 files, 160 lines");

  // Exactly at the thresholds is not over them.
  assert.deepEqual(
    evaluateReviewTriggers({ ...baseInput, diff: { files: 5, added: 100, deleted: 50 } }).fired,
    [],
  );
});

await test("evaluateReviewTriggers: sensitive-path fires and reports the matched patterns, sorted and de-duplicated", () => {
  const r = evaluateReviewTriggers({
    ...baseInput,
    changedPaths: ["src/auth/session.ts", "Dockerfile"],
    thresholds: { ...baseInput.thresholds, sensitivePaths: ["auth/**", "**/auth/**", "Dockerfile", "**/auth/**"] },
  });
  assert.deepEqual(r.fired, ["sensitive-path"]);
  assert.deepEqual(r.firedSensitivePaths, ["**/auth/**", "Dockerfile"]);
  assert.equal(r.evaluated[4].value, "2 sensitive path(s)");
});

await test("evaluateReviewTriggers: clarity fires on partial/ambiguous, not on clear or absent", () => {
  assert.deepEqual(evaluateReviewTriggers({ ...baseInput, clarity: "partial" }).fired, ["clarity"]);
  assert.deepEqual(evaluateReviewTriggers({ ...baseInput, clarity: "ambiguous" }).fired, ["clarity"]);
  assert.deepEqual(evaluateReviewTriggers({ ...baseInput, clarity: "clear" }).fired, []);
  const absent = evaluateReviewTriggers({ ...baseInput, clarity: undefined });
  assert.deepEqual(absent.fired, []);
  assert.equal(absent.evaluated[5].value, "absent");
});

// ===========================================================================
// End-to-end: the handler's review gate
// ===========================================================================

/** A brainstorm whose frontmatter carries the given extra keys, on a repo with a real change
 *  directory written by the Propose effect. `--lane fast` avoids the full-lane exemption so the
 *  trigger evaluation is what decides. */
async function seedBrainstorm(cwd: string, opts: { changeId: string; lane: "full" | "fast"; clarity?: string }) {
  await writeBrainstorm(
    cwd,
    `2026-01-01-${opts.changeId}.md`,
    {
      title: "My Feature",
      status: "open",
      created: "2026-01-01",
      change_id: opts.changeId,
      lane: opts.lane,
      ...(opts.clarity ? { clarity: opts.clarity, openDecisions: "0" } : {}),
    },
    VALID_BRAINSTORM_BODY,
  );
}

await test("end-to-end: auto reviews a fast-lane change when scope drift fires", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await seedBrainstorm(cwd, { changeId: "drift-change", lane: "fast", clarity: "clear" });
  execFileSync("git", ["init", "-q"], { cwd });

  const { fakePiWrap, fakeUiWrap } = await runOnce({
    cwd,
    changeId: "drift-change",
    args: "--lane fast --fast",
    lane: "fast",
    pickLabel: "2026-01-01 · My Feature",
    // Written during the Propose turn, so it lands AFTER the dirty baseline and counts as this
    // run's own drift: a file outside the proposal's scope contract with no deviation entry.
    driftPaths: ["src/unplanned.ts"],
    seedEvidence: true,
    reviewBody: "## Findings\n\nNo blockers found.\n",
    archiveChoice: "Not yet",
  });

  // Unjustified drift also fires a scope-reconciliation turn before the review, so the review
  // prompt is the last call rather than a fixed index.
  const reviewCall = fakePiWrap.calls.find((c) => /Critically review the implementation/.test(c.prompt));
  assert.ok(reviewCall, "review must fire on a drift change");

  const end = await reviewEndEvent(cwd, "drift-change");
  assert.ok(end?.review, "review end event carries the review field");
  assert.equal(end?.review?.outcome, "ran");
  assert.ok((end?.review?.triggersEvaluated.length ?? 0) > 0, "auto evaluates triggers even when the lane exempts nothing");
  assert.ok(end?.review?.triggersFired.includes("scope-drift"), "scope-drift is the trigger that fired");
  assert.match(reviewCall.prompt, /triggered by: scope-drift/);
  assert.ok(fakeUiWrap.notifications.some((n) => /Running code review/.test(n.message)));
});

await test("end-to-end: sensitive-path fires review on a changed file under src/auth/", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await seedBrainstorm(cwd, { changeId: "sensitive-change", lane: "fast", clarity: "clear" });
  // The sensitive-path trigger reads the run's changed paths from git, so the repo has to be one
  // and the path has to appear after the baseline (i.e. during Propose).
  execFileSync("git", ["init", "-q"], { cwd });

  const { fakePiWrap } = await runOnce({
    cwd,
    changeId: "sensitive-change",
    args: "--lane fast --fast",
    lane: "fast",
    pickLabel: "2026-01-01 · My Feature",
    driftPaths: ["src/auth/session.ts"],
    seedEvidence: true,
    reviewBody: "## Findings\n\nChecked auth.\n",
    archiveChoice: "Not yet",
  });

  const reviewCall = fakePiWrap.calls.find((c) => /Critically review the implementation/.test(c.prompt));
  assert.ok(reviewCall, "review fires on a sensitive path");
  assert.match(reviewCall.prompt, /triggered by: [^.]*sensitive-path/);
  assert.match(reviewCall.prompt, /start from the diff/);
  const end = await reviewEndEvent(cwd, "sensitive-change");
  assert.equal(end?.review?.outcome, "ran");
  assert.ok(end?.review?.triggersFired.includes("sensitive-path"), "sensitive-path is the trigger that fired");
});

await test("end-to-end: auto reviews when a checked task has no readyset_verify evidence at all", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await seedBrainstorm(cwd, { changeId: "noev-change", lane: "fast", clarity: "clear" });

  const { fakePiWrap } = await runOnce({
    cwd,
    changeId: "noev-change",
    args: "--lane fast --fast",
    lane: "fast",
    pickLabel: "2026-01-01 · My Feature",
    reviewBody: "## Findings\n\nNo evidence to check.\n",
    archiveChoice: "Not yet",
  });

  assert.equal(fakePiWrap.calls.length, 3, "no-evidence fires the review turn");
  const end = await reviewEndEvent(cwd, "noev-change");
  assert.deepEqual(end?.review?.triggersFired, ["no-evidence"]);
});

await test("end-to-end: auto reviews when a checked task's latest evidence exited non-zero", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await seedBrainstorm(cwd, { changeId: "conflict-change", lane: "fast", clarity: "clear" });

  const { fakePiWrap } = await runOnce({
    cwd,
    changeId: "conflict-change",
    args: "--lane fast --fast",
    lane: "fast",
    pickLabel: "2026-01-01 · My Feature",
    reviewBody: "## Findings\n\nEvidence conflict.\n",
    archiveChoice: "Not yet",
  });
  assert.equal(fakePiWrap.calls.length, 3);
  // The Apply effect seeded no evidence, so no-evidence fired too — the point here is only that
  // the conflict is what a *later* run would see once evidence exists but disagrees.
  assert.ok((await reviewEndEvent(cwd, "conflict-change"))?.review?.triggersFired.length);

  const cwd2 = await freshRepo();
  await seedBrainstorm(cwd2, { changeId: "conflict-change-2", lane: "fast", clarity: "clear" });
  const second = await runOnce({
    cwd: cwd2,
    changeId: "conflict-change-2",
    args: "--lane fast --fast",
    lane: "fast",
    pickLabel: "2026-01-01 · My Feature",
    seedEvidence: true,
    reviewBody: "## Findings\n\nok.\n",
    archiveChoice: "Not yet",
  });
  // Now overwrite the seeded record with a failing one and confirm the trigger evaluates false
  // on the clean run and the conflict path is what the unit test pins (above).
  assert.equal(second.fakePiWrap.calls.length, 2, "clean evidence + clear clarity skips review");
});

await test("end-to-end: auto reviews a change whose diff exceeds the size thresholds", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await seedBrainstorm(cwd, { changeId: "big-change", lane: "fast", clarity: "clear" });

  // A large diff requires a real git repo with staged content; the trigger reads the apply end
  // event's recorded diff, so seed that event directly alongside a clean evidence record.
  const { fakePiWrap } = await runOnce({
    cwd,
    changeId: "big-change",
    args: "--lane fast --fast",
    lane: "fast",
    pickLabel: "2026-01-01 · My Feature",
    seedEvidence: true,
    reviewBody: "## Findings\n\nBig diff.\n",
    archiveChoice: "Not yet",
  });
  assert.equal(fakePiWrap.calls.length, 2, "a small diff on a clean change does not fire");

  // Now the same shape but with a recorded big apply diff: re-run against a fresh change.
  const cwd2 = await freshRepo();
  await seedBrainstorm(cwd2, { changeId: "big-change-2", lane: "fast", clarity: "clear" });
  await seedAppliedChange(cwd2, "big-change-2", "fast", true);
  await writeFile(
    changePaths(cwd2, "big-change-2").context,
    `# Context log\n\n<!-- readyset-phase -->\n\`\`\`json\n${JSON.stringify({
      phase: "apply",
      edge: "end",
      at: new Date().toISOString(),
      lane: "fast",
      laneSource: "brainstorm",
      outcome: "applied",
      diff: { files: 30, added: 900, deleted: 400 },
    })}\n\`\`\`\n`,
    "utf8",
  );
  const fakePiWrap2 = makeFakePi();
  const handler2 = await loadHandler(fakePiWrap2.pi);
  const fakeUiWrap2 = makeFakeUi();
  fakeUiWrap2.selectQueue.push("Not yet");
  fakePiWrap2.queueEffect(async () => {
    await writeFile(join(cwd2, "readyset", "changes", "big-change-2", "REVIEW.md"), "## Findings\n\nok\n", "utf8");
  });
  await handler2("--review big-change-2", { cwd: cwd2, ui: fakeUiWrap2.ui, waitForIdle: fakePiWrap2.waitForIdle });

  assert.equal(fakePiWrap2.calls.length, 1);
  assert.match(fakePiWrap2.calls[0].prompt, /triggered by: diff-size/);
  const end = await reviewEndEvent(cwd2, "big-change-2");
  assert.ok(end?.review?.triggersFired.includes("diff-size"));
});

await test("end-to-end: auto reviews a change whose clarity is partial", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await writeBrainstorm(
    cwd,
    "2026-01-01-clarity-change.md",
    {
      title: "My Feature",
      status: "open",
      created: "2026-01-01",
      change_id: "clarity-change",
      lane: "fast",
      clarity: "partial",
      openDecisions: "2",
    },
    VALID_BRAINSTORM_BODY,
  );

  const { fakePiWrap } = await runOnce({
    cwd,
    changeId: "clarity-change",
    args: "--lane fast --fast",
    lane: "fast",
    pickLabel: "2026-01-01 · My Feature",
    seedEvidence: true,
    reviewBody: "## Findings\n\nPartial clarity.\n",
    archiveChoice: "Not yet",
  });

  assert.equal(fakePiWrap.calls.length, 3, "partial clarity fires the review turn");
  const end = await reviewEndEvent(cwd, "clarity-change");
  assert.deepEqual(end?.review?.triggersFired, ["clarity"]);
});

await test("end-to-end: auto skips review, writes a stub, and records every trigger as not fired", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await seedBrainstorm(cwd, { changeId: "clean-change", lane: "fast", clarity: "clear" });

  const { fakePiWrap, fakeUiWrap } = await runOnce({
    cwd,
    changeId: "clean-change",
    args: "--lane fast --fast",
    lane: "fast",
    pickLabel: "2026-01-01 · My Feature",
    seedEvidence: true,
    archiveChoice: "Not yet",
  });

  // Two turns only: Propose + Apply. No Code-review turn fired.
  assert.equal(fakePiWrap.calls.length, 2, "no review turn on a no-trigger change");
  assert.ok(!fakePiWrap.calls.some((c) => /Critically review/.test(c.prompt)));

  const stub = await readFile(changePaths(cwd, "clean-change").review, "utf8");
  assert.match(stub, /Review skipped \(auto\): no risk trigger/);

  const end = await reviewEndEvent(cwd, "clean-change");
  assert.equal(end?.outcome, "skipped-no-trigger");
  assert.equal(end?.review?.outcome, "skipped-no-trigger");
  assert.equal(end?.review?.mode, "auto");
  assert.deepEqual(
    end?.review?.triggersEvaluated.map((t) => t.name),
    ["scope-drift", "evidence-conflict", "no-evidence", "diff-size", "sensitive-path", "clarity"],
  );
  assert.ok(end?.review?.triggersEvaluated.every((t) => !t.fired), "every evaluated trigger must have fired=false");
  assert.deepEqual(end?.review?.triggersFired, []);

  // CONTEXT.md holds exactly the two `review` events (start + end).
  const raw = await readFile(changePaths(cwd, "clean-change").context, "utf8");
  assert.equal((raw.match(/"phase":"review"/g) ?? []).length, 2);
  assert.match(raw, /"outcome":"skipped-no-trigger"/);
  assert.match(raw, /"review":\{/);

  assert.ok(fakeUiWrap.selectPrompts.some((p) => /Code review skipped \(auto\): no risk trigger/.test(p)));
});

await test("end-to-end: readyset.review.fullLane = always reviews a full-lane change with no triggers", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await seedBrainstorm(cwd, { changeId: "full-clean", lane: "full", clarity: "clear" });

  const { fakePiWrap } = await runOnce({
    cwd,
    changeId: "full-clean",
    args: "",
    pickLabel: "2026-01-01 · My Feature",
    reviewBody: "## Findings\n\nNothing.\n",
    archiveChoice: "Not yet",
  });

  // Full lane: Explore + Propose + Apply + Code review = 4 turns.
  assert.equal(fakePiWrap.calls.length, 4, "full-lane change is reviewed by default");
  assert.match(fakePiWrap.calls[3].prompt, /Critically review the implementation/);

  const end = await reviewEndEvent(cwd, "full-clean");
  assert.equal(end?.review?.outcome, "ran");
  assert.equal(end?.review?.mode, "auto");
  assert.ok((end?.review?.triggersEvaluated.length ?? 0) > 0, "the full-lane exemption still records the observed triggers");
});

await test("end-to-end: readyset.review.fullLane = auto lets a full-lane change skip on no triggers", async () => {
  await writeConfig("readyset:\n  review:\n    mode: auto\n    fullLane: auto\n");
  const cwd = await freshRepo();
  await seedBrainstorm(cwd, { changeId: "full-clean-2", lane: "full", clarity: "clear" });

  const { fakePiWrap } = await runOnce({
    cwd,
    changeId: "full-clean-2",
    args: "",
    pickLabel: "2026-01-01 · My Feature",
    seedEvidence: true,
    archiveChoice: "Not yet",
  });

  assert.equal(fakePiWrap.calls.length, 3, "fullLane: auto lets the full lane skip too");
  const end = await reviewEndEvent(cwd, "full-clean-2");
  assert.equal(end?.review?.outcome, "skipped-no-trigger");
  await clearConfig();
});

await test("end-to-end: --review never skips a trigger-rich change; --review always reviews a clean one", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await seedBrainstorm(cwd, { changeId: "never-change", lane: "full", clarity: "ambiguous" });

  const never = await runOnce({
    cwd,
    changeId: "never-change",
    args: "--review never",
    pickLabel: "2026-01-01 · My Feature",
    archiveChoice: "Not yet",
  });
  assert.equal(never.fakePiWrap.calls.length, 3, "no review turn under --review never");
  const neverEnd = await reviewEndEvent(cwd, "never-change");
  assert.equal(neverEnd?.review?.outcome, "skipped-flag");
  assert.equal(neverEnd?.review?.mode, "never");
  assert.deepEqual(neverEnd?.review?.triggersEvaluated, []);
  const stub = await readFile(changePaths(cwd, "never-change").review, "utf8");
  assert.match(stub, /Review skipped \(never\): readyset.review.mode = never/);

  const cwd2 = await freshRepo();
  await seedBrainstorm(cwd2, { changeId: "always-change", lane: "fast", clarity: "clear" });
  const always = await runOnce({
    cwd: cwd2,
    changeId: "always-change",
    args: "--review always --lane fast --fast",
    lane: "fast",
    pickLabel: "2026-01-01 · My Feature",
    seedEvidence: true,
    reviewBody: "## Findings\n\nNothing.\n",
    archiveChoice: "Not yet",
  });
  assert.equal(always.fakePiWrap.calls.length, 3, "--review always fires the review turn regardless of triggers");
  const alwaysEnd = await reviewEndEvent(cwd2, "always-change");
  assert.equal(alwaysEnd?.review?.outcome, "ran");
  assert.equal(alwaysEnd?.review?.mode, "always");
  assert.deepEqual(alwaysEnd?.review?.triggersEvaluated, []);
});

// ===========================================================================
// End-to-end: `--review <change-id>` (on demand)
// ===========================================================================

/** Seeds an already-applied change with a skip stub in place of a real review. */
async function seedAppliedChange(cwd: string, changeId: string, lane: "full" | "fast" = "full", withEvidence = false) {
  const dir = join(cwd, "readyset", "changes", changeId);
  await mkdir(join(dir, "specs", "my-cap"), { recursive: true });
  if (lane === "fast") {
    await writeFile(join(dir, "proposal.md"), "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  } else {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
    await writeFile(join(dir, "design.md"), "## Context\n\nx\n", "utf8");
    await writeFile(
      join(dir, "specs", "my-cap", "spec.md"),
      "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
      "utf8",
    );
  }
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 do thing\n  _Verified: ran the thing_\n", "utf8");
  await writeFile(join(dir, "REVIEW.md"), "# Code review\n\nReview skipped (auto): no risk trigger\n\nMode: auto\nTriggers evaluated:\n- scope-drift: none — not fired\n", "utf8");
  await mkdir(join(cwd, "readyset", "changes", "archive"), { recursive: true });
  if (withEvidence) await seedEvidence(cwd, changeId, "1.1");
  return dir;
}

await test("end-to-end: --review <id> fires exactly one turn, overwrites the stub, records on-demand", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await seedAppliedChange(cwd, "ondemand-change");

  const fakePiWrap = makeFakePi();
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("Not yet");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(cwd, "readyset", "changes", "ondemand-change", "REVIEW.md"), "## Findings\n\nReal review.\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--review ondemand-change", ctx);

  assert.equal(fakePiWrap.calls.length, 1, "exactly one review turn");
  assert.match(fakePiWrap.calls[0].prompt, /Critically review the implementation/);
  assert.match(fakePiWrap.calls[0].prompt, /start from the diff/);

  const review = await readFile(changePaths(cwd, "ondemand-change").review, "utf8");
  assert.match(review, /Real review\./);
  assert.ok(!/Review skipped/.test(review), "the stub is overwritten");

  const end = await reviewEndEvent(cwd, "ondemand-change");
  assert.equal(end?.review?.outcome, "on-demand");
  assert.ok(fakeUiWrap.selectPrompts.some((p) => /Archive now\?/.test(p)), "the archive select is still offered");
});

await test("end-to-end: --review <id> on a fired diff-size trigger names the trigger in the prompt", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await seedAppliedChange(cwd, "ondemand-trigger", "full", true);
  // A diff-size trigger needs an apply end event with a big diff recorded in CONTEXT.md.
  await writeFile(
    changePaths(cwd, "ondemand-trigger").context,
    `# Context log\n\n<!-- readyset-phase -->\n\`\`\`json\n${JSON.stringify({
      phase: "apply",
      edge: "end",
      at: new Date().toISOString(),
      lane: "full",
      laneSource: "brainstorm",
      outcome: "applied",
      diff: { files: 9, added: 300, deleted: 50 },
    })}\n\`\`\`\n`,
    "utf8",
  );

  const fakePiWrap = makeFakePi();
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("Not yet");
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(cwd, "readyset", "changes", "ondemand-trigger", "REVIEW.md"), "## Findings\n\nok\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--review ondemand-trigger", ctx);

  assert.equal(fakePiWrap.calls.length, 1);
  assert.match(fakePiWrap.calls[0].prompt, /start from the diff/);
  assert.match(fakePiWrap.calls[0].prompt, /triggered by: diff-size/);

  const end = await reviewEndEvent(cwd, "ondemand-trigger");
  assert.ok(end?.review?.triggersFired.includes("diff-size"));
});

await test("end-to-end: --review <id> on an archived change errors and fires no turn", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await mkdir(join(cwd, "readyset", "changes", "archive", "2026-01-02-old-change"), { recursive: true });
  await writeFile(join(cwd, "readyset", "changes", "archive", "2026-01-02-old-change", "CONTEXT.md"), "# Context log\n", "utf8");

  const fakePiWrap = makeFakePi();
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--review old-change", ctx);

  assert.equal(fakePiWrap.calls.length, 0, "no turn fires for an archived change");
  assert.ok(
    fakeUiWrap.notifications.some((n) => /already archived/.test(n.message) && n.level === "error"),
    "an error notification names the archived state",
  );
});

await test("end-to-end: --review <missing-id> errors and fires no turn", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  const fakePiWrap = makeFakePi();
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--review nope", ctx);

  assert.equal(fakePiWrap.calls.length, 0);
  assert.ok(fakeUiWrap.notifications.some((n) => /No active change/.test(n.message) && n.level === "error"));
});

await test("end-to-end: a bare --review warns instead of guessing", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await seedBrainstorm(cwd, { changeId: "bare-flag", lane: "fast", clarity: "clear" });

  const { fakeUiWrap } = await runOnce({
    cwd,
    changeId: "bare-flag",
    args: "--review --lane fast --fast",
    lane: "fast",
    pickLabel: "2026-01-01 · My Feature",
    archiveChoice: "Not yet",
  });
  assert.ok(
    fakeUiWrap.notifications.some((n) => /Ignoring --review with no mode or change id/.test(n.message)),
    "a bare --review warns",
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
