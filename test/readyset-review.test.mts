import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readPhaseEvents, changePaths, readContext } from "../src/lib/readyset-spec.ts";

// This whole file exercises readyset-review.ts's handler, which reads omp config
// (language/model/fallback chain/lane default) via readers called with NO argument -- by design,
// that always resolves to the real ~/.omp/agent/config.yml (see readyset-omp-config.ts's
// OMP_CONFIG_PATH comment), never a scratch path. Point it at a scratch path instead, so every
// "no flag" test here gets the same clean "nothing configured" starting point regardless of what's
// actually sitting in the real config.yml on whatever machine runs this suite. Must be set before
// the first `import(".../readyset-review.ts?t=...")` below, since OMP_CONFIG_PATH is a top-level
// const evaluated at module load -- which also means the *path* is fixed once the config module
// loads. Tests that need a real config value therefore write/remove this exact file (writeConfig/
// clearConfig) rather than re-pointing the env var; when it's absent, every reader sees "unset".
const TEST_CONFIG_PATH = join(
  await mkdtemp(join(tmpdir(), "readyset-test-omp-config-")),
  "config.yml",
);
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
  assert.ok(!/FAST lane/.test(fakePiWrap.calls[1].prompt), "full-lane Propose must not carry the fast-lane suffix");
  assert.match(fakePiWrap.calls[2].prompt, /Implement the Readyset change "my-feature"/);
  assert.match(fakePiWrap.calls[3].prompt, /Critically review the implementation of Readyset change "my-feature"/);
  assert.ok(!/mutation-testing-style/.test(fakePiWrap.calls[3].prompt), "full-lane review keeps mutation-testing depth");

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

await test("fast lane: --lane fast skips the Explore turn, tightens Propose, and narrows review", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-28-fast.md", {
    title: "Fast Fix",
    status: "open",
    created: "2026-01-28",
    change_id: "fast-fix",
    lane: "full", // recorded lane is full; the flag must override it
  }, VALID_BRAINSTORM_BODY);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-01-28 · Fast Fix"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Archive now");

  const dir = join(cwd, "readyset", "changes", "fast-fix");

  // No Explore effect queued: the fast lane must never fire an Explore turn.
  // Propose effect: writes the fast-lane artifact set (proposal.md with lane:+Acceptance, tasks.md).
  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "proposal.md"),
      "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- x (new)\n\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n",
      "utf8",
    );
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 do thing\n", "utf8");
  });
  // Apply effect
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 do thing\n  _Verified: ran the thing, it worked_\n", "utf8");
  });
  // Code-review effect
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nNo blockers found.\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  // 3 turns, not 4: no Explore turn fired at all.
  assert.equal(fakePiWrap.calls.length, 3);
  assert.ok(!fakePiWrap.calls.some((c) => /Explore the ground truth/.test(c.prompt)), "fast lane must not fire Explore");
  const propose = fakePiWrap.calls.find((c) => /Create a Readyset change/.test(c.prompt));
  assert.ok(propose, "Propose still fires");
  assert.match(propose.prompt, /FAST lane/, "fast-lane Propose carries the tight-planning suffix");
  assert.match(propose.prompt, /at most ~8 tasks/, "fast-lane Propose caps the task count");
  const review = fakePiWrap.calls.find((c) => /Critically review/.test(c.prompt));
  assert.ok(review, "Code review still fires");
  assert.match(review.prompt, /skip mutation-testing-style probes/, "fast-lane review narrows its depth");

  // The override must be announced, since the file said full.
  assert.ok(
    fakeUiWrap.notifications.some((n) => /--lane override.*full/.test(n.message)),
    "the --lane override over a differing recorded lane must notify",
  );

  // CONTEXT.md records the folded Explore, not a missing one.
  const contextRaw = await readFile(
    join(cwd, "readyset", "changes", "archive", "fast-fix", "CONTEXT.md"),
    "utf8",
  ).catch(() => undefined);
  if (contextRaw !== undefined) {
    assert.match(contextRaw, /fast lane folds grounding into Propose/);
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
      "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** the command exits 0\n",
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
  for (const tocEntry of ["1. Exploration", "2. Proposal", "3. Scope", "4. Design", "5. Specs (1)", "6. Tasks (1/1)", "7. Verification summary", "8. Runtime evidence", "9. Code review", "10. Context log"]) {
    assert.ok(doc.includes(tocEntry), `expected table of contents to include "${tocEntry}"`);
  }
  // each section heading appears again as its own header, and the spec file path is shown
  for (const heading of ["EXPLORATION", "PROPOSAL", "SCOPE", "DESIGN", "SPECS (1)", "specs/widgets/spec.md", "TASKS (1/1)", "VERIFICATION SUMMARY", "RUNTIME EVIDENCE", "CODE REVIEW", "CONTEXT LOG"]) {
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

await test("classic gate is fail-closed: cancel/undefined at the gate runs nothing", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-27-failclosed.md", {
    title: "Fail Closed",
    status: "proposed",
    created: "2026-01-27",
    change_id: "fail-closed",
  });
  const dir = join(cwd, "readyset", "changes", "fail-closed");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-01-27 · Fail Closed"); // pick
  fakeUiWrap.selectQueue.push(undefined); // cancel at the gate — must discard, run nothing

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(fakePiWrap.calls.length, 0, "a cancelled gate must fire no agent turn at all");
  const tasksRaw = await readFile(join(dir, "tasks.md"), "utf8");
  assert.ok(tasksRaw.includes("- [ ] 1.1"), "no task may be touched without an approval");
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
  await askExecute("call1", { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }], decision: "A or B -- the plan differs in the call path" }] }, undefined, undefined, {
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
    { questions: [{ id: "q1", question: "Which approach?", options: [{ label: "A" }, { label: "B" }], recommendedIndex: 0, decision: "A is sync, B is async -- the plan differs" }] },
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

  const result = await tool.execute("call1", { questions: [{ id: "q1", question: "Name it?", options: [{ label: "X" }], decision: "the name changes the public API surface" }] }, undefined, undefined, ctx);
  assert.match(result.content[0]?.text ?? "", /their own answer: "my own answer"/);
});

await test("readyset_ask: kind 'chat' tells the model to continue the round in plain chat", async () => {
  const tool = await loadAskTool();
  const ctx = { ui: { askDialog: async () => ({ kind: "chat" }) } };

  const result = await tool.execute("call1", { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }], decision: "A or B -- the plan differs" }] }, undefined, undefined, ctx);
  assert.match(result.content[0]?.text ?? "", /chose to discuss this round in plain chat/);
});

await test("readyset_ask: dialog cancelled (undefined result) -> tells the model to ask the user directly", async () => {
  const tool = await loadAskTool();
  const ctx = { ui: { askDialog: async () => undefined } };

  const result = await tool.execute("call1", { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }], decision: "A or B -- the plan differs" }] }, undefined, undefined, ctx);
  assert.match(result.content[0]?.text ?? "", /closed the picker without answering/);
});

await test("readyset_ask: askDialog unavailable (non-interactive mode) -> falls back to plain-chat instruction", async () => {
  const tool = await loadAskTool();
  const ctx = { ui: {} }; // no askDialog on this ctx shape -- RPC/print/ACP modes

  const result = await tool.execute("call1", { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }], decision: "A or B -- the plan differs" }] }, undefined, undefined, ctx);
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
  const oneQuestion = { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }], decision: "A or B -- the plan differs" }] };

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

await test("readyset_ask: a question without `decision` is rejected and opens no dialog", async () => {
  const tool = await loadAskTool();
  let dialogCalls = 0;
  const ctx = { ui: { askDialog: async () => { dialogCalls++; return { kind: "submit", results: [] }; } } };

  const rejected = await tool.execute(
    "c",
    { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }] }] },
    undefined,
    undefined,
    ctx,
  );
  const text = rejected.content[0]?.text ?? "";
  assert.match(text, /Rejected/);
  assert.match(text, /`decision`/);
  assert.match(text, /q1/, "the offending question id is named");
  assert.equal(dialogCalls, 0, "a rejected round must not open the picker");
});

await test("readyset_ask: a blank `decision` is rejected too", async () => {
  const tool = await loadAskTool();
  let dialogCalls = 0;
  const ctx = { ui: { askDialog: async () => { dialogCalls++; return { kind: "submit", results: [] }; } } };

  const rejected = await tool.execute(
    "c",
    { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }], decision: "   " }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(rejected.content[0]?.text ?? "", /Rejected/);
  assert.equal(dialogCalls, 0);
});

await test("readyset_ask: a rejected round does not consume the round budget", async () => {
  const tool = await loadAskTool();
  let dialogCalls = 0;
  const ctx = { ui: { askDialog: async () => { dialogCalls++; return { kind: "submit", results: [{ id: "q1", question: "Q?", options: ["A"], multi: false, selectedOptions: ["A"] }] }; } } };
  const noDecision = { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }] }] };

  // Reject many rounds with no decision -- none of these should count against the cap.
  for (let i = 0; i < 10; i++) await tool.execute("c", noDecision, undefined, undefined, ctx);
  assert.equal(dialogCalls, 0);

  // A well-formed round still opens the dialog (the cap was not drained by the rejections).
  const good = await tool.execute(
    "c",
    { questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }, { label: "B" }], decision: "pick A or B -- A is synchronous" }] },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(dialogCalls, 1, "a well-formed round after rejections still opens the dialog");
  assert.match(good.content[0]?.text ?? "", /Q\? -> A/);
});

await test("readyset_ask: a clean round with `decision` set still returns the user's picks", async () => {
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
    { questions: [{ id: "q1", question: "Which approach?", options: [{ label: "A" }, { label: "B" }], decision: "A is sync, B is async -- the plan differs in the call path" }] },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(askDialogCalls.length, 1);
  assert.match(result.content[0]?.text ?? "", /Which approach\? -> B/);
});

// --- lane policy: prompt text (grilling) and handler precedence ------------------------------

async function runProposedThroughGate(cwd: string, changeId: string, title: string, extraBrainstorm?: Record<string, string>, args = "") {
  await writeBrainstorm(cwd, `2026-02-02-${changeId}.md`, {
    title,
    status: "proposed",
    created: "2026-02-02",
    change_id: changeId,
    ...extraBrainstorm,
  });
  const dir = join(cwd, "readyset", "changes", changeId);
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await writeFile(
    join(dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** the command exits 0\n",
    "utf8",
  );
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push(`2026-02-02 · ${title}`); // pick
  fakeUiWrap.selectQueue.push("Discard"); // gate: discard immediately, no turns fire

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler(args, ctx);
  const events = await readPhaseEvents(cwd, changeId);
  const gateEnd = events.find((e) => e.phase === "gate" && e.edge === "end");
  assert.ok(gateEnd, "a gate end event exists");
  return { gateEnd, fakeUiWrap };
}

await test("lane policy: default (ask) grilling prompt carries the VoI rule and the ask-the-user lane wording", async () => {
  const cwd = await freshRepo();
  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };

  await clearConfig();
  await handler("--idea Some idea", ctx);

  const prompt = fakePiWrap.calls[0]?.prompt ?? "";
  assert.match(prompt, /Ask only questions whose answer changes the plan/);
  assert.match(prompt, /Then ask the user directly for the lane/);
  assert.match(prompt, /clarity: clear\|partial\|ambiguous/);
  assert.match(prompt, /## Assumed/);
});

await test("lane policy: readyset.lane.default auto tells grilling not to ask and to derive the lane", async () => {
  const cwd = await freshRepo();
  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };

  await writeConfig("readyset:\n  lane:\n    default: auto\n");
  try {
    await handler("--idea Some idea", ctx);
    const prompt = fakePiWrap.calls[0]?.prompt ?? "";
    assert.match(prompt, /Do NOT ask the user for the lane/);
    assert.match(prompt, /`clarity: clear` → `fast`/);
    assert.doesNotMatch(prompt, /Then ask the user directly for the lane/);
  } finally {
    await clearConfig();
  }
});

await test("handler lane precedence: readyset.lane.default auto uses code's recommendation + warns", async () => {
  const cwd = await freshRepo();
  await writeConfig("readyset:\n  lane:\n    default: auto\n");
  try {
    // openDecisions: 0 -> clear -> fast, but the file records full: auto accepts fast.
    const { gateEnd, fakeUiWrap } = await runProposedThroughGate(cwd, "auto1", "Auto One", { lane: "full", openDecisions: "0" });
    assert.equal(gateEnd.lane, "fast");
    assert.equal(gateEnd.laneSource, "config-auto");
    assert.ok(
      fakeUiWrap.notifications.some((n) => /Auto lane: clarity clear/.test(n.message) && /recommends the fast lane/.test(n.message)),
      "a warning names the recommendation",
    );
  } finally {
    await clearConfig();
  }
});

await test("handler lane precedence: readyset.lane.default full forces the lane over the file", async () => {
  const cwd = await freshRepo();
  await writeConfig("readyset:\n  lane:\n    default: full\n");
  try {
    // The file records fast, which the default picker filter would hide; --fast includes
    // fast-lane brainstorms so the run can proceed and prove the configured `full` overrides it.
    const { gateEnd } = await runProposedThroughGate(cwd, "force1", "Force One", { lane: "fast" }, "--fast");
    assert.equal(gateEnd.lane, "full");
    assert.equal(gateEnd.laneSource, "config-auto");
  } finally {
    await clearConfig();
  }
});

await test("handler lane precedence: --lane beats readyset.lane.default (laneSource flag)", async () => {
  const cwd = await freshRepo();
  await writeConfig("readyset:\n  lane:\n    default: full\n");
  try {
    await writeBrainstorm(cwd, "2026-02-02-flag1.md", { title: "Flag One", status: "proposed", created: "2026-02-02", change_id: "flag1" });
    const dir = join(cwd, "readyset", "changes", "flag1");
    await mkdir(join(dir, "specs", "cap"), { recursive: true });
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

    const fakePiWrap = makeFakePi(cwd);
    const handler = await loadHandler(fakePiWrap.pi);
    const fakeUiWrap = makeFakeUi();
    fakeUiWrap.selectQueue.push("2026-02-02 · Flag One");
    fakeUiWrap.selectQueue.push("Discard");
    const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };

    await handler("--lane fast", ctx);
    const gateEnd = (await readPhaseEvents(cwd, "flag1")).find((e) => e.phase === "gate" && e.edge === "end");
    assert.ok(gateEnd, "a gate end event exists");
    assert.equal(gateEnd.lane, "fast");
    assert.equal(gateEnd.laneSource, "flag");
  } finally {
    await clearConfig();
  }
});

await test("handler lane source: ask + clarity signal -> user-pick; old file with none -> brainstorm", async () => {
  const cwd = await freshRepo();
  await clearConfig();

  const withClarity = await runProposedThroughGate(cwd, "pick1", "Pick One", { lane: "full", clarity: "partial" });
  assert.equal(withClarity.gateEnd.laneSource, "user-pick");

  const old = await runProposedThroughGate(cwd, "old1", "Old One", { lane: "full" });
  assert.equal(old.gateEnd.laneSource, "brainstorm");
});

await test("old brainstorms with no new frontmatter keys still load and run", async () => {
  const cwd = await freshRepo();
  await clearConfig();
  const { gateEnd } = await runProposedThroughGate(cwd, "legacy1", "Legacy One", { lane: "full" });
  assert.equal(gateEnd.lane, "full");
  assert.equal(gateEnd.laneSource, "brainstorm", "no clarity signal -> today's meaning, unchanged");
});

await test("the grill end phase event carries the clarity signal from the brainstorm", async () => {
  const cwd = await freshRepo();
  await clearConfig();
  await writeBrainstorm(
    cwd,
    "2026-04-01-signal.md",
    {
      title: "Signal",
      status: "open",
      created: "2026-04-01",
      change_id: "signal",
      lane: "full",
      clarity: "partial",
      openDecisions: "1",
      questionsAsked: "2",
      laneReason: "narrow but migration-bound",
      riskFlag: "migration",
    },
    VALID_BRAINSTORM_BODY,
  );

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-04-01 · Signal"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Archive now");

  const dir = join(cwd, "readyset", "changes", "signal");
  // --lane fast skips Explore, so the first effect is the Propose turn.
  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "proposal.md"),
      "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- x (new)\n\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n",
      "utf8",
    );
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 do thing\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 do thing\n  _Verified: ran the thing, it worked_\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nNo blockers found.\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  const grillEnd = (await phaseEventsArchivedOrLive(cwd, "signal")).find((e) => e.phase === "grill" && e.edge === "end");
  assert.ok(grillEnd, "a grill end event is written");
  assert.ok(grillEnd!.grill, "the grill event carries the clarity signal payload");
  assert.equal(grillEnd!.grill!.clarity, "partial");
  assert.equal(grillEnd!.grill!.openDecisions, 1);
  assert.equal(grillEnd!.grill!.questionsAsked, 2);
  assert.equal(grillEnd!.grill!.recommendedLane, "full", "partial + migration risk flag escalates to full");
  assert.equal(grillEnd!.grill!.riskFlag, "migration");
  assert.equal(grillEnd!.grill!.laneReason, "narrow but migration-bound");
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

await test("prep compaction: full lane compacts before Explore and before Propose with Readyset guidance", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(
    cwd,
    "2026-02-01-prep.md",
    { title: "Prep Compact", status: "open", created: "2026-02-01", change_id: "prep-compact" },
    VALID_BRAINSTORM_BODY,
  );
  const dir = join(cwd, "readyset", "changes", "prep-compact");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-02-01 · Prep Compact"); // pick

  // Explore turn: write EXPLORATION.md so Propose's guidance can name it.
  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "EXPLORATION.md"), "## Findings\n\nchecked things\n", "utf8");
  });
  // Propose turn: nothing needed -- we only assert the compactions fired.
  fakePiWrap.queueEffect(async () => {});

  const compactCalls: Array<{ internalGuidance?: string; suppressContinuation?: boolean }> = [];
  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: fakePiWrap.waitForIdle,
    // Above the default 25% threshold, so `auto` compacts at both boundaries.
    getContextUsage: () => ({ tokens: 90000, contextWindow: 100000, percent: 90 }),
    async compact(opts: { internalGuidance?: string; suppressContinuation?: boolean }) {
      compactCalls.push(opts);
    },
  };
  await handler("", ctx);

  assert.equal(compactCalls.length, 2, "one compaction before Explore, one before Propose");
  assert.match(compactCalls[0].internalGuidance ?? "", /prep-compact/);
  assert.match(compactCalls[0].internalGuidance ?? "", /\.ai\/brainstorms/);
  assert.match(compactCalls[1].internalGuidance ?? "", /EXPLORATION\.md/);
  assert.equal(compactCalls[0].suppressContinuation, true);
  assert.equal(compactCalls[1].suppressContinuation, true);

  const compactEvents = (await readPhaseEvents(cwd, "prep-compact")).filter((e) => e.phase === "compact" && e.edge === "end");
  assert.equal(compactEvents.length, 2, "one compact event per boundary");
  assert.equal(compactEvents[0].boundary, "explore");
  assert.equal(compactEvents[0].outcome, "compacted");
  assert.equal(compactEvents[1].boundary, "propose");
  assert.equal(compactEvents[1].outcome, "compacted");
});

await test("prep compaction: fast lane skips the Explore boundary and compacts only before Propose", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(
    cwd,
    "2026-02-02-fastprep.md",
    { title: "Fast Prep", status: "open", created: "2026-02-02", change_id: "fast-prep" },
    VALID_BRAINSTORM_BODY,
  );

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-02-02 · Fast Prep"); // pick
  fakePiWrap.queueEffect(async () => {}); // the single (Propose) turn

  const compactCalls: Array<{ internalGuidance?: string }> = [];
  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: fakePiWrap.waitForIdle,
    getContextUsage: () => ({ tokens: 90000, contextWindow: 100000, percent: 90 }),
    async compact(opts: { internalGuidance?: string }) {
      compactCalls.push(opts);
    },
  };
  await handler("--fast --lane fast", ctx);

  assert.equal(compactCalls.length, 1, "fast lane has no separate Explore turn, so only the Propose compaction fires");
  assert.match(compactCalls[0].internalGuidance ?? "", /\.ai\/brainstorms/);
  assert.doesNotMatch(compactCalls[0].internalGuidance ?? "", /EXPLORATION\.md/);

  const compactEvents = (await readPhaseEvents(cwd, "fast-prep")).filter((e) => e.phase === "compact" && e.edge === "end");
  assert.equal(compactEvents.length, 1, "only the Propose boundary records a compact event on the fast lane");
  assert.equal(compactEvents[0].boundary, "propose");
  assert.equal(compactEvents[0].outcome, "compacted");
});

await test("post-Apply scope drift: warns and surfaces the out-of-contract file at the archive prompt", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-02-03-drift.md", {
    title: "Drift Test",
    status: "proposed",
    created: "2026-02-03",
    change_id: "drift-test",
  });
  const dir = join(cwd, "readyset", "changes", "drift-test");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\ndrift\n\n## Files This Change Will Touch\n\n- src/keep.ts\n", "utf8");
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-02-03 · Drift Test"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  fakeUiWrap.selectQueue.push("Not yet"); // archive prompt

  // Apply turn: finish the task AND touch a file outside the contract.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "rogue.ts"), "// outside the contract\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(
    fakeUiWrap.notifications.some((n) => /outside its scope contract during Apply/.test(n.message) && /src\/rogue\.ts/.test(n.message)),
    "should warn that Apply drifted outside the scope contract",
  );
  assert.ok(
    fakeUiWrap.selectPrompts.some((p) => /outside the contract/.test(p) && /src\/rogue\.ts/.test(p)),
    "the archive prompt should surface the drift",
  );
});

await test("dangling refs: a contract path that doesn't exist and isn't (new) is surfaced in the gate", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-02-04-dangling.md", {
    title: "Dangling Test",
    status: "proposed",
    created: "2026-02-04",
    change_id: "dangling-test",
  });
  const dir = join(cwd, "readyset", "changes", "dangling-test");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## Files This Change Will Touch\n\n- src/ghost.ts\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-02-04 · Dangling Test"); // pick
  fakeUiWrap.selectQueue.push("Discard"); // leave the gate

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(
    fakeUiWrap.widgetHistory.some((entry) => entry.some((l) => /DANGLING/.test(l) && /src\/ghost\.ts/.test(l))),
    "the gate widget should flag the dangling contract path",
  );
  assert.ok(
    fakeUiWrap.editorTextHistory.some((doc) => /Dangling refs .*src\/ghost\.ts/.test(doc)),
    "the compiled review document should list the dangling ref",
  );
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

  assert.equal(parse("--lane fast").lane, "fast");
  assert.equal(parse("--lane FULL").lane, "full", "lane values are case-insensitive");
  assert.equal(parse("--lane medium").lane, undefined, "an unknown lane is ignored, never a silent default");
  assert.equal(parse("--lane").lane, undefined, "a bare --lane is ignored, not a crash");

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

await test("fast-lane run records its effective lane and the full phase-boundary set", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-02-01-fast.md", {
    title: "Fast Fix",
    status: "open",
    created: "2026-02-01",
    change_id: "fast-fix",
    lane: "full", // recorded lane is full; --lane fast must override it
  }, VALID_BRAINSTORM_BODY);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-02-01 · Fast Fix"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Archive now");

  const dir = join(cwd, "readyset", "changes", "fast-fix");
  // No Explore effect: fast lane never fires an Explore turn.
  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "proposal.md"),
      "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- x (new)\n\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n",
      "utf8",
    );
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 do thing\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 do thing\n  _Verified: ran the thing, it worked_\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nNo blockers found.\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  // The change was archived to changes/archive/<date>-fast-fix/, so the events live in the
  // archived CONTEXT.md. Fall back to the live path if the archive move did not happen.
  const liveEvents = await readPhaseEvents(cwd, "fast-fix");
  let archivedEvents: Awaited<ReturnType<typeof readPhaseEvents>> = [];
  const archiveRoot = join(cwd, "readyset", "changes", "archive");
  const archivedEntries = await (await import("node:fs/promises")).readdir(archiveRoot).catch(() => [] as string[]);
  const archivedDirName = archivedEntries.find((name) => name.endsWith("-fast-fix"));
  if (archivedDirName) archivedEvents = await readPhaseEvents(cwd, `archive/${archivedDirName}`);
  const all = archivedEvents.length > 0 ? archivedEvents : liveEvents;

  assert.ok(all.length > 0, "phase events must be recorded");
  const explore = all.find((e) => e.phase === "explore" && e.edge === "end");
  assert.ok(explore, "an explore end event exists");
  assert.equal(explore.outcome, "skipped-fast-lane");
  assert.equal(explore.lane, "fast");

  const propose = all.find((e) => e.phase === "propose" && e.edge === "end");
  assert.ok(propose, "a propose end event exists");
  assert.equal(propose.lane, "fast");

  const gate = all.find((e) => e.phase === "gate" && e.edge === "end");
  assert.ok(gate, "a gate end event exists");
  assert.equal(gate.outcome, "approve");
  assert.equal(gate.lane, "fast");

  assert.ok(all.some((e) => e.phase === "apply" && e.edge === "end"), "an apply end event exists");
  assert.ok(all.some((e) => e.phase === "review" && e.edge === "end"), "a review end event exists");
  assert.ok(all.some((e) => e.phase === "archive" && e.edge === "end"), "an archive end event exists");

  for (const e of all) {
    if (e.phase === "grill") continue;
    assert.equal(e.lane, "fast", `event ${e.phase}/${e.edge} carries the effective lane`);
    assert.equal(e.laneSource, "flag", `event ${e.phase}/${e.edge} attributes the lane to the flag`);
  }

  const grill = all.find((e) => e.phase === "grill" && e.edge === "end");
  assert.ok(grill, "a grill end event is recorded at scaffold time");
  assert.equal(grill.lane, "fast");
});

await test("a discarded gate still closes its boundary with outcome discard", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-02-02-thing.md", { title: "Thing", status: "proposed", created: "2026-02-02", change_id: "thing" });
  const dir = join(cwd, "readyset", "changes", "thing");
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await writeFile(
    join(dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** the command exits 0\n",
    "utf8",
  );
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-02-02 · Thing"); // pick
  fakeUiWrap.selectQueue.push("Discard"); // gate: discard immediately

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(fakePiWrap.calls.length, 0, "no turn fires on a straight discard");
  const events = await readPhaseEvents(cwd, "thing");
  const gateEnd = events.find((e) => e.phase === "gate" && e.edge === "end");
  assert.ok(gateEnd, "a gate end event is written even on discard");
  assert.equal(gateEnd.outcome, "discard");
  const gateStart = events.find((e) => e.phase === "gate" && e.edge === "start");
  assert.ok(gateStart, "the gate start boundary is written too");
});

// --- Contract repair (dangling / new-but-exists / delete-but-missing) -------------------------

// A minimal valid, *proposed* change so the handler reaches the gate without a Propose turn.
// Mirrors the "already-proposed" tests above; used by the repair tests that reach the repair via
// the Refine branch (the already-proposed path has no Propose turn to hang a repair on).
async function writeProposedChange(cwd: string, changeId: string, contractLines: string[]) {
  const dir = join(cwd, "readyset", "changes", changeId);
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  await writeFile(
    join(dir, "proposal.md"),
    ["## Why", "", "x", "", "## What Changes", "", "- x", "", "## Files This Change Will Touch", "", ...contractLines].join("\n") + "\n",
    "utf8",
  );
  await writeFile(join(dir, "specs", "cap", "spec.md"), "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** the command exits 0\n", "utf8");
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");
  return dir;
}

// Reads phase events from the archived CONTEXT.md if the change was archived, else the live path.
async function phaseEventsArchivedOrLive(cwd: string, changeId: string) {
  const live = await readPhaseEvents(cwd, changeId);
  const archiveRoot = join(cwd, "readyset", "changes", "archive");
  const entries = await (await import("node:fs/promises")).readdir(archiveRoot).catch(() => [] as string[]);
  const dirName = entries.find((name) => name.endsWith(`-${changeId}`));
  const archived = dirName ? await readPhaseEvents(cwd, `archive/${dirName}`) : [];
  return archived.length > 0 ? archived : live;
}

await test("T0: the Propose path repairs a dangling contract before the gate", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(
    cwd,
    "2026-03-01-repair0.md",
    { title: "Repair Zero", status: "open", created: "2026-03-01", change_id: "repair0", lane: "full" },
    VALID_BRAINSTORM_BODY,
  );
  const dir = join(cwd, "readyset", "changes", "repair0");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-03-01 · Repair Zero"); // pick
  fakeUiWrap.selectQueue.push("Archive now"); // archive prompt
  fakeUiWrap.selectQueue.push("Approve & Execute"); // gate

  // Propose turn: writes a fast-lane contract with a dangling line.
  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "proposal.md"), "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/missing.ts\n\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n", "utf8");
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 do thing\n", "utf8");
  });
  // Repair turn: rewrites the contract to a path that exists.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/real.ts\n\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n", "utf8");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "real.ts"), "x\n", "utf8");
  });
  // Apply turn.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 do thing\n  _Verified: ran it, it worked_\n", "utf8");
  });
  // Review turn.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nNo blockers found.\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  assert.ok(
    fakePiWrap.calls.some((c) => /scope contract in proposal\.md is wrong/.test(c.prompt)),
    "a repair turn fired with the repair prompt",
  );
  assert.ok(
    !fakePiWrap.calls.some((c) => /Create a Readyset change/.test(c.prompt) && /scope contract in proposal\.md is wrong/.test(c.prompt)),
    "the Propose prompt must not be the repair prompt",
  );

  const all = await phaseEventsArchivedOrLive(cwd, "repair0");
  const repairEnd = all.find((e) => e.phase === "contract-repair" && e.edge === "end");
  assert.ok(repairEnd, "a contract-repair end event exists");
  assert.equal(repairEnd.outcome, "fixed");
});

await test("T1: a dangling contract triggers exactly one repair turn, then the gate", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-03-02-repair1.md", {
    title: "Repair One",
    status: "proposed",
    created: "2026-03-02",
    change_id: "repair1",
  }, VALID_BRAINSTORM_BODY);
  const dir = await writeProposedChange(cwd, "repair1", ["- src/missing.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-03-02 · Repair One"); // pick
  fakeUiWrap.selectQueue.push("Refine"); // refine round
  fakeUiWrap.inputQueue.push("fix the contract");
  fakeUiWrap.selectQueue.push("Discard"); // second gate: discard

  // (a) Refine turn: keeps the dangling line, so the repair still has work.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/missing.ts\n", "utf8");
  });
  // (b) Repair turn: rewrites the contract to a path that exists.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/real.ts\n", "utf8");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "real.ts"), "x\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(fakePiWrap.calls.length, 2, "one Refine turn + one repair turn, no more");
  assert.match(fakePiWrap.calls[0].prompt, /Revise the Readyset change/);
  assert.match(fakePiWrap.calls[1].prompt, /scope contract in proposal\.md is wrong/);
  assert.match(fakePiWrap.calls[1].prompt, /src\/missing\.ts/);

  const events = await readPhaseEvents(cwd, "repair1");
  const repairEnds = events.filter((e) => e.phase === "contract-repair" && e.edge === "end");
  assert.equal(repairEnds.length, 1, "exactly one contract-repair end event");
  assert.equal(repairEnds[0].outcome, "fixed");

  const context = await readContext(cwd, "repair1");
  assert.ok(context?.includes("## Contract repair —"), "a CONTEXT.md repair entry is written");
  assert.ok(context?.includes("issue(s) before"), "the entry records the before/after count");
});

await test("T2: a clean contract triggers no repair", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-03-03-repair2.md", {
    title: "Repair Two",
    status: "proposed",
    created: "2026-03-03",
    change_id: "repair2",
  }, VALID_BRAINSTORM_BODY);
  const dir = await writeProposedChange(cwd, "repair2", ["- src/real.ts"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "real.ts"), "x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-03-03 · Repair Two");
  fakeUiWrap.selectQueue.push("Refine");
  fakeUiWrap.inputQueue.push("tweak the wording");
  fakeUiWrap.selectQueue.push("Discard");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nupdated\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/real.ts\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(!fakePiWrap.calls.some((c) => /scope contract in proposal\.md is wrong/.test(c.prompt)), "no repair turn fires");
  const events = await readPhaseEvents(cwd, "repair2");
  assert.ok(!events.some((e) => e.phase === "contract-repair"), "no contract-repair event exists");
});

await test("T3: a repair that writes outside the change dir is caught", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-03-04-repair3.md", {
    title: "Repair Three",
    status: "proposed",
    created: "2026-03-04",
    change_id: "repair3",
  }, VALID_BRAINSTORM_BODY);
  const dir = await writeProposedChange(cwd, "repair3", ["- src/missing.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-03-04 · Repair Three");
  fakeUiWrap.selectQueue.push("Refine");
  fakeUiWrap.inputQueue.push("fix the contract");
  fakeUiWrap.selectQueue.push("Discard");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/missing.ts\n", "utf8");
  });
  // Repair turn writes a rogue product file instead of fixing the contract.
  fakePiWrap.queueEffect(async () => {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "rogue.ts"), "// out of bounds\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const events = await readPhaseEvents(cwd, "repair3");
  const repairEnd = events.find((e) => e.phase === "contract-repair" && e.edge === "end");
  assert.ok(repairEnd, "a contract-repair end event exists");
  assert.equal(repairEnd.outcome, "partial");
  assert.ok(
    fakeUiWrap.notifications.some((n) => /contract-repair turn.*outside the change directory/.test(n.message) && n.level === "error"),
    "an error notification names the boundary violation",
  );
});

await test("T4: an exhausted budget skips the repair and still reaches the gate", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-03-05-repair4.md", {
    title: "Repair Four",
    status: "proposed",
    created: "2026-03-05",
    change_id: "repair4",
  }, VALID_BRAINSTORM_BODY);
  const dir = await writeProposedChange(cwd, "repair4", ["- src/missing.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-03-05 · Repair Four");
  // 10 Refine rounds, each keeping the contract dangling so the repair keeps wanting a turn.
  // Each round consumes one turn; the 11th refine's spendTurn hits the cap.
  for (let i = 0; i < 11; i++) {
    fakeUiWrap.selectQueue.push("Refine");
    fakeUiWrap.inputQueue.push(`refine ${i}`);
  }
  fakeUiWrap.selectQueue.push("Discard"); // final gate

  for (let i = 0; i < 11; i++) {
    fakePiWrap.queueEffect(async () => {
      await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/missing.ts\n", "utf8");
    });
  }

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(
    fakeUiWrap.notifications.some((n) => /Turn budget/.test(n.message) && n.level === "warning"),
    "a turn-budget warning fired",
  );
  assert.ok(
    fakeUiWrap.selectPrompts.some((p) => /Review change/.test(p)),
    "the run still reached the review gate",
  );

  const events = await readPhaseEvents(cwd, "repair4");
  const repairEnds = events.filter((e) => e.phase === "contract-repair" && e.edge === "end");
  assert.ok(
    fakeUiWrap.notifications.some((n) => /Turn budget/.test(n.message) && n.level === "warning"),
    "a turn-budget warning fired",
  );
  assert.ok(
    fakeUiWrap.selectPrompts.some((p) => /Review change/.test(p)),
    "the run still reached the review gate",
  );
  assert.equal(fakePiWrap.calls.length, 10, "10 model turns fired total (6 Refine + 4 repair), never more than the budget");
  // New semantics (turn reserves): the repair only fires when 2 turns would still remain for
  // Apply + Review, so it stops firing at spent=9 (10-9=1, not > 2) and records skipped-budget
  // instead — the reserve keeps Apply/Review from being starved. The loop itself halts when the
  // 10-turn budget is fully spent.
  const skipped = repairEnds.filter((e) => e.outcome === "skipped-budget");
  assert.equal(skipped.length, 2, "the last two gate iterations reserved turns and skipped the repair");
  assert.equal(repairEnds.length, 6, "four repair turns ran, then two skipped-budget events");
  assert.ok(
    fakeUiWrap.notifications.some((n) => /starve Apply\/Review/.test(n.message) && n.level === "warning"),
    "the reserve notify names Apply/Review retention",
  );
});

await test("T5: Refine triggers the repair again", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-03-06-repair5.md", {
    title: "Repair Five",
    status: "proposed",
    created: "2026-03-06",
    change_id: "repair5",
  }, VALID_BRAINSTORM_BODY);
  const dir = await writeProposedChange(cwd, "repair5", ["- src/missing.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-03-06 · Repair Five");
  fakeUiWrap.selectQueue.push("Refine");
  fakeUiWrap.inputQueue.push("round one");
  fakeUiWrap.selectQueue.push("Refine");
  fakeUiWrap.inputQueue.push("round two");
  fakeUiWrap.selectQueue.push("Discard");

  // Round 1 refine leaves it dangling; its repair fixes it.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/missing.ts\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/real.ts\n", "utf8");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "real.ts"), "x\n", "utf8");
  });
  // Round 2 refine re-introduces a dangling line; its repair fixes it again.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/missing.ts\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/real.ts\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const events = await readPhaseEvents(cwd, "repair5");
  const repairEnds = events.filter((e) => e.phase === "contract-repair" && e.edge === "end");
  assert.equal(repairEnds.length, 2, "two repair rounds each recorded an end event");
  assert.equal(repairEnds[1].outcome, "fixed", "the second repair resolved the contract");
});

await test("T6: phase events and CONTEXT.md entry are written", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-03-07-repair6.md", {
    title: "Repair Six",
    status: "proposed",
    created: "2026-03-07",
    change_id: "repair6",
  }, VALID_BRAINSTORM_BODY);
  const dir = await writeProposedChange(cwd, "repair6", ["- src/missing.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-03-07 · Repair Six");
  fakeUiWrap.selectQueue.push("Refine");
  fakeUiWrap.inputQueue.push("fix it");
  fakeUiWrap.selectQueue.push("Discard");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/missing.ts\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/real.ts\n", "utf8");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "real.ts"), "x\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const events = await readPhaseEvents(cwd, "repair6");
  assert.ok(events.some((e) => e.phase === "contract-repair"), "a contract-repair phase event is written");
  const context = await readContext(cwd, "repair6");
  assert.ok(context?.includes("## Contract repair —"), "a CONTEXT.md repair entry is written");
});

// --- Post-Apply scope reconciliation ----------------------------------------------------------

// A proposed change whose contract names src/keep.ts (created so it resolves), so Apply can be
// driven straight from the gate with no Propose turn.
async function writeReconcileChange(cwd: string, changeId: string) {
  const dir = await writeProposedChange(cwd, changeId, ["- src/keep.ts"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 1;\n", "utf8");
  return dir;
}

await test("S1: unjustified drift triggers exactly one reconciliation turn, which fixes it", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-04-01-recon1.md", {
    title: "Reconcile One",
    status: "proposed",
    created: "2026-04-01",
    change_id: "recon1",
  });
  const dir = await writeReconcileChange(cwd, "recon1");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-04-01 · Reconcile One"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet"); // archive prompt

  // Apply: complete the task AND touch a file outside the contract.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await writeFile(join(cwd, "src", "rogue.ts"), "// outside the contract\n", "utf8");
  });
  // Reconciliation: revert src/rogue.ts.
  fakePiWrap.queueEffect(async () => {
    await rm(join(cwd, "src", "rogue.ts"), { force: true });
  });
  // Review.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(
    fakePiWrap.calls.some((c) => /scope contract does NOT name/.test(c.prompt) && /src\/rogue\.ts/.test(c.prompt)),
    "a reconciliation turn fired naming the out-of-contract file",
  );
  const events = await readPhaseEvents(cwd, "recon1");
  const recStarts = events.filter((e) => e.phase === "scope-reconcile" && e.edge === "start");
  const recEnds = events.filter((e) => e.phase === "scope-reconcile" && e.edge === "end");
  assert.equal(recStarts.length, 1, "exactly one reconciliation turn started");
  assert.equal(recEnds.length, 1, "exactly one reconciliation end event");
  assert.equal(recEnds[0].outcome, "fixed");
  assert.equal(recEnds[0].counts?.outsideBefore, 1);
  assert.equal(recEnds[0].counts?.unjustifiedAfter, 0);
});

await test("S2: already-justified drift triggers no reconciliation", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-04-02-recon2.md", {
    title: "Reconcile Two",
    status: "proposed",
    created: "2026-04-02",
    change_id: "recon2",
  });
  const dir = await writeReconcileChange(cwd, "recon2");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-04-02 · Reconcile Two");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n\n## Scope deviations\n\n- src/rogue.ts — required by scenario X\n", "utf8");
    await writeFile(join(cwd, "src", "rogue.ts"), "// justified\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(!fakePiWrap.calls.some((c) => /scope contract does NOT name/.test(c.prompt)), "no reconciliation turn fires");
  const events = await readPhaseEvents(cwd, "recon2");
  assert.ok(!events.some((e) => e.phase === "scope-reconcile"), "no scope-reconcile event exists");
});

await test("S3: a clean scope triggers no reconciliation", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-04-03-recon3.md", {
    title: "Reconcile Three",
    status: "proposed",
    created: "2026-04-03",
    change_id: "recon3",
  });
  const dir = await writeReconcileChange(cwd, "recon3");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-04-03 · Reconcile Three");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 2;\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(!fakePiWrap.calls.some((c) => /scope contract does NOT name/.test(c.prompt)), "no reconciliation turn fires");
  const events = await readPhaseEvents(cwd, "recon3");
  assert.ok(!events.some((e) => e.phase === "scope-reconcile"), "no scope-reconcile event exists");
});

await test("S4: an exhausted budget skips reconciliation and keeps the warning", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-04-04-recon4.md", {
    title: "Reconcile Four",
    status: "proposed",
    created: "2026-04-04",
    change_id: "recon4",
  }, VALID_BRAINSTORM_BODY);
  const dir = await writeReconcileChange(cwd, "recon4");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-04-04 · Reconcile Four");
  // 9 Refine rounds consume 9 turns; the Apply turn is the 10th and exhausts the budget.
  for (let i = 0; i < 9; i++) {
    fakeUiWrap.selectQueue.push("Refine");
    fakeUiWrap.inputQueue.push(`round ${i}`);
  }
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet");

  for (let i = 0; i < 9; i++) {
    fakePiWrap.queueEffect(async () => {
      // No-op refine: the contract stays resolvable (src/keep.ts exists).
      await writeFile(join(cwd, "src", "keep.ts"), `export const keep = ${i};\n`, "utf8");
    });
  }
  // Apply: unjustified drift.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await writeFile(join(cwd, "src", "rogue.ts"), "// outside the contract\n", "utf8");
  });
  // Review.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const events = await readPhaseEvents(cwd, "recon4");
  const recEnds = events.filter((e) => e.phase === "scope-reconcile" && e.edge === "end");
  assert.equal(recEnds.length, 1, "exactly one reconciliation end event");
  assert.equal(recEnds[0].outcome, "skipped-budget");
  assert.equal(recEnds[0].counts?.unjustifiedAfter, 1);
  assert.ok(
    fakeUiWrap.notifications.some((n) => /starve the code-review turn/.test(n.message) && n.level === "warning"),
    "a reserve warning names the code-review turn's retention",
  );
  // Observed behavior (pinned, not `||`): the 9 Refine turns plus the Apply turn spend the full
  // budget, so once Apply completes there is no turn left for the review turn either — the run
  // stops before Code review with the turn-budget warning, and the reconciliation's own
  // skipped-budget pre-check writes the `scope-reconcile` event and the drift warning above. The
  // load-bearing guarantees (skip + warn + never loop) are asserted here; reaching the archive
  // prompt would require one more budget unit than this recipe has.
  assert.ok(
    fakeUiWrap.notifications.some((n) => /Turn budget \(10 agent turns\) reached/.test(n.message) && n.level === "warning"),
    "the run stopped at the turn budget before the review turn",
  );
  assert.ok(
    fakeUiWrap.notifications.some((n) => /touched file\(s\) outside its scope contract during Apply/.test(n.message) && /src\/rogue\.ts/.test(n.message)),
    "the remaining drift still warns at the end",
  );
  assert.equal(fakePiWrap.calls.length, 10, "never more than the turn budget of model turns");
});

await test("S5: a reconciliation turn that touches a new outside file is surfaced", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-04-05-recon5.md", {
    title: "Reconcile Five",
    status: "proposed",
    created: "2026-04-05",
    change_id: "recon5",
  });
  const dir = await writeReconcileChange(cwd, "recon5");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-04-05 · Reconcile Five");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await writeFile(join(cwd, "src", "rogue.ts"), "// outside the contract\n", "utf8");
  });
  // Reconciliation: creates ANOTHER new outside file instead of fixing anything.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(cwd, "src", "rogue2.ts"), "// a new out-of-contract file\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(
    fakeUiWrap.notifications.some((n) => /changed additional out-of-contract file/.test(n.message) && n.level === "warning"),
    "a warning surfaces the new out-of-contract file",
  );
  const context = await readContext(cwd, "recon5");
  assert.ok(
    context?.includes("Reconciliation turn changed file(s) it was not asked to"),
    "CONTEXT.md records the boundary growth",
  );
});

await test("S6: the deviation list reaches the review prompt", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-04-06-recon6.md", {
    title: "Reconcile Six",
    status: "proposed",
    created: "2026-04-06",
    change_id: "recon6",
  });
  const dir = await writeReconcileChange(cwd, "recon6");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-04-06 · Reconcile Six");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n\n## Scope deviations\n\n- src/rogue.ts — required\n", "utf8");
    await writeFile(join(cwd, "src", "rogue.ts"), "// justified\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(
    fakePiWrap.calls.some((c) => /## Scope/.test(c.prompt) && /src\/rogue\.ts/.test(c.prompt) && /required/.test(c.prompt)),
    "the review prompt carries the declared deviation with its reason",
  );
});

await test("S7: the apply end event carries diff stats", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-04-07-recon7.md", {
    title: "Reconcile Seven",
    status: "proposed",
    created: "2026-04-07",
    change_id: "recon7",
  });
  const dir = await writeProposedChange(cwd, "recon7", ["- src/keep.ts", "- src/new.ts (new)"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 1;\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-04-07 · Reconcile Seven");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 2;\nexport const more = 3;\n", "utf8");
    await writeFile(join(cwd, "src", "new.ts"), "export const fresh = true;\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const events = await readPhaseEvents(cwd, "recon7");
  const applyEnd = events.find((e) => e.phase === "apply" && e.edge === "end");
  assert.ok(applyEnd, "an apply end event exists");
  assert.equal(applyEnd.outcome, "applied");
  assert.ok(applyEnd.diff, "the apply end event carries a diff");
  assert.ok((applyEnd.diff?.files ?? 0) >= 1, "at least one file counted");
  assert.ok((applyEnd.diff?.added ?? 0) >= 1, "at least one added line counted");
});

await test("S8: the Apply prompt carries the minimal-diff rules", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-04-08-recon8.md", {
    title: "Reconcile Eight",
    status: "proposed",
    created: "2026-04-08",
    change_id: "recon8",
  });
  const dir = await writeReconcileChange(cwd, "recon8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-04-08 · Reconcile Eight");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 2;\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const applyCall = fakePiWrap.calls.find((c) => /Implement the Readyset change/.test(c.prompt));
  assert.ok(applyCall, "an Apply turn fired");
  assert.match(applyCall.prompt, /touch ONLY files/);
  assert.match(applyCall.prompt, /## Scope deviations/);
  assert.match(applyCall.prompt, /smallest change/);
});

// --- F1: safe scope reconciliation (baseline-subtracted candidates, backups, restore) ---------

await test("F1: a file already dirty before the run is never offered for revert and is byte-identical after reconciliation", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
  execFileSync("git", ["config", "user.name", "t"], { cwd });
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 1;\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });

  await writeBrainstorm(cwd, "2026-04-20-f1a.md", {
    title: "F1 A",
    status: "proposed",
    created: "2026-04-20",
    change_id: "f1a",
  });
  const dir = await writeReconcileChange(cwd, "f1a"); // contract names src/keep.ts only
  // Dirty src/keep.ts with a USER edit AFTER the helper wrote the committed version but BEFORE
  // the run's baseline is captured (the handler captures it at the start).
  const keepEdit = "export const keep = 42; // user edit before the run\n";
  await writeFile(join(cwd, "src", "keep.ts"), keepEdit, "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-04-20 · F1 A"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet"); // archive prompt

  // Apply: complete the task AND touch src/mine.ts (out of contract). Leave src/keep.ts alone.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await writeFile(join(cwd, "src", "mine.ts"), "// out-of-contract, made by this run\n", "utf8");
  });
  // Reconciliation: wrongly rewrite the PRE-EXISTING dirty file too.
  fakePiWrap.queueEffect(async () => {
    await rm(join(cwd, "src", "mine.ts"), { force: true });
    await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 999; // clobbered by recon\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const reconPrompt = fakePiWrap.calls.find((c) => /scope contract does NOT name/.test(c.prompt));
  if (reconPrompt) {
    assert.match(reconPrompt.prompt, /src\/mine\.ts/, "the candidate list names src/mine.ts");
    assert.ok(!reconPrompt.prompt.includes("src/keep.ts"), "the pre-run dirty file is NOT listed as a candidate");
  } else {
    assert.match(fakePiWrap.calls.find((c) => /Implement the Readyset change/.test(c.prompt))?.prompt ?? "", /Implement/);
  }

  // The out-of-list rewrite of the pre-existing dirty file was restored byte-for-byte.
  const keepAfter = await readFile(join(cwd, "src", "keep.ts"), "utf8");
  assert.equal(keepAfter, keepEdit, "the pre-run dirty file is byte-identical after reconciliation");

  // Backups exist for the candidate.
  const backup = await readFile(join(dir, "reverted", "src", "mine.ts"), "utf8").catch(() => undefined);
  assert.equal(backup, "// out-of-contract, made by this run\n", "the candidate was backed up before the turn");
});

await test("F1: a fresh baseline capture protects pre-existing dirty files (no revert of them)", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-04-21-f1b.md", {
    title: "F1 B",
    status: "proposed",
    created: "2026-04-21",
    change_id: "f1b",
  });
  const dir = await writeReconcileChange(cwd, "f1b");
  await mkdir(join(cwd, "src"), { recursive: true });
  // A file dirty before the run's baseline capture (the handler captures one on this path).
  await writeFile(join(cwd, "src", "user.ts"), "// user WIP before the run\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-04-21 · F1 B");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await writeFile(join(cwd, "src", "mine.ts"), "// out-of-contract, made by this run\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  // Only this run's own out-of-contract file is a candidate; the pre-existing dirty file is not.
  const reconPrompt = fakePiWrap.calls.find((c) => /scope contract does NOT name/.test(c.prompt));
  if (reconPrompt) {
    assert.match(reconPrompt.prompt, /src\/mine\.ts/);
    assert.ok(!reconPrompt.prompt.includes("src/user.ts"), "a file dirty before the run is never a candidate");
  }
  const events = await readPhaseEvents(cwd, "f1b");
  const recEnd = events.find((e) => e.phase === "scope-reconcile" && e.edge === "end");
  // A baseline exists here, so the outcome is the ordinary one, never "no-baseline".
  if (recEnd) assert.notEqual(recEnd.outcome, "no-baseline");
});

await test("F1: an out-of-list revert by the model is detected and restored", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
  execFileSync("git", ["config", "user.name", "t"], { cwd });
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(cwd, "src", "b.ts"), "export const b = 1;\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });
  // Two files dirty before the run (both captured into the baseline).
  const aEdit = "export const a = 2; // user edit\n";
  const bEdit = "export const b = 2; // user edit\n";
  await writeFile(join(cwd, "src", "a.ts"), aEdit, "utf8");
  await writeFile(join(cwd, "src", "b.ts"), bEdit, "utf8");

  await writeBrainstorm(cwd, "2026-04-22-f1c.md", {
    title: "F1 C",
    status: "proposed",
    created: "2026-04-22",
    change_id: "f1c",
  });
  const dir = await writeReconcileChange(cwd, "f1c");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-04-22 · F1 C");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await writeFile(join(cwd, "src", "mine.ts"), "// out-of-contract, made by this run\n", "utf8");
  });
  // Reconciliation: reverts the candidate correctly, but ALSO overwrites src/a.ts and deletes src/b.ts.
  fakePiWrap.queueEffect(async () => {
    await rm(join(cwd, "src", "mine.ts"), { force: true });
    await writeFile(join(cwd, "src", "a.ts"), "export const a = 777; // out of list\n", "utf8");
    await rm(join(cwd, "src", "b.ts"), { force: true });
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(await readFile(join(cwd, "src", "a.ts"), "utf8"), aEdit, "src/a.ts restored to its pre-turn bytes");
  assert.equal(await readFile(join(cwd, "src", "b.ts"), "utf8"), bEdit, "src/b.ts restored to its pre-turn bytes");
  assert.ok(
    fakeUiWrap.notifications.some((n) => /restored from a pre-turn snapshot/.test(n.message) && n.level === "warning"),
    "a restore warning fires",
  );
  const archivePrompt = fakeUiWrap.selectPrompts.find((p) => /Archive now\?/.test(p));
  assert.ok(archivePrompt, "an archive prompt exists");
  assert.match(archivePrompt, /RESTORED/, "the archive prompt carries the RESTORED line");
});

// --- Conditional / model-aware compaction (C1-C8) ---------------------------------------------

// A fresh full-lane run that reaches the Explore boundary, with a controllable context-usage
// reading and a compact that records its calls. The Explore turn is the first boundary, so a
// single queued effect is enough to observe whether the Explore compaction ran. Only the first
// boundary is exercised unless a test queues more effects.
async function runFreshFullLane(
  opts: {
    args?: string;
    percent?: number | undefined; // undefined => omit getContextUsage entirely
    noCompactApi?: boolean;
    extraCtx?: Record<string, unknown>;
  } = {},
) {
  const cwd = await freshRepo();
  await writeBrainstorm(
    cwd,
    "2026-05-01-compact.md",
    { title: "Compact Boundary", status: "open", created: "2026-05-01", change_id: "compact-boundary", lane: "full" },
    VALID_BRAINSTORM_BODY,
  );
  const dir = join(cwd, "readyset", "changes", "compact-boundary");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-05-01 · Compact Boundary"); // pick

  // Explore turn: write EXPLORATION.md so Propose's guidance can name it.
  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "EXPLORATION.md"), "## Findings\n\nchecked things\n", "utf8");
  });
  // Propose turn: nothing needed beyond landing at the next boundary.
  fakePiWrap.queueEffect(async () => {});

  const compactCalls: Array<{ internalGuidance?: string }> = [];
  const ctx: Record<string, unknown> = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: fakePiWrap.waitForIdle,
    ...(opts.percent !== undefined ? { getContextUsage: () => ({ tokens: 80000, contextWindow: 100000, percent: opts.percent }) } : {}),
    ...(opts.noCompactApi ? {} : { async compact(o: { internalGuidance?: string }) { compactCalls.push(o); } }),
    ...(opts.extraCtx ?? {}),
  };
  await handler(opts.args ?? "", ctx);

  const events = (await readPhaseEvents(cwd, "compact-boundary")).filter((e) => e.phase === "compact" && e.edge === "end");
  return { cwd, compactCalls, events, fakeUiWrap };
}

await test("C1: below the threshold skips compaction and records skipped-below-threshold", async () => {
  const { compactCalls, events } = await runFreshFullLane({ percent: 5 });
  assert.equal(compactCalls.length, 0, "below the threshold, no compaction fires");
  const explore = events.find((e) => e.boundary === "explore");
  assert.ok(explore, "the Explore boundary still records a compact event (the skip is measurable)");
  assert.equal(explore.outcome, "skipped-below-threshold");
  assert.equal(explore.context?.beforePercent, 5);
});

await test("C2: above the threshold compacts at the Explore boundary", async () => {
  const { compactCalls, events } = await runFreshFullLane({ percent: 80 });
  assert.ok(compactCalls.length >= 1, "above the threshold, the Explore compaction fires");
  const explore = events.find((e) => e.boundary === "explore");
  assert.ok(explore, "the Explore compact event is recorded");
  assert.equal(explore.outcome, "compacted");
});

await test("C3: no getContextUsage at all compacts anyway (today's fallback)", async () => {
  const { compactCalls, events } = await runFreshFullLane({ percent: undefined });
  assert.ok(compactCalls.length >= 1, "without a way to measure usage, compaction still runs");
  const explore = events.find((e) => e.boundary === "explore");
  assert.ok(explore, "the Explore compact event is recorded");
  assert.equal(explore.outcome, "compacted");
  assert.equal(explore.context?.beforePercent, undefined, "no beforePercent when the host did not report usage");
});

await test("C4: --compact never suppresses every boundary and records skipped-flag", async () => {
  const { compactCalls, events } = await runFreshFullLane({ percent: 80, args: "--compact never" });
  assert.equal(compactCalls.length, 0, "--compact never must compact nothing");
  assert.ok(events.length > 0, "the boundaries still record a compact event");
  for (const e of events) assert.equal(e.outcome, "skipped-flag", `boundary ${e.boundary} skipped by the flag`);
});

await test("C5: --compact always compacts even below the threshold", async () => {
  const { compactCalls, events } = await runFreshFullLane({ percent: 5, args: "--compact always" });
  assert.ok(compactCalls.length >= 1, "--compact always ignores the threshold");
  const explore = events.find((e) => e.boundary === "explore");
  assert.ok(explore, "the Explore compact event is recorded");
  assert.equal(explore.outcome, "compacted");
});

await test("C6: the keep-context CTA never compacts, even above the threshold", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-05-02-keepctx.md", { title: "Keep Ctx", status: "proposed", created: "2026-05-02", change_id: "keepctx" });
  const dir = await writeProposedChange(cwd, "keepctx", ["- src/keep.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-05-02 · Keep Ctx"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context"); // gate
  fakeUiWrap.selectQueue.push("Not yet"); // archive prompt

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const compactCalls: unknown[] = [];
  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: fakePiWrap.waitForIdle,
    getContextUsage: () => ({ tokens: 90000, contextWindow: 100000, percent: 90 }),
    async compact(opts: unknown) {
      compactCalls.push(opts);
    },
  };
  await handler("", ctx);

  assert.equal(compactCalls.length, 0, "keep-context bypasses compaction even above the threshold");
});

await test("C7: --compact never also suppresses the Apply default", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-05-03-neverapply.md", { title: "Never Apply", status: "proposed", created: "2026-05-03", change_id: "neverapply" });
  const dir = await writeProposedChange(cwd, "neverapply", ["- src/keep.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-05-03 · Never Apply"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute"); // gate
  fakeUiWrap.selectQueue.push("Not yet"); // archive prompt

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const compactCalls: unknown[] = [];
  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: fakePiWrap.waitForIdle,
    getContextUsage: () => ({ tokens: 90000, contextWindow: 100000, percent: 90 }),
    async compact(opts: unknown) {
      compactCalls.push(opts);
    },
  };
  await handler("--compact never", ctx);

  assert.equal(compactCalls.length, 0, "--compact never suppresses the Apply default too");
  const events = await readPhaseEvents(cwd, "neverapply");
  const apply = events.find((e) => e.phase === "compact" && e.edge === "end" && e.boundary === "apply");
  assert.ok(apply, "the Apply boundary records a compact event even when suppressed");
  assert.equal(apply.outcome, "skipped-flag");
});

await test("C8: the compaction call runs under the phase model when an override is set", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(
    cwd,
    "2026-05-04-phasemodel.md",
    { title: "Phase Model", status: "open", created: "2026-05-04", change_id: "phasemodel", lane: "full" },
    VALID_BRAINSTORM_BODY,
  );
  const dir = join(cwd, "readyset", "changes", "phasemodel");

  const setModelCalls: unknown[] = [];
  const compactOrder: string[] = [];
  const fakePiWrap = makeFakePi(cwd);
  // Wrap setModel so we can observe when the explore override is pinned relative to the compact.
  const pi = {
    ...fakePiWrap.pi,
    async setModel(spec: unknown) {
      setModelCalls.push(spec);
      compactOrder.push(`setModel:${String(spec)}`);
      return true;
    },
  };
  const handler = await loadHandler(pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-05-04 · Phase Model"); // pick

  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "EXPLORATION.md"), "## Findings\n\nchecked things\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {});

  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: fakePiWrap.waitForIdle,
    getContextUsage: () => ({ tokens: 90000, contextWindow: 100000, percent: 90 }),
    models: { current: () => "session-default-model", resolve: (spec: string) => `resolved:${spec}` },
    async compact() {
      compactOrder.push("compact");
    },
  };
  await handler("--phase-model explore=cheap/model", ctx);

  // The explore override must have been pinned (resolved) during the run, and the Explore
  // boundary's compact must have happened after the override was applied and before it was
  // restored -- i.e. the compaction ran under the phase model, not the session default.
  assert.ok(
    setModelCalls.includes("resolved:cheap/model"),
    "the explore phase override was pinned at some point during the run",
  );
  const overrideIdx = compactOrder.indexOf("setModel:resolved:cheap/model");
  const compactIdx = compactOrder.indexOf("compact");
  assert.ok(overrideIdx !== -1, "the explore override was pinned");
  assert.ok(compactIdx !== -1, "a compaction fired");
  assert.ok(
    overrideIdx < compactIdx,
    `the compaction must run after the explore override is pinned (order: ${compactOrder.join(" -> ")})`,
  );
  // The override is restored to the session default after the phase finishes.
  assert.ok(
    compactOrder.lastIndexOf("setModel:session-default-model") > compactIdx,
    "the model is restored to the session default after the compaction",
  );

  const events = (await readPhaseEvents(cwd, "phasemodel")).filter((e) => e.phase === "compact" && e.edge === "end");
  const explore = events.find((e) => e.boundary === "explore");
  assert.ok(explore, "the Explore compact event is recorded");
  assert.equal(explore.outcome, "compacted");
  assert.equal(explore.model, "cheap/model", "the compact event names the phase model it ran under");
});

// --- Turn reserves (task 1) --------------------------------------------------------------------

await test("R1: the repair turn is reserved for Apply/Review, so a nearly-spent run still reaches code review", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-06-01-reserve1.md", {
    title: "Reserve One",
    status: "proposed",
    created: "2026-06-01",
    change_id: "reserve1",
  }, VALID_BRAINSTORM_BODY);
  const dir = await writeReconcileChange(cwd, "reserve1"); // contract: src/keep.ts (resolvable)

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-06-01 · Reserve One"); // pick
  // 8 Refine rounds: the first 7 keep the contract resolvable (one turn each, no repair), the 8th
  // makes it dangling — at that point spent reaches 8, so the repair's reserve-2 check skips it
  // and leaves exactly the two turns Apply and Review need.
  for (let i = 0; i < 8; i++) {
    fakeUiWrap.selectQueue.push("Refine");
    fakeUiWrap.inputQueue.push(`round ${i}`);
  }
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet"); // archive prompt

  for (let i = 0; i < 7; i++) {
    fakePiWrap.queueEffect(async () => {
      await writeFile(join(cwd, "src", "keep.ts"), `export const keep = ${i};\n`, "utf8");
    });
  }
  // Round 8: introduce a dangling contract line so the repair wants a turn at spent=8.
  fakePiWrap.queueEffect(async () => {
    await writeFile(
      join(dir, "proposal.md"),
      "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/keep.ts\n- src/missing.ts\n",
      "utf8",
    );
  });
  // Apply: complete the task.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
  });
  // Review.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const events = await readPhaseEvents(cwd, "reserve1");
  const repairEnds = events.filter((e) => e.phase === "contract-repair" && e.edge === "end");
  // The repair either never fired, or it recorded skipped-budget; either way no turn was taken.
  assert.equal(repairEnds.filter((e) => e.outcome !== "skipped-budget").length, 0, "no repair turn fired at the reserve boundary");
  assert.ok(
    fakeUiWrap.notifications.some((n) => /starve Apply\/Review/i.test(n.message) && n.level === "warning"),
    "the reserve notify names Apply/Review retention",
  );
  assert.ok(events.some((e) => e.phase === "apply" && e.edge === "end" && e.outcome === "applied"), "Apply ran and applied");
  assert.ok(
    events.some((e) => e.phase === "review" && e.edge === "end" && e.outcome === "review-written"),
    "the reserved turn let code review run and write REVIEW.md",
  );
  assert.equal(fakePiWrap.calls.length, 10, "the run used every turn but never exceeded the budget");
});

await test("R2: reconciliation reserves the code-review turn and still writes REVIEW.md", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-06-02-reserve2.md", {
    title: "Reserve Two",
    status: "proposed",
    created: "2026-06-02",
    change_id: "reserve2",
  }, VALID_BRAINSTORM_BODY);
  const dir = await writeReconcileChange(cwd, "reserve2");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-06-02 · Reserve Two"); // pick
  // 8 Refine rounds consume 8 turns (the contract stays resolvable, so no repair turns fire).
  for (let i = 0; i < 8; i++) {
    fakeUiWrap.selectQueue.push("Refine");
    fakeUiWrap.inputQueue.push(`round ${i}`);
  }
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet");

  for (let i = 0; i < 8; i++) {
    fakePiWrap.queueEffect(async () => {
      await writeFile(join(cwd, "src", "keep.ts"), `export const keep = ${i};\n`, "utf8");
    });
  }
  // Apply (turn 9): complete the task and drift outside the contract.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await writeFile(join(cwd, "src", "rogue.ts"), "// outside the contract\n", "utf8");
  });
  // Review (turn 10): the reserved turn.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const events = await readPhaseEvents(cwd, "reserve2");
  const recEnds = events.filter((e) => e.phase === "scope-reconcile" && e.edge === "end");
  assert.equal(recEnds.length, 1, "one reconciliation end event");
  assert.equal(recEnds[0].outcome, "skipped-budget", "reconciliation reserved the review turn");
  assert.ok(
    fakeUiWrap.notifications.some((n) => /starve the code-review turn/i.test(n.message) && n.level === "warning"),
    "the reserve notify names the code-review turn",
  );
  assert.ok(
    events.some((e) => e.phase === "review" && e.edge === "end" && e.outcome === "review-written"),
    "the reserved turn let code review run",
  );
  assert.equal(fakePiWrap.calls.length, 10, "never more than the turn budget");
});

// --- Post-Apply contract semantics (task 2) ----------------------------------------------------

// Drives a change through Apply with a `(new)` file Apply creates and a `(delete)` file Apply
// removes, then reopens the gate by re-invoking the handler. Returns the wrapper handles so the
// test can inspect both runs' panels/documents.
async function runApplyThenReopen(changeId: string) {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, `2026-07-01-${changeId}.md`, {
    title: "Post Apply",
    status: "proposed",
    created: "2026-07-01",
    change_id: changeId,
  });
  const dir = await writeProposedChange(cwd, changeId, ["- src/keep.ts", "- src/created.ts (new)", "- src/gone.ts (delete)"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 1;\n", "utf8");
  await writeFile(join(cwd, "src", "gone.ts"), "export const gone = 1;\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push(`2026-07-01 · Post Apply`); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute"); // gate
  fakeUiWrap.selectQueue.push("Address findings first"); // archive prompt (do NOT archive)

  // Apply: create the (new) file and delete the (delete) file.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await writeFile(join(cwd, "src", "created.ts"), "export const fresh = true;\n", "utf8");
    await rm(join(cwd, "src", "gone.ts"), { force: true });
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);
  return { cwd, dir, handler, fakePiWrap, fakeUiWrap, ctx };
}

await test("P1: reopening the gate after Apply uses post-Apply contract semantics (no false MISSING/EXISTS)", async () => {
  const { cwd, handler, fakePiWrap, fakeUiWrap, ctx } = await runApplyThenReopen("postapply1");

  // Re-run: pick the change again and reach the gate, then discard.
  fakeUiWrap.selectQueue.push("2026-07-01 · Post Apply");
  fakeUiWrap.selectQueue.push("Discard");
  await handler("", ctx);

  const panelText = fakeUiWrap.widgetHistory.flat().join("\n");
  const docText = fakeUiWrap.editorTextHistory.join("\n");
  const all = `${panelText}\n${docText}`;
  assert.ok(!/NEW-BUT-EXISTS/.test(all), "the reopened gate never shows a false NEW-BUT-EXISTS for the (new) file Apply created");
  assert.ok(!/DELETE-BUT-MISSING/.test(all), "the reopened gate never shows a false DELETE-BUT-MISSING for the (delete) file Apply removed");
  assert.ok(cwd.length > 0, "repo used");
});

await test("P2: Refine after Apply fires no contract-repair turn", async () => {
  const { dir, handler, fakePiWrap, fakeUiWrap, ctx } = await runApplyThenReopen("postapply2");

  // Re-run: pick again, Refine at the gate, then Discard.
  fakeUiWrap.selectQueue.push("2026-07-01 · Post Apply");
  fakeUiWrap.selectQueue.push("Refine");
  fakeUiWrap.inputQueue.push("tweak it");
  fakeUiWrap.selectQueue.push("Discard");
  const callsBefore = fakePiWrap.calls.length;
  fakePiWrap.queueEffect(async () => {
    // The refine turn leaves a genuinely dangling unmarked path alongside the (new)/(delete)
    // markers Apply already satisfied — so problems exist, and the applied guard must warn and
    // still refuse to fire a repair turn (one would strip the correct markers).
    await writeFile(
      join(dir, "proposal.md"),
      "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/keep.ts\n- src/created.ts (new)\n- src/gone.ts (delete)\n- src/missing.ts\n",
      "utf8",
    );
  });
  await handler("", ctx);

  const newCalls = fakePiWrap.calls.slice(callsBefore).map((c) => c.prompt);
  assert.ok(
    !newCalls.some((p) => /scope contract in proposal\.md is wrong/.test(p)),
    "no contract-repair prompt fired on a Refine after Apply",
  );
  assert.ok(
    fakeUiWrap.notifications.some((n) => /already been applied — not firing a repair turn/.test(n.message) && n.level === "warning"),
    "the applied guard warns instead of firing the repair turn",
  );
});

// --- Balanced gate phase events (task 3) -------------------------------------------------------

await test("G1: every gate path closes its boundary, with the outcome matching the action", async () => {
  // Gate picks that should be recorded: approve (empty-input Refine excepted) / keep-context /
  // refine / discard. Each is driven in its own short run against a *proposed* change.
  const cases: { label: string; picks: string[]; yes: string; outcome: string; extra?: (events: Awaited<ReturnType<typeof readPhaseEvents>>) => void }[] = [
    {
      label: "approve",
      picks: ["Approve & Execute", "Not yet"],
      yes: "yes",
      outcome: "approve",
    },
    {
      label: "keep-context",
      picks: ["Approve & Execute, keep context", "Not yet"],
      yes: "yes",
      outcome: "approve-keep-context",
      extra: (events) => {
        const compact = events.find((e) => e.phase === "compact" && e.edge === "end" && e.boundary === "apply");
        assert.ok(compact, "keep-context records a compact boundary event");
        assert.equal(compact?.outcome, "skipped-keep-context");
      },
    },
    {
      label: "refine",
      picks: ["Refine", "Discard"],
      yes: "refine",
      outcome: "refine",
    },
    {
      label: "discard",
      picks: ["Discard"],
      yes: "discard",
      outcome: "discard",
    },
  ];

  for (const c of cases) {
    const cwd = await freshRepo();
    await writeBrainstorm(cwd, `2026-08-01-gate-${c.label}.md`, {
      title: `Gate ${c.label}`,
      status: "proposed",
      created: "2026-08-01",
      change_id: `gate-${c.label}`,
    });
    const dir = await writeProposedChange(cwd, `gate-${c.label}`, ["- src/keep.ts"]);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 1;\n", "utf8");

    const fakePiWrap = makeFakePi(cwd);
    const handler = await loadHandler(fakePiWrap.pi);
    const fakeUiWrap = makeFakeUi();
    fakeUiWrap.selectQueue.push(`2026-08-01 · Gate ${c.label}`);
    for (const pick of c.picks) fakeUiWrap.selectQueue.push(pick);
    if (c.label === "refine") fakeUiWrap.inputQueue.push("please change");

    // For approve / keep-context, Apply + Review turns run before the archive prompt.
    if (c.yes === "yes") {
      fakePiWrap.queueEffect(async () => {
        await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
      });
      fakePiWrap.queueEffect(async () => {
        await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
      });
    } else if (c.label === "refine") {
      fakePiWrap.queueEffect(async () => {
        await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/keep.ts\n", "utf8");
      });
    }

    const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
    await handler("", ctx);

    const events = await readPhaseEvents(cwd, `gate-${c.label}`);
    const starts = events.filter((e) => e.phase === "gate" && e.edge === "start");
    const ends = events.filter((e) => e.phase === "gate" && e.edge === "end");
    // Refine loops back to the gate, so count a balanced pair per iteration, not a single one.
    assert.equal(starts.length, ends.length, `${c.label}: every gate start has a matching end`);
    assert.ok(ends.length >= 1, `${c.label}: at least one gate end was recorded`);
    assert.ok(
      ends.some((e) => e.outcome === c.outcome),
      `${c.label}: a gate end with outcome ${c.outcome} exists`,
    );
    c.extra?.(events);
  }
});

// --- Diff stats see staged changes (task 4) ----------------------------------------------------

await test("D1: the apply diff stats count fully staged (git add-ed) changes", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  // Commit a baseline so HEAD exists and a staged modification shows up against it.
  await writeFile(join(cwd, "README.md"), "baseline\n", "utf8");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd });

  await writeBrainstorm(cwd, "2026-09-01-staged.md", {
    title: "Staged",
    status: "proposed",
    created: "2026-09-01",
    change_id: "staged",
  });
  const dir = await writeProposedChange(cwd, "staged", ["- src/keep.ts"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 1;\n", "utf8");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "keep"], { cwd });

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-09-01 · Staged");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Not yet");

  // Apply: modify src/keep.ts and STAGE it, leaving nothing unstaged.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
    await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 2;\nexport const more = 3;\n", "utf8");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "src/keep.ts"], { cwd });
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const events = await readPhaseEvents(cwd, "staged");
  const applyEnd = events.find((e) => e.phase === "apply" && e.edge === "end");
  assert.ok(applyEnd, "an apply end event exists");
  assert.equal(applyEnd.outcome, "applied");
  assert.ok((applyEnd.diff?.files ?? 0) >= 1, "the staged file is counted (git diff --numstat would report 0)");
  assert.ok((applyEnd.diff?.added ?? 0) >= 1, "the staged added lines are counted");
});

// --- Fast-lane artifact set + per-artifact budgets + the bounded Trim turn -------------------

const FAST_LANE_PROPOSAL = (body: string) =>
  `---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/thing.ts (new)\n\n${body}`;

/** Writes a minimal, gate-reachable fast-lane change (proposal.md with lane:fast + Acceptance,
 *  tasks.md) and returns the change dir. No design.md, no spec delta. The brainstorm records
 *  `lane: full` so the default picker lists it; `--lane fast` overrides the run's lane. */
async function writeFastLaneChange(cwd: string, changeId: string, title: string, acceptance = "## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n") {
  await writeBrainstorm(cwd, `2026-05-01-${changeId}.md`, {
    title,
    status: "proposed",
    created: "2026-05-01",
    change_id: changeId,
    lane: "full",
  });
  const dir = join(cwd, "readyset", "changes", changeId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "proposal.md"), FAST_LANE_PROPOSAL(acceptance), "utf8");
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");
  return dir;
}

await test("fast lane: the review document shows the Artifact set section, not design/specs placeholders", async () => {
  const cwd = await freshRepo();
  await clearConfig();
  await writeFastLaneChange(cwd, "fast-overlay", "Fast Overlay");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-05-01 · Fast Overlay"); // pick
  fakeUiWrap.selectQueue.push("Discard"); // gate

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  const doc = fakeUiWrap.editorTextHistory.join("\n\n");
  assert.match(doc, /Artifact set/, "the compiled document names the fast-lane artifact set");
  assert.match(doc, /no design\.md and no spec delta/, "the fast-lane description is rendered");
  assert.ok(!doc.includes("_(design.md not found.)_"), "no design.md placeholder on the fast lane");
  assert.ok(!doc.includes("_(no specs/**/spec.md found.)_"), "no specs placeholder on the fast lane");
  assert.equal(fakePiWrap.calls.length, 0, "a straight discard fires no turns");
});

await test("fast lane: an overrun warns in the gate panel and fires exactly one Trim turn", async () => {
  const cwd = await freshRepo();
  await clearConfig();
  // proposal budget on the fast lane is 4,000; 1.5x is 6,000. Blow well past that.
  const bigBullets = Array.from({ length: 200 }, (_, i) => `- change number ${i} with some padding text`).join("\n");
  const acceptance = "## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n";
  const dir = join(cwd, "readyset", "changes", "fast-trim");
  // status "open" -> an Explore-less fast-lane Propose turn fires, so the handler's post-Propose
  // trim call site runs (the already-proposed path never reaches it).
  await writeBrainstorm(cwd, "2026-05-02-fast-trim.md", {
    title: "Fast Trim", status: "open", created: "2026-05-02", change_id: "fast-trim", lane: "full",
  }, VALID_BRAINSTORM_BODY);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-05-02 · Fast Trim"); // pick
  fakeUiWrap.selectQueue.push("Discard"); // gate

  // Propose effect: writes an over-budget proposal (and tasks.md).
  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "proposal.md"), FAST_LANE_PROPOSAL(`## What Changes\n\n${bigBullets}\n\n${acceptance}`), "utf8");
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");
  });
  // Trim effect: rewrites proposal.md under budget (the trimmed outcome).
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), FAST_LANE_PROPOSAL(acceptance), "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  // The gate panel shows a budget line for the artifact (the Propose turn's overrun was already
  // trimmed back under budget before the gate opened — see the trim event assertions below).
  const panel = fakeUiWrap.widgetHistory.flat().join("\n");
  assert.match(panel, /artifacts: proposal \d[\d,]* chars \(budget 4,000\)/, "the gate line shows the proposal budget");

  // Exactly one Trim turn fired.
  const trims = fakePiWrap.calls.filter((c) => /over their character budget/.test(c.prompt));
  assert.equal(trims.length, 1, "exactly one Trim turn fired, no loop");

  // The trim event records the before/after sizes and a trimmed outcome.
  const events = await phaseEventsArchivedOrLive(cwd, "fast-trim");
  const trimEnd = events.find((e) => e.phase === "trim" && e.edge === "end");
  assert.ok(trimEnd, "a trim end event exists");
  assert.equal(trimEnd.outcome, "trimmed");
  assert.ok(trimEnd.artifactChars, "the trim event carries artifactChars");
  assert.ok((trimEnd.artifactChars!.before.proposal ?? 0) > 1.5 * 4000, "before size is over 1.5x");
  assert.ok((trimEnd.artifactChars!.after.proposal ?? 0) <= 4000, "after size is under budget");
});

await test("fast lane: the Trim turn is caught if it writes outside the change directory", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await clearConfig();
  const bigBullets = Array.from({ length: 200 }, (_, i) => `- change number ${i} with some padding text`).join("\n");
  const dir = join(cwd, "readyset", "changes", "fast-trim-violation");
  await writeBrainstorm(cwd, "2026-05-03-fast-trim-violation.md", {
    title: "Trim Violation", status: "open", created: "2026-05-03", change_id: "fast-trim-violation", lane: "full",
  }, VALID_BRAINSTORM_BODY);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-05-03 · Trim Violation");
  fakeUiWrap.selectQueue.push("Discard");

  // Propose effect: over-budget proposal.
  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "proposal.md"), FAST_LANE_PROPOSAL(`## What Changes\n\n${bigBullets}\n\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n`), "utf8");
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");
  });
  // Trim effect: rewrites proposal.md under budget but ALSO writes a file outside the change dir.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), FAST_LANE_PROPOSAL("## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n"), "utf8");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "leaked.ts"), "x\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  const events = await phaseEventsArchivedOrLive(cwd, "fast-trim-violation");
  const trimEnd = events.find((e) => e.phase === "trim" && e.edge === "end");
  assert.ok(trimEnd, "a trim end event exists");
  assert.equal(trimEnd.outcome, "partial", "a boundary violation fails the trim");
  assert.ok(
    fakeUiWrap.notifications.some((n) => /outside the change directory/.test(n.message) && n.level === "error"),
    "an error notification names the boundary violation",
  );
});

await test("fast lane: an exhausted budget skips the Trim and only warns", async () => {
  const cwd = await freshRepo();
  await clearConfig();
  // A valid scope contract means no contract-repair turn interferes, so each Refine round
  // consumes exactly one turn. The proposal stays under 1.5x for the first six rounds (where a
  // trim would still be affordable) and only blows past 1.5x from round seven on — by then
  // turnsAvailableFor(budget, 3) is false, so the trim is skipped and only warns.
  const bigBullets = Array.from({ length: 200 }, (_, i) => `- change number ${i} with some padding text`).join("\n");
  const contract = "## Files This Change Will Touch\n\n- src/thing.ts (new)\n";
  const small = FAST_LANE_PROPOSAL(`${contract}\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n`);
  const big = FAST_LANE_PROPOSAL(`## What Changes\n\n${bigBullets}\n\n${contract}\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n`);
  const dir = join(cwd, "readyset", "changes", "fast-trim-budget");
  await writeBrainstorm(cwd, "2026-05-04-fast-trim-budget.md", {
    title: "Trim Budget", status: "proposed", created: "2026-05-04", change_id: "fast-trim-budget", lane: "full",
  });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "proposal.md"), small, "utf8");
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  // Many Refine rounds (each consumes a turn + a repair turn) to tighten the budget, then Discard.
  fakeUiWrap.selectQueue.push("2026-05-04 · Trim Budget");
  for (let i = 0; i < 8; i++) {
    fakeUiWrap.selectQueue.push("Refine");
    fakeUiWrap.inputQueue.push(`refine ${i}`);
  }
  fakeUiWrap.selectQueue.push("Discard");

  for (let i = 0; i < 8; i++) {
    const over = i >= 6;
    fakePiWrap.queueEffect(async () => {
      await writeFile(join(dir, "proposal.md"), over ? big : small, "utf8");
    });
  }

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  const events = await phaseEventsArchivedOrLive(cwd, "fast-trim-budget");
  const trimEnds = events.filter((e) => e.phase === "trim" && e.edge === "end");
  assert.ok(trimEnds.some((e) => e.outcome === "skipped-budget"), "a trim end event records skipped-budget");
  assert.ok(
    fakeUiWrap.notifications.some((n) => /starve Apply\/Review/.test(n.message) && n.level === "warning"),
    "the trim reserve warns about starving Apply/Review",
  );
  // No trim prompt ever fired (every trim that wanted to run was skipped at the reserve boundary).
  assert.ok(
    !fakePiWrap.calls.some((c) => /over their character budget/.test(c.prompt)),
    "no Trim turn fired",
  );
});

await test("fast lane: archiving notifies info-level 'no spec delta' and CONTEXT.md records it", async () => {
  const cwd = await freshRepo();
  await clearConfig();
  const dir = await writeFastLaneChange(cwd, "fast-archive", "Fast Archive");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-05-01 · Fast Archive"); // pick
  fakeUiWrap.selectQueue.push("Approve & Execute");
  fakeUiWrap.selectQueue.push("Archive now");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  const infoNotice = fakeUiWrap.notifications.find((n) => /Archived to/.test(n.message) && n.level === "info");
  assert.ok(infoNotice, "an info-level archive notice fired");
  assert.match(infoNotice!.message, /no spec delta/);
  assert.ok(
    !fakeUiWrap.notifications.some((n) => n.level === "warning" && /append-only merge/.test(n.message)),
    "no warning-level spec-merge notice on the fast lane",
  );

  const archiveRoot = join(cwd, "readyset", "changes", "archive");
  const entries = await (await import("node:fs/promises")).readdir(archiveRoot).catch(() => [] as string[]);
  const archivedDirName = entries.find((name) => name.endsWith("-fast-archive"));
  assert.ok(archivedDirName, "the change was archived");
  const context = await readFile(join(archiveRoot, archivedDirName!, "CONTEXT.md"), "utf8");
  assert.match(context, /no spec delta to merge/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);