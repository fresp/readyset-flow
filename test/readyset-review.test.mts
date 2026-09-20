import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

// This whole file exercises readyset-review.ts's handler, which reads omp config
// (language/model/fallback chain) via readPreferredLanguage()/readPinnedModel()/
// readFallbackChain() called with NO argument -- by design, that always resolves to the real
// ~/.omp/agent/config.yml (see readyset-omp-config.ts's OMP_CONFIG_PATH comment), never a scratch
// path. Point it at a path that's guaranteed not to exist instead, so every "no --lang/--model
// flag" test here gets the same clean "nothing configured" starting point regardless of what's
// actually sitting in the real config.yml on whatever machine runs this suite. Must be set before
// the first `import(".../readyset-review.ts?t=...")` below, since OMP_CONFIG_PATH is a top-level
// const evaluated at module load.
process.env.READYSET_TEST_CONFIG_PATH = join(tmpdir(), `readyset-test-omp-config-${Date.now()}-${Math.random()}`, "config.yml");

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

// A "not yet proposed" brainstorm that clears validateBrainstormContent's gate (readyset-brainstorm.ts)
// -- Decision/Seam/Scope/Acceptance Criteria all genuinely filled in, matching the brainstorm-ai
// skill's own template. Used by tests that are meant to sail straight through to Explore without
// the new content-check gate intervening; the gate itself gets its own dedicated tests below.
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
  const raw = `---\n${fm}\n---\n${body}`;
  await writeFile(join(cwd, ".ai", "brainstorms", filename), raw, "utf8");
}

// Fake pi.zod: `registerAskTool` (readyset-review.ts) builds its schema via a chain of
// pi.zod.object/.array/.string/.number/.boolean/.optional/.describe/.min/.max/.int calls at
// module-load time (export default calls it unconditionally), and nothing in these tests
// inspects the resulting schema shape -- only that registration itself doesn't throw. A
// self-referential Proxy absorbs any property access or call and returns itself, so the whole
// chain resolves to one object regardless of which zod methods get called or in what order.
function makeFakeZodNode(): any {
  const node: any = new Proxy(() => node, {
    get: () => node,
    apply: () => node,
  });
  return node;
}
const fakeZod = makeFakeZodNode();

// Fake pi.sendUserMessage: each test controls what "the agent turn" does via a queue of
// side-effect functions, invoked when waitForIdle() is awaited (mirrors the real fire-and-forget
// send -> waitForIdle() pattern, fully under test control, same approach used throughout this
// conversation's other extension tests). Note the handler calls it with NO options: omp's
// `sendUserMessage` accepts only `deliverAs: "steer" | "followUp" | "aside"`, and omitting it is
// what starts a turn when the session is idle.
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
      registerTool(_def: unknown) {
        /* readyset_ask registration -- not exercised directly by these tests */
      },
      zod: fakeZod,
      async setModel(spec: unknown) {
        setModelCalls.push(spec);
        // Real omp contract is `Promise<boolean>` -- true once applied, false when there's no
        // API key for the model. Returning a bare `undefined` here would make every test treat
        // a failed pin as a successful one, hiding exactly the bug this suite now pins down.
        return true;
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
  const widgetKeys: string[] = [];
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
      // Real omp signature is `setWidget(key: string, content: ExtensionWidgetContent, options?)`.
      // A fake that records the first argument as the lines array (as this one used to) cannot
      // tell the correct call apart from `setWidget(lines)`, which the host reads as key = the
      // array and content = undefined -- so the panel never rendered at all.
      setWidget(key: string, content: string[]) {
        widgetKeys.push(key);
        widgetHistory.push(content);
      },
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
    notifications,
    widgetHistory,
    widgetKeys,
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
  let captured: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  const registerCommand = (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
    captured = def;
  };
  // registerCommand is captured, but sendUserMessage must be the real fake so the handler's
  // closure over `pi` (from the default-export function param) actually reaches our queue.
  mod.default({ ...fakePi, registerCommand } as any);
  if (!captured) throw new Error("registerCommand was never called");
  return captured.handler;
}

// Loads a fresh module instance and captures the readyset_ask tool definition registerAskTool
// registers via pi.registerTool -- for tests that exercise the tool's execute() directly rather
// than going through the /readyset command handler.
async function loadAskTool(): Promise<{
  execute: (
    toolCallId: string,
    params: { questions: unknown[] },
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text: string }[] }>;
}> {
  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let captured: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
  const fakePi = {
    sendUserMessage(_prompt: string, _opts: unknown) {},
    registerCommand(_name: string, _def: unknown) {},
    registerTool(def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      if (def.name === "readyset_ask") captured = def;
    },
    zod: fakeZod,
  };
  mod.default(fakePi as any);
  if (!captured) throw new Error("readyset_ask was never registered");
  return captured as any;
}

// Loads ONE fresh module instance and captures BOTH the /readyset command handler and the
// readyset_ask tool from it, so grillRoundState (module-level) is genuinely shared between them
// -- needed to test the zero-rounds gate, which depends on readyset_ask's execute() and the
// command handler's content-check gate agreeing on the same in-memory state.
async function loadHandlerAndAskTool(fakePi: { sendUserMessage: (prompt: string, opts: unknown) => void }): Promise<{
  handler: (args: string, ctx: unknown) => Promise<void>;
  askExecute: (
    toolCallId: string,
    params: { questions: unknown[] },
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text: string }[] }>;
}> {
  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let capturedHandler: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  let capturedAsk: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
  mod.default({
    ...fakePi,
    registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      capturedHandler = def;
    },
    registerTool(def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      if (def.name === "readyset_ask") capturedAsk = def;
    },
    zod: fakeZod,
  } as any);
  if (!capturedHandler) throw new Error("registerCommand was never called");
  if (!capturedAsk) throw new Error("readyset_ask was never registered");
  return { handler: capturedHandler.handler, askExecute: capturedAsk.execute as any };
}

await test("full happy path: open -> explore -> propose -> approve & execute -> code review -> archive", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-01-my-feature.md", {
    title: "My Feature",
    status: "open",
    created: "2026-01-01",
  }, VALID_BRAINSTORM_BODY);

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
  await handler("", ctx);

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
  await handler("", ctx);

  assert.ok(
    fakeUiWrap.selectPrompts.some((p) => /have no _Verified: note/.test(p)),
    "should have surfaced the missing-verification gate",
  );
  assert.equal(fakePiWrap.calls.length, 3); // apply, apply-again, code-review (no re-propose)
  assert.ok(fakeUiWrap.notifications.some((n) => /Archived to/.test(n.message)));
});

await test("propose fails to produce a valid change -> warns, does not enter review", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-02-broken.md", { title: "Broken", status: "open", created: "2026-01-02" }, VALID_BRAINSTORM_BODY);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-02 · Broken");
  // explore turn effect does nothing (no EXPLORATION.md) -- should warn but still continue to propose
  fakePiWrap.queueEffect(async () => {});
  // propose turn effect also does nothing (no files written) -> reconcileStatuses will not bump to proposed
  fakePiWrap.queueEffect(async () => {});

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

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
      "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** b\n",
      "utf8",
    );
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(fakePiWrap.calls.length, 1);
  assert.match(fakePiWrap.calls[0].prompt, /Revise the Readyset change "thing"/);
  assert.match(fakePiWrap.calls[0].prompt, /add the missing sections/);
  // no propose call, since already proposed
  assert.ok(!fakePiWrap.calls.some((c) => /Create a Readyset change/.test(c.prompt)));

  // widget shown twice (once per loop iteration) and disagreement check: first pass had issues, second didn't
  assert.equal(fakeUiWrap.widgetHistory.length, 2);
  assert.deepEqual(fakeUiWrap.widgetKeys, ["readyset", "readyset"], "the first argument must be the string key, not the lines array");
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
  await handler("", ctx);

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
  await handler("", ctx); // no --fast
  assert.ok(fakeUiWrap.notifications.some((n) => /No full-lane brainstorms found/.test(n.message)));

  const fakeUiWrap2 = makeFakeUi();
  fakeUiWrap2.selectQueue.push(undefined); // cancel immediately, we just want to confirm it's listed
  const ctx2 = { cwd, ui: fakeUiWrap2.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--fast", ctx2);
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
  await handler("", ctx);
  assert.ok(fakeUiWrap.notifications.some((n) => /No full-lane brainstorms found/.test(n.message)));

  const fakeUiWrap2 = makeFakeUi();
  fakeUiWrap2.selectQueue.push("2026-01-06 · Done");
  const ctx2 = { cwd, ui: fakeUiWrap2.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--all", ctx2);
  assert.ok(fakeUiWrap2.notifications.some((n) => /already archived/.test(n.message) && n.level === "warning"));
  assert.equal(fakePiWrap.calls.length, 0);
});

await test("fireTurnAndWait survives the observed race: waitForIdle would resolve before the turn actually starts", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-07-race.md", { title: "Race", status: "open", created: "2026-01-07" }, VALID_BRAINSTORM_BODY);

  const handler = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let captured: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;

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
    registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      captured = def;
    },
    registerTool(_def: unknown) {},
    zod: fakeZod,
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

  await captured.handler("", ctx);

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
  await handler("", ctx);

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

  await handler("--model anthropic/claude-opus-5", ctx);

  assert.deepEqual(fakePiWrap.setModelCalls, ["resolved:anthropic/claude-opus-5", "session-default-model"]);
  assert.ok(fakeUiWrap.notifications.some((n) => /Pinned model "anthropic\/claude-opus-5"/.test(n.message)));
});

await test("setModel is called bound to pi, not detached -- a real terminal run hit 'this.runtime' undefined from a bare extracted reference", async () => {
  // The other model-pinning tests' fake `setModel` is a plain shorthand method that ignores
  // `this` entirely, so it would pass whether or not withPinnedModel keeps setModel bound to
  // `pi` -- it can't catch a `this`-binding regression. This one can: `this.runtime` is only
  // reachable when setModel is actually invoked as `pi.setModel(...)` (or an equivalent bound
  // call), which is exactly what broke in a real omp session (2026-09-18): `const setModel =
  // pi.setModel` followed by a bare `setModel(spec)` call loses `this`, and the real
  // implementation apparently reads state off it, producing "undefined is not an object
  // (evaluating 'this.runtime')" on every pin attempt -- primary, fallback, and restore alike.
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-11-pinned-this.md", {
    title: "Pinned This",
    status: "proposed",
    created: "2026-01-11",
    change_id: "pinned-this",
  });
  const dir = join(cwd, "readyset", "changes", "pinned-this");
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
    runtime: "ok", // present only on `pi` itself -- reachable only through a correctly-bound `this`
    sendUserMessage(_prompt: string, _opts: unknown) {},
    registerCommand(_name: string, _def: unknown) {},
    setModel(spec: unknown) {
      // Mirrors the real failure mode: a detached call has `this` as undefined (strict mode,
      // ES modules), so `this.runtime` throws before ever recording the call.
      if (!(this as { runtime?: string }).runtime) {
        throw new TypeError("undefined is not an object (evaluating 'this.runtime')");
      }
      setModelCalls.push(spec);
    },
    registerTool(_def: unknown) {},
    zod: fakeZod,
  };
  const handler = await loadHandler(fakePi as any);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-11 · Pinned This");
  fakeUiWrap.selectQueue.push("Discard");

  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: async () => {},
    models: {
      current: () => "session-default-model",
      resolve: (spec: string) => `resolved:${spec}`,
    },
  };

  await handler("--model some/model", ctx);

  assert.deepEqual(
    setModelCalls,
    ["resolved:some/model", "session-default-model"],
    "setModel should have been called (bound to pi) for both the pin and the restore",
  );
  assert.ok(
    fakeUiWrap.notifications.some((n) => /Pinned model "some\/model"/.test(n.message)),
    "should have reported a successful pin, not a 'this.runtime' failure",
  );
  assert.ok(
    !fakeUiWrap.notifications.some((n) => /this\.runtime/.test(n.message)),
    "a detached setModel call would have surfaced the this.runtime TypeError as a warning -- it must not",
  );
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
  await handler("", ctx); // no --model

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
    registerTool(_def: unknown) {},
    zod: fakeZod,
  };

  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let captured: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  mod.default({ ...fakePi, registerCommand: (_n: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => (captured = def) } as any);
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

  await captured.handler("--model bad/primary-model --fallback-model good/fallback-model", ctx);

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
    registerTool(_def: unknown) {},
    zod: fakeZod,
  };

  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let captured: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  mod.default({ ...fakePi, registerCommand: (_n: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => (captured = def) } as any);
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

  await captured.handler("--model bad/primary --fallback-model also/bad", ctx);

  assert.equal(setModelCalls.length, 2); // primary attempted, fallback attempted, no restore (nothing succeeded)
  assert.ok(fakeUiWrap.notifications.some((n) => /Every fallback in the chain.*failed to pin/.test(n.message) && n.level === "warning"));
  // the run still reached the review gate (Discard) rather than aborting
  assert.ok(fakeUiWrap.selectPrompts.some((p) => p.includes("Review change")));
});

await test("fallbackChains array: tries every entry in order until one pins, not just the first", async () => {
  const { withPinnedModel } = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    withPinnedModel: <T>(
      pi: unknown,
      ctx: unknown,
      modelSpec: string | undefined,
      source: string,
      fallbackChain: string[],
      fallbackSource: string,
      fn: () => Promise<T>,
    ) => Promise<T>;
  };

  const setModelCalls: unknown[] = [];
  const fakePi = {
    async setModel(spec: unknown) {
      setModelCalls.push(spec);
      if (spec !== "resolved:third/good-model") throw new Error(`model not found: ${spec}`);
    },
  };
  const fakeUiWrap = makeFakeUi();
  const ctx = {
    ui: fakeUiWrap.ui,
    models: { current: () => "session-default-model", resolve: (spec: string) => `resolved:${spec}` },
  };

  let ran = false;
  await withPinnedModel(
    fakePi,
    ctx,
    "bad/primary-model",
    "--model flag",
    ["also/bad", "still/bad", "third/good-model"],
    "readyset.model.fallbackChains in ~/.omp/agent/config.yml",
    async () => {
      ran = true;
    },
  );

  assert.ok(ran, "fn should have run once a chain entry pinned");
  assert.deepEqual(setModelCalls, [
    "resolved:bad/primary-model",
    "resolved:also/bad",
    "resolved:still/bad",
    "resolved:third/good-model",
    "session-default-model", // restore
  ]);
  assert.ok(fakeUiWrap.notifications.some((n) => /Pinned model "third\/good-model"/.test(n.message)));
  assert.ok(fakeUiWrap.notifications.some((n) => /Trying fallback "also\/bad"/.test(n.message)));
  assert.ok(fakeUiWrap.notifications.some((n) => /Trying next fallback "still\/bad"/.test(n.message)));
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
  await handler("", ctx);

  assert.equal(fakeUiWrap.editorTextHistory.length, 1);
  const doc = fakeUiWrap.editorTextHistory[0];
  // table of contents lists every section with a status
  for (const tocEntry of ["1. Exploration", "2. Proposal", "3. Design", "4. Specs (1)", "5. Tasks (1/1)", "6. Verification summary", "7. Runtime evidence", "8. Code review", "9. Context log"]) {
    assert.ok(doc.includes(tocEntry), `expected table of contents to include "${tocEntry}"`);
  }
  // each section heading appears again as its own header, and the spec file path is shown
  for (const heading of ["EXPLORATION", "PROPOSAL", "DESIGN", "SPECS (1)", "specs/widgets/spec.md", "TASKS (1/1)", "VERIFICATION SUMMARY", "RUNTIME EVIDENCE", "CODE REVIEW", "CONTEXT LOG"]) {
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
  await handler("", ctx);

  // editor gets set: initial full doc, single-section view, full doc on Back -- "Jump to
  // section" now loops entirely inside classicGateSelect's own select() loop (no more separate
  // "Sidebar view" branch in the outer gate loop to bounce back through), so there's no extra
  // redundant redraw of the same full document once the gate re-asks after Back.
  assert.equal(fakeUiWrap.editorTextHistory.length, 3);
  const singleSectionDoc = fakeUiWrap.editorTextHistory[1];
  assert.match(singleSectionDoc, /PROPOSAL/);
  assert.match(singleSectionDoc, /some unique proposal text here/);
  // single-section view should NOT include other sections' headers (it's isolated, not the full doc)
  assert.ok(!singleSectionDoc.includes("DESIGN"), "single-section view should not include unrelated section headers");

  const restoredDoc = fakeUiWrap.editorTextHistory[2];
  assert.match(restoredDoc, /Sections:/); // back to the full document with its table of contents
  assert.match(restoredDoc, /DESIGN/);
});

await test("Sidebar overlay opens automatically as the review gate when ctx.ui.custom exists -- no menu step first, CTAs live in the overlay", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-16-sidebar.md", {
    title: "Sidebar Test",
    status: "proposed",
    created: "2026-01-16",
    change_id: "sidebar-test",
  });
  const dir = join(cwd, "readyset", "changes", "sidebar-test");
  await mkdir(dir, { recursive: true });
  await writeFile(dir + "/proposal.md", "## Why\n\nsidebar test proposal\n", "utf8");
  await writeFile(dir + "/tasks.md", "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  const customCalls: unknown[] = [];
  const ui = {
    ...fakeUiWrap.ui,
    async custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (r: unknown) => void) => unknown, options: unknown) {
      customCalls.push(options);
      // Exercise the factory the way real Interactive mode would: build the overlay, confirm it
      // renders without throwing (including its Approve/Approve & Compact/Refine/Discard CTA
      // bar), then close it as if the user pressed Esc -- our keybindings stub always says no,
      // so nothing calls done() and it just resolves undefined (== cancel, same as an explicit
      // Discard).
      let resolved: unknown;
      const overlay = factory(
        {},
        { fg: (_n: string, t: string) => t, bold: (t: string) => t },
        { matches: () => false },
        (r: unknown) => (resolved = r),
      ) as { render: (w: number) => string[]; handleInput?: (d: string) => void };
      const rendered = overlay.render(100);
      assert.ok(Array.isArray(rendered) && rendered.length > 0, "overlay factory should produce a real Component with render()");
      assert.ok(rendered.some(l => l.includes("Proposal")), "overlay should include the Proposal section heading");
      assert.ok(
        rendered.some(l => l.includes("Approve & Execute") && l.includes("Keep context") && l.includes("Refine") && l.includes("Discard")),
        "overlay should render its own Approve/Keep context/Refine/Discard CTA bar",
      );
      overlay.handleInput?.("\x1b");
      return resolved;
    },
  };

  fakeUiWrap.selectQueue.push("2026-01-16 · Sidebar Test"); // pick -- the only select() call this whole run makes

  const ctx = { cwd, ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(customCalls.length, 1, "ctx.ui.custom should be called exactly once, automatically -- no 'Sidebar view' menu pick needed first");
  assert.equal((customCalls[0] as { overlay?: boolean }).overlay, true);
  assert.equal(fakeUiWrap.selectPrompts.length, 1, "the review gate should never call ctx.ui.select() at all when the sidebar overlay is available");
  assert.equal(fakeUiWrap.selectQueue.length, 0, "nothing left unconsumed in the queue -- the run ended on the overlay's own cancel, not a follow-up Discard pick");
});

await test("RPC host: ui.custom exists but is a stub -- the review gate falls back to the select menu instead of silently discarding", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-17-rpc-gate.md", {
    title: "RPC Gate",
    status: "proposed",
    created: "2026-01-17",
    change_id: "rpc-gate",
  });
  const dir = join(cwd, "readyset", "changes", "rpc-gate");
  await mkdir(dir, { recursive: true });
  await writeFile(dir + "/proposal.md", "## Why\n\nrpc gate proposal\n", "utf8");
  await writeFile(dir + "/tasks.md", "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  let customCalls = 0;
  // Exactly what omp's RPC host does (rpc-mode.ts: "Custom UI not supported in RPC mode").
  const ui = { ...fakeUiWrap.ui, async custom() { customCalls++; return undefined; } };

  fakeUiWrap.selectQueue.push("2026-01-17 · RPC Gate"); // picker
  fakeUiWrap.selectQueue.push("Discard"); // the classic gate menu must be what's shown

  const ctx = { cwd, mode: "rpc", ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(customCalls, 0, "ui.custom must not be used outside the TUI");
  assert.equal(fakeUiWrap.selectPrompts.length, 2, "picker + the classic review gate menu");
  assert.match(fakeUiWrap.selectPrompts[1], /^Review change "rpc-gate"/);
  assert.equal(fakeUiWrap.selectQueue.length, 0);
});

await test("--idea skips the picker entirely and fires a grill turn as the first message (not fire-and-wait)", async () => {
  const cwd = await freshRepo();

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  // No selectQueue/inputQueue pushed at all: if the handler tried to show the picker or ask
  // for input, select()/input() would throw on an empty queue and fail the test.

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--idea Add a dark mode toggle to settings", ctx);

  assert.equal(fakePiWrap.calls.length, 1);
  assert.match(fakePiWrap.calls[0].prompt, /Grill this raw idea into a decided Readyset brainstorm file/);
  assert.match(fakePiWrap.calls[0].prompt, /Add a dark mode toggle to settings/);
  assert.ok(fakeUiWrap.notifications.some((n) => /Grilling started for/.test(n.message)));
  // mattpocock/skills' own "finding facts is your job, never the user's" rule, extended with
  // this session's baseline web search tool -- added after a real grilling run left a checkable
  // external fact (a WhatsApp Business Platform tier requirement) as an open question instead of
  // looking it up. See src/skill/mattpocock-grilling.md for the vendored source rule.
  assert.match(fakePiWrap.calls[0].prompt, /[Ff]inding facts is your job, never the user's/);
  assert.match(fakePiWrap.calls[0].prompt, /web search tool/);
});

await test("--lang before --idea opens grilling's discussion in that language from round 1", async () => {
  const cwd = await freshRepo();

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lang Indonesian --idea Add a dark mode toggle", ctx);

  assert.equal(fakePiWrap.calls.length, 1);
  assert.match(fakePiWrap.calls[0].prompt, /Preferred language for this discussion: Indonesian/);
  assert.match(fakePiWrap.calls[0].prompt, /Add a dark mode toggle/);
  // --lang's own value must not leak into the idea text (it's parsed out before --idea's join).
  assert.doesNotMatch(fakePiWrap.calls[0].prompt, /Raw idea from the user: "--lang/);
  assert.ok(fakeUiWrap.notifications.some((n) => /Grilling started for.*in Indonesian/.test(n.message)));
  // readyset_ask's `header` (the tab chip label) stays in English even with --lang set -- a
  // picker with some tabs translated and some not read as more jarring than none of them
  // translated (real feedback: mixed "Framing" / "Sumber kebenaran" tabs in the same round).
  assert.match(fakePiWrap.calls[0].prompt, /Keep each `readyset_ask` question's `header`.*in English/);
});

await test("no --lang flag: grillTurnPrompt keeps its reactive default (no 'Preferred language' line)", async () => {
  const cwd = await freshRepo();

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--idea Add a dark mode toggle", ctx);

  assert.doesNotMatch(fakePiWrap.calls[0].prompt, /Preferred language for this discussion/);
  assert.match(fakePiWrap.calls[0].prompt, /Reply in whatever language the user is using/);
});

await test("no --idea flag, brainstorms exist: 'Type a new idea' is offered, prompts for the idea, then grills it", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-01-my-feature.md", { title: "My Feature", status: "open", created: "2026-01-01" });

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("✎ Type a new idea (grill it here)");
  fakeUiWrap.inputQueue.push("Let users export their data as CSV");

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(fakePiWrap.calls.length, 1);
  assert.match(fakePiWrap.calls[0].prompt, /Let users export their data as CSV/);
});

await test("'Type a new idea' selected but input cancelled -> notifies, does not fire a turn", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-01-my-feature.md", { title: "My Feature", status: "open", created: "2026-01-01" });

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("✎ Type a new idea (grill it here)");
  fakeUiWrap.inputQueue.push(undefined);

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(fakePiWrap.calls.length, 0);
  assert.ok(fakeUiWrap.notifications.some((n) => /No idea given/.test(n.message)));
});

await test("'No full-lane brainstorms found' warning still fires with no brainstorms and no --idea (existing behavior preserved)", async () => {
  const cwd = await freshRepo();

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  // No selectQueue pushed: the handler must return via the warning path, not reach select().

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(fakeUiWrap.notifications.some((n) => /No full-lane brainstorms found/.test(n.message) && /--idea/.test(n.message)));
  assert.equal(fakePiWrap.calls.length, 0);
});

await test("content-check gate: an unresolved brainstorm (empty body) blocks Explore until the user picks 'Continue anyway'", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-17-vague.md", { title: "Vague", status: "open", created: "2026-01-17" }); // no body at all

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-17 · Vague"); // pick
  fakeUiWrap.selectQueue.push("Continue anyway"); // content-check gate

  fakePiWrap.queueEffect(async () => {}); // Explore turn: does nothing, fine for this test
  fakePiWrap.queueEffect(async () => {}); // Propose turn: does nothing either -- we only care that it fired

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(
    fakeUiWrap.selectPrompts.some((p) => /section\(s\) look unresolved \(structural check\)/.test(p)),
    "content-check gate should have fired",
  );
  assert.ok(fakePiWrap.calls.length >= 1, "Explore should still have fired after 'Continue anyway'");
});

await test("content-check gate: 'Go back' stops before Explore fires at all", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-18-vague2.md", { title: "Vague2", status: "open", created: "2026-01-18" });

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-18 · Vague2"); // pick
  fakeUiWrap.selectQueue.push("Go back"); // content-check gate

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(fakePiWrap.calls.length, 0, "Explore must not fire once the user picks 'Go back'");
  assert.ok(fakeUiWrap.notifications.some((n) => /Stopped before Explore/.test(n.message)));
});

await test("content-check gate: a fully-filled-in brainstorm never triggers the gate", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(
    cwd,
    "2026-01-19-solid.md",
    { title: "Solid", status: "open", created: "2026-01-19" },
    VALID_BRAINSTORM_BODY,
  );

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-19 · Solid"); // pick only -- no gate select should be needed

  fakePiWrap.queueEffect(async () => {});
  fakePiWrap.queueEffect(async () => {});

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(
    !fakeUiWrap.selectPrompts.some((p) => /section\(s\) look unresolved \(structural check\)/.test(p)),
    "content-check gate should not have fired for a fully-filled-in brainstorm",
  );
  assert.ok(fakePiWrap.calls.length >= 1, "Explore should have fired directly");
});

await test("zero-rounds gate: grilling started this session but readyset_ask never fired -> warns before Explore", async () => {
  const cwd = await freshRepo();
  const fakePiWrap = makeFakePi(cwd);
  const { handler } = await loadHandlerAndAskTool(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };

  // Start grilling (sets grillRoundState.active = true, rounds = 0) -- but never call
  // readyset_ask, simulating a model that skipped asking and just wrote the file itself.
  await handler("--idea Some risky feature", ctx);
  assert.equal(fakePiWrap.calls.length, 1, "grilling should have fired its opening message");

  // Simulate the model writing a perfectly well-formed brainstorm anyway (content-check alone
  // would NOT catch this -- the zero-rounds signal is the only thing that can).
  await writeBrainstorm(cwd, "2026-01-20-risky.md", { title: "Risky", status: "open", created: "2026-01-20" }, VALID_BRAINSTORM_BODY);

  fakeUiWrap.selectQueue.push("2026-01-20 · Risky"); // pick it up
  fakeUiWrap.selectQueue.push("Go back"); // decline to proceed
  await handler("", ctx);

  assert.ok(
    fakeUiWrap.selectPrompts.some((p) => /readyset_ask was never called/.test(p)),
    "expected the zero-rounds warning to appear in the gate prompt",
  );
  assert.ok(fakeUiWrap.notifications.some((n) => /Stopped before Explore/.test(n.message)));
});

await test("zero-rounds gate: does not fire once readyset_ask has actually been called this grilling session", async () => {
  const cwd = await freshRepo();
  const fakePiWrap = makeFakePi(cwd);
  const { handler, askExecute } = await loadHandlerAndAskTool(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };

  await handler("--idea Some risky feature", ctx);

  // The model actually asked at least one real round this time.
  await askExecute("call1", { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }] }] }, undefined, undefined, {
    ui: {}, // no askDialog -- falls back to plain text, but still counts as a round asked
  });

  await writeBrainstorm(cwd, "2026-01-21-asked.md", { title: "Asked", status: "open", created: "2026-01-21" }, VALID_BRAINSTORM_BODY);

  fakeUiWrap.selectQueue.push("2026-01-21 · Asked"); // pick it up -- no gate select should be needed

  fakePiWrap.queueEffect(async () => {});
  fakePiWrap.queueEffect(async () => {});

  await handler("", ctx);

  assert.ok(
    !fakeUiWrap.selectPrompts.some((p) => /readyset_ask was never called/.test(p)),
    "the zero-rounds warning should not fire once a real round was asked",
  );
  assert.ok(fakePiWrap.calls.length >= 2, "Explore should have fired directly (1 grilling call + at least 1 Explore call)");
});

await test("readyset_ask: presents askDialog and returns the user's picks back to the model", async () => {
  const tool = await loadAskTool();
  const askDialogCalls: unknown[] = [];
  const ctx = {
    ui: {
      askDialog: async (questions: unknown) => {
        askDialogCalls.push(questions);
        return {
          kind: "submit",
          results: [{ id: "q1", question: "Which approach?", options: ["A", "B"], multi: false, selectedOptions: ["B"] }],
        };
      },
    },
  };

  const result = await tool.execute(
    "call1",
    { questions: [{ id: "q1", question: "Which approach?", options: [{ label: "A" }, { label: "B" }], recommendedIndex: 0 }] },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(askDialogCalls.length, 1);
  assert.match(result.content[0]?.text ?? "", /Which approach\? -> B/);
});

await test("readyset_ask: a custom typed answer is reported back verbatim", async () => {
  const tool = await loadAskTool();
  const ctx = {
    ui: {
      askDialog: async () => ({
        kind: "submit",
        results: [{ id: "q1", question: "Name it?", options: ["X"], multi: false, selectedOptions: [], customInput: "my own answer" }],
      }),
    },
  };

  const result = await tool.execute("call1", { questions: [{ id: "q1", question: "Name it?", options: [{ label: "X" }] }] }, undefined, undefined, ctx);
  assert.match(result.content[0]?.text ?? "", /their own answer: "my own answer"/);
});

await test("readyset_ask: kind 'chat' tells the model to continue the round in plain chat", async () => {
  const tool = await loadAskTool();
  const ctx = { ui: { askDialog: async () => ({ kind: "chat" }) } };

  const result = await tool.execute("call1", { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }] }] }, undefined, undefined, ctx);
  assert.match(result.content[0]?.text ?? "", /chose to discuss this round in plain chat/);
});

await test("readyset_ask: dialog cancelled (undefined result) -> tells the model to ask the user directly", async () => {
  const tool = await loadAskTool();
  const ctx = { ui: { askDialog: async () => undefined } };

  const result = await tool.execute("call1", { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }] }] }, undefined, undefined, ctx);
  assert.match(result.content[0]?.text ?? "", /closed the picker without answering/);
});

await test("readyset_ask: askDialog unavailable (non-interactive mode) -> falls back to plain-chat instruction", async () => {
  const tool = await loadAskTool();
  const ctx = { ui: {} }; // no askDialog on this ctx shape -- RPC/print/ACP modes

  const result = await tool.execute("call1", { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }] }] }, undefined, undefined, ctx);
  assert.match(result.content[0]?.text ?? "", /structured picker isn't available/);
});

await test("readyset_ask: round cap is enforced in code -- stops opening the dialog once hit", async () => {
  const tool = await loadAskTool();
  let askDialogCallCount = 0;
  const ctx = {
    ui: {
      askDialog: async () => {
        askDialogCallCount++;
        return { kind: "submit", results: [] };
      },
    },
  };
  const oneQuestion = { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }] }] };

  let cappedText: string | undefined;
  for (let i = 0; i < 20 && !cappedText; i++) {
    const result = await tool.execute("call", oneQuestion, undefined, undefined, ctx);
    const text = result.content[0]?.text ?? "";
    if (/Round cap/.test(text)) cappedText = text;
  }

  assert.ok(cappedText, "expected the round cap to trip within 20 calls");
  assert.match(cappedText!, /check in with the user in plain chat text/i);
  const callsAtCap = askDialogCallCount;
  // one more call past the cap must not open the dialog again
  await tool.execute("call", oneQuestion, undefined, undefined, ctx);
  assert.equal(askDialogCallCount, callsAtCap, "askDialog should not be called again once the cap is hit");
});

await test("Approve & Execute compacts first: ctx.compact() with internalGuidance + suppressContinuation before Apply", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-20-compact.md", {
    title: "Compact Test",
    status: "proposed",
    created: "2026-01-20",
    change_id: "compact-test",
  });
  const dir = join(cwd, "readyset", "changes", "compact-test");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\ncompact test\n", "utf8");
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-01-20 · Compact Test"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet"); // skip the archive prompt

  // Apply turn effect
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
  });
  // Code-review turn effect
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const compactCalls: unknown[] = [];
  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: fakePiWrap.waitForIdle,
    async compact(opts: unknown) {
      compactCalls.push(opts);
    },
  };
  await handler("", ctx);

  assert.equal(compactCalls.length, 1, "ctx.compact should be called exactly once");
  const opts = compactCalls[0] as { internalGuidance?: string; suppressContinuation?: boolean };
  assert.match(opts.internalGuidance ?? "", /compact-test/, "internalGuidance should name the change id");
  assert.match(opts.internalGuidance ?? "", /readyset\/changes\/compact-test/, "internalGuidance should point at the persisted artifacts");
  assert.equal(opts.suppressContinuation, true, "the caller dispatches Apply itself right after, so continuation must be suppressed");

  // Same destination as Approve & Execute once compaction is done: Apply, then Code review.
  assert.equal(fakePiWrap.calls.length, 2);
  assert.match(fakePiWrap.calls[0].prompt, /Implement the Readyset change "compact-test"/);
  assert.match(fakePiWrap.calls[1].prompt, /Critically review the implementation of Readyset change "compact-test"/);
});

await test("Approve & Execute, keep context skips compact but still runs Apply and Code review", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-21-keepctx.md", {
    title: "Keep Context Test",
    status: "proposed",
    created: "2026-01-21",
    change_id: "keep-context-test",
  });
  const dir = join(cwd, "readyset", "changes", "keep-context-test");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nkeep context test\n", "utf8");
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-01-21 · Keep Context Test"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  fakeUiWrap.selectQueue.push("Not yet"); // skip the archive prompt

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  // With a compact-capable ctx, "keep context" must NOT call it — but Apply/Code review fire.
  const compactCalls: unknown[] = [];
  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: fakePiWrap.waitForIdle,
    async compact(opts: unknown) {
      compactCalls.push(opts);
    },
  };
  await handler("", ctx);

  assert.equal(compactCalls.length, 0, "keep-context must not compact");
  assert.equal(fakePiWrap.calls.length, 2, "Apply and Code review should still fire");
  assert.match(fakePiWrap.calls[0].prompt, /Implement the Readyset change "keep-context-test"/);
});

await test("Approve & Execute degrades to plain execution when ctx.compact isn't available", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-22-nocompact.md", {
    title: "No Compact Test",
    status: "proposed",
    created: "2026-01-22",
    change_id: "no-compact-test",
  });
  const dir = join(cwd, "readyset", "changes", "no-compact-test");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nno compact test\n", "utf8");
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-01-22 · No Compact Test"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet"); // skip the archive prompt

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  // No `compact` on this ctx at all -- an older omp build, or one that never exposed it.
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(
    fakeUiWrap.notifications.some((n) => /Compact isn't available in this context/.test(n.message)),
    "should warn that it's proceeding without compacting",
  );
  assert.equal(fakePiWrap.calls.length, 2, "Apply and Code review should still fire");
  assert.match(fakePiWrap.calls[0].prompt, /Implement the Readyset change "no-compact-test"/);
});

await test("setModel returning false (no API key) counts as a failed pin and moves on to the fallback", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-22-nokey.md", {
    title: "No Key",
    status: "proposed",
    created: "2026-01-22",
    change_id: "no-key",
  });
  const dir = join(cwd, "readyset", "changes", "no-key");
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
    // Real omp: `runExtensionSetModel` resolves the API key first and returns false -- without
    // throwing -- when there isn't one. This is the shape that used to be read as success.
    async setModel(spec: unknown) {
      setModelCalls.push(spec);
      return !String(spec).includes("no-key-model");
    },
    registerTool(_def: unknown) {},
    zod: fakeZod,
  };

  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let captured: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  mod.default({ ...fakePi, registerCommand: (_n: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => (captured = def) } as any);
  if (!captured) throw new Error("registerCommand was never called");

  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-22 · No Key"); // pick
  fakeUiWrap.selectQueue.push("Discard"); // leave as soon as we reach the gate

  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: async () => {},
    models: { current: () => "session-default-model", resolve: (spec: string) => `resolved:${spec}` },
  };

  await captured.handler("--model no-key-model --fallback-model usable-model", ctx);

  assert.deepEqual(
    setModelCalls,
    ["resolved:no-key-model", "resolved:usable-model", "session-default-model"],
    "a false return must be treated as a failed pin, so the fallback is tried (and the original restored)",
  );
  assert.ok(
    fakeUiWrap.notifications.some((n) => /Couldn't pin model "no-key-model"/.test(n.message) && n.level === "warning"),
    "the false return should be reported as a failure, not silently swallowed",
  );
  assert.ok(fakeUiWrap.notifications.some((n) => /Pinned model "usable-model"/.test(n.message)), "the fallback should actually be pinned");
  assert.ok(
    !fakeUiWrap.notifications.some((n) => /Pinned model "no-key-model"/.test(n.message)),
    "must not claim the failed model was pinned",
  );
});

await test("a raw idea arrives as one string (omp's real command contract) and starts grilling instead of throwing", async () => {
  const cwd = await freshRepo();
  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };

  // Before this was fixed, `args` was treated as a pre-split array, so this exact call threw
  // "(args ?? []).slice(...).join is not a function" and grilling never started.
  await handler("--idea let users export their data as CSV", ctx);

  assert.equal(fakePiWrap.calls.length, 1, "grilling should fire its opening turn");
  assert.match(fakePiWrap.calls[0].prompt, /Grill this raw idea into a decided Readyset brainstorm file/);
  assert.match(fakePiWrap.calls[0].prompt, /let users export their data as CSV/);
});

await test("parseReadysetArgs reads the raw argument string the way omp hands it over", async () => {
  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    parseReadysetArgs: (raw: string) => {
      all: boolean;
      fast: boolean;
      lang?: string;
      model?: string;
      fallbackModel?: string;
      idea?: string;
    };
  };
  const parse = mod.parseReadysetArgs;

  assert.deepEqual(parse(""), { all: false, fast: false });
  assert.deepEqual(parse("--all --fast"), { all: true, fast: true });

  const lang = parse("--lang Indonesian --idea a b c");
  assert.equal(lang.lang, "Indonesian", "the whole language must be read, not the character after '--lang'");
  assert.equal(lang.idea, "a b c", "--idea swallows every remaining token, joined back together");

  const models = parse("--model m1 --fallback-model m2");
  assert.equal(models.model, "m1");
  assert.equal(models.fallbackModel, "m2");

  assert.equal(parse('--model "a b"').model, "a b", "a quoted value stays one token");
  assert.equal(parse("--model").model, undefined, "a flag with no value is undefined, not a crash");
  assert.equal(parse("just some words").idea, undefined, "plain words are not mistaken for an idea");

  const phases = parse("--model big/main --phase-model explore=small/fast --phase-model grill=small/fast");
  assert.equal(phases.model, "big/main", "the run pin is unchanged");
  assert.deepEqual(
    phases.phaseModels,
    [
      { phase: "explore", model: "small/fast" },
      { phase: "grill", model: "small/fast" },
    ],
    "--phase-model is repeatable and keeps phase names",
  );
  assert.equal(parse("--phase-model typo").phaseModels, undefined, "a flag with no = is ignored, not a crash");
  assert.equal(parse("--phase-model Explore=small/fast").phaseModels?.[0].phase, "explore", "phase names are lowercased");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
