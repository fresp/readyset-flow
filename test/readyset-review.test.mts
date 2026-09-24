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
const NOTES_REQUIRED_CONFIG = "readyset:\n  verify:\n    requireNotes: true\n";

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
  const outsideHandlers: ((event: unknown, ctx: { cwd?: string }) => void)[] = [];
  const agentEndHandlers: ((event: unknown, ctx: unknown) => Promise<void> | void)[] = [];
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
      // omp's real extension API fires `tool_call` before each tool runs. Capture the handler so
      // the tripwire tests can drive it; existing tests never call it, so counts stay 0.
      on(event: string, handler: (event: unknown, ctx: { cwd?: string }) => void) {
        if (event === "tool_call") outsideHandlers.push(handler);
        if (event === "agent_end") agentEndHandlers.push(handler);
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
    outsideHandlers,
    agentEndHandlers,
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
  const widgetHistory: (string[] | undefined)[] = [];
  const widgetKeys: string[] = [];
  const editorTextHistory: string[] = [];
  const selectQueue: (string | undefined)[] = [];
  const inputQueue: (string | undefined)[] = [];
  const selectPrompts: string[] = [];
  const selectOptions: unknown[] = [];
  return {
    ui: {
      async select(prompt: string, options: unknown, _opts?: unknown) {
        selectPrompts.push(prompt);
        selectOptions.push(options);
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
      // array and content = undefined -- so the panel never rendered at all. `content` is
      // `string[] | undefined`: undefined with the same key clears the widget (the Review Gate
      // handoff does exactly that before handing off to omp).
      setWidget(key: string, content: string[] | undefined) {
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
    selectOptions,
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

// Loads one fresh module instance and captures BOTH the command handler and the pi.on("agent_end")
// handler from the same instance, so the module-level activeGrillSession set by startGrilling is
// the one the agent_end handler sees.
async function loadHandlerAndAgentEnd(fakePi: { sendUserMessage: (prompt: string, opts: unknown) => void }): Promise<{
  handler: (args: string, ctx: unknown) => Promise<void>;
  agentEnd: (event: unknown, ctx: unknown) => Promise<void>;
}> {
  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let capturedHandler: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  let capturedAgentEnd: ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
  mod.default({
    ...fakePi,
    registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      capturedHandler = def;
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
      if (event === "agent_end") capturedAgentEnd = handler;
    },
    registerTool(_def: unknown) {},
    zod: fakeZod,
  } as any);
  if (!capturedHandler) throw new Error("registerCommand was never called");
  if (!capturedAgentEnd) throw new Error("the agent_end handler was never registered");
  return { handler: capturedHandler.handler, agentEnd: async (event, ctx) => void (await capturedAgentEnd!(event, ctx)) };
}

// Same as loadHandlerAndAgentEnd, plus the readyset_verify tool's execute() from the SAME module
// instance, so activeVerifyChangeId (module-level) is genuinely shared between the handler's
// approve branch and the tool.
async function loadHandlerAgentEndAndVerify(fakePi: { sendUserMessage: (prompt: string, opts: unknown) => void }): Promise<{
  handler: (args: string, ctx: unknown) => Promise<void>;
  agentEnd: (event: unknown, ctx: unknown) => Promise<void>;
  verifyExecute: (toolCallId: string, params: { taskId: string; command: string }, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: { type: string; text: string }[] }>;
}> {
  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let capturedHandler: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  let capturedAgentEnd: ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
  let capturedVerify: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
  mod.default({
    ...fakePi,
    registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      capturedHandler = def;
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
      if (event === "agent_end") capturedAgentEnd = handler;
    },
    registerTool(def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      if (def.name === "readyset_verify") capturedVerify = def;
    },
    zod: fakeZod,
  } as any);
  if (!capturedHandler) throw new Error("registerCommand was never called");
  if (!capturedAgentEnd) throw new Error("the agent_end handler was never registered");
  if (!capturedVerify) throw new Error("readyset_verify was never registered");
  return {
    handler: capturedHandler.handler,
    agentEnd: async (event, ctx) => void (await capturedAgentEnd!(event, ctx)),
    verifyExecute: capturedVerify.execute as any,
  };
}

// Same as loadHandlerAndAgentEnd, plus the session_stop verification-gate handler from the SAME
// module instance, so activeVerifyChangeId/sessionStopBlockCounts (module-level) are shared.
async function loadHandlerAgentEndAndSessionStop(fakePi: { sendUserMessage: (prompt: string, opts: unknown) => void }): Promise<{
  handler: (args: string, ctx: unknown) => Promise<void>;
  agentEnd: (event: unknown, ctx: unknown) => Promise<void>;
  sessionStop: (event: unknown, ctx: unknown) => Promise<{ decision?: string; reason?: string } | undefined>;
}> {
  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as {
    default: (pi: unknown) => void;
  };
  let capturedHandler: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  let capturedAgentEnd: ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
  let capturedSessionStop: ((event: unknown, ctx: unknown) => Promise<{ decision?: string; reason?: string } | undefined> | { decision?: string; reason?: string } | undefined) | undefined;
  mod.default({
    ...fakePi,
    registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      capturedHandler = def;
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (event === "agent_end") capturedAgentEnd = handler as any;
      if (event === "session_stop") capturedSessionStop = handler as any;
    },
    registerTool(_def: unknown) {},
    zod: fakeZod,
  } as any);
  if (!capturedHandler) throw new Error("registerCommand was never called");
  if (!capturedAgentEnd) throw new Error("the agent_end handler was never registered");
  if (!capturedSessionStop) throw new Error("the session_stop handler was never registered");
  return {
    handler: capturedHandler.handler,
    agentEnd: async (event, ctx) => void (await capturedAgentEnd!(event, ctx)),
    sessionStop: async (event, ctx) => await capturedSessionStop!(event, ctx),
  };
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

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(fakePiWrap.calls.length, 3);
  assert.match(fakePiWrap.calls[0].prompt, /Explore the ground truth for the Readyset change "my-feature"/);
  assert.match(fakePiWrap.calls[1].prompt, /Create a Readyset change named "my-feature"/);
  assert.ok(!/FAST lane/.test(fakePiWrap.calls[1].prompt), "full-lane Propose must not carry the fast-lane suffix");
  assert.match(fakePiWrap.calls[2].prompt, /Implement the Readyset change "my-feature"/);

  // Brainstorm file should now say approved (markApproved happened before apply handoff)
  const raw = await readFile(join(cwd, ".ai", "brainstorms", "2026-01-01-my-feature.md"), "utf8");
  assert.match(raw, /status: approved/);
  assert.ok(fakeUiWrap.notifications.some((n) => /Handing off execution to core omp/.test(n.message)));

  // Simulate core omp completing the tasks
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 do thing\n  _Verified: ran the thing, it worked_\n", "utf8");

  // On-demand code review and archive
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nNo blockers found.\n", "utf8");
  });
  fakeUiWrap.selectQueue.push("Archive now");
  await handler("--review my-feature", ctx);

  assert.equal(fakePiWrap.calls.length, 4);
  assert.match(fakePiWrap.calls[3].prompt, /Critically review the implementation of Readyset change "my-feature"/);
  assert.ok(!/mutation-testing-style/.test(fakePiWrap.calls[3].prompt), "full-lane review keeps mutation-testing depth");

  // Archive happened: change dir moved, main spec created
  const mainSpec = await readFile(join(cwd, "readyset", "specs", "my-cap", "spec.md"), "utf8");
  assert.match(mainSpec, /Foo/);

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

// --- grill -> propose transition from the agent_end hook -----------------------------------------
//
// The grill -> propose transition runs from omp's `agent_end` hook, whose ctx is the general
// `ExtensionContext` -- it has isIdle/hasPendingMessages but NO waitForIdle (that only exists on
// `ExtensionCommandContext`, i.e. the /readyset command handler's ctx). These tests drive the
// captured agent_end handler with exactly such a ctx.

// Shared setup for the four transition tests: an idea that is already on disk (so a real
// grilling conversation would have already produced it), and a command-style ctx whose waitForIdle
// drains the queued turn effects (mirroring the fake pi's fire-and-forget send -> waitForIdle
// contract).
//
// Note on filenames: `startGrilling` snapshots `.ai/brainstorms/*.md` into `existingFiles`, and
// `findNewlyWrittenBrainstorm` only reports a file that is NOT in that snapshot. The command
// handler's own grill turn fires *before* the pre-seeded file exists, and the queued grill effect
// writes it -- that is the sequence `--idea` produces in a real session.
async function queueTransitionTurns(
  fakePiWrap: ReturnType<typeof makeFakePi>,
  cwd: string,
  dir: string,
  proposeExtra?: (dir: string) => Promise<void>,
) {
  // The grill turn itself: writes the brainstorm the transition is waiting for.
  fakePiWrap.queueEffect(async () => {
    await writeBrainstorm(cwd, "2026-01-01-idea.md", {
      title: "Idea",
      status: "open",
      created: "2026-01-01",
    }, VALID_BRAINSTORM_BODY);
  });
  // Explore turn: writes EXPLORATION.md.
  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "EXPLORATION.md"), "## Findings\n\nChecked docker-compose.yml, nothing relevant.\n", "utf8");
  });
  // Propose turn: writes valid artifacts (plus anything the test wants to leak).
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
    if (proposeExtra) await proposeExtra(dir);
  });
}

await test("grill→propose transition from an agent_end ctx without waitForIdle reaches the review gate", async () => {
  const cwd = await freshRepo();

  const fakePiWrap = makeFakePi(cwd);
  const { handler, agentEnd } = await loadHandlerAndAgentEnd(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  // 1st select: the transition picker. 2nd: the review gate.
  fakeUiWrap.selectQueue.push("Continue to Explore & Propose (Recommended)");
  fakeUiWrap.selectQueue.push("Discard");

  const dir = join(cwd, "readyset", "changes", "idea");
  await queueTransitionTurns(fakePiWrap, cwd, dir);

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--idea Add a health endpoint", ctx);
  assert.equal(fakePiWrap.calls.length, 1, "the command handler fires the grill turn");
  // startGrilling fires the grill turn with a bare pi.sendUserMessage (it is a chat turn the
  // user answers, not a fired-and-awaited one), so nothing drains the queue for us -- do it the
  // way omp would: the turn runs, then agent_end arrives.
  await fakePiWrap.waitForIdle();

  await agentEnd(
    { willContinue: false },
    { cwd, ui: fakeUiWrap.ui, isIdle: () => false, hasPendingMessages: () => false },
  );

  assert.equal(fakePiWrap.calls.length, 3, "grill + explore + propose all fired");
  assert.ok(
    fakeUiWrap.selectPrompts.some((p) => /^Review change "idea"/.test(p)),
    "the review gate was reached after the transition",
  );
  assert.ok(
    !fakeUiWrap.notifications.some((n) => n.level === "error"),
    "no error notification expected, got: " + JSON.stringify(fakeUiWrap.notifications.filter((n) => n.level === "error")),
  );
});

await test("grill→propose transition with neither waitForIdle nor isIdle notifies an error and does not throw", async () => {
  const cwd = await freshRepo();

  const fakePiWrap = makeFakePi(cwd);
  const { handler, agentEnd } = await loadHandlerAndAgentEnd(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("Continue to Explore & Propose (Recommended)");

  const dir = join(cwd, "readyset", "changes", "idea");
  await queueTransitionTurns(fakePiWrap, cwd, dir);

  // The command ctx itself omits waitForIdle too, so the captured session.waitForIdle is
  // undefined and fireTurnAndWait has no way to know when the turn finished.
  await handler("--idea Add a health endpoint", { cwd, ui: fakeUiWrap.ui });
  await fakePiWrap.waitForIdle();

  await agentEnd({ willContinue: false }, { cwd, ui: fakeUiWrap.ui });

  assert.ok(
    fakeUiWrap.notifications.some((n) => /Can't tell when this turn finished/.test(n.message) && n.level === "error"),
    "expected the fail-loudly notification, got: " + JSON.stringify(fakeUiWrap.notifications),
  );
  assert.ok(
    !fakeUiWrap.selectPrompts.some((p) => /^Review change/.test(p)),
    "no gate may be offered when the run could not tell that its turn finished",
  );
});

await test("grill→propose transition with an event ctx that has waitForIdle still works (regression)", async () => {
  const cwd = await freshRepo();

  const fakePiWrap = makeFakePi(cwd);
  const { handler, agentEnd } = await loadHandlerAndAgentEnd(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("Continue to Explore & Propose (Recommended)");
  fakeUiWrap.selectQueue.push("Discard");

  const dir = join(cwd, "readyset", "changes", "idea");
  await queueTransitionTurns(fakePiWrap, cwd, dir);

  await handler("--idea Add a health endpoint", { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle });
  await fakePiWrap.waitForIdle();
  await agentEnd(
    { willContinue: false },
    { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle, isIdle: () => false, hasPendingMessages: () => false },
  );

  assert.equal(fakePiWrap.calls.length, 3);
  assert.ok(fakeUiWrap.selectPrompts.some((p) => /^Review change "idea"/.test(p)));
  assert.ok(!fakeUiWrap.notifications.some((n) => n.level === "error"));
});

// The grill session is armed from the command ctx. When that ctx carries a session id, a foreign
// session's agent_end (same cwd) must not drive the transition; the matching session must.
async function driveGrillToTransition(cwd: string, fakePiWrap: ReturnType<typeof makeFakePi>, fakeUiWrap: ReturnType<typeof makeFakeUi>, handler: (args: string, ctx: unknown) => Promise<void>, commandSessionId?: string) {
  const dir = join(cwd, "readyset", "changes", "idea");
  await queueTransitionTurns(fakePiWrap, cwd, dir);
  const commandCtx: Record<string, unknown> = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  if (commandSessionId !== undefined) commandCtx.sessionManager = { getSessionId: () => commandSessionId };
  await handler("--idea Add a health endpoint", commandCtx);
  await fakePiWrap.waitForIdle();
}

await test("agent_end: a different session id cannot trigger the grill->propose transition", async () => {
  const cwd = await freshRepo();
  const fakePiWrap = makeFakePi(cwd);
  const { handler, agentEnd } = await loadHandlerAndAgentEnd(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("Continue to Explore & Propose (Recommended)");
  fakeUiWrap.selectQueue.push("Discard");

  await driveGrillToTransition(cwd, fakePiWrap, fakeUiWrap, handler, "grill-session");
  assert.equal(fakePiWrap.calls.length, 1, "only the grill turn fired so far");

  await agentEnd(
    { willContinue: false },
    eventCtx(cwd, fakeUiWrap.ui, "foreign-session"),
  );

  assert.ok(
    !fakeUiWrap.selectPrompts.some((p) => /^Review change "idea"/.test(p)),
    "a foreign session must not drive the grill transition: " + JSON.stringify(fakeUiWrap.selectPrompts),
  );
  assert.equal(fakePiWrap.calls.length, 1, "no further turns fired for a foreign session's settle");
});

await test("agent_end: the matching session id triggers the grill->propose transition", async () => {
  const cwd = await freshRepo();
  const fakePiWrap = makeFakePi(cwd);
  const { handler, agentEnd } = await loadHandlerAndAgentEnd(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("Continue to Explore & Propose (Recommended)");
  fakeUiWrap.selectQueue.push("Discard");

  await driveGrillToTransition(cwd, fakePiWrap, fakeUiWrap, handler, "grill-session");

  await agentEnd(
    { willContinue: false },
    { cwd, ui: fakeUiWrap.ui, sessionManager: { getSessionId: () => "grill-session" }, isIdle: () => false, hasPendingMessages: () => false },
  );

  assert.equal(fakePiWrap.calls.length, 3, "grill + explore + propose all fired");
  assert.ok(fakeUiWrap.selectPrompts.some((p) => /^Review change "idea"/.test(p)), "the matching session drives the transition");
});

await test("grill model: --phase-model grill= pins the grill turn, restores before Explore, and the grill event records it", async () => {
  const cwd = await freshRepo();
  await clearConfig();
  const fakePiWrap = makeFakePi(cwd);
  const { handler, agentEnd } = await loadHandlerAndAgentEnd(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("Continue to Explore & Propose (Recommended)");
  fakeUiWrap.selectQueue.push("Discard");
  const dir = join(cwd, "readyset", "changes", "idea");
  await queueTransitionTurns(fakePiWrap, cwd, dir);

  const ctx = {
    cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle,
    models: { current: () => "session-default-model", resolve: (spec: string) => `resolved:${spec}` },
  };
  await handler("--phase-model grill=small/fast --idea Add a health endpoint", ctx);
  assert.deepEqual(fakePiWrap.setModelCalls, ["resolved:small/fast"], "the grill pin is applied before the grill turn fires");
  assert.equal(fakePiWrap.calls.length, 1, "the grill turn fired");
  assert.ok(fakeUiWrap.notifications.some((n) => /Grilling runs on "small\/fast" \(from --phase-model flag\)/.test(n.message)));

  await fakePiWrap.waitForIdle(); // the grill turn writes the brainstorm
  await agentEnd({ willContinue: false }, { cwd, ui: fakeUiWrap.ui, isIdle: () => false, hasPendingMessages: () => false });

  assert.equal(fakePiWrap.setModelCalls[1], "session-default-model", "the pre-grill model is restored once the brainstorm is written");
  assert.equal(fakePiWrap.calls.length, 3, "grill + explore + propose all fired");
  const grillEnd = (await readPhaseEvents(cwd, "idea")).find((e) => e.phase === "grill" && e.edge === "end");
  assert.equal(grillEnd?.model, "small/fast", "the grill event records the model grilling actually ran on");
});

await test("grill model: nothing configured -> no setModel call, and the grill event records no model (never a guess)", async () => {
  const cwd = await freshRepo();
  await clearConfig();
  const fakePiWrap = makeFakePi(cwd);
  const { handler, agentEnd } = await loadHandlerAndAgentEnd(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("Continue to Explore & Propose (Recommended)");
  fakeUiWrap.selectQueue.push("Discard");
  const dir = join(cwd, "readyset", "changes", "idea");
  await queueTransitionTurns(fakePiWrap, cwd, dir);

  const ctx = {
    cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle,
    models: { current: () => "session-default-model", resolve: (spec: string) => `resolved:${spec}` },
  };
  // An explore-only override must not leak onto the grill turn.
  await handler("--phase-model explore=small/fast --idea Add a health endpoint", ctx);
  assert.deepEqual(fakePiWrap.setModelCalls, [], "no grill pin without a grill override or a run pin");
  await fakePiWrap.waitForIdle();
  await agentEnd({ willContinue: false }, { cwd, ui: fakeUiWrap.ui, isIdle: () => false, hasPendingMessages: () => false });

  const grillEnd = (await readPhaseEvents(cwd, "idea")).find((e) => e.phase === "grill" && e.edge === "end");
  assert.ok(grillEnd, "a grill end event is written");
  assert.equal(grillEnd!.model, undefined, "grilling ran on the session model: nothing to record");
});

await test("grill model: an abandoned grill pin is restored by the next /readyset command", async () => {
  const cwd = await freshRepo();
  await clearConfig();
  const fakePiWrap = makeFakePi(cwd);
  const { handler } = await loadHandlerAndAgentEnd(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const ctx = {
    cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle,
    models: { current: () => "session-default-model", resolve: (spec: string) => `resolved:${spec}` },
  };
  await handler("--phase-model grill=small/fast --idea Add a health endpoint", ctx);
  assert.deepEqual(fakePiWrap.setModelCalls, ["resolved:small/fast"]);

  // No brainstorm is ever written; the user runs /readyset again.
  await handler("", ctx);
  assert.equal(fakePiWrap.setModelCalls[1], "session-default-model", "the grill pin is released by the next command");
  // One-shot: a third command does not restore again.
  await handler("", ctx);
  assert.equal(fakePiWrap.setModelCalls.length, 2, "the restore runs once");
});

await test("a planning turn that writes outside the change dir during the transition path trips the propose-boundary invariant", async () => {
  const cwd = await freshRepo();
  await execFileSync("git", ["init", "-q"], { cwd });
  await execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
  await execFileSync("git", ["config", "user.name", "t"], { cwd });
  await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");
  await execFileSync("git", ["add", "-A"], { cwd });
  await execFileSync("git", ["commit", "-qm", "base"], { cwd });

  const fakePiWrap = makeFakePi(cwd);
  const { handler, agentEnd } = await loadHandlerAndAgentEnd(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("Continue to Explore & Propose (Recommended)");

  const dir = join(cwd, "readyset", "changes", "idea");
  await queueTransitionTurns(fakePiWrap, cwd, dir, async () => {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "leak.ts"), "export const leak = 1;\n", "utf8");
  });

  await handler("--idea Add a health endpoint", { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle });
  await fakePiWrap.waitForIdle();
  await agentEnd({ willContinue: false }, { cwd, ui: fakeUiWrap.ui, isIdle: () => false, hasPendingMessages: () => false });

  assert.ok(
    !fakeUiWrap.selectPrompts.some((p) => /^Review change/.test(p)),
    "no gate may be offered once the planning turn wrote outside its boundary",
  );
  assert.ok(
    fakeUiWrap.notifications.some((n) => /changed files outside the change directory/.test(n.message) && n.level === "error"),
    "expected the boundary error, got: " + JSON.stringify(fakeUiWrap.notifications),
  );
  const context = await readContext(cwd, "idea");
  assert.match(context ?? "", /STOPPED — planning turn wrote outside its boundary/);
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

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  // 2 calls: Propose turn + Apply handoff to omp (no Explore)
  assert.equal(fakePiWrap.calls.length, 2);
  assert.ok(!fakePiWrap.calls.some((c) => /Explore the ground truth/.test(c.prompt)), "fast lane must not fire Explore");
  const propose = fakePiWrap.calls.find((c) => /Create a Readyset change/.test(c.prompt));
  assert.ok(propose, "Propose still fires");
  assert.match(propose.prompt, /FAST lane/, "fast-lane Propose carries the tight-planning suffix");
  assert.match(propose.prompt, /at most ~8 tasks/, "fast-lane Propose caps the task count");

  // The override must be announced, since the file said full.
  assert.ok(
    fakeUiWrap.notifications.some((n) => /--lane override.*full/.test(n.message)),
    "the --lane override over a differing recorded lane must notify",
  );

  // Simulate omp completing tasks
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 do thing\n  _Verified: ran the thing, it worked_\n", "utf8");

  // On-demand code review
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nNo blockers found.\n", "utf8");
  });
  fakeUiWrap.selectQueue.push("Archive now");
  await handler("--review fast-fix", ctx);

  assert.equal(fakePiWrap.calls.length, 3);
  const review = fakePiWrap.calls.find((c) => /Critically review/.test(c.prompt));
  assert.ok(review, "Code review fires via on-demand");
  assert.match(review.prompt, /skip mutation-testing-style probes/, "fast-lane review narrows its depth");

  // CONTEXT.md records the folded Explore, not a missing one.
  const contextRaw = await readFile(
    join(cwd, "readyset", "changes", "archive", "fast-fix", "CONTEXT.md"),
    "utf8",
  ).catch(() => undefined);
  if (contextRaw !== undefined) {
    assert.match(contextRaw, /fast lane folds grounding into Propose/);
  }
});

await test("review gate: approving an already-proposed change dispatches apply prompt with verification requirement to omp", async () => {
  await writeConfig(NOTES_REQUIRED_CONFIG); // the pre-lite contract: _Verified notes enforced
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

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(fakePiWrap.calls.length, 1);
  assert.match(fakePiWrap.calls[0].prompt, /MANDATORY: every task you complete/);
  assert.match(fakePiWrap.calls[0].prompt, /_Verified: <command and result>_/);
  assert.ok(fakeUiWrap.notifications.some((n) => /Handing off execution to core omp/.test(n.message)));
  await clearConfig();
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

await test("approve & execute hands off execution to core omp and exits", async () => {
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

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(fakeUiWrap.notifications.some((n) => /Handing off execution to core omp/.test(n.message)));
  assert.equal(fakePiWrap.calls.length, 1);
  assert.match(fakePiWrap.calls[0].prompt, /Implement the Readyset change "partial"/);
  // The gate's panel is cleared before the handoff, so the review document/widget does not linger
  // over omp's own execution: setWidget("readyset", undefined), and the editor text emptied.
  assert.equal(fakeUiWrap.widgetHistory.at(-1), undefined, "the review widget is cleared on handoff");
  assert.equal(fakeUiWrap.widgetKeys.at(-1), "readyset", "cleared by key, not by passing the lines array");
  assert.equal(fakeUiWrap.editorTextHistory.at(-1), "", "the editor text is cleared on handoff");
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

await test("--lane fast lists a fast-lane brainstorm, opens the picker, and runs the fast lane", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-30-fastlane.md", {
    title: "Fast Street",
    status: "open",
    created: "2026-01-30",
    change_id: "fast-street",
    lane: "fast",
  }, VALID_BRAINSTORM_BODY);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-01-30 · Fast Street");
  fakeUiWrap.selectQueue.push("Approve & Execute");

  const dir = join(cwd, "readyset", "changes", "fast-street");
  // Fast lane: the first (and only) planning turn is Propose.
  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "proposal.md"),
      "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- x (new)\n\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n",
      "utf8",
    );
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 do thing\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  // The picker really opened
  assert.equal(fakeUiWrap.selectPrompts.length >= 1, true, "the brainstorm picker opened");
  assert.equal(
    fakeUiWrap.notifications.filter((n) => /No full-lane brainstorms found/.test(n.message)).length,
    0,
    "an explicit --lane must not warn that no full-lane brainstorms exist",
  );

  // 2 calls: Propose then Apply handoff to omp, no Explore
  assert.equal(fakePiWrap.calls.length, 2, "Propose then handoff to omp, no Explore");
  assert.ok(!fakePiWrap.calls.some((c) => /Explore the ground truth/.test(c.prompt)), "fast lane must not fire Explore");
  assert.ok(fakePiWrap.calls.some((c) => /Create a Readyset change/.test(c.prompt)), "Propose still fires");

  // The run's lane is the flag's, and the phase log says so.
  const gateEnd = (await phaseEventsArchivedOrLive(cwd, "fast-street")).find((e) => e.phase === "gate" && e.edge === "end");
  assert.ok(gateEnd, "a gate end event exists");
  assert.equal(gateEnd!.lane, "fast");
  assert.equal(gateEnd!.laneSource, "flag");
});

await test("--lane full lists a fast-lane brainstorm and runs it on the full lane", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-01-31-fastlane-full.md", {
    title: "Fast Street Full",
    status: "proposed",
    created: "2026-01-31",
    change_id: "fast-street-full",
    lane: "fast",
  });

  const dir = join(cwd, "readyset", "changes", "fast-street-full");
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
  fakeUiWrap.selectQueue.push("2026-01-31 · Fast Street Full"); // pick
  fakeUiWrap.selectQueue.push("Discard"); // gate: leave immediately, no turns fire

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane full", ctx);

  const gateEnd = (await readPhaseEvents(cwd, "fast-street-full")).find((e) => e.phase === "gate" && e.edge === "end");
  assert.ok(gateEnd, "a gate end event exists");
  assert.equal(gateEnd!.lane, "full", "an explicit --lane full overrides the file's fast lane");
  assert.equal(gateEnd!.laneSource, "flag");
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

// --- handed-off execution model (--model / --phase-model apply) -------------------------------

// A change already at the gate, with the fake pi + fake ui wired exactly like the existing pin
// tests: `ctx.models.current()` is the session's pre-run model and `resolve` maps a spec to the
// value the fake `pi.setModel` records.
async function gateCtx(cwd: string, extraCtx: Record<string, unknown> = {}) {
  const fakePiWrap = makeFakePi(cwd);
  const { handler, agentEnd } = await loadHandlerAndAgentEnd(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const sessionId = "session-under-test";
  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: fakePiWrap.waitForIdle,
    models: { current: () => "session-default-model", resolve: (spec: string) => `resolved:${spec}` },
    sessionManager: { getSessionId: () => sessionId },
    ...extraCtx,
  };
  return { fakePiWrap, fakeUiWrap, handler, agentEnd, ctx, sessionId };
}

// The ctx omp hands the agent_end hook: no waitForIdle (that is the whole point of Bug 1), and no
// models either -- the restore goes through pi.setModel, not ctx.models. When a session id is
// given, it carries the same `sessionManager` shape the real ExtensionContext exposes, so the
// session-id matching can be exercised; without one it exercises the cwd fallback path.
function eventCtx(cwd: string, ui: unknown, sessionId?: string) {
  return {
    cwd,
    ui,
    ...(sessionId !== undefined
      ? { sessionManager: { getSessionId: () => sessionId } }
      : {}),
  };
}

await test("handoff model: --model X pins at the gate, no restore before the handler returns, restore(original) after a terminal agent_end", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-01-handoff-pin.md", {
    title: "Handoff Pin",
    status: "proposed",
    created: "2026-07-01",
    change_id: "handoff-pin",
  });
  await writeProposedChange(cwd, "handoff-pin", ["- src/keep.ts"]);

  const { fakePiWrap, fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-01 · Handoff Pin");
  fakeUiWrap.selectQueue.push("Approve & Execute");

  await handler("--model pinned-model", ctx);

  // The pin is applied by withPinnedModel and then again by the approve branch (the execution model
  // is the same pin -- setModel is called with the same resolved value, matching withPhaseModel).
  // What matters is that NO restore ran: no session-default-model call before the handler returned.
  assert.deepEqual(
    fakePiWrap.setModelCalls,
    ["resolved:pinned-model", "resolved:pinned-model"],
    "the pin applies twice (run pin + execution model), and withPinnedModel must not restore while the handoff is pending",
  );
  assert.ok(
    !fakePiWrap.setModelCalls.includes("session-default-model"),
    "no restore before the execution turn settles",
  );
  assert.ok(fakeUiWrap.notifications.some((n) => /Pinned model "pinned-model"/.test(n.message)));
  assert.ok(fakeUiWrap.notifications.some((n) => /Execution runs on "pinned-model" \(from --model flag\)/.test(n.message)));
  assert.equal(fakePiWrap.calls.length, 1, "the execution prompt was handed off");
  assert.match(fakePiWrap.calls[0].prompt, /Implement the Readyset change "handoff-pin"/);

  // A non-terminal settle (willContinue: true) must not restore.
  await agentEnd({ willContinue: true }, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  assert.ok(
    !fakePiWrap.setModelCalls.includes("session-default-model"),
    "a willContinue settle is not a terminal settle -- no restore",
  );

  // The terminal settle restores the pre-run model and records the balancing apply end event.
  // Mark the tasks done first: a terminal settle with unfinished tasks is a pause, not a completion.
  await markTasksDone(cwd, "handoff-pin");
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  assert.equal(fakePiWrap.setModelCalls.at(-1), "session-default-model", "the pre-run model is restored after the execution settles");
  assert.ok(fakeUiWrap.notifications.some((n) => /Execution settled/.test(n.message)));

  const events = await phaseEventsArchivedOrLive(cwd, "handoff-pin");
  const applyEnd = events.find((e) => e.phase === "apply" && e.edge === "end");
  assert.ok(applyEnd, "a balancing apply end event exists");
  assert.equal(applyEnd.outcome, "handoff-settled");
  assert.equal(applyEnd.model, "pinned-model", "the apply end event carries the model execution ran on");
});

await test("handoff model: apply override without --model captures the session model and restores it after settle", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-05-handoff-applyonly.md", {
    title: "Handoff Apply Only", status: "proposed", created: "2026-07-05", change_id: "handoff-applyonly",
  });
  await writeProposedChange(cwd, "handoff-applyonly", ["- src/keep.ts"]);

  const { fakePiWrap, fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-05 · Handoff Apply Only");
  fakeUiWrap.selectQueue.push("Approve & Execute");

  await handler("--phase-model apply=apply-model", ctx);

  assert.deepEqual(fakePiWrap.setModelCalls, ["resolved:apply-model"], "only the execution model is applied — there is no --model pin");
  assert.equal(fakePiWrap.calls.length, 1, "the execution prompt was handed off");
  assert.match(fakePiWrap.calls[0].prompt, /Implement the Readyset change "handoff-applyonly"/);

  await markTasksDone(cwd, "handoff-applyonly");
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));

  assert.equal(fakePiWrap.setModelCalls.at(-1), "session-default-model", "the session model captured before setModel is restored");

  const events = await phaseEventsArchivedOrLive(cwd, "handoff-applyonly");
  const applyEnd = events.find((e) => e.phase === "apply" && e.edge === "end");
  assert.equal(applyEnd?.outcome, "handoff-settled");
  assert.equal(applyEnd?.model, "apply-model");
});

await test("handoff model: a new /readyset before settle supersedes the handoff — one apply end, restore, no double settle", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-06-handoff-supersede.md", {
    title: "Handoff Supersede", status: "proposed", created: "2026-07-06", change_id: "handoff-supersede",
  });
  await writeProposedChange(cwd, "handoff-supersede", ["- src/keep.ts"]);

  const { fakePiWrap, fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-06 · Handoff Supersede");
  fakeUiWrap.selectQueue.push("Approve & Execute");

  await handler("--model pinned-model", ctx);
  assert.equal(fakePiWrap.calls.length, 1, "execution was handed off");
  assert.ok(!fakePiWrap.setModelCalls.includes("session-default-model"), "still armed — no restore yet");

  // A second /readyset lands before any terminal agent_end. `--review <id>` reaches offerArchive,
  // so queue an answer for its select. The review turn writes nothing (no queueEffect).
  fakeUiWrap.selectQueue.push("Not yet");
  await handler("--review handoff-supersede", ctx);

  assert.equal(fakePiWrap.setModelCalls.at(-1), "session-default-model", "the supersede restores the pre-run model");
  assert.ok(
    fakeUiWrap.notifications.some((n) => /handoff-superseded/.test(n.message)),
    "the supersede is notified: " + JSON.stringify(fakeUiWrap.notifications),
  );

  const events = await phaseEventsArchivedOrLive(cwd, "handoff-supersede");
  const applyEnds = events.filter((e) => e.phase === "apply" && e.edge === "end");
  assert.equal(applyEnds.length, 1, "exactly one apply end event");
  assert.equal(applyEnds[0].outcome, "handoff-superseded");
  assert.equal(applyEnds[0].model, "pinned-model", "the supersede carries the execution model");

  // A later terminal agent_end must add nothing: the handoff is gone.
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  const after = await phaseEventsArchivedOrLive(cwd, "handoff-supersede");
  assert.equal(after.filter((e) => e.phase === "apply" && e.edge === "end").length, 1);
  assert.equal(fakePiWrap.setModelCalls.at(-1), "session-default-model", "no double restore");
});

await test("handoff model: a terminal agent_end with tasks unfinished pauses the handoff (no restore, still armed, pause recorded)", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-07-handoff-pause.md", {
    title: "Handoff Pause", status: "proposed", created: "2026-07-07", change_id: "handoff-pause",
  });
  const dir = await writeProposedChange(cwd, "handoff-pause", ["- src/keep.ts"]);
  // 1 of 3 checked -> execution is only paused.
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 done\n  _Verified: ran it_\n- [ ] 1.2 todo\n- [ ] 1.3 todo\n", "utf8");

  const { fakePiWrap, fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-07 · Handoff Pause");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  await handler("--model pinned-model", ctx);

  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));

  assert.ok(!fakePiWrap.setModelCalls.includes("session-default-model"), "no restore while tasks are unfinished");
  assert.ok(fakeUiWrap.notifications.some((n) => /Execution paused at 1\/3 tasks/.test(n.message)), "the pause is notified: " + JSON.stringify(fakeUiWrap.notifications));
  const events = await phaseEventsArchivedOrLive(cwd, "handoff-pause");
  const applyStarts = events.filter((e) => e.phase === "apply" && e.edge === "start");
  assert.equal(applyStarts.length, 1, "the pause writes no new apply start event -- only the original handoff-omp one: " + JSON.stringify(events));
  assert.equal(applyStarts[0].outcome, "handoff-omp");
  assert.ok(!events.some((e) => e.phase === "apply" && e.edge === "end"), "no apply end while paused");

  // A later terminal agent_end with all tasks checked settles for real.
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 done\n  _Verified: ran it_\n- [x] 1.2 done\n  _Verified: ran it_\n- [x] 1.3 done\n  _Verified: ran it_\n", "utf8");
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));

  assert.equal(fakePiWrap.setModelCalls.at(-1), "session-default-model", "restored once all tasks are done");
  const after = await phaseEventsArchivedOrLive(cwd, "handoff-pause");
  const applyEnds = after.filter((e) => e.phase === "apply" && e.edge === "end");
  assert.equal(applyEnds.length, 1, "exactly one apply end event");
  assert.equal(applyEnds[0].outcome, "handoff-settled");
});

await test("handoff model: unfinished pauses never settle on their own -- the next /readyset closes an abandoned handoff", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-07-handoff-stall.md", {
    title: "Handoff Stall", status: "proposed", created: "2026-07-07", change_id: "handoff-stall",
  });
  const dir = await writeProposedChange(cwd, "handoff-stall", ["- src/keep.ts"]);
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 done\n  _Verified: ran it_\n- [ ] 1.2 todo\n- [ ] 1.3 todo\n", "utf8");

  const { fakePiWrap, fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-07 · Handoff Stall");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  await handler("--model pinned-model", ctx);

  // Three terminal turns with nothing changing: no stall inference, still armed.
  for (let i = 0; i < 3; i++) await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  assert.ok(!fakePiWrap.setModelCalls.includes("session-default-model"), "still armed, execution model still active");
  assert.equal((await phaseEventsArchivedOrLive(cwd, "handoff-stall")).filter((e) => e.phase === "apply" && e.edge === "end").length, 0);

  // The next /readyset supersedes it: model restored, apply window closed exactly once.
  fakeUiWrap.selectQueue.push("");
  await handler("", ctx);
  assert.equal(fakePiWrap.setModelCalls.at(-1), "session-default-model");
  const ends = (await phaseEventsArchivedOrLive(cwd, "handoff-stall")).filter((e) => e.phase === "apply" && e.edge === "end");
  assert.deepEqual(ends.map((e) => e.outcome), ["handoff-superseded"]);
  assert.equal(ends[0].handoff?.pauses, 3, "the pauses are still counted on the settle event");
});

await test("handoff model: a pause followed by real progress stays armed", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-07-handoff-progress.md", {
    title: "Handoff Progress", status: "proposed", created: "2026-07-07", change_id: "handoff-progress",
  });
  const dir = await writeProposedChange(cwd, "handoff-progress", ["- src/keep.ts"]);
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 todo\n- [ ] 1.2 todo\n- [ ] 1.3 todo\n", "utf8");

  const { fakePiWrap, fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-07 · Handoff Progress");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  await handler("--model pinned-model", ctx);

  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  assert.ok(!fakePiWrap.setModelCalls.includes("session-default-model"), "armed after the first pause");

  // Real progress happened between the two pauses.
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 done\n  _Verified: ran it_\n- [ ] 1.2 todo\n- [ ] 1.3 todo\n", "utf8");
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  assert.ok(!fakePiWrap.setModelCalls.includes("session-default-model"), "still armed — tasks unfinished");
  const events = await phaseEventsArchivedOrLive(cwd, "handoff-progress");
  assert.ok(!events.some((e) => e.phase === "apply" && e.edge === "end"), "no settle while genuinely progressing");
});

await test("handoff model: an unreadable tasks.md counts as done so the handoff cannot get stuck", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-08-handoff-notasks.md", {
    title: "Handoff No Tasks", status: "proposed", created: "2026-07-08", change_id: "handoff-notasks",
  });
  await writeProposedChange(cwd, "handoff-notasks", ["- src/keep.ts"]);
  await rm(join(cwd, "readyset", "changes", "handoff-notasks", "tasks.md"), { force: true });

  const { fakePiWrap, fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-08 · Handoff No Tasks");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  await handler("--model pinned-model", ctx);

  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  assert.equal(fakePiWrap.setModelCalls.at(-1), "session-default-model", "an unreadable tasks.md still settles");
});

await test("handoff model: a terminal agent_end from a different session id (same cwd) does not settle", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-09-handoff-subagent.md", {
    title: "Handoff Subagent", status: "proposed", created: "2026-07-09", change_id: "handoff-subagent",
  });
  await writeProposedChange(cwd, "handoff-subagent", ["- src/keep.ts"]);
  await markTasksDone(cwd, "handoff-subagent");

  const { fakePiWrap, fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-09 · Handoff Subagent");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  await handler("--model pinned-model", ctx);

  // A subagent's own terminal agent_end: same cwd, different session id.
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, "subagent-session"));
  assert.ok(!fakePiWrap.setModelCalls.includes("session-default-model"), "a foreign session must not restore the parent's model");
  const events = await phaseEventsArchivedOrLive(cwd, "handoff-subagent");
  assert.ok(!events.some((e) => e.phase === "apply" && e.edge === "end"), "a foreign session must not write the parent's apply end");

  // The parent's own terminal settle still works.
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  assert.equal(fakePiWrap.setModelCalls.at(-1), "session-default-model", "the parent session still settles");
  assert.ok(
    (await phaseEventsArchivedOrLive(cwd, "handoff-subagent")).some((e) => e.phase === "apply" && e.edge === "end" && e.outcome === "handoff-settled"),
  );
});

await test("handoff model: ctx without sessionManager falls back to cwd matching", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-10-handoff-fallback.md", {
    title: "Handoff Fallback", status: "proposed", created: "2026-07-10", change_id: "handoff-fallback",
  });
  await writeProposedChange(cwd, "handoff-fallback", ["- src/keep.ts"]);
  await markTasksDone(cwd, "handoff-fallback");

  // Command ctx has a session id; the settle ctx does not.
  const { fakePiWrap, fakeUiWrap, handler, agentEnd, ctx } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-10 · Handoff Fallback");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  await handler("--model pinned-model", ctx);

  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui)); // no sessionManager
  assert.equal(fakePiWrap.setModelCalls.at(-1), "session-default-model", "falls back to cwd matching and settles");
});

await test("readyset_verify: attached while the handoff is armed, detached again once it settles", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-12-verify-wire.md", {
    title: "Verify Wire", status: "proposed", created: "2026-07-12", change_id: "verify-wire",
  });
  await writeProposedChange(cwd, "verify-wire", ["- src/keep.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const { handler, agentEnd, verifyExecute } = await loadHandlerAgentEndAndVerify(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const sessionId = "verify-session";
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle, sessionManager: { getSessionId: () => sessionId } };

  // Before any handoff is armed: not attached to anything.
  const before = await verifyExecute("t1", { taskId: "1.1", command: "true" }, undefined, undefined, ctx);
  assert.match(before.content[0].text, /isn't attached to an active Apply turn/);

  fakeUiWrap.selectQueue.push("2026-07-12 · Verify Wire");
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  await handler("", ctx);

  // Armed: readyset_verify now records evidence for this change.
  const during = await verifyExecute("t2", { taskId: "1.1", command: "true" }, undefined, undefined, ctx);
  assert.match(during.content[0].text, /Evidence E\d+ recorded/, "readyset_verify recorded evidence: " + JSON.stringify(during));

  // Settling (all tasks done) detaches it again.
  await markTasksDone(cwd, "verify-wire");
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  const after = await verifyExecute("t3", { taskId: "1.1", command: "true" }, undefined, undefined, ctx);
  assert.match(after.content[0].text, /isn't attached to an active Apply turn/);
});

await test("session_stop verification gate: blocks while a checked task lacks a _Verified: note, capped at MAX_VERIFICATION_SENDBACKS, only for the armed change", async () => {
  await writeConfig(NOTES_REQUIRED_CONFIG); // the pre-lite contract: _Verified notes enforced
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-14-sessionstop.md", {
    title: "Session Stop", status: "proposed", created: "2026-07-14", change_id: "session-stop",
  });
  await writeProposedChange(cwd, "session-stop", ["- src/keep.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const { handler, sessionStop } = await loadHandlerAgentEndAndSessionStop(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const sessionId = "sessionstop-session";
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle, sessionManager: { getSessionId: () => sessionId } };

  // Before any handoff is armed: nothing to check, never blocks.
  assert.equal(await sessionStop({ session_id: sessionId }, { cwd }), undefined);

  fakeUiWrap.selectQueue.push("2026-07-14 · Session Stop");
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  await handler("", ctx);

  // Armed, but no task checked yet -- nothing to flag.
  assert.equal(await sessionStop({ session_id: sessionId }, { cwd }), undefined);

  // A checked task with no _Verified: note -> blocks.
  const dir = join(cwd, "readyset", "changes", "session-stop");
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 no note\n- [ ] 1.2 todo\n", "utf8");
  const first = await sessionStop({ session_id: sessionId }, { cwd });
  assert.equal(first?.decision, "block");
  assert.match(first?.reason ?? "", /1 checked task\(s\)/);
  assert.match(first?.reason ?? "", /1\/2/);

  const second = await sessionStop({ session_id: sessionId }, { cwd });
  assert.equal(second?.decision, "block");
  assert.match(second?.reason ?? "", /2\/2/);

  // Cap reached (MAX_VERIFICATION_SENDBACKS = 2): the third call lets the session stop.
  const third = await sessionStop({ session_id: sessionId }, { cwd });
  assert.equal(third, undefined);

  // A DIFFERENT session in the same cwd (a subagent core omp spawned during the handed-off
  // execution) is never gated at all -- only the session that armed the handoff is.
  const otherSession = await sessionStop({ session_id: "another-session" }, { cwd });
  assert.equal(otherSession, undefined, "a subagent's session_stop is not blocked for the parent's tasks.md");
  await clearConfig();
});

await test("session_stop verification gate: a subagent session in the same cwd is never blocked, even with budget left", async () => {
  await writeConfig(NOTES_REQUIRED_CONFIG); // the pre-lite contract: _Verified notes enforced
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-14-sessionstop-sub.md", {
    title: "Session Stop Sub", status: "proposed", created: "2026-07-14", change_id: "session-stop-sub",
  });
  await writeProposedChange(cwd, "session-stop-sub", ["- src/keep.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const { handler, sessionStop } = await loadHandlerAgentEndAndSessionStop(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const sessionId = "parent-session";
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle, sessionManager: { getSessionId: () => sessionId } };
  fakeUiWrap.selectQueue.push("2026-07-14 · Session Stop Sub");
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  await handler("", ctx);

  const dir = join(cwd, "readyset", "changes", "session-stop-sub");
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 no note\n- [ ] 1.2 todo\n", "utf8");
  // The subagent's id comes from its own sessionManager on the hook ctx, not the event payload.
  assert.equal(await sessionStop({}, eventCtx(cwd, fakeUiWrap.ui, "subagent-session")), undefined, "subagent (by sessionManager) not gated");
  assert.equal(await sessionStop({ session_id: "subagent-2" }, { cwd }), undefined, "subagent (by event session_id) not gated");
  // The arming session still is, with its full budget.
  const parent = await sessionStop({}, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  assert.equal(parent?.decision, "block");
  assert.match(parent?.reason ?? "", /1\/2/);
  await clearConfig();
});

await test("session_stop verification gate: the cap is per handoff -- a new change in the same session is gated again", async () => {
  await writeConfig(NOTES_REQUIRED_CONFIG); // the pre-lite contract: _Verified notes enforced
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-14-sessionstop-a.md", {
    title: "Session Stop A", status: "proposed", created: "2026-07-14", change_id: "session-stop-a",
  });
  await writeProposedChange(cwd, "session-stop-a", ["- src/keep.ts"]);
  await writeBrainstorm(cwd, "2026-07-15-sessionstop-b.md", {
    title: "Session Stop B", status: "proposed", created: "2026-07-15", change_id: "session-stop-b",
  });
  await writeProposedChange(cwd, "session-stop-b", ["- src/keep.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const { handler, agentEnd, sessionStop } = await loadHandlerAgentEndAndSessionStop(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const sessionId = "same-session";
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle, sessionManager: { getSessionId: () => sessionId } };

  // Change A: exhaust the cap.
  fakeUiWrap.selectQueue.push("2026-07-14 · Session Stop A");
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  await handler("", ctx);
  const dirA = join(cwd, "readyset", "changes", "session-stop-a");
  await writeFile(join(dirA, "tasks.md"), "- [x] 1.1 no note\n", "utf8");
  assert.equal((await sessionStop({ session_id: sessionId }, { cwd }))?.decision, "block");
  assert.equal((await sessionStop({ session_id: sessionId }, { cwd }))?.decision, "block");
  assert.equal(await sessionStop({ session_id: sessionId }, { cwd }), undefined, "cap reached on A");
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId)); // A settles (all ticked)

  // Change B in the SAME session: the gate applies again with a fresh budget.
  fakeUiWrap.selectQueue.push("2026-07-15 · Session Stop B");
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  await handler("", ctx);
  const dirB = join(cwd, "readyset", "changes", "session-stop-b");
  await writeFile(join(dirB, "tasks.md"), "- [x] 1.1 no note\n- [ ] 1.2 todo\n", "utf8");
  const onB = await sessionStop({ session_id: sessionId }, { cwd });
  assert.equal(onB?.decision, "block", "change B is gated even though A exhausted its cap");
  assert.match(onB?.reason ?? "", /session-stop-b/);
  assert.match(onB?.reason ?? "", /1\/2/);
  await clearConfig();
});

await test("session_stop verification gate: a verified task, or no cwd, never blocks", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-14-sessionstop-clean.md", {
    title: "Session Stop Clean", status: "proposed", created: "2026-07-14", change_id: "session-stop-clean",
  });
  await writeProposedChange(cwd, "session-stop-clean", ["- src/keep.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const { handler, sessionStop } = await loadHandlerAgentEndAndSessionStop(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const sessionId = "sessionstop-clean-session";
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle, sessionManager: { getSessionId: () => sessionId } };

  fakeUiWrap.selectQueue.push("2026-07-14 · Session Stop Clean");
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  await handler("", ctx);

  const dir = join(cwd, "readyset", "changes", "session-stop-clean");
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 done\n  _Verified: ran it_\n", "utf8");
  assert.equal(await sessionStop({ session_id: sessionId }, { cwd }), undefined, "every checked task carries a _Verified: note");
  assert.equal(await sessionStop({ session_id: sessionId }, {}), undefined, "no cwd on the event ctx -- never blocks");
});

// --- Persisted handoff (survives an omp restart) -------------------------------------------------

const fileExists = (p: string) => readFile(p, "utf8").then(() => true, () => false);

await test("persisted handoff: armed at approve, cleared when a supersede settles it", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-20-persist-a.md", {
    title: "Persist A", status: "proposed", created: "2026-07-20", change_id: "persist-a",
  });
  const dir = await writeProposedChange(cwd, "persist-a", ["- src/keep.ts"]);
  const { fakeUiWrap, handler, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-20 · Persist A");
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  await handler("", ctx);

  const state = JSON.parse(await readFile(join(dir, "handoff.json"), "utf8"));
  assert.equal(state.changeId, "persist-a");
  assert.equal(state.sessionId, sessionId);
  assert.equal(typeof state.armedAt, "string");
  assert.equal(state.reviewPolicy?.mode, "auto", "the review policy travels with the handoff");

  // The next /readyset command supersedes the in-memory handoff -- and removes the file with it.
  fakeUiWrap.selectQueue.push(""); // dismiss the picker
  await handler("", ctx);
  assert.equal(await fileExists(join(dir, "handoff.json")), false, "a settled handoff leaves no persisted copy");
});

await test("persisted handoff: a restarted process re-attaches this session's handoff, gates session_stop, and settles it", async () => {
  await writeConfig(NOTES_REQUIRED_CONFIG); // the pre-lite contract: _Verified notes enforced
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-21-persist-b.md", {
    title: "Persist B", status: "proposed", created: "2026-07-21", change_id: "persist-b",
  });
  const dir = await writeProposedChange(cwd, "persist-b", ["- src/keep.ts"]);

  // Process 1: approve and hand off, then "crash" (the module instance is simply abandoned).
  const first = await gateCtx(cwd);
  first.fakeUiWrap.selectQueue.push("2026-07-21 · Persist B");
  first.fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  await first.handler("", first.ctx);
  assert.equal(await fileExists(join(dir, "handoff.json")), true);

  // Process 2: a fresh module instance -- no in-memory handoff at all.
  const fakePiWrap = makeFakePi(cwd);
  const { agentEnd, sessionStop } = await loadHandlerAgentEndAndSessionStop(fakePiWrap.pi);
  const ui = makeFakeUi();

  // A different session's settle does not adopt it.
  await agentEnd({ willContinue: false }, eventCtx(cwd, ui.ui, "someone-else"));
  assert.equal(await fileExists(join(dir, "handoff.json")), true, "another session never adopts the handoff");

  // The arming session's session_stop re-attaches it and is gated again.
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 no note\n- [ ] 1.2 todo\n", "utf8");
  const blocked = await sessionStop({ session_id: first.sessionId }, { cwd, ui: ui.ui });
  assert.equal(blocked?.decision, "block", "the session_stop gate works again after a restart");
  assert.ok(ui.notifications.some((n) => /re-attached to the handed-off execution of "persist-b"/.test(n.message)));

  // Its terminal settle closes the apply window and removes the persisted copy.
  await markTasksDone(cwd, "persist-b");
  await agentEnd({ willContinue: false }, eventCtx(cwd, ui.ui, first.sessionId));
  const applyEvents = (await readPhaseEvents(cwd, "persist-b")).filter((e) => e.phase === "apply");
  assert.deepEqual(applyEvents.map((e) => e.edge), ["start", "end"], "the apply window is balanced across the restart");
  assert.equal(applyEvents[1].outcome, "handoff-settled");
  assert.equal(await fileExists(join(dir, "handoff.json")), false);
  await clearConfig();
});

await test("persisted handoff: --review <id> from another session closes an orphaned handoff before reviewing", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-22-persist-c.md", {
    title: "Persist C", status: "proposed", created: "2026-07-22", change_id: "persist-c",
  });
  const dir = await writeProposedChange(cwd, "persist-c", ["- src/keep.ts"]);

  const first = await gateCtx(cwd);
  first.fakeUiWrap.selectQueue.push("2026-07-22 · Persist C");
  first.fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  await first.handler("", first.ctx);

  // A new process, a new session: the old one is gone and never settled.
  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const ui = makeFakeUi();
  const ctx = { cwd, ui: ui.ui, waitForIdle: fakePiWrap.waitForIdle, sessionManager: { getSessionId: () => "new-session" } };
  await markTasksDone(cwd, "persist-c");
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nnone\n\n## Blocking\n\nnone\n", "utf8");
  });
  ui.selectQueue.push("Not yet");
  await handler("--review persist-c", ctx);

  assert.ok(ui.notifications.some((n) => /as handoff-orphaned before reviewing/.test(n.message)));
  const applyEvents = (await readPhaseEvents(cwd, "persist-c")).filter((e) => e.phase === "apply");
  assert.deepEqual(applyEvents.map((e) => e.edge), ["start", "end"]);
  assert.equal(applyEvents[1].outcome, "handoff-orphaned");
  assert.equal(await fileExists(join(dir, "handoff.json")), false);
  assert.ok(fakePiWrap.calls.some((c) => /Critically review the implementation/.test(c.prompt)), "the review still ran");
});

// --- readyset_done: the executing model's explicit completion signal --------------------------

async function loadWithDoneTool(fakePi: ReturnType<typeof makeFakePi>["pi"]) {
  const mod = (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as { default: (pi: unknown) => void };
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let agentEnd: ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
  let done: { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> } | undefined;
  mod.default({
    ...fakePi,
    registerCommand(_n: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) { handler = def.handler; },
    on(event: string, h: (event: unknown, ctx: unknown) => void) { if (event === "agent_end") agentEnd = h as any; },
    registerTool(def: { name: string; execute: (...args: unknown[]) => Promise<any> }) { if (def.name === "readyset_done") done = def as any; },
    zod: fakeZod,
  } as any);
  if (!handler || !agentEnd || !done) throw new Error("handler, agent_end or readyset_done was never registered");
  return {
    handler,
    agentEnd: async (e: unknown, c: unknown) => void (await agentEnd!(e, c)),
    signal: async (params: { status: string; summary?: string }, ctx: unknown) => (await done!.execute("call", params, undefined, undefined, ctx)).content[0].text,
  };
}

async function armDoneHandoff(slug: string, date: string) {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, `${date}-${slug}.md`, { title: slug, status: "proposed", created: date, change_id: slug });
  const dir = await writeProposedChange(cwd, slug, ["- src/keep.ts"]);
  const fakePiWrap = makeFakePi(cwd);
  const loaded = await loadWithDoneTool(fakePiWrap.pi);
  const ui = makeFakeUi();
  const sessionId = `${slug}-session`;
  const ctx = { cwd, ui: ui.ui, waitForIdle: fakePiWrap.waitForIdle, sessionManager: { getSessionId: () => sessionId } };
  ui.selectQueue.push(`${date} · ${slug}`);
  ui.selectQueue.push("Approve & Execute, keep context");
  await loaded.handler("", ctx);
  return { cwd, dir, ui, sessionId, ...loaded };
}

await test("readyset_done: refuses 'done' with unchecked or unverified tasks, then settles the handoff as handoff-done", async () => {
  await writeConfig(NOTES_REQUIRED_CONFIG); // the pre-lite contract: _Verified notes enforced
  const { cwd, dir, ui, sessionId, agentEnd, signal } = await armDoneHandoff("done-ok", "2026-07-23");
  const toolCtx = eventCtx(cwd, ui.ui, sessionId);

  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 a\n  _Verified: ran it_\n- [ ] 1.2 b\n", "utf8");
  assert.match(await signal({ status: "done" }, toolCtx), /Not recorded: tasks\.md still has 1 unchecked task/);

  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 a\n  _Verified: ran it_\n- [x] 1.2 b\n", "utf8");
  assert.match(await signal({ status: "done" }, toolCtx), /Not recorded: 1 checked task\(s\) in tasks\.md have no _Verified: note/);

  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 a\n  _Verified: ran it_\n- [x] 1.2 b\n  - _Verified: ran `npm test`, 2/2_\n", "utf8");
  assert.match(await signal({ status: "done", summary: "shipped the endpoint" }, toolCtx), /Recorded as done/);

  await agentEnd({ willContinue: false }, toolCtx);
  const applyEnd = (await readPhaseEvents(cwd, "done-ok")).find((e) => e.phase === "apply" && e.edge === "end");
  assert.equal(applyEnd?.outcome, "handoff-done");
  assert.equal(applyEnd?.handoff?.signal, "done");
  assert.ok(applyEnd?.reviewPolicy, "the settle's review decision is recorded on the event");
  assert.ok(ui.notifications.some((n) => /signalled done: shipped the endpoint/.test(n.message)));
  assert.equal(await fileExists(join(dir, "handoff.json")), false);
  await clearConfig();
});

await test("readyset_done: 'blocked' is an explicit pause, counted on the settle event", async () => {
  const { cwd, dir, ui, sessionId, agentEnd, signal } = await armDoneHandoff("done-blocked", "2026-07-24");
  const toolCtx = eventCtx(cwd, ui.ui, sessionId);
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 a\n  _Verified: ran it_\n- [ ] 1.2 b\n", "utf8");

  assert.match(await signal({ status: "blocked" }, toolCtx), /needs a summary/);
  // Three blocked turns in a row: each surfaces the question, none settles.
  for (let i = 0; i < 3; i++) {
    assert.match(await signal({ status: "blocked", summary: "Which DB should the export read from?" }, toolCtx), /Recorded as blocked/);
    await agentEnd({ willContinue: false }, toolCtx);
  }
  assert.ok(ui.notifications.some((n) => /is blocked at 1\/2 tasks: Which DB/.test(n.message)));
  assert.equal((await readPhaseEvents(cwd, "done-blocked")).filter((e) => e.phase === "apply" && e.edge === "end").length, 0, "still armed");

  await markTasksDone(cwd, "done-blocked");
  await agentEnd({ willContinue: false }, toolCtx);
  const applyEnd = (await readPhaseEvents(cwd, "done-blocked")).find((e) => e.phase === "apply" && e.edge === "end");
  assert.equal(applyEnd?.outcome, "handoff-settled", "without a done signal, the checkbox fallback still settles it");
  assert.equal(applyEnd?.handoff?.blocks, 3);
});

await test("readyset_done: refuses 'done' while a _Verified: note cites evidence that doesn't back it", async () => {
  const { cwd, dir, ui, sessionId, signal } = await armDoneHandoff("done-cite", "2026-07-26");
  const toolCtx = eventCtx(cwd, ui.ui, sessionId);
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 a\n  _Verified: evidence E007 — npm test, pass_\n", "utf8");
  const refused = await signal({ status: "done" }, toolCtx);
  assert.match(refused, /Not recorded: the notes disagree with the runtime evidence/);
  assert.match(refused, /task 1\.1 cites evidence E007, which does not exist/);

  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 a\n  _Verified: ran `npm test`, pass_\n", "utf8");
  assert.match(await signal({ status: "done" }, toolCtx), /Recorded as done/);
});

await test("apply prompt recommends readyset_verify and the `evidence E00N` citation form", async () => {
  const mod = await loadMod();
  const apply = mod.applyTurnPrompt("x");
  assert.match(apply, /readyset_verify/);
  assert.match(apply, /evidence E00N/);
  assert.match(apply, /readyset_done will not accept "done" while any conflict remains/);
});

await test("on-demand review measures the diff live -- the diff-size trigger no longer sees an empty diff", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
  execFileSync("git", ["config", "user.name", "t"], { cwd });
  await clearConfig();
  await writeBrainstorm(cwd, "2026-07-27-diffsize.md", { title: "Diff Size", status: "proposed", created: "2026-07-27", change_id: "diffsize" });
  const dir = await writeProposedChange(cwd, "diffsize", ["- src/big.ts (new)"]);
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-qm", "base"], { cwd });

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const ui = makeFakeUi();
  const ctx = { cwd, ui: ui.ui, waitForIdle: fakePiWrap.waitForIdle };
  ui.selectQueue.push("2026-07-27 · Diff Size");
  ui.selectQueue.push("Approve & Execute, keep context");
  await handler("", ctx);

  // The execution writes 200 lines (default maxLines is 150).
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "big.ts"), Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n", "utf8");
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran `npm test`, all pass_\n", "utf8");

  ui.selectQueue.push("Not yet");
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n\n## Blocking\n\nnone\n", "utf8");
  });
  await handler("--review diffsize", ctx);
  const reviewEnd = (await readPhaseEvents(cwd, "diffsize")).find((e) => e.phase === "review" && e.edge === "end");
  assert.ok(reviewEnd?.review?.triggersFired.includes("diff-size"), "diff-size fired: " + JSON.stringify(reviewEnd?.review));
});

await test("readyset_done: a subagent session, or no armed handoff, cannot signal", async () => {
  const { cwd, ui, signal } = await armDoneHandoff("done-sub", "2026-07-25");
  assert.match(await signal({ status: "done" }, eventCtx(cwd, ui.ui, "a-subagent")), /Only the session that approved/);

  const other = await freshRepo();
  const loaded = await loadWithDoneTool(makeFakePi(other).pi);
  assert.match(await loaded.signal({ status: "done" }, eventCtx(other, ui.ui, "nobody")), /isn't attached to a handed-off Readyset execution/);
});

// --- readyset.verify: deterministic verification (lite default: notes optional) ----------------

const TEST_SCRIPT = (exit: number) => JSON.stringify({ name: "fx", scripts: { test: `node -e "process.exit(${exit})"` } });

await test("verify: with notes optional, the apply prompt drops the note ritual and names the test command", async () => {
  const mod = await loadMod();
  const lite = mod.applyTurnPrompt("x", [], "full", { command: "npm test", requireNotes: false });
  assert.doesNotMatch(lite, /MANDATORY/);
  assert.doesNotMatch(lite, /evidence E00N/);
  assert.match(lite, /Readyset then runs `npm test` itself and refuses "done" if it fails/);
  assert.match(lite, /Scope deviations/);
  const none = mod.applyTurnPrompt("x", [], "fast", { requireNotes: false });
  assert.match(none, /Readyset then closes the execution/);
  assert.ok(lite.length < mod.applyTurnPrompt("x").length, "the lite prompt is shorter than the notes-required one");
});

await test("verify: readyset_done refuses while the project's tests fail, then records the passing run on the settle event", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await writeFile(join(cwd, "package.json"), TEST_SCRIPT(0), "utf8"); // green suite at approve time (the baseline)
  await writeBrainstorm(cwd, "2026-07-31-verify-run.md", { title: "verify-run", status: "proposed", created: "2026-07-31", change_id: "verify-run" });
  const dir = await writeProposedChange(cwd, "verify-run", ["- src/keep.ts"]);
  const fakePiWrap = makeFakePi(cwd);
  const loaded = await loadWithDoneTool(fakePiWrap.pi);
  const ui = makeFakeUi();
  const sessionId = "verify-run-session";
  const ctx = { cwd, ui: ui.ui, waitForIdle: fakePiWrap.waitForIdle, sessionManager: { getSessionId: () => sessionId } };
  ui.selectQueue.push("2026-07-31 · verify-run");
  ui.selectQueue.push("Approve & Execute, keep context");
  await loaded.handler("", ctx);
  assert.match(fakePiWrap.calls.at(-1)!.prompt, /Readyset then runs `npm test` itself/, "the apply prompt names the detected command");

  assert.ok(ui.notifications.some((n) => /pre-change test baseline/.test(n.message)), "the baseline run is announced");
  const toolCtx = eventCtx(cwd, ui.ui, sessionId);
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 a\n", "utf8"); // no _Verified note: optional now
  await writeFile(join(cwd, "package.json"), TEST_SCRIPT(1), "utf8"); // the execution broke the suite
  const refused = await loaded.signal({ status: "done" }, toolCtx);
  assert.match(refused, /Not recorded: Readyset ran `npm test` and it exited 1/);

  await writeFile(join(cwd, "package.json"), TEST_SCRIPT(0), "utf8");
  assert.match(await loaded.signal({ status: "done", summary: "fixed" }, toolCtx), /`npm test` passed .* Recorded as done/);
  await loaded.agentEnd({ willContinue: false }, toolCtx);
  const applyEnd = (await readPhaseEvents(cwd, "verify-run")).find((e) => e.phase === "apply" && e.edge === "end");
  assert.equal(applyEnd?.outcome, "handoff-done");
  assert.equal(applyEnd?.tests?.command, "npm test");
  assert.equal(applyEnd?.tests?.passed, true);
});

await test("verify: a checkbox settle (no readyset_done) runs the tests at settle; failing tests fire tests-failing", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await writeFile(join(cwd, "package.json"), TEST_SCRIPT(0), "utf8");
  await writeBrainstorm(cwd, "2026-08-01-verify-settle.md", { title: "verify-settle", status: "proposed", created: "2026-08-01", change_id: "verify-settle", lane: "fast" });
  await writeProposedChange(cwd, "verify-settle", ["- src/keep.ts"]);
  const { fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-08-01 · verify-settle");
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  await handler("--lane fast", ctx);
  await markTasksDone(cwd, "verify-settle");
  await writeFile(join(cwd, "package.json"), TEST_SCRIPT(2), "utf8"); // broken by the execution
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  const applyEnd = (await readPhaseEvents(cwd, "verify-settle")).find((e) => e.phase === "apply" && e.edge === "end");
  assert.equal(applyEnd?.outcome, "handoff-settled");
  assert.equal(applyEnd?.tests?.passed, false);
  assert.equal(applyEnd?.tests?.exitCode, 2);
  assert.ok(applyEnd?.reviewPolicy?.triggersFired.includes("tests-failing"), JSON.stringify(applyEnd?.reviewPolicy));
  assert.ok(fakeUiWrap.notifications.some((n) => /Tests are failing after the execution/.test(n.message)));
});

await test("verify: with notes optional the session_stop gate never blocks", async () => {
  await writeConfig("readyset:\n  verify:\n    command: node -e 0\n"); // a test command, so notes stay optional
  const { cwd, dir, ui, sessionId } = await armDoneHandoff("verify-nostop", "2026-08-02");
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 no note\n- [ ] 1.2 todo\n", "utf8");
  const fakePiWrap = makeFakePi(cwd);
  const { sessionStop } = await loadHandlerAgentEndAndSessionStop(fakePiWrap.pi);
  // A fresh instance re-attaches the persisted handoff (verify settings travel with it).
  assert.equal(await sessionStop({ session_id: sessionId }, { cwd, ui: ui.ui }), undefined);
  await clearConfig();
});

await test("verify: no test command in the repo falls back to _Verified notes (and says so)", async () => {
  await clearConfig();
  const { cwd, dir, ui, sessionId, signal } = await armDoneHandoff("verify-fallback", "2026-08-05");
  assert.ok(ui.notifications.some((n) => /No test command found in this repo/.test(n.message)), "the fallback is announced");
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 no note\n", "utf8");
  assert.match(await signal({ status: "done" }, eventCtx(cwd, ui.ui, sessionId)), /no _Verified: note/);
});

const TAP_SCRIPT = (names: string[]) =>
  JSON.stringify({ name: "fx", scripts: { test: `node -e "${names.map((n, i) => `console.log('not ok ${i + 1} - ${n}')`).join(";")};process.exit(${names.length > 0 ? 1 : 0})"` } });

await test("verify: failures already in the approve-time baseline never block done; a new failure does", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await writeFile(join(cwd, "package.json"), TAP_SCRIPT(["old flaky"]), "utf8"); // red before the change
  await writeBrainstorm(cwd, "2026-08-06-verify-base.md", { title: "verify-base", status: "proposed", created: "2026-08-06", change_id: "verify-base" });
  const dir = await writeProposedChange(cwd, "verify-base", ["- src/keep.ts"]);
  const fakePiWrap = makeFakePi(cwd);
  const loaded = await loadWithDoneTool(fakePiWrap.pi);
  const ui = makeFakeUi();
  const sessionId = "verify-base-session";
  const ctx = { cwd, ui: ui.ui, waitForIdle: fakePiWrap.waitForIdle, sessionManager: { getSessionId: () => sessionId } };
  ui.selectQueue.push("2026-08-06 · verify-base");
  ui.selectQueue.push("Approve & Execute, keep context");
  await loaded.handler("", ctx);
  assert.ok(ui.notifications.some((n) => /already failed before this change .*failing: old flaky/.test(n.message)), "the red baseline is announced");
  assert.match(fakePiWrap.calls.at(-1)!.prompt, /refuses "done" on any failure that is new.*leave those failures alone/s, "the apply prompt says not to chase them");
  const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  assert.deepEqual(state.testBaseline?.failures, ["old flaky"], "the baseline is recorded in state.json");

  const toolCtx = eventCtx(cwd, ui.ui, sessionId);
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 a\n", "utf8");
  await writeFile(join(cwd, "package.json"), TAP_SCRIPT(["old flaky", "new break"]), "utf8");
  assert.match(await loaded.signal({ status: "done" }, toolCtx), /Not recorded: .*not there before this change: new break/);

  await writeFile(join(cwd, "package.json"), TAP_SCRIPT(["old flaky"]), "utf8");
  assert.match(await loaded.signal({ status: "done" }, toolCtx), /still fails, but only as it already did before this change\. Recorded as done/);
  await loaded.agentEnd({ willContinue: false }, toolCtx);
  const applyEnd = (await readPhaseEvents(cwd, "verify-base")).find((e) => e.phase === "apply" && e.edge === "end");
  assert.equal(applyEnd?.outcome, "handoff-done");
  assert.equal(applyEnd?.tests?.passed, false, "the event records the real exit");
  assert.ok(!applyEnd?.reviewPolicy?.triggersFired?.includes("tests-failing"), "pre-existing failures do not fire tests-failing");
});

await test("verify: --review <id> runs the tests first and hands the result to the review", async () => {
  await clearConfig();
  const cwd = await freshRepo();
  await writeFile(join(cwd, "package.json"), TEST_SCRIPT(3), "utf8");
  await writeBrainstorm(cwd, "2026-08-03-verify-review.md", { title: "verify-review", status: "approved", created: "2026-08-03", change_id: "verify-review" });
  const dir = await writeProposedChange(cwd, "verify-review", ["- src/keep.ts"]);
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n", "utf8");
  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const ui = makeFakeUi();
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfailing\n\n## Blocking\n\n- tests fail\n", "utf8");
  });
  ui.selectQueue.push("Not yet");
  await handler("--review verify-review", { cwd, ui: ui.ui, waitForIdle: fakePiWrap.waitForIdle });
  const prompt = fakePiWrap.calls.find((c) => /Critically review the implementation/.test(c.prompt))!.prompt;
  assert.match(prompt, /Readyset ran `npm test` just before this review and it FAILED \(exit 3\)/);
  const reviewEnd = (await readPhaseEvents(cwd, "verify-review")).find((e) => e.phase === "review" && e.edge === "end");
  assert.equal(reviewEnd?.tests?.exitCode, 3);
  assert.ok(reviewEnd?.review?.triggersFired.includes("tests-failing"));
});

await test("review policy at settle: mode=never writes the skip stub", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-13-policy-never.md", {
    title: "Policy Never", status: "proposed", created: "2026-07-13", change_id: "policy-never",
  });
  await writeProposedChange(cwd, "policy-never", ["- src/keep.ts"]);

  const { fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-13 · Policy Never");
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  await handler("--review never", ctx);

  await markTasksDone(cwd, "policy-never");
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));

  const review = await readFile(join(cwd, "readyset", "changes", "policy-never", "REVIEW.md"), "utf8");
  assert.match(review, /Review skipped \(never\)/);
});

await test("review policy at settle: auto mode with an open decision fires the trigger and recommends review instead of writing a skip stub", async () => {
  const cwd = await freshRepo();
  // readyset.review.fullLane: auto -- otherwise the default (always) reviews every full-lane
  // change unconditionally and the open-decisions trigger never gets a chance to fire.
  await writeConfig("readyset:\n  review:\n    fullLane: auto\n");
  await writeBrainstorm(cwd, "2026-07-13-policy-auto.md", {
    title: "Policy Auto", status: "proposed", created: "2026-07-13", change_id: "policy-auto",
  });
  await writeOpenDecisionChange(cwd, "policy-auto");

  const { fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-13 · Policy Auto");
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  await handler("", ctx);

  await markTasksDone(cwd, "policy-auto");
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));

  assert.ok(
    fakeUiWrap.notifications.some((n) => /Review recommended for "policy-auto": .*open-decisions/.test(n.message)),
    "review-recommended notice fired with the trigger name: " + JSON.stringify(fakeUiWrap.notifications),
  );
  const reviewPath = join(cwd, "readyset", "changes", "policy-auto", "REVIEW.md");
  const exists = await readFile(reviewPath, "utf8").catch(() => undefined);
  assert.equal(exists, undefined, "no skip stub is written when review is recommended, not skipped");
  await clearConfig();
});

await test("on-demand review that writes no REVIEW.md reports 'ran but wrote no REVIEW.md' and does not default to Archive now", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-11-review-empty.md", {
    title: "Review Empty", status: "approved", created: "2026-07-11", change_id: "review-empty",
  });
  await writeProposedChange(cwd, "review-empty", ["- src/keep.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };

  // The review turn writes nothing at all (no queued effect leaves REVIEW.md missing).
  fakeUiWrap.selectQueue.push("Address findings first");
  await handler("--review review-empty", ctx);

  const promptIndex = fakeUiWrap.selectPrompts.findIndex((p) => /REVIEW\.md/.test(p) && /Archive now\?/.test(p));
  assert.ok(promptIndex !== -1, "the archive prompt fired: " + JSON.stringify(fakeUiWrap.selectPrompts));
  const prompt = fakeUiWrap.selectPrompts[promptIndex];
  assert.match(prompt, /ran but wrote no REVIEW\.md/);
  assert.ok(!/stub/.test(prompt), "the false 'see the stub' wording is gone");

  const opts = fakeUiWrap.selectOptions[promptIndex] as { label: string }[];
  assert.notEqual(opts[0].label, "Archive now", "archiving is not the default after a failed review");
  assert.equal(opts[0].label, "Address findings first");
  assert.ok(opts.some((o) => o.label === "Archive now"), "'Archive now' is still offered, just not first");

  // Declining the archive still closes a window that was opened: one start, one end.
  const archiveEvents = (await readPhaseEvents(cwd, "review-empty")).filter((e) => e.phase === "archive");
  assert.deepEqual(archiveEvents.map((e) => e.edge), ["start", "end"], "declined archive is a balanced start/end pair");
  assert.equal(archiveEvents[1].outcome, "Address findings first");
});

await test("archive events: Archive now also records exactly one start and one end", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-12-archive-balanced.md", {
    title: "Archive Balanced", status: "approved", created: "2026-07-12", change_id: "archive-balanced",
  });
  const dir = await writeProposedChange(cwd, "archive-balanced", ["- src/keep.ts"]);
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nnone\n\n## Blocking\n\nnone\n", "utf8");
  });
  fakeUiWrap.selectQueue.push("Archive now");
  await handler("--review archive-balanced", ctx);

  const archiveEvents = (await phaseEventsArchivedOrLive(cwd, "archive-balanced")).filter((e) => e.phase === "archive");
  assert.deepEqual(archiveEvents.map((e) => e.edge), ["start", "end"], "archived: a balanced start/end pair");
  assert.equal(archiveEvents[1].outcome, "archived");
});

await test("handoff model: --phase-model apply=Y sets Y before the handoff and restores the original after settle", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-02-handoff-phase.md", {
    title: "Handoff Phase",
    status: "proposed",
    created: "2026-07-02",
    change_id: "handoff-phase",
  });
  await writeProposedChange(cwd, "handoff-phase", ["- src/keep.ts"]);

  const { fakePiWrap, fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-02 · Handoff Phase");
  fakeUiWrap.selectQueue.push("Approve & Execute");

  await handler("--phase-model apply=apply-model --model run-pin-model", ctx);

  assert.equal(fakePiWrap.setModelCalls.at(-1), "resolved:apply-model", "the apply phase override wins over the run pin");
  assert.ok(
    fakeUiWrap.notifications.some((n) => /Execution runs on "apply-model" \(from --phase-model flag\)/.test(n.message)),
  );

  await markTasksDone(cwd, "handoff-phase");
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  assert.equal(fakePiWrap.setModelCalls.at(-1), "session-default-model");

  const events = await phaseEventsArchivedOrLive(cwd, "handoff-phase");
  const applyEnd = events.find((e) => e.phase === "apply" && e.edge === "end");
  assert.equal(applyEnd?.outcome, "handoff-settled");
  assert.equal(applyEnd?.model, "apply-model");
});

await test("handoff model: Discard restores the model immediately (unchanged behavior)", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-03-handoff-discard.md", {
    title: "Handoff Discard",
    status: "proposed",
    created: "2026-07-03",
    change_id: "handoff-discard",
  });
  await writeProposedChange(cwd, "handoff-discard", ["- src/keep.ts"]);

  const { fakePiWrap, fakeUiWrap, handler, agentEnd, ctx, sessionId } = await gateCtx(cwd);
  fakeUiWrap.selectQueue.push("2026-07-03 · Handoff Discard");
  fakeUiWrap.selectQueue.push("Discard");

  await handler("--model pinned-model", ctx);

  // No handoff was set, so withPinnedModel's finally restored straight away.
  assert.deepEqual(fakePiWrap.setModelCalls, ["resolved:pinned-model", "session-default-model"]);
  assert.equal(fakePiWrap.calls.length, 0, "no execution turn fires on discard");

  // A later terminal agent_end must add nothing: no pending handoff, no apply end event.
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui, sessionId));
  assert.deepEqual(fakePiWrap.setModelCalls, ["resolved:pinned-model", "session-default-model"]);
  const events = await phaseEventsArchivedOrLive(cwd, "handoff-discard");
  assert.ok(!events.some((e) => e.phase === "apply" && e.edge === "end"), "no handoff-settled apply end event for a discarded run");
});

await test("handoff model: a failed apply-model pins falls back to the run pin, and the restore failure warns", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-07-04-handoff-noapply.md", {
    title: "Handoff No Apply",
    status: "proposed",
    created: "2026-07-04",
    change_id: "handoff-noapply",
  });
  await writeProposedChange(cwd, "handoff-noapply", ["- src/keep.ts"]);

  const fakePiWrap = makeFakePi(cwd);
  // The apply override can't be applied (no API key) -- it must warn and execution must continue.
  // The post-settle restore rejects, which must also warn rather than throw.
  fakePiWrap.pi.setModel = async (spec: unknown) => {
    fakePiWrap.setModelCalls.push(spec);
    if (spec === "session-default-model") throw new Error("model registry unavailable");
    return spec !== "resolved:apply-model";
  };
  const { handler, agentEnd } = await loadHandlerAndAgentEnd(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-07-04 · Handoff No Apply");
  fakeUiWrap.selectQueue.push("Approve & Execute");
  const ctx = {
    cwd,
    ui: fakeUiWrap.ui,
    waitForIdle: fakePiWrap.waitForIdle,
    models: { current: () => "session-default-model", resolve: (spec: string) => `resolved:${spec}` },
  };

  await handler("--phase-model apply=apply-model --model run-pin-model", ctx);

  assert.ok(
    fakeUiWrap.notifications.some((n) => /Execution model "apply-model" .*couldn't be applied/.test(n.message) && n.level === "warning"),
    "the failed apply override warns and execution continues: " + JSON.stringify(fakeUiWrap.notifications),
  );
  assert.equal(fakePiWrap.calls.length, 1, "the execution prompt is still handed off");
  assert.match(fakePiWrap.calls[0].prompt, /Implement the Readyset change "handoff-noapply"/);

  await markTasksDone(cwd, "handoff-noapply");
  await agentEnd({ willContinue: false }, eventCtx(cwd, fakeUiWrap.ui));
  assert.ok(
    fakeUiWrap.notifications.some((n) => /Couldn't restore the model this session had before the \/readyset run/.test(n.message) && n.level === "warning"),
    "the failed restore warns: " + JSON.stringify(fakeUiWrap.notifications),
  );
  const applyEnd = (await phaseEventsArchivedOrLive(cwd, "handoff-noapply")).find((e) => e.phase === "apply" && e.edge === "end");
  assert.equal(applyEnd?.outcome, "handoff-settled");
  assert.equal(applyEnd?.model, "apply-model", "the apply end event records what the apply start recorded");
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
  for (const tocEntry of ["1. Exploration", "2. Proposal", "3. Open decisions", "4. Scope", "5. Design", "6. Specs (1)", "7. Tasks (1/1)", "8. Verification summary", "9. Runtime evidence", "10. Code review", "11. Context log"]) {
    assert.ok(doc.includes(tocEntry), `expected table of contents to include "${tocEntry}"`);
  }
  // each section heading appears again as its own header, and the spec file path is shown
  for (const heading of ["EXPLORATION", "PROPOSAL", "OPEN DECISIONS", "SCOPE", "DESIGN", "SPECS (1)", "specs/widgets/spec.md", "TASKS (1/1)", "VERIFICATION SUMMARY", "RUNTIME EVIDENCE", "CODE REVIEW", "CONTEXT LOG"]) {
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
  assert.doesNotMatch(fakePiWrap.calls[0].prompt, /src\/skill\/mattpocock-grilling\.md/);
});

await test("F6: the grill prompt contains the edge-case checklist and the ask-only-if-it-changes-the-plan rule", async () => {
  const cwd = await freshRepo();
  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--idea Add an export feature", ctx);

  assert.equal(fakePiWrap.calls.length, 1);
  const prompt = fakePiWrap.calls[0].prompt;
  assert.match(prompt, /edge-case checklist/);
  assert.match(prompt, /empty\/missing values/);
  assert.match(prompt, /case sensitivity/);
  assert.match(prompt, /only if the answer changes the plan/);
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

  // Same destination as Approve & Execute once compaction is done: hands off Apply to core omp.
  assert.equal(fakePiWrap.calls.length, 1);
  assert.match(fakePiWrap.calls[0].prompt, /Implement the Readyset change "compact-test"/);
});

await test("Approve & Execute, keep context skips compact and hands off Apply to omp", async () => {
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

  // With a compact-capable ctx, "keep context" must NOT call it — but Apply hands off to omp.
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
  assert.equal(fakePiWrap.calls.length, 1, "Apply handoff should still fire");
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

  // No `compact` on this ctx at all -- an older omp build, or one that never exposed it.
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(
    fakeUiWrap.notifications.some((n) => /Compact isn't available in this context/.test(n.message)),
    "should warn that it's proceeding without compacting",
  );
  assert.equal(fakePiWrap.calls.length, 1, "Apply handoff should still fire");
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

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  // Core omp executes and touches a file outside the contract:
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "rogue.ts"), "// outside the contract\n", "utf8");

  // On-demand review:
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });
  fakeUiWrap.selectQueue.push("Not yet"); // archive prompt
  await handler("--review drift-test", ctx);

  assert.ok(
    fakeUiWrap.selectPrompts.some((p) => /outside the contract/.test(p) && /src\/rogue\.ts/.test(p)),
    "the archive prompt should surface the drift",
  );
});

await test("approve base: a file committed during the handed-off execution is picked up by review/scope even though the working tree is clean again", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
  execFileSync("git", ["config", "user.name", "t"], { cwd });
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "keep.ts"), "// base\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-qm", "base"], { cwd });

  await writeBrainstorm(cwd, "2026-02-04-basecommit.md", {
    title: "Base Commit", status: "proposed", created: "2026-02-04", change_id: "base-commit",
  });
  const dir = join(cwd, "readyset", "changes", "base-commit");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## Files This Change Will Touch\n\n- src/keep.ts\n- src/committed.ts (new)\n", "utf8");
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-02-04 · Base Commit");
  fakeUiWrap.selectQueue.push("Approve & Execute, keep context");
  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  // The approve base sha was captured at approval time.
  const { readApproveBase } = await import("../src/lib/readyset-spec.ts");
  const base = await readApproveBase(cwd, "base-commit");
  assert.ok(base, "an approve-base sha was recorded");

  // The handed-off execution writes a new file AND commits it -- the working tree is clean again.
  await writeFile(join(cwd, "src", "committed.ts"), "// new\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-qm", "apply work"], { cwd });
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });
  fakeUiWrap.selectQueue.push("Not yet");
  await handler("--review base-commit", ctx);

  const reviewCall = fakePiWrap.calls.find((c) => /Critically review the implementation/.test(c.prompt));
  assert.ok(reviewCall, "the review turn fired");
  assert.match(reviewCall.prompt, /src\/committed\.ts/, "the committed-but-no-longer-dirty file is still counted as changed this run");
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

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  // Complete tasks and run on-demand review to archive:
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 do thing\n  _Verified: ran the thing, it worked_\n", "utf8");
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nNo blockers found.\n", "utf8");
  });
  fakeUiWrap.selectQueue.push("Archive now");
  await handler("--review fast-fix", ctx);

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

  assert.ok(all.some((e) => e.phase === "apply" && e.edge === "start"), "an apply start event exists");
  assert.ok(all.some((e) => e.phase === "review" && e.edge === "end"), "a review end event exists");
  assert.ok(all.some((e) => e.phase === "archive" && e.edge === "end"), "an archive end event exists");

  for (const e of all) {
    if (e.phase === "grill") continue;
    assert.equal(e.lane, "fast", `event ${e.phase}/${e.edge} carries the effective lane`);
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

await test("F6: (assumed) scenarios are parsed and shown at the gate", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-06-10-f6assumed.md", {
    title: "F6 Assumed",
    status: "proposed",
    created: "2026-06-10",
    change_id: "f6assumed",
  });
  const dir = await writeProposedChange(cwd, "f6assumed", ["- src/keep.ts"]);
  await writeFile(
    join(dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: empty sort is default order (assumed)\n\n- **WHEN** empty sort is requested\n- **THEN** the command exits 0\n",
    "utf8",
  );
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 1;\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-06-10 · F6 Assumed");
  fakeUiWrap.selectQueue.push("Discard");

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.equal(fakePiWrap.calls.length, 0, "a straight discard fires no turns");
  const panel = fakeUiWrap.widgetHistory.flat();
  assert.ok(
    panel.some((line) => /assumed scenario: empty sort is default order \(assumed\)/.test(line)),
    "the gate panel lists the assumed scenario",
  );
  assert.ok(
    fakeUiWrap.editorTextHistory.join("\n\n").includes("- empty sort is default order (assumed)"),
    "the review document lists the assumed scenario",
  );
});

// Marks every task in a change's tasks.md as done, so a terminal agent_end after approving the
// change settles the handoff instead of recording a pause (executionComplete reads getProgress).
async function markTasksDone(cwd: string, changeId: string) {
  const path = join(cwd, "readyset", "changes", changeId, "tasks.md");
  const raw = (await readFile(path, "utf8").catch(() => "")) || "";
  const done = raw.replace(/^(\s*-\s*)\[ \]/gm, "$1[x]");
  await mkdir(join(cwd, "readyset", "changes", changeId), { recursive: true });
  await writeFile(path, done, "utf8");
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
  // Turn reserve (AUTO_TURN_RESERVE = 1): an automatic repair never takes the last turn, which
  // stays free for a user Refine. Refine 5 lands at spent=9 (10-9=1, not > 1), so from there the
  // repair records skipped-budget instead. The loop itself halts when the 10-turn budget is spent.
  const skipped = repairEnds.filter((e) => e.outcome === "skipped-budget");
  assert.equal(skipped.length, 2, "the last two gate iterations reserved turns and skipped the repair");
  assert.equal(repairEnds.length, 6, "four repair turns ran, then two skipped-budget events");
  assert.ok(
    fakeUiWrap.notifications.some((n) => /leave no turn for a Refine/.test(n.message) && n.level === "warning"),
    "the reserve notify says the last turn is kept for a Refine",
  );
});

await test("phase budget: an Explore/Propose turn past readyset.phaseBudget.minutes is aborted and recorded", async () => {
  const cwd = await freshRepo();
  await writeConfig("readyset:\n  phaseBudget:\n    minutes: 0.001\n"); // 60ms
  try {
    await writeBrainstorm(cwd, "2026-07-28-slow.md", { title: "Slow", status: "open", created: "2026-07-28" }, VALID_BRAINSTORM_BODY);
    const dir = join(cwd, "readyset", "changes", "slow");
    const fakePiWrap = makeFakePi(cwd);
    fakePiWrap.queueEffect(async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "EXPLORATION.md"), "## Findings\n\npartial\n", "utf8");
    });
    fakePiWrap.queueEffect(async () => {});
    const handler = await loadHandler(fakePiWrap.pi);
    const ui = makeFakeUi();
    ui.selectQueue.push("2026-07-28 · Slow");
    let aborts = 0;
    const ctx = {
      cwd, ui: ui.ui,
      // Each turn takes 250ms, well past the 60ms ceiling.
      waitForIdle: async () => { await new Promise((r) => setTimeout(r, 250)); await fakePiWrap.waitForIdle(); },
      abort: () => { aborts++; },
    };
    await handler("", ctx);

    assert.equal(aborts, 2, "both Explore and Propose were aborted at the ceiling");
    assert.ok(ui.notifications.some((n) => /Explore ran past its <1-minute phase budget — aborting the turn/.test(n.message)));
    const events = await readPhaseEvents(cwd, "slow");
    assert.equal(events.find((e) => e.phase === "explore" && e.edge === "end")?.outcome, "budget-aborted-partial");
    assert.equal(events.find((e) => e.phase === "propose" && e.edge === "end")?.outcome, "budget-aborted");
    assert.match((await readContext(cwd, "slow")) ?? "", /ABORTED at the ceiling/);
  } finally {
    await clearConfig();
  }
});

await test("phase budget: minutes 0 measures only and never aborts", async () => {
  const cwd = await freshRepo();
  await writeConfig("readyset:\n  phaseBudget:\n    minutes: 0\n");
  try {
    await writeBrainstorm(cwd, "2026-07-29-unbounded.md", { title: "Unbounded", status: "open", created: "2026-07-29" }, VALID_BRAINSTORM_BODY);
    const fakePiWrap = makeFakePi(cwd);
    fakePiWrap.queueEffect(async () => {});
    fakePiWrap.queueEffect(async () => {});
    const handler = await loadHandler(fakePiWrap.pi);
    const ui = makeFakeUi();
    ui.selectQueue.push("2026-07-29 · Unbounded");
    let aborts = 0;
    const ctx = {
      cwd, ui: ui.ui,
      waitForIdle: async () => { await new Promise((r) => setTimeout(r, 30)); await fakePiWrap.waitForIdle(); },
      abort: () => { aborts++; },
    };
    await handler("", ctx);
    assert.equal(aborts, 0);
    assert.match((await readContext(cwd, "unbounded")) ?? "", /\(no budget\)/);
  } finally {
    await clearConfig();
  }
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

await test("S8: the Apply prompt carries the minimal-diff rules", async () => {
  await writeConfig(NOTES_REQUIRED_CONFIG); // the pre-lite contract: _Verified notes enforced
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
  assert.match(applyCall.prompt, /Never modify seed data, fixtures, or sample data/);
  assert.match(applyCall.prompt, /Never add runtime self-checks or assertions/);
  assert.match(applyCall.prompt, /Never change an existing test's expectations/);
  assert.match(applyCall.prompt, /every doc the contract lists must be updated/);
  assert.match(applyCall.prompt, /must say so in its name/);
  await clearConfig();
});

// --- F2/F3: open decisions + blocking review findings -----------------------------------------

/** A proposed change whose proposal.md carries an `## Open Decisions` section with one decision. */
async function writeOpenDecisionChange(cwd: string, changeId: string, opts: { recommended?: boolean; reviewBody?: string } = {}) {
  const dir = join(cwd, "readyset", "changes", changeId);
  await mkdir(join(dir, "specs", "cap"), { recursive: true });
  const rec = opts.recommended === false ? "" : "- Recommended: sqlite — simpler for one process\n";
  await writeFile(
    join(dir, "proposal.md"),
    [
      "---",
      "lane: full",
      "---",
      "## Why",
      "",
      "x",
      "",
      "## What Changes",
      "",
      "- x",
      "",
      "## Files This Change Will Touch",
      "",
      "- src/keep.ts",
      "",
      "## Open Decisions",
      "",
      "### Which store?",
      "- Options: sqlite | postgres",
      rec + "- Changes per option: postgres adds a migration step",
      "",
      "## Assumptions",
      "",
      "- default timeout — 30s",
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    join(dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** the command exits 0\n",
    "utf8",
  );
  await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");
  if (opts.reviewBody !== undefined) await writeFile(join(dir, "REVIEW.md"), opts.reviewBody, "utf8");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 1;\n", "utf8");
  return dir;
}

await test("F3: the gate shows open decisions and lists them in the review document", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-05-10-f3a.md", { title: "F3 A", status: "proposed", created: "2026-05-10", change_id: "f3a" });
  await writeOpenDecisionChange(cwd, "f3a");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-05-10 · F3 A");
  fakeUiWrap.selectQueue.push("Discard");

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const panel = fakeUiWrap.widgetHistory.flat();
  assert.ok(panel.some((l) => /open decisions: 1/.test(l)), "the panel states the open-decision count");
  assert.ok(panel.some((l) => /Which store\?/.test(l)), "the panel lists the question");
  const doc = fakeUiWrap.editorTextHistory.join("\n\n");
  assert.match(doc, /Which store\?/, "the review document names the question");
  assert.match(doc, /Open decisions/, "the review document has the Open decisions section");
  assert.match(doc, /default timeout — 30s/, "the review document lists the assumptions");
});

await test("F3: 'Resolve open decisions' routes to Refine with the list", async () => {
  const cwd = await freshRepo();
  await writeBrainstorm(cwd, "2026-05-11-f3b.md", { title: "F3 B", status: "proposed", created: "2026-05-11", change_id: "f3b" });
  const dir = await writeOpenDecisionChange(cwd, "f3b");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-05-11 · F3 B");
  fakeUiWrap.selectQueue.push("Resolve open decisions");
  // A Refine turn fires from the resolve branch; then the gate reopens -> Discard.
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/keep.ts\n", "utf8");
  });
  fakeUiWrap.selectQueue.push("Discard");

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const refine = fakePiWrap.calls.find((c) => /Revise the Readyset change "f3b"/.test(c.prompt));
  assert.ok(refine, "a Refine turn fired");
  assert.match(refine.prompt, /Which store\?/, "the refine feedback carries the question");
  assert.match(refine.prompt, /recommended:/, "the refine feedback names the recommendation");
});

await test("F3: the Apply prompt carries the apply-recommended rule when N > 0", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-05-12-f3c.md", { title: "F3 C", status: "proposed", created: "2026-05-12", change_id: "f3c" });
  const dir = await writeOpenDecisionChange(cwd, "f3c");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-05-12 · F3 C");
  fakeUiWrap.selectQueue.push("Approve & Execute");

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const apply = fakePiWrap.calls.find((c) => /Implement the Readyset change "f3c"/.test(c.prompt));
  assert.ok(apply, "an Apply turn fired");
  assert.match(apply.prompt, /apply the RECOMMENDED option/);
  assert.match(apply.prompt, /## Decisions made during Apply/);
});

await test("F3: the open-decisions trigger fires and the gate end event records the count", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await writeBrainstorm(cwd, "2026-05-13-f3d.md", { title: "F3 D", status: "proposed", created: "2026-05-13", change_id: "f3d" });
  const dir = await writeOpenDecisionChange(cwd, "f3d");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-05-13 · F3 D");
  fakeUiWrap.selectQueue.push("Approve & Execute");

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const events = await readPhaseEvents(cwd, "f3d");
  const gateEnd = events.find((e) => e.phase === "gate" && e.edge === "end");
  assert.ok(gateEnd, "a gate end event exists");
  assert.equal(gateEnd.openDecisions, 1, "the gate end event records the open-decision count");

  // Simulate omp execution
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
  await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 2;\n", "utf8");

  // Run on-demand review
  fakeUiWrap.selectQueue.push("Not yet");
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n\n## Blocking\n\nnone\n", "utf8");
  });
  await handler("--review f3d", ctx);

  const reviewEvents = await readPhaseEvents(cwd, "f3d");
  const reviewEnd = reviewEvents.find((e) => e.phase === "review" && e.edge === "end");
  assert.ok(reviewEnd?.review?.triggersFired.includes("open-decisions"), "the open-decisions trigger fired");
});

// --- F4/F5: protected paths and requested docs --------------------------------------------------

await test("F4: a changed protected path fires the protected-path trigger during on-demand review", async () => {
  const cwd = await freshRepo();
  execFileSync("git", ["init", "-q"], { cwd });
  await clearConfig();
  await writeBrainstorm(cwd, "2026-06-01-f4protected.md", {
    title: "F4 Protected",
    status: "proposed",
    created: "2026-06-01",
    change_id: "f4protected",
  });
  const dir = await writeProposedChange(cwd, "f4protected", [
    "- src/keep.ts",
    "- db/seeds/users.ts — requested production seed update",
  ]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 1;\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();

  fakeUiWrap.selectQueue.push("2026-06-01 · F4 Protected");
  fakeUiWrap.selectQueue.push("Approve & Execute");

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  // Simulate omp execution touching a protected path
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran `npm test`, all pass_\n", "utf8");
  await mkdir(join(cwd, "db", "seeds"), { recursive: true });
  await writeFile(join(cwd, "db/seeds/users.ts"), "export const users = [];\n", "utf8");

  // Run on-demand review
  fakeUiWrap.selectQueue.push("Not yet");
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n\n## Blocking\n\nnone\n", "utf8");
  });
  await handler("--review f4protected", ctx);

  const events = await readPhaseEvents(cwd, "f4protected");
  const reviewEnd = events.find((e) => e.phase === "review" && e.edge === "end");
  assert.ok(reviewEnd?.review?.triggersFired.includes("protected-path"), "the protected-path trigger fired");
});

await test("F5: a doc mention missing from the contract is shown in the gate and the repair turn adds it as (new)", async () => {
  const cwd = await freshRepo();
  await clearConfig();
  await writeBrainstorm(
    cwd,
    "2026-06-02-f5docs.md",
    { title: "F5 Docs", status: "proposed", created: "2026-06-02", change_id: "f5docs" },
    `${VALID_BRAINSTORM_BODY.replace(
      "## Scope\n- In scope: the thing itself\n- Out of scope: unrelated things\n",
      "## Scope\n- In scope: the thing itself\n- Out of scope: unrelated things\n- Please update CHANGELOG.md to document this behavior change.\n- Follow the deprecation path in the code.\n",
    )}`,
  );
  const dir = await writeProposedChange(cwd, "f5docs", ["- src/keep.ts"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "keep.ts"), "export const keep = 1;\n", "utf8");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-06-02 · F5 Docs");
  fakeUiWrap.selectQueue.push("Refine");
  fakeUiWrap.inputQueue.push("tighten the scope wording");
  fakeUiWrap.selectQueue.push("Discard");

  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/keep.ts\n", "utf8");
  });
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/keep.ts\n- CHANGELOG.md (new)\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  const panel = fakeUiWrap.widgetHistory.flat();
  assert.ok(
    panel.some((line) => /requested doc missing from contract: changelog/.test(line)),
    "the gate panel names the requested doc missing from the contract",
  );
  assert.ok(
    fakeUiWrap.editorTextHistory.join("\n\n").includes("requested doc missing from contract: changelog"),
    "the review document Scope section names the requested doc",
  );
  assert.ok(
    panel.some((line) => /requested deprecation has no matching contract entry or existing file — warning only, not a repair item/.test(line)),
    "the gate panel shows the deprecation advisory",
  );
  const repair = fakePiWrap.calls.find((call) => /scope contract in proposal\.md is wrong/.test(call.prompt));
  assert.ok(repair, "a contract-repair turn fired");
  assert.match(repair.prompt, /requested doc missing from contract: changelog/);
  assert.match(repair.prompt, /marked \(new\) if the file does not exist yet/);
  assert.ok(!/deprecation/i.test(repair.prompt), "the repair prompt never mentions the advisory-only deprecation");

  const proposal = await readFile(join(dir, "proposal.md"), "utf8");
  assert.match(proposal, /- CHANGELOG\.md \(new\)/, "the repaired contract lists the requested doc as (new)");
  const events = await readPhaseEvents(cwd, "f5docs");
  const repairEnd = events.find((event) => event.phase === "contract-repair" && event.edge === "end");
  assert.equal(repairEnd?.outcome, "fixed", "the post-repair contract check passes");
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

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  // Simulate omp execution
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");
  await writeFile(join(cwd, "src", "created.ts"), "export const fresh = true;\n", "utf8");
  await rm(join(cwd, "src", "gone.ts"), { force: true });

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

await test("F7: ARTIFACT_GUIDE contains the workflow-internals rule", async () => {
  const cwd = await freshRepo();
  await clearConfig();
  await writeBrainstorm(
    cwd,
    "2026-06-20-f7guide.md",
    { title: "F7 Guide", status: "open", created: "2026-06-20", change_id: "f7guide", lane: "full" },
    VALID_BRAINSTORM_BODY,
  );
  const dir = join(cwd, "readyset", "changes", "f7guide");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-06-20 · F7 Guide");
  fakeUiWrap.selectQueue.push("Discard");
  fakePiWrap.queueEffect(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "proposal.md"),
      FAST_LANE_PROPOSAL("## Acceptance\n\n- **WHEN** a sorted list is requested **THEN** the command exits 0\n"),
      "utf8",
    );
    await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  const propose = fakePiWrap.calls.find((call) => /Create a Readyset change named "f7guide"/.test(call.prompt));
  assert.ok(propose, "a Propose turn fired");
  assert.match(propose.prompt, /Never mention Readyset's own workflow/);
  assert.match(propose.prompt, /## Grounding/);
});

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
  // consumes exactly one turn. The proposal blows past 1.5x from round seven on: round seven
  // (spent=7) can still afford a trim and keep a turn for a Refine; round eight's trim would take
  // the last turn (turnsAvailableFor(budget, AUTO_TURN_RESERVE) is false), so it is skipped.
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
    fakeUiWrap.notifications.some((n) => /leave no turn for a Refine/.test(n.message) && n.level === "warning"),
    "the trim reserve says the last turn is kept for a Refine",
  );
  // Exactly one trim fired (round seven); round eight's was skipped at the reserve boundary.
  assert.equal(
    fakePiWrap.calls.filter((c) => /over their character budget/.test(c.prompt)).length,
    1,
    "one Trim turn fired while a Refine still fit afterwards",
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

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("--lane fast", ctx);

  // Simulate omp execution
  await writeFile(join(dir, "tasks.md"), "- [x] 1.1 x\n  _Verified: ran it_\n", "utf8");

  // Run on-demand review and archive
  fakeUiWrap.selectQueue.push("Archive now");
  fakePiWrap.queueEffect(async () => {
    await writeFile(join(dir, "REVIEW.md"), "## Findings\n\nfine\n", "utf8");
  });
  await handler("--review fast-archive", ctx);

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

// --- Stay-in-repo rule + outside-repo tripwire ------------------------------------------------

async function loadMod(): Promise<any> {
  return (await import(`../src/extensions/readyset-review.ts?t=${Date.now()}-${Math.random()}`)) as any;
}

await test("stay-in-repo rule: every phase prompt and SKILL.md carry it", async () => {
  const mod = await loadMod();
  const prompts: [string, string][] = [
    ["grill", mod.grillTurnPrompt("idea", "2026-01-01", "ask")],
    ["explore", mod.exploreTurnPrompt({ changeId: "x", file: ".ai/brainstorms/x.md" } as any, [])],
    ["propose", mod.proposeTurnPrompt({ changeId: "x", file: ".ai/brainstorms/x.md" } as any)],
    ["refine", mod.refineTurnPrompt("x", "fb", [])],
    ["apply", mod.applyTurnPrompt("x")],
    ["code-review", mod.codeReviewTurnPrompt("x")],
    ["contract-repair", mod.contractRepairPrompt(["p"])],
    ["trim", mod.trimPrompt([{ file: "proposal", chars: 1, budget: 1 }] as any)],
  ];
  for (const [name, prompt] of prompts) {
    assert.match(prompt, /Work only inside the current repository/, `${name} prompt carries the rule`);
    assert.ok(prompt.trimEnd().endsWith(mod.STAY_IN_REPO_RULE), `${name} prompt ends with the rule as its last paragraph`);
  }
  const skill = await readFile("src/skill/SKILL.md", "utf8");
  assert.ok(skill.includes(mod.STAY_IN_REPO_RULE), "SKILL.md carries the rule byte-identically");
  const grill = mod.grillTurnPrompt("idea", "2026-01-01", "ask");
  assert.doesNotMatch(grill, /mattpocock\/skills style/);
  assert.doesNotMatch(grill, /brainstorm-ai skill's own closing/);
});

await test("prompts: WIP preservation and anti-overengineering constraints are present", async () => {
  const mod = await loadMod();
  const propose = mod.proposeTurnPrompt({ changeId: "x", file: ".ai/brainstorms/x.md" } as any);
  const apply = mod.applyTurnPrompt("x");
  const grill = mod.grillTurnPrompt("idea", "2026-01-01", "ask");

  // Requirement 1: dirty tree is user WIP; never tidy it / never list untouched files.
  assert.match(propose, /never add an untouched dirty or untracked file to `## Files This Change Will Touch`/);
  assert.match(propose, /user note/);
  assert.match(apply, /keep every pre-existing comment, user note/);
  assert.match(apply, /never strip, reword, reformat, or delete a stray comment/);

  // Requirement 2: the mandatory note rule leads the apply prompt.
  const applyIdx = apply.indexOf("MANDATORY: every task you complete");
  const implIdx = apply.indexOf("Implement the Readyset change");
  assert.ok(applyIdx >= 0, "the mandatory _Verified: rule is present");
  assert.ok(implIdx >= 0 && applyIdx < implIdx, "the mandatory rule precedes the implement instruction");
  assert.match(apply, /will stop and send this change back/);

  // Requirement 3: no phantom auth unless explicitly required -- generalized (no bench-specific
  // x-api-key/401 example baked into the wording).
  for (const [name, prompt] of [["propose", propose], ["grill", grill]] as const) {
    assert.match(prompt, /do NOT invent secondary systems that were not requested/i, `${name} forbids inventing secondary systems`);
    assert.match(prompt, /authentication, authorization, or credential-validation logic/i, `${name} forbids phantom auth`);
    assert.doesNotMatch(prompt, /x-api-key/, `${name} carries no bench-specific x-api-key example`);
    assert.doesNotMatch(prompt, /401 UNAUTHORIZED/, `${name} carries no bench-specific 401 example`);
  }
});

await test("lane-aware grounding: fast-lane propose/apply never mention EXPLORATION.md/design.md/specs; full lane does; fast propose is smaller than full", async () => {
  const mod = await loadMod();
  const brainstorm = { changeId: "x", file: ".ai/brainstorms/x.md" } as any;
  const fullPropose = mod.proposeTurnPrompt(brainstorm, "full");
  const fastPropose = mod.proposeTurnPrompt(brainstorm, "fast");

  assert.match(fullPropose, /read readyset\/changes\/x\/EXPLORATION\.md/, "full lane is told to read EXPLORATION.md");
  assert.doesNotMatch(fastPropose, /read readyset\/changes\/x\/EXPLORATION\.md/, "fast lane is never told to read EXPLORATION.md -- no Explore turn ran");
  assert.doesNotMatch(fastPropose, /already checked against real repo state in a prior turn/, "fast lane never claims a prior grounding turn already ran");

  // The fix's whole point: fast used to be LARGER than full (contradictory content bloated it).
  // It must now be smaller, since it carries none of the full-lane-only grounding/design/specs text.
  assert.ok(
    fastPropose.length < fullPropose.length,
    `fast lane propose prompt (${fastPropose.length} chars) should be smaller than full lane's (${fullPropose.length} chars)`,
  );

  const fullApply = mod.applyTurnPrompt("x", [], "full");
  const fastApply = mod.applyTurnPrompt("x", [], "fast");
  assert.match(fullApply, /design\.md/, "full lane apply still reads design.md/specs");
  assert.match(fullApply, /specs\/\*\*/, "full lane apply still reads specs/**");
  assert.doesNotMatch(fastApply, /design\.md/, "fast lane apply never mentions design.md -- it doesn't exist");
  assert.doesNotMatch(fastApply, /specs\/\*\*/, "fast lane apply never mentions specs/** -- fast lane carries no spec delta");

  const fullReview = mod.codeReviewTurnPrompt("x", "full");
  const fastReview = mod.codeReviewTurnPrompt("x", "fast");
  assert.match(fullReview, /design\.md/, "full lane review still reads design.md");
  assert.match(fullReview, /specs\/\*\*/, "full lane review still reads specs/**");
  assert.doesNotMatch(fastReview, /design\.md/, "fast lane review never mentions design.md -- it doesn't exist");
  assert.doesNotMatch(fastReview, /specs\/\*\*/, "fast lane review never mentions specs/**");
  assert.match(fastReview, /## Acceptance/, "fast lane review points at proposal.md's Acceptance scenarios");
});

await test("prompts: no two sentences glued together across string concatenation", async () => {
  const mod = await loadMod();
  const prompts: [string, string][] = [
    ["apply full", mod.applyTurnPrompt("x", [], "full")],
    ["apply fast", mod.applyTurnPrompt("x", [], "fast")],
    ["review full", mod.codeReviewTurnPrompt("x", "full")],
    ["review fast", mod.codeReviewTurnPrompt("x", "fast")],
    ["explore", mod.exploreTurnPrompt({ changeId: "x", file: ".ai/brainstorms/x.md" } as any, [])],
    ["propose full", mod.proposeTurnPrompt({ changeId: "x", file: ".ai/brainstorms/x.md" } as any, "full")],
    ["propose fast", mod.proposeTurnPrompt({ changeId: "x", file: ".ai/brainstorms/x.md" } as any, "fast")],
    ["refine", mod.refineTurnPrompt("x", "fb", [])],
    ["grill", mod.grillTurnPrompt("idea", "2026-01-01", "ask")],
  ];
  for (const [name, prompt] of prompts) {
    // A lowercase word, a period, then an uppercase letter with no space: "it.Keep".
    const glued = prompt.match(/\b[a-z]{2,}[.!?][A-Z][a-z]/g) ?? [];
    assert.deepEqual(glued, [], `${name} prompt has a glued sentence boundary`);
  }
});

await test("grill prompt: the per-task commit-only/merge-request question and its template field are gone", async () => {
  const mod = await loadMod();
  const grill = mod.grillTurnPrompt("idea", "2026-01-01", "ask");
  assert.doesNotMatch(grill, /commit-only vs\.? commit \+ merge request/i, "the git-flow question is no longer asked (nothing consumed the answer)");
  assert.doesNotMatch(grill, /Per-task flow/, "the template no longer asks for an unconsumed Per-task flow field");
});

await test("outside-repo tripwire: classifies outside-repo calls and ignores in-repo ones", async () => {
  const mod = await loadMod();
  const cwd = await mkdtemp(join(tmpdir(), "outside-cwd-"));
  const kind = (toolName: string, input: Record<string, unknown>) => mod.classifyOutsideRepoAccess(toolName, input, cwd);
  assert.equal(kind("bash", { command: "cat /etc/passwd" }), "outside", "absolute path outside cwd");
  assert.equal(kind("bash", { command: "find / -name 'readyset*'" }), "outside", "find / root token");
  assert.equal(kind("bash", { command: "cat ~/.omp/agent/config.yml" }), "outside", "tilde reference");
  assert.equal(kind("bash", { command: "cat $HOME/Downloads/notes.md" }), "outside", "$HOME reference");
  assert.equal(kind("bash", { command: "ls /home/someone" }), "outside", "real top-level dir");
  assert.equal(kind("bash", { command: "cat 2>/home/x" }), "outside", "redirection target still caught");
  assert.equal(kind("read", { path: "/etc/passwd" }), "outside", "read outside path");
  assert.equal(kind("grep", { pattern: "x", path: "/etc" }), "outside", "grep path counts");
  assert.equal(kind("bash", { command: "mktemp -d /tmp/x" }), "tmp", "scratch dir is its own category");
  assert.equal(kind("glob", { path: "/tmp" }), "tmp", "glob /tmp is the tmp category");
  assert.equal(kind("bash", { command: "npm test > /dev/null 2>&1" }), undefined, "/dev/null is ignored");
  assert.equal(kind("grep", { pattern: "/orders/:id" }), undefined, "grep pattern is never a path");
  assert.equal(kind("bash", { command: "grep -rn \"'/products'\" src" }), undefined, "route string is not a host dir");
  assert.equal(kind("bash", { command: "curl localhost:3000/orders/1" }), undefined, "URL path is not absolute");
  assert.equal(kind("bash", { command: "node -e \"console.log(1)\"" }), undefined, "inline script");
  assert.equal(kind("bash", { command: "cat src/a.ts" }), undefined, "relative bash path is inside");
  assert.equal(kind("bash", { command: `cat ${cwd}/src/a.ts` }), undefined, "absolute path under cwd is inside");
  assert.equal(kind("read", { path: join(cwd, "src/a.ts") }), undefined, "read under cwd is inside");
  assert.equal(kind("read", { path: "src/a.ts" }), undefined, "relative read is inside");
  assert.equal(kind("grep", { pattern: "x", path: cwd }), undefined, "grep path == cwd is inside");
  assert.equal(kind("edit", { path: "/etc/passwd" }), undefined, "unwatched tool is never recorded");
});

await test("outside-repo tripwire: no-op when the host has no tool_call hook", async () => {
  const mod = await loadMod();
  assert.doesNotThrow(() =>
    mod.default({ sendUserMessage() {}, registerCommand() {}, registerTool() {}, zod: fakeZod } as any),
  );
  assert.equal(mod.outsideRepoCount(), 0);
});

await test("outside-repo tripwire: records an outside bash call and ignores in-repo ones", async () => {
  const mod = await loadMod();
  const cwd = await freshRepo();
  const fakePiWrap = makeFakePi(cwd);
  mod.default(fakePiWrap.pi as any);
  assert.ok(fakePiWrap.outsideHandlers.length > 0, "the tool_call handler was registered");
  mod.resetOutsideRepoWatch(cwd);
  const handler = fakePiWrap.outsideHandlers[0];
  handler({ toolName: "bash", input: { command: "find / -name 'readyset*'" } }, { cwd });
  assert.equal(mod.outsideRepoCount(), 1, "an outside bash call is recorded");
  handler({ toolName: "read", input: { path: join(cwd, "src/a.ts") } }, { cwd });
  assert.equal(mod.outsideRepoCount(), 1, "an in-repo read is ignored");
  handler({ toolName: "bash", input: { command: "find / -name 'readyset*'" } }, { cwd: `${cwd}-other` });
  assert.equal(mod.outsideRepoCount(), 1, "a call from a different cwd is ignored");
  handler({ toolName: "bash", input: { command: "mktemp -d /tmp/x" } }, { cwd });
  assert.equal(mod.outsideRepoCount(), 1, "a /tmp call is not counted in the headline");
  assert.equal(mod.outsideRepoTmpCount(), 1, "a /tmp call is counted in the tmp category");
});

await test("outside-repo tripwire: an outside bash call during Explore shows at the gate, in CONTEXT.md and on the gate end event", async () => {
  const cwd = await freshRepo();
  await clearConfig();
  await writeBrainstorm(
    cwd,
    "2026-07-01-tripwire.md",
    { title: "Tripwire", status: "open", created: "2026-07-01", change_id: "tripwire" },
    VALID_BRAINSTORM_BODY,
  );
  const dir = join(cwd, "readyset", "changes", "tripwire");

  const fakePiWrap = makeFakePi(cwd);
  const handler = await loadHandler(fakePiWrap.pi);
  const fakeUiWrap = makeFakeUi();
  fakeUiWrap.selectQueue.push("2026-07-01 · Tripwire"); // pick
  fakeUiWrap.selectQueue.push("Discard"); // gate

  // Fire the outside bash call during the Explore turn's waitForIdle, before the gate.
  fakePiWrap.queueEffect(async () => {
    fakePiWrap.outsideHandlers.forEach((h) => h({ toolName: "bash", input: { command: "find / -name 'readyset*'" } }, { cwd }));
    fakePiWrap.outsideHandlers.forEach((h) => h({ toolName: "bash", input: { command: "mktemp -d /tmp/x" } }, { cwd }));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "EXPLORATION.md"), "## Findings\n\nchecked things\n", "utf8");
  });
  // Propose turn: write a valid proposal so the run reaches the gate.
  fakePiWrap.queueEffect(async () => {
    await writeFile(
      join(dir, "proposal.md"),
      "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/keep.ts\n",
      "utf8",
    );
  });

  const ctx = { cwd, ui: fakeUiWrap.ui, waitForIdle: fakePiWrap.waitForIdle };
  await handler("", ctx);

  assert.ok(
    fakeUiWrap.widgetHistory.flat().some((line) => /⚠ outside-repo access: 1 tool call/.test(line)),
    "the gate panel shows the outside-repo count",
  );
  assert.ok(
    fakeUiWrap.widgetHistory.flat().some((line) => /\/tmp access: 1 tool call/.test(line)),
    "the gate panel shows the /tmp category",
  );
  const context = await readContext(cwd, "tripwire");
  assert.match(context, /⚠ outside-repo access/, "CONTEXT.md records the outside-repo access");
  assert.match(context, /tmp-directory access/, "CONTEXT.md records the /tmp category");
  const events = await readPhaseEvents(cwd, "tripwire");
  const gateEnd = events.find((event) => event.phase === "gate" && event.edge === "end");
  assert.equal(gateEnd?.outsideRepo, 1, "the gate end event carries the outsideRepo count");
  assert.equal(gateEnd?.outsideRepoTmp, 1, "the gate end event carries the outsideRepoTmp count");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);