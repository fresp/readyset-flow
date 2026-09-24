import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { verifyPanelLine } from "../src/lib/readyset-gate-ui.ts";
import { detectTestCommand, judgeTestRun, parseFailures, resolveVerifySettings, runTestCommand, type TestRun } from "../src/lib/readyset-verify.ts";

let pass = 0;
let fail = 0;
async function test(name: string, fn: () => Promise<void> | void) {
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

async function repoWith(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "readyset-verify-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(cwd, name), content, "utf8");
  return cwd;
}

const run = (over: Partial<TestRun>): TestRun => ({ command: "x", exitCode: 1, timedOut: false, passed: false, durationMs: 1, tail: "", at: "t", ...over });

await test("detectTestCommand: package manager from the lockfile, then go / cargo / pytest / make, else nothing", async () => {
  const pkg = JSON.stringify({ scripts: { test: "node --test" } });
  assert.equal(detectTestCommand(await repoWith({ "package.json": pkg })), "npm test");
  assert.equal(detectTestCommand(await repoWith({ "package.json": pkg, "pnpm-lock.yaml": "" })), "pnpm test");
  assert.equal(detectTestCommand(await repoWith({ "package.json": pkg, "yarn.lock": "" })), "yarn test");
  assert.equal(detectTestCommand(await repoWith({ "package.json": pkg, "bun.lock": "" })), "bun run test");
  assert.equal(detectTestCommand(await repoWith({ "package.json": JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }) })), undefined);
  assert.equal(detectTestCommand(await repoWith({ "go.mod": "module x\n" })), "go test ./...");
  assert.equal(detectTestCommand(await repoWith({ "Cargo.toml": "[package]\n" })), "cargo test");
  assert.equal(detectTestCommand(await repoWith({ "pyproject.toml": "[tool.pytest.ini_options]\n" })), "python -m pytest -q");
  assert.equal(detectTestCommand(await repoWith({ "pyproject.toml": "[project]\nname='x'\n" })), undefined);
  assert.equal(detectTestCommand(await repoWith({ Makefile: "build:\n\ttrue\ntest:\n\ttrue\n" })), "make test");
  assert.equal(detectTestCommand(await repoWith({ "README.md": "x" })), undefined);
});

await test("resolveVerifySettings: config wins, none disables, nothing detected falls back to notes", async () => {
  const cwd = await repoWith({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
  assert.deepEqual(resolveVerifySettings(cwd, { command: "make check", disabled: false, requireNotes: false }), { command: "make check", source: "config", requireNotes: false });
  assert.deepEqual(resolveVerifySettings(cwd, { disabled: false, requireNotes: false }), { command: "npm test", source: "detected", requireNotes: false });
  assert.deepEqual(resolveVerifySettings(cwd, { disabled: true, requireNotes: false }), { requireNotes: false });
  assert.deepEqual(resolveVerifySettings(await repoWith({}), { disabled: false, requireNotes: false }), { requireNotes: true });
});

await test("parseFailures: TAP, node spec / jest / vitest marks, pytest, go, cargo; durations stripped, deduped", () => {
  const out = [
    "not ok 1 - adds totals",
    "  not ok 2 - rounds # TODO",
    "✖ rounds (1.25ms)",
    "✖ failing tests:",
    "  ✕ jest case (3 ms)",
    "FAILED tests/test_a.py::test_x - AssertionError",
    "--- FAIL: TestGo (0.00s)",
    "test cargo_case ... FAILED",
    "ok 3 - passes",
  ].join("\n");
  assert.deepEqual(parseFailures(out).sort(), ["TestGo", "adds totals", "cargo_case", "jest case", "rounds", "tests/test_a.py::test_x"].sort());
  assert.deepEqual(parseFailures("all good\n"), []);
});

await test("judgeTestRun: pass never blocks; a green or missing baseline blocks any failure; a red baseline blocks only new ones", () => {
  assert.equal(judgeTestRun(run({ passed: true, exitCode: 0 })).blocking, false);
  assert.equal(judgeTestRun(run({ failures: ["a"] })).blocking, true);
  assert.equal(judgeTestRun(run({ failures: ["a"] }), { command: "x", passed: true, exitCode: 0, timedOut: false, at: "t" }).blocking, true);
  const red = { command: "x", passed: false, exitCode: 1, timedOut: false, failures: ["a"], at: "t" };
  assert.deepEqual(judgeTestRun(run({ failures: ["a"] }), red), { blocking: false, newFailures: [], preexisting: true });
  assert.deepEqual(judgeTestRun(run({ failures: ["a", "b"] }), red), { blocking: true, newFailures: ["b"], preexisting: false });
  // Unparseable output on either side: it cannot tell, so it does not block (and says it is pre-existing).
  assert.deepEqual(judgeTestRun(run({}), { ...red, failures: undefined }), { blocking: false, newFailures: [], preexisting: true });
});

await test("runTestCommand records the parsed failures", async () => {
  const cwd = await repoWith({});
  const r = await runTestCommand(cwd, `node -e "console.log('not ok 1 - broken');process.exit(1)"`);
  assert.equal(r.passed, false);
  assert.deepEqual(r.failures, ["broken"]);
  const ok = await runTestCommand(cwd, `node -e "process.exit(0)"`);
  assert.equal(ok.passed, true);
  assert.equal(ok.failures, undefined);
});

await test("verifyPanelLine: approving names the command it lets Readyset run", () => {
  assert.match(verifyPanelLine({ command: "npm test", source: "detected", requireNotes: false }) ?? "", /Approve lets Readyset run `npm test` \(auto-detected\)/);
  assert.match(verifyPanelLine({ requireNotes: true }) ?? "", /need _Verified: notes/);
  assert.equal(verifyPanelLine(undefined), undefined);
});

await test("codeReviewTurnPrompt: a run failing only as before is not counted against the change", async () => {
  const { codeReviewTurnPrompt } = await import("../src/lib/readyset-prompts.ts");
  const p = codeReviewTurnPrompt("x", "fast", [], undefined, [], run({ command: "npm test" }), { blocking: false, newFailures: [], preexisting: true });
  assert.match(p, /only with failures that were already there before this change was approved/);
  assert.doesNotMatch(p, /FAILED \(exit/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
