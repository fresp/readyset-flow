import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

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
  const cwd = await mkdtemp(join(tmpdir(), "brev-"));
  await mkdir(join(cwd, ".ai", "brainstorms"), { recursive: true });
  return cwd;
}

async function writeBrainstorm(cwd: string, filename: string, frontmatter: Record<string, string>, body = "") {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const raw = `---\n${fm}\n---\n${body}`;
  await writeFile(join(cwd, ".ai", "brainstorms", filename), raw, "utf8");
}

// Fake pi.sendUserMessage: each test controls what "the agent turn" does via a queue of
// side-effect functions, invoked when waitForIdle() is awaited (mirrors the real
// triggerTurn -> waitForIdle blocking pattern, fully under test control, same approach
// used throughout this conversation's other extension tests).
function makeFakePi(cwd: string) {
  const calls: { prompt: string }[] = [];
  const pendingEffects: (() => Promise<void>)[] = [];
  const setModelCalls: unknown[] = [];
  return {
    pi: {
      sendUserMessage(prompt: string, _opts: unknown) {
        calls.push({ prompt });
      },
      registerCommand(_name: string, _def: unknown) {
        /* not used directly in these tests; we call the handler ourselves */
      },
      async setModel(spec: unknown) {
        setModelCalls.push(spec);
      },
    },
    calls,
    setModelCalls,
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
  const widgetHistory: string[][] = [];
  const editorTextHistory: string[] = [];
  const selectQueue: (string | undefined)[] = [];
  const inputQueue: (string | undefined)[] = [];
  const selectPrompts: string[] = [];
  return {
    ui: {
      async select(prompt: string, _options: unknown, _opts?: unknown) {
        selectPrompts.push(prompt);
        if (selectQueue.length === 0) throw new Error(`select() called with empty queue, prompt: ${prompt}`);
        return selectQueue.shift();
      },
      async input(_prompt: string) {
        if (inputQueue.length === 0) throw new Error("input() called with empty queue");
        return inputQueue.shift();
      },
      setEditorText(text: string) {
        editorTextHistory.push(text);
      },
      setWidget(lines: string[]) {
        widgetHistory.push(lines);
      },
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
    notifications,
    widgetHistory,
    editorTextHistory,
    selectQueue,
    inputQueue,
    selectPrompts,
  };
}

async function loadHandler(fakePi: { sendUserMessage: (prompt: string, opts: unknown) => void }) {
  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let captured: { handler: (args: string[], ctx: unknown) => Promise<void> } | undefined;
  const registerCommand = (_name: string, def: { handler: (args: string[], ctx: unknown) => Promise<void> }) => {
    captured = def;
  };
  // registerCommand is captured, but sendUserMessage must be the real fake so the handler's
  // closure over `pi` (from the default-export function param) actually reaches our queue.
  mod.default({ ...fakePi, registerCommand } as any);
  if (!captured) throw new Error("registerCommand was never called");
  return captured.handler;
}

await test("full happy path: open -> explore -> propose -> approve & execute -> code review -> archive", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-01-my-feature.md", {
    title: "My Feature",
    status: "open",
    created: "2026-01-01",
  });

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  // 1st select: pick the brainstorm
  fakeUiWrap.selectQueue.push("2026-01-01 · My Feature");
  // 2nd select (inside reviewAndMaybeExecute, after propose lands): Approve & Execute
  fakeUiWrap.selectQueue.push("Approve & Execute");
  // 3rd select: archive prompt (verification note is present, so the "send back" gate is skipped)
  fakeUiWrap.selectQueue.push("Archive now");

  const dir = join(cwd, "readyset", "changes", "my-feature");

  // Explore turn effect: writes EXPLORATION.md
  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "EXPLORATION.md"), "## Findings\n\nChecked docker-compose.yml, nothing relevant.\n", "utf8");
  });
  // Propose turn effect: writes valid artifacts
  fakePiWrap.queueEffect(async () => {
    await mkdir(join(dir, "specs", "my-cap"), { recursive: true });
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
    await writeFile(join(dir, "design.md"), "## Context\n\nx\n", "utf8");
    await writeFile(
      join(dir, "specs", "my-cap", "spec.md"),
      "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
      "utf8",
    );
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 do thing\n", "utf8");
  });
  // Apply turn effect: marks all tasks done, with a verification note
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 do thing\n  _Verified: ran the thing, it worked_\n", "utf8");
  });
  // Code-review turn effect: writes REVIEW.md
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nNo blockers found.\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler([], ctx);

  assert.equal(fakePiWrap.calls.length, 4);
  assert.match(fakePiWrap.calls[0].prompt, /Explore the ground truth for the Readyset change "my-feature"/);
  assert.match(fakePiWrap.calls[1].prompt, /Create a Readyset change named "my-feature"/);
  assert.match(fakePiWrap.calls[2].prompt, /Implement the Readyset change "my-feature"/);
  assert.match(fakePiWrap.calls[3].prompt, /Critically review the implementation of Readyset change "my-feature"/);

  // Brainstorm file should now say approved (markApproved happened before apply)
  const raw = await readFile(join(cwd, ".ai", "brainstorms", "2026-01-01-my-feature.md"), "utf8");
  assert.match(raw, /status: approved/);

  // Archive happened: change dir moved, main spec created
  const mainSpec = await readFile(join(cwd, "readyset", "specs", "my-cap", "spec.md"), "utf8");
  assert.match(mainSpec, /Foo/);

  assert.ok(fakeUiWrap.notifications.some((n) => /Implementation complete: 1\/1/.test(n.message)));
  assert.ok(fakeUiWrap.notifications.some((n) => /Archived to/.test(n.message)));

  // CONTEXT.md audit trail should have been left behind before the dir got archived-away --
  // read it from the archived location.
  const archived = await readFile(
    join(cwd, "readyset", "changes", "archive", "my-feature", "CONTEXT.md"),
    "utf8",
  ).catch(() => undefined);
  if (archived !== undefined) {
    assert.match(archived, /## Explore —/);
    assert.match(archived, /## Propose —/);
    assert.match(archived, /## Apply —/);
    assert.match(archived, /## Code review —/);
  }
});

await test("verification gate: missing _Verified notes sends back for another apply turn before code review", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-08-unverified.md", {
    title: "Unverified",
    status: "proposed",
    created: "2026-01-08",
    change_id: "unverified",
  });
  const dir = join(cwd, "readyset", "changes", "unverified");
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await writeFile(
    join(dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
    "utf8",
  );
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 a\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-08 · Unverified"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Send back for verification"); // missing _Verified: note triggers this gate
  fakeUiWrap.selectQueue.push("Archive now"); // after the loop re-enters, Approve & Execute again -> Archive now

  // 1st apply effect: checks the box but forgets the _Verified: note
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 a\n", "utf8");
  });
  // 2nd apply effect (after "Send back"): adds the note
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 a\n  _Verified: ran it, works_\n", "utf8");
  });
  // code-review effect
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nNo blockers found.\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler([], ctx);

  assert.ok(
    fakeUiWrap.selectPrompts.some((p) => /have no _Verified: note/.test(p)),
    "should have surfaced the missing-verification gate",
  );
  assert.equal(fakePiWrap.calls.length, 3); // apply, apply-again, code-review (no re-propose)
  assert.ok(fakeUiWrap.notifications.some((n) => /Archived to/.test(n.message)));
});

await test("propose fails to produce a valid change -> warns, does not enter review", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-02-broken.md", { title: "Broken", status: "open", created: "2026-01-02" });

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-02 · Broken");
  // explore turn effect does nothing (no EXPLORATION.md) -- should warn but still continue to propose
  fakePiWrap.queueEffect(async () => {});
  // propose turn effect also does nothing (no files written) -> reconcileStatuses will not bump to proposed
  fakePiWrap.queueEffect(async () => {});

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler([], ctx);

  assert.equal(fakePiWrap.calls.length, 2); // explore + propose fired, never apply
  assert.ok(fakeUiWrap.notifications.some((n) => /didn't produce EXPLORATION.md/.test(n.message) && n.level === "warning"));
  assert.ok(fakeUiWrap.notifications.some((n) => /doesn't look finished/.test(n.message) && n.level === "warning"));
  // only one select call total (the pick) -- review gate select never happened
  assert.equal(fakeUiWrap.selectPrompts.length, 1);
});

await test("already-proposed brainstorm: goes straight to review gate, refine loop works, then discard", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-03-thing.md", { title: "Thing", status: "proposed", created: "2026-01-03", change_id: "thing" });
  const dir = join(cwd, "readyset", "changes", "thing");
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  // invalid proposal initially -> validate should flag issues
  await writeFile(join(dir, "proposal.md"), "no sections\n", "utf8");
  await writeFile(join(dir, "specs", "cap", "spec.md"), "nothing here\n", "utf8");
  await writeFile(join(dir, "tasks.md"), "no boxes\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-01-03 · Thing"); // pick
  fakeUiWrap.selectQueue.push("Refine"); // first loop: refine
  fakeUiWrap.inputQueue.push("add the missing sections");
  fakeUiWrap.selectQueue.push("Discard"); // second loop: discard after refine

  fakePiWrap.queueEffect(async () => {
    // refine turn fixes the proposal
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
    await writeFile(
      join(dir, "specs", "cap", "spec.md"),
      "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
      "utf8",
    );
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler([], ctx);

  assert.equal(fakePiWrap.calls.length, 1);
  assert.match(fakePiWrap.calls[0].prompt, /Revise the Readyset change "thing"/);
  assert.match(fakePiWrap.calls[0].prompt, /add the missing sections/);
  // no propose call, since already proposed
  assert.ok(!fakePiWrap.calls.some((c) => /Create a Readyset change/.test(c.prompt)));

  // widget shown twice (once per loop iteration) and disagreement check: first pass had issues, second didn't
  assert.equal(fakeUiWrap.widgetHistory.length, 2);
  assert.match(fakeUiWrap.widgetHistory[0].join("\n"), /issue/);
  assert.match(fakeUiWrap.widgetHistory[1].join("\n"), /pass/);
});

await test("approve & execute pauses when tasks incomplete (agent stopped early)", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-04-partial.md", { title: "Partial", status: "proposed", created: "2026-01-04", change_id: "partial" });
  const dir = join(cwd, "readyset", "changes", "partial");
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await writeFile(
    join(dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
    "utf8",
  );
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 a\n- [ ] 1.2 b\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-04 · Partial");
  fakeUiWrap.selectQueue.push("Approve & Execute");

  fakePiWrap.queueEffect(async () => {
    // agent only completes one of two tasks, then "stops" (simulating a blocker)
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 a\n- [ ] 1.2 b\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler([], ctx);

  assert.ok(fakeUiWrap.notifications.some((n) => /Paused at 1\/2 tasks/.test(n.message) && n.level === "warning"));
  // no archive prompt should have been offered
  assert.equal(fakeUiWrap.selectPrompts.length, 2); // pick + review gate only
});

await test("--fast flag includes fast-lane brainstorms; default excludes them", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-05-quickfix.md", { title: "Quickfix", status: "open", created: "2026-01-05", lane: "fast" });

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler([], ctx); // no --fast
  assert.ok(fakeUiWrap.notifications.some((n) => /No full-lane brainstorms found/.test(n.message)));

  const fakeUiWrap2 = makeFakeUi();
  fakeUiWrap2.selectQueue.push(undefined); // cancel immediately, we just want to confirm it's listed
  const ctx2 = { cwd, ui: fakeUiWrap2.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler(["--fast"], ctx2);
  assert.equal(fakeUiWrap2.notifications.filter((n) => /No full-lane/.test(n.message)).length, 0);
});

await test("archived brainstorm short-circuits with a warning", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-06-done.md", { title: "Done", status: "archived", created: "2026-01-06", change_id: "done" });

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push(undefined); // --all needed to see archived; test the "no items" path without --all first
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler([], ctx);
  assert.ok(fakeUiWrap.notifications.some((n) => /No full-lane brainstorms found/.test(n.message)));

  const fakeUiWrap2 = makeFakeUi();
  fakeUiWrap2.selectQueue.push("2026-01-06 · Done");
  const ctx2 = { cwd, ui: fakeUiWrap2.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler(["--all"], ctx2);
  assert.ok(fakeUiWrap2.notifications.some((n) => /already archived/.test(n.message) && n.level === "warning"));
  assert.equal(fakePiWrap.calls.length, 0);
});

await test("fireTurnAndWait survives the observed race: waitForIdle would resolve before the turn actually starts", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-07-race.md", { title: "Race", status: "open", created: "2026-01-07" });

  const handler = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let captured: { handler: (args: string[], ctx: unknown) => Promise<void> } | undefined;

  // Simulate the real omp timing bug: right after sendUserMessage fires, the session still
  // reads as idle for a beat (turn hasn't started yet) before flipping to "running", and only
  // THEN does the artifact actually get written. A naive immediate waitForIdle() would resolve
  // instantly here and see nothing written yet -- exactly what happened live.
  let idle = true;
  let artifactWritten = false;
  const dir = join(cwd, "readyset", "changes", "race");

  const fakePi = {
    sendUserMessage(_prompt: string, _opts: unknown) {
      // Turn "starts" 150ms later (flips idle false), writes the artifact, then goes idle again.
      setTimeout(() => {
        idle = false;
      }, 150);
      setTimeout(async () => {
        await mkdir(join(dir, "specs", "cap"), { recursive: true });
        await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
        await writeFile(
          join(dir, "specs", "cap", "spec.md"),
          "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
          "utf8",
        );
        await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");
        idle = true;
      }, 300);
    },
    registerCommand(_name: string, def: { handler: (args: string[], ctx: unknown) => Promise<void> }) {
      captured = def;
    },
  };
  handler.default(fakePi as any);
  if (!captured) throw new Error("registerCommand was never called");

  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-07 · Race");
  fakeUiWrap.selectQueue.push("Discard"); // once review gate is reached, just bail

  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    isIdle: () => idle,
    hasPendingMessages: () => false,
    // A naive waitForIdle that resolves immediately if already idle right now (the buggy
    // real-world behavior) -- the polling in fireTurnAndWait must compensate for this, not
    // this mock, so this intentionally does NOT wait for the artifact.
    waitForIdle: async () => {
      while (!idle) await new Promise((r) => setTimeout(r, 20));
    },
  };

  await captured.handler([], ctx);

  assert.ok(!fakeUiWrap.notifications.some((n) => /doesn't look finished/.test(n.message)), "should not have raced past the turn");
  assert.ok(fakeUiWrap.selectPrompts.some((p) => p.includes("Review change")), "should have reached the review gate");
});

await test("turn budget: caps a runaway refine loop and stops firing new turns", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-09-loopy.md", {
    title: "Loopy",
    status: "proposed",
    created: "2026-01-09",
    change_id: "loopy",
  });
  const dir = join(cwd, "readyset", "changes", "loopy");
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  // deliberately invalid, so every refine pass still has "issues" and the user keeps refining
  await writeFile(join(dir, "proposal.md"), "no sections\n", "utf8");
  await writeFile(join(dir, "specs", "cap", "spec.md"), "nothing here\n", "utf8");
  await writeFile(join(dir, "tasks.md"), "no boxes\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  // Queue far more "Refine" picks than the default budget (10) allows, each with feedback and
  // a no-op effect (proposal never actually gets fixed) -- simulating a user who keeps hitting
  // Refine without the artifact ever becoming valid.
  fakeUiWrap.selectQueue.push("2026-01-09 · Loopy");
  for (let i = 0; i < 15; i++) {
    fakeUiWrap.selectQueue.push("Refine");
    fakeUiWrap.inputQueue.push(`feedback round ${i}`);
    fakePiWrap.queueEffect(async () => {}); // refine turn effect: does nothing, stays invalid
  }

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler([], ctx);

  // default budget is 10 -- should have stopped well before 15 refine turns fired
  assert.ok(fakePiWrap.calls.length <= 10, `expected at most 10 turns fired, got ${fakePiWrap.calls.length}`);
  assert.ok(
    fakeUiWrap.notifications.some((n) => /Turn budget/.test(n.message) && n.level === "warning"),
    "should have warned that the turn budget was reached",
  );
});

await test("--model pins a model for the run's turns and restores the original model afterward", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-10-pinned.md", {
    title: "Pinned",
    status: "proposed",
    created: "2026-01-10",
    change_id: "pinned",
  });
  const dir = join(cwd, "readyset", "changes", "pinned");
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await writeFile(
    join(dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
    "utf8",
  );
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-10 · Pinned"); // pick
  fakeUiWrap.selectQueue.push("Discard"); // reach the gate once pinned, then leave -- no apply needed for this test

  const currentModel = "session-default-model";
  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: fakePiWrap.waitForIdle,
    models: {
      current: () => currentModel,
      resolve: (spec: string) => `resolved:${spec}`,
    },
  };

  await handler(["--model", "anthropic/claude-opus-5"], ctx);

  assert.deepEqual(fakePiWrap.setModelCalls, ["resolved:anthropic/claude-opus-5", "session-default-model"]);
  assert.ok(fakeUiWrap.notifications.some((n) => /Pinned model "anthropic\/claude-opus-5"/.test(n.message)));
});

await test("without --model, setModel is never called even though the API is available", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-11-unpinned.md", {
    title: "Unpinned",
    status: "proposed",
    created: "2026-01-11",
    change_id: "unpinned",
  });
  const dir = join(cwd, "readyset", "changes", "unpinned");
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await writeFile(
    join(dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
    "utf8",
  );
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-11 · Unpinned");
  fakeUiWrap.selectQueue.push("Discard");
  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: fakePiWrap.waitForIdle,
    models: { current: () => "whatever", resolve: (s: string) => s },
  };
  await handler([], ctx); // no --model

  assert.equal(fakePiWrap.setModelCalls.length, 0);
});

await test("--fallback-model is used when the primary --model fails to pin", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-12-fallback.md", {
    title: "Fallback",
    status: "proposed",
    created: "2026-01-12",
    change_id: "fallback",
  });
  const dir = join(cwd, "readyset", "changes", "fallback");
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await writeFile(
    join(dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
    "utf8",
  );
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const setModelCalls: unknown[] = [];
  const pendingEffects: (() => Promise<void>)[] = [];
  const fakePi = {
    sendUserMessage(_prompt: string, _opts: unknown) {},
    registerCommand(_name: string, _def: unknown) {},
    async setModel(spec: unknown) {
      setModelCalls.push(spec);
      if (spec === "resolved:bad/primary-model") throw new Error("model not found: bad/primary-model");
    },
  };

  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let captured: { handler: (args: string[], ctx: unknown) => Promise<void> } | undefined;
  mod.default({ ...fakePi, registerCommand: (_n: string, def: { handler: (args: string[], ctx: unknown) => Promise<void> }) => (captured = def) } as any);
  if (!captured) throw new Error("registerCommand was never called");

  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-12 · Fallback"); // pick
  fakeUiWrap.selectQueue.push("Discard"); // reach the gate once pinned, then leave

  const currentModel = "session-default-model";
  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: async () => {
      const fn = pendingEffects.shift();
      if (fn) await fn();
    },
    models: {
      current: () => currentModel,
      resolve: (spec: string) => `resolved:${spec}`,
    },
  };

  await captured.handler(["--model", "bad/primary-model", "--fallback-model", "good/fallback-model"], ctx);

  assert.deepEqual(setModelCalls, ["resolved:bad/primary-model", "resolved:good/fallback-model", "session-default-model"]);
  assert.ok(fakeUiWrap.notifications.some((n) => /Couldn't pin model "bad\/primary-model"/.test(n.message) && n.level === "warning"));
  assert.ok(fakeUiWrap.notifications.some((n) => /Pinned model "good\/fallback-model"/.test(n.message)));
});

await test("both --model and --fallback-model fail to pin -> runs unpinned rather than aborting", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-13-doublefail.md", {
    title: "Doublefail",
    status: "proposed",
    created: "2026-01-13",
    change_id: "doublefail",
  });
  const dir = join(cwd, "readyset", "changes", "doublefail");
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await writeFile(
    join(dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
    "utf8",
  );
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const setModelCalls: unknown[] = [];
  const fakePi = {
    sendUserMessage(_prompt: string, _opts: unknown) {},
    registerCommand(_name: string, _def: unknown) {},
    async setModel(spec: unknown) {
      setModelCalls.push(spec);
      throw new Error(`model not found: ${spec}`);
    },
  };

  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let captured: { handler: (args: string[], ctx: unknown) => Promise<void> } | undefined;
  mod.default({ ...fakePi, registerCommand: (_n: string, def: { handler: (args: string[], ctx: unknown) => Promise<void> }) => (captured = def) } as any);
  if (!captured) throw new Error("registerCommand was never called");

  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-13 · Doublefail");
  fakeUiWrap.selectQueue.push("Discard");

  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: async () => {},
    models: { current: () => "session-default-model", resolve: (spec: string) => `resolved:${spec}` },
  };

  await captured.handler(["--model", "bad/primary", "--fallback-model", "also/bad"], ctx);

  assert.equal(setModelCalls.length, 2); // primary attempted, fallback attempted, no restore (nothing succeeded)
  assert.ok(fakeUiWrap.notifications.some((n) => /also failed to pin/.test(n.message) && n.level === "warning"));
  // the run still reached the review gate (Discard) rather than aborting
  assert.ok(fakeUiWrap.selectPrompts.some((p) => p.includes("Review change")));
});

await test("review gate pushes a full compiled document (all sections) to the editor pane", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-14-doc.md", {
    title: "Doc Review",
    status: "proposed",
    created: "2026-01-14",
    change_id: "doc-review",
  });
  const dir = join(cwd, "readyset", "changes", "doc-review");
  await mkdir(join(dir, "specs", "widgets"), { recursive: true });
  await writeFile(join(dir, "EXPLORATION.md"), "Checked docker-compose.yml, found REDIRECT_URI stale.", "utf8");
  await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await writeFile(join(dir, "design.md"), "## Context\n\ndesign notes here\n", "utf8");
  await writeFile(
    join(dir, "specs", "widgets", "spec.md"),
    "## Purpose\n\nx\n\n### Requirement: Spin\n\n#### Scenario: spins\n\n- **WHEN** a\n- **THEN** b\n",
    "utf8",
  );
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 do thing\n  _Verified: ran it_\n", "utf8");
  await writeFile(join(dir, "REVIEW.md"), "No blockers found.", "utf8");
  await writeFile(join(dir, "CONTEXT.md"), "## Explore — 2026-01-14T00:00:00Z\n\nfound the drift\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-14 · Doc Review");
  fakeUiWrap.selectQueue.push("Discard");

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler([], ctx);

  assert.equal(fakeUiWrap.editorTextHistory.length, 1);
  const doc = fakeUiWrap.editorTextHistory[0];
  // table of contents lists every section with a status
  for (const tocEntry of ["1. Exploration", "2. Proposal", "3. Design", "4. Specs (1)", "5. Tasks (1/1)", "6. Verification summary", "7. Code review", "8. Context log"]) {
    assert.ok(doc.includes(tocEntry), `expected table of contents to include "${tocEntry}"`);
  }
  // each section heading appears again as its own header, and the spec file path is shown
  for (const heading of ["EXPLORATION", "PROPOSAL", "DESIGN", "SPECS (1)", "specs/widgets/spec.md", "TASKS (1/1)", "VERIFICATION SUMMARY", "CODE REVIEW", "CONTEXT LOG"]) {
    assert.ok(doc.includes(heading), `expected document to include "${heading}"`);
  }
  assert.match(doc, /REDIRECT_URI stale/);
  assert.match(doc, /design notes here/);
  assert.match(doc, /Spin/);
  assert.match(doc, /No blockers found/);
  assert.match(doc, /found the drift/);
  assert.match(doc, /1\/1 checked tasks carry a _Verified: note/);
});

await test("Jump to section shows one section at a time, then restores the full document on Back", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-15-jump.md", {
    title: "Jump Test",
    status: "proposed",
    created: "2026-01-15",
    change_id: "jump-test",
  });
  const dir = join(cwd, "readyset", "changes", "jump-test");
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nsome unique proposal text here\n\n## What Changes\n\n- x\n", "utf8");
  await writeFile(
    join(dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
    "utf8",
  );
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-15 · Jump Test"); // pick
  fakeUiWrap.selectQueue.push("Jump to section"); // enter browse mode
  fakeUiWrap.selectQueue.push("2. Proposal"); // view just the Proposal section
  fakeUiWrap.selectQueue.push("◂ Back to full document"); // exit browse mode
  fakeUiWrap.selectQueue.push("Discard"); // leave the gate

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler([], ctx);

  // editor gets set: initial full doc, single-section view, full doc on Back, then the outer
  // loop's own redraw on its next iteration (it always re-renders regardless of how it looped)
  assert.equal(fakeUiWrap.editorTextHistory.length, 4);
  const singleSectionDoc = fakeUiWrap.editorTextHistory[1];
  assert.match(singleSectionDoc, /PROPOSAL/);
  assert.match(singleSectionDoc, /some unique proposal text here/);
  // single-section view should NOT include other sections' headers (it's isolated, not the full doc)
  assert.ok(!singleSectionDoc.includes("DESIGN"), "single-section view should not include unrelated section headers");

  const restoredDoc = fakeUiWrap.editorTextHistory[2];
  assert.match(restoredDoc, /Sections:/); // back to the full document with its table of contents
  assert.match(restoredDoc, /DESIGN/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
