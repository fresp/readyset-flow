import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  checkTaskEvidence,
  EVIDENCE_MAX_OUTPUT_BYTES,
  describeEvidenceConflict,
  findEvidenceConflicts,
  persistEvidence,
  readAllEvidence,
  runCommand,
  truncateForCapture,
} from "../src/lib/readyset-evidence.ts";
import { scaffoldChange } from "../src/lib/readyset-spec.ts";

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

async function freshCwd() {
  return await mkdtemp(join(tmpdir(), "rse-"));
}

// --- runCommand: low-level execution capture ---

await test("runCommand: success -> real exit code 0 captured", async () => {
  const cwd = await freshCwd();
  const result = await runCommand("echo hello", cwd, 5000);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /hello/);
});

await test("runCommand: failure -> real non-zero exit code captured deterministically", async () => {
  const cwd = await freshCwd();
  const result = await runCommand("exit 7", cwd, 5000);
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
});

await test("runCommand: timeout -> timedOut true, process killed", async () => {
  const cwd = await freshCwd();
  const result = await runCommand("sleep 5", cwd, 200);
  assert.equal(result.timedOut, true);
});

await test("runCommand: shell composition works (&&, pipes) -- delegated to a real shell, not a custom parser", async () => {
  const cwd = await freshCwd();
  const result = await runCommand("echo one && echo two", cwd, 5000);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /one/);
  assert.match(result.stdout, /two/);
});

await test("runCommand: stdin is ignored -- a command waiting on stdin does not hang past its own logic", async () => {
  const cwd = await freshCwd();
  // `cat` with stdin closed reads EOF immediately and exits 0, rather than blocking forever.
  const result = await runCommand("cat", cwd, 5000);
  assert.equal(result.exitCode, 0);
});

// --- truncateForCapture: output bound ---

await test("truncateForCapture: output under the cap is untouched", async () => {
  const { text, truncated } = truncateForCapture("short output", 100);
  assert.equal(text, "short output");
  assert.equal(truncated, false);
});

await test("truncateForCapture: output over the cap is bounded and flagged", async () => {
  const big = "x".repeat(1000);
  const { text, truncated } = truncateForCapture(big, 100);
  assert.equal(Buffer.byteLength(text, "utf8") <= 100, true);
  assert.equal(truncated, true);
});

// --- persistEvidence / readAllEvidence: immutable records ---

await test("persistEvidence: success is persisted with exitCode 0", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "evid-success");
  const rec = await persistEvidence(cwd, "evid-success", {
    taskId: "1.1",
    command: "echo ok",
    cwd,
    startedAt: new Date().toISOString(),
    durationMs: 12,
    exitCode: 0,
    timedOut: false,
    signal: null,
    stdout: "ok\n",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  assert.equal(rec.id, "E001");
  const all = await readAllEvidence(cwd, "evid-success");
  assert.equal(all.length, 1);
  assert.equal(all[0].exitCode, 0);
  assert.equal(all[0].taskId, "1.1");
});

await test("persistEvidence: failure is persisted with the real non-zero exit code, not silently dropped", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "evid-failure");
  await persistEvidence(cwd, "evid-failure", {
    taskId: "1.1",
    command: "exit 3",
    cwd,
    startedAt: new Date().toISOString(),
    durationMs: 5,
    exitCode: 3,
    timedOut: false,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  const all = await readAllEvidence(cwd, "evid-failure");
  assert.equal(all.length, 1);
  assert.equal(all[0].exitCode, 3);
});

await test("persistEvidence: timeout is recorded deterministically (timedOut=true)", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "evid-timeout");
  await persistEvidence(cwd, "evid-timeout", {
    taskId: "1.1",
    command: "sleep 999",
    cwd,
    startedAt: new Date().toISOString(),
    durationMs: 300000,
    exitCode: null,
    timedOut: true,
    signal: "SIGKILL",
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  const all = await readAllEvidence(cwd, "evid-timeout");
  assert.equal(all[0].timedOut, true);
  assert.equal(all[0].exitCode, null);
});

await test("persistEvidence: output is bounded and the truncation flag round-trips through the file", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "evid-truncated");
  const big = "line\n".repeat(20000); // well over EVIDENCE_MAX_OUTPUT_BYTES
  const capped = truncateForCapture(big, EVIDENCE_MAX_OUTPUT_BYTES);
  assert.equal(capped.truncated, true);
  await persistEvidence(cwd, "evid-truncated", {
    taskId: "1.1",
    command: "yes line | head -20000",
    cwd,
    startedAt: new Date().toISOString(),
    durationMs: 50,
    exitCode: 0,
    timedOut: false,
    signal: null,
    stdout: capped.text,
    stderr: "",
    stdoutTruncated: capped.truncated,
    stderrTruncated: false,
  });
  const all = await readAllEvidence(cwd, "evid-truncated");
  assert.equal(all[0].stdoutTruncated, true);
  assert.equal(Buffer.byteLength(all[0].stdout, "utf8") <= EVIDENCE_MAX_OUTPUT_BYTES, true);
});

await test("persistEvidence: repeated verification creates E001/E002, both remain intact", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "evid-repeat");
  const base = {
    taskId: "1.1",
    cwd,
    startedAt: new Date().toISOString(),
    durationMs: 10,
    timedOut: false,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  } as const;
  const first = await persistEvidence(cwd, "evid-repeat", { ...base, command: "first attempt", exitCode: 1 });
  const second = await persistEvidence(cwd, "evid-repeat", { ...base, command: "second attempt", exitCode: 0 });
  assert.equal(first.id, "E001");
  assert.equal(second.id, "E002");

  const all = await readAllEvidence(cwd, "evid-repeat");
  assert.equal(all.length, 2);
  const e1 = all.find((r) => r.id === "E001");
  const e2 = all.find((r) => r.id === "E002");
  assert.equal(e1?.command, "first attempt");
  assert.equal(e1?.exitCode, 1); // first record untouched by the second write
  assert.equal(e2?.command, "second attempt");
  assert.equal(e2?.exitCode, 0);
});

await test("persistEvidence: evidence belongs to the taskId it was recorded for", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "evid-task-assoc");
  await persistEvidence(cwd, "evid-task-assoc", {
    taskId: "3.2",
    command: "echo x",
    cwd,
    startedAt: new Date().toISOString(),
    durationMs: 1,
    exitCode: 0,
    timedOut: false,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  const { byTask } = await checkTaskEvidence(cwd, "evid-task-assoc");
  assert.ok(byTask.has("3.2"));
  assert.equal(byTask.get("3.2")?.records[0].taskId, "3.2");
  assert.equal(byTask.has("9.9"), false);
});

await test("persistEvidence: successful evidence does NOT touch tasks.md or mark anything [x]", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "evid-no-auto-complete");
  await writeFile(paths.tasks, "- [ ] 1.1 not done yet\n", "utf8");

  await persistEvidence(cwd, "evid-no-auto-complete", {
    taskId: "1.1",
    command: "echo ok",
    cwd,
    startedAt: new Date().toISOString(),
    durationMs: 1,
    exitCode: 0,
    timedOut: false,
    signal: null,
    stdout: "ok",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });

  const tasksContent = await import("node:fs/promises").then((m) => m.readFile(paths.tasks, "utf8"));
  assert.equal(tasksContent, "- [ ] 1.1 not done yet\n"); // byte-for-byte untouched
});

// --- findEvidenceConflicts: self-report vs runtime evidence, surfaced not reconciled ---

await test("findEvidenceConflicts: task marked [x] but latest evidence exitCode != 0 -> conflict surfaced", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "evid-conflict");
  await writeFile(paths.tasks, "- [x] 1.1 done\n  _Verified: looked fine_\n", "utf8");
  await persistEvidence(cwd, "evid-conflict", {
    taskId: "1.1",
    command: "npm test",
    cwd,
    startedAt: new Date().toISOString(),
    durationMs: 100,
    exitCode: 1,
    timedOut: false,
    signal: null,
    stdout: "",
    stderr: "1 failing",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  const conflicts = await findEvidenceConflicts(cwd, "evid-conflict");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].taskId, "1.1");
  assert.equal(conflicts[0].exitCode, 1);
});

await test("findEvidenceConflicts: task marked [x] with matching successful evidence -> no conflict", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "evid-no-conflict");
  await writeFile(paths.tasks, "- [x] 1.1 done\n  _Verified: ran npm test, pass_\n", "utf8");
  await persistEvidence(cwd, "evid-no-conflict", {
    taskId: "1.1",
    command: "npm test",
    cwd,
    startedAt: new Date().toISOString(),
    durationMs: 100,
    exitCode: 0,
    timedOut: false,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  const conflicts = await findEvidenceConflicts(cwd, "evid-no-conflict");
  assert.deepEqual(conflicts, []);
});

await test("findEvidenceConflicts: task NOT marked done with failing evidence -> no conflict (not yet claimed done)", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "evid-not-done-yet");
  await writeFile(paths.tasks, "- [ ] 1.1 in progress\n", "utf8");
  await persistEvidence(cwd, "evid-not-done-yet", {
    taskId: "1.1",
    command: "npm test",
    cwd,
    startedAt: new Date().toISOString(),
    durationMs: 100,
    exitCode: 1,
    timedOut: false,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  const conflicts = await findEvidenceConflicts(cwd, "evid-not-done-yet");
  assert.deepEqual(conflicts, []);
});

await test("findEvidenceConflicts: a _Verified: citation must name an existing, passing record of the same task", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "evid-cite");
  const rec = (taskId: string, exitCode: number) => persistEvidence(cwd, "evid-cite", {
    taskId, command: "npm test", cwd, startedAt: new Date().toISOString(), durationMs: 1, exitCode,
    timedOut: false, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
  });
  await rec("1.1", 0); // E001 passes for 1.1
  await rec("1.2", 1); // E002 fails for 1.2 -- but 1.2's LATEST is E004 (passing), so no latest-failed
  await rec("1.3", 0); // E003 passes for 1.3
  await rec("1.2", 0); // E004 passes for 1.2
  await writeFile(
    paths.tasks,
    [
      "- [x] 1.1 ok",
      "  _Verified: evidence E001 — `npm test`, pass_",
      "- [x] 1.2 cites its own failed run",
      "  - _Verified: see E002_",
      "- [x] 1.4 cites another task's record",
      "  _Verified: evidence E003_",
      "- [x] 1.5 cites a record that doesn't exist",
      "  _Verified: evidence E099_",
      "- [x] 1.6 quotes an error code, not a citation",
      "  _Verified: curl got E500 before the fix, 200 after_",
    ].join("\n"),
    "utf8",
  );
  const conflicts = await findEvidenceConflicts(cwd, "evid-cite");
  const byKind = Object.fromEntries(conflicts.map((c) => [c.kind, `${c.taskId}:${c.evidenceId}`]));
  assert.deepEqual(byKind, { "cited-failed": "1.2:E002", "cited-other-task": "1.4:E003", "cited-missing": "1.5:E099" });
  assert.equal(conflicts.length, 3, "a quoted error code (E500) is not a citation, and a valid one (E001) is not a conflict");
  assert.match(describeEvidenceConflict(conflicts.find((c) => c.kind === "cited-missing")!), /task 1\.5 cites evidence E099, which does not exist/);
});

// --- backward compatibility ---

await test("checkTaskEvidence: no evidence/ directory -> empty overview, no crash", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "evid-none");
  const overview = await checkTaskEvidence(cwd, "evid-none");
  assert.equal(overview.totalRecords, 0);
  assert.equal(overview.byTask.size, 0);
});

await test("readAllEvidence: a malformed evidence file is skipped, not thrown, and doesn't take down the rest", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "evid-malformed");
  const dir = join(paths.dir, "evidence");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "E001.md"), "not even frontmatter, just garbage", "utf8");
  await persistEvidence(cwd, "evid-malformed", {
    taskId: "1.1",
    command: "echo ok",
    cwd,
    startedAt: new Date().toISOString(),
    durationMs: 1,
    exitCode: 0,
    timedOut: false,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  // the malformed E001.md is skipped; the freshly-persisted valid record (E002, since E001 is
  // already on disk even though it's garbage -- nextEvidenceId only looks at filenames) is read fine
  const all = await readAllEvidence(cwd, "evid-malformed");
  assert.equal(all.length, 1);
  assert.equal(all[0].taskId, "1.1");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
