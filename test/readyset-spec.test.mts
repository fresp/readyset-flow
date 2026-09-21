import { mkdir, rm, writeFile, readFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  ensureReadysetRoot,
  scaffoldChange,
  validateChange,
  getProgress,
  archiveChange,
  changePaths,
  listSubmodules,
  hasExploration,
  appendContext,
  readContext,
  checkTaskVerification,
  checkPhaseViolations,
  ensureDirtyBaseline,
  readDirtyBaseline,
  readScopeContract,
  checkScope,
  checkScopeRefs,
  readReview,
  taskCheckedStates,
} from "../src/lib/readyset-spec.ts";

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
  return await mkdtemp(join(tmpdir(), "osl-"));
}

await test("ensureReadysetRoot creates dirs", async () => {
  const cwd = await freshCwd();
  await ensureReadysetRoot(cwd);
  const stat = await import("node:fs/promises").then((m) => m.stat);
  assert.ok((await stat(join(cwd, "readyset", "changes"))).isDirectory());
  assert.ok((await stat(join(cwd, "readyset", "changes", "archive"))).isDirectory());
  assert.ok((await stat(join(cwd, "readyset", "specs"))).isDirectory());
});

await test("scaffoldChange is idempotent and creates specs dir", async () => {
  const cwd = await freshCwd();
  const paths1 = await scaffoldChange(cwd, "my-change");
  const paths2 = await scaffoldChange(cwd, "my-change");
  assert.equal(paths1.dir, paths2.dir);
  const stat = await import("node:fs/promises").then((m) => m.stat);
  assert.ok((await stat(paths1.specsDir)).isDirectory());
});

await test("validateChange: missing everything -> multiple issues", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "empty-change");
  const result = await validateChange(cwd, "empty-change");
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.file === "proposal.md" && i.problem === "missing"));
  assert.ok(result.issues.some((i) => i.file === "specs/"));
  assert.ok(result.issues.some((i) => i.file === "tasks.md" && i.problem === "missing"));
});

await test("validateChange: proposal missing sections", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "partial-change");
  await writeFile(paths.proposal, "# Some proposal\n\nno sections here\n", "utf8");
  const result = await validateChange(cwd, "partial-change");
  assert.ok(result.issues.some((i) => i.problem.includes("Why")));
  assert.ok(result.issues.some((i) => i.problem.includes("What Changes")));
});

await test("validateChange: full valid artifact passes", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "good-change");
  await writeFile(
    paths.proposal,
    "## Why\n\nBecause reasons.\n\n## What Changes\n\n- did a thing\n",
    "utf8",
  );
  await writeFile(paths.design, "## Context\n\nblah\n", "utf8");
  await mkdir(join(paths.specsDir, "my-capability"), { recursive: true });
  await writeFile(
    join(paths.specsDir, "my-capability", "spec.md"),
    "## Purpose\n\nfoo\n\n## ADDED Requirements\n\n### Requirement: Does the thing\n\n#### Scenario: happy path\n\n- **WHEN** the user does X\n- **THEN** the command exits 0 and prints the result\n",
    "utf8",
  );
  await writeFile(paths.tasks, "## Tasks\n\n- [ ] 1.1 do the thing\n", "utf8");
  const result = await validateChange(cwd, "good-change");
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
});

await test("validateChange: requirement without WHEN/THEN flagged", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "bad-scenario-change");
  await writeFile(paths.proposal, "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await mkdir(join(paths.specsDir, "cap"), { recursive: true });
  await writeFile(
    join(paths.specsDir, "cap", "spec.md"),
    "## Purpose\n\nx\n\n### Requirement: Foo\n\nno scenario here\n",
    "utf8",
  );
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  const result = await validateChange(cwd, "bad-scenario-change");
  assert.ok(result.issues.some((i) => i.problem.includes("WHEN/THEN")));
});

await test("validateChange: one requirement with a scenario no longer hides a sibling requirement with none", async () => {
  // The old validator checked "does a WHEN/THEN exist anywhere in this file" -- a single real
  // scenario satisfied that file-wide regex regardless of which requirement it belonged to, so
  // a file with one good requirement and one empty one passed silently. This is the case that
  // regression-tests the per-requirement scoping in splitRequirementBlocks.
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "mixed-requirements-change");
  await writeFile(paths.proposal, "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await mkdir(join(paths.specsDir, "cap"), { recursive: true });
  await writeFile(
    join(paths.specsDir, "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n" +
      "### Requirement: Has a scenario\n\n#### Scenario: ok\n\n- **WHEN** a\n- **THEN** the command exits 0\n\n" +
      "### Requirement: Missing its scenario\n\nnothing here but prose\n",
    "utf8",
  );
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  const result = await validateChange(cwd, "mixed-requirements-change");
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((i) => i.problem.includes('"Missing its scenario"') && i.problem.includes("WHEN/THEN")),
    `expected an issue naming "Missing its scenario", got: ${JSON.stringify(result.issues)}`,
  );
  assert.ok(
    !result.issues.some((i) => i.problem.includes('"Has a scenario"')),
    "the requirement that does have a scenario should not be flagged",
  );
});

await test("validateChange: missing '## ADDED/MODIFIED/REMOVED Requirements' section is flagged even with a valid requirement", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "no-delta-header-change");
  await writeFile(paths.proposal, "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await mkdir(join(paths.specsDir, "cap"), { recursive: true });
  await writeFile(
    join(paths.specsDir, "cap", "spec.md"),
    "## Purpose\n\nx\n\n### Requirement: Foo\n\n#### Scenario: ok\n\n- **WHEN** a\n- **THEN** b\n",
    "utf8",
  );
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  const result = await validateChange(cwd, "no-delta-header-change");
  assert.ok(result.issues.some((i) => /ADDED\/MODIFIED\/REMOVED/.test(i.problem)));
});

await test("getProgress: not_started / in_progress / all_done / missing", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "progress-change");

  const missing = await getProgress(cwd, "progress-change");
  assert.equal(missing, undefined);

  await writeFile(paths.tasks, "## Tasks\n\n(nothing checked off, no boxes)\n", "utf8");
  const notStarted = await getProgress(cwd, "progress-change");
  assert.deepEqual(notStarted, { done: 0, total: 0, state: "not_started" });

  await writeFile(paths.tasks, "- [ ] 1.1 a\n- [x] 1.2 b\n- [ ] 1.3 c\n", "utf8");
  const inProgress = await getProgress(cwd, "progress-change");
  assert.deepEqual(inProgress, { done: 1, total: 3, state: "in_progress" });

  await writeFile(paths.tasks, "- [x] 1.1 a\n- [X] 1.2 b\n", "utf8");
  const allDone = await getProgress(cwd, "progress-change");
  assert.deepEqual(allDone, { done: 2, total: 2, state: "all_done" });
});

await test("archiveChange: moves dir and creates new spec file", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "archive-change-1");
  await writeFile(paths.proposal, "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await mkdir(join(paths.specsDir, "widgets"), { recursive: true });
  await writeFile(
    join(paths.specsDir, "widgets", "spec.md"),
    "## Purpose\n\nwidgets\n\n### Requirement: Spin\n\n#### Scenario: spins\n\n- **WHEN** spun\n- **THEN** it spins\n",
    "utf8",
  );
  await writeFile(paths.tasks, "- [x] 1.1 done\n", "utf8");

  const result = await archiveChange(cwd, "archive-change-1");
  assert.match(result.archivedDir, /archive-change-1$/);
  assert.equal(result.mergedSpecFiles.length, 1);

  const mergedContent = await readFile(result.mergedSpecFiles[0], "utf8");
  assert.ok(mergedContent.includes("Spin"));

  // original change dir should be gone
  let stillThere = true;
  try {
    await readFile(paths.proposal);
  } catch {
    stillThere = false;
  }
  assert.equal(stillThere, false);
});

await test("archiveChange: appends to existing spec rather than overwriting", async () => {
  const cwd = await freshCwd();
  await ensureReadysetRoot(cwd);
  await mkdir(join(cwd, "readyset", "specs", "widgets"), { recursive: true });
  await writeFile(
    join(cwd, "readyset", "specs", "widgets", "spec.md"),
    "## Purpose\n\noriginal widgets spec\n\n### Requirement: Existing\n\n#### Scenario: already there\n\n- **WHEN** x\n- **THEN** y\n",
    "utf8",
  );

  const paths = await scaffoldChange(cwd, "archive-change-2");
  await mkdir(join(paths.specsDir, "widgets"), { recursive: true });
  await writeFile(
    join(paths.specsDir, "widgets", "spec.md"),
    "### Requirement: NewOne\n\n#### Scenario: new\n\n- **WHEN** a\n- **THEN** b\n",
    "utf8",
  );

  const result = await archiveChange(cwd, "archive-change-2");
  const mergedContent = await readFile(result.mergedSpecFiles[0], "utf8");
  assert.ok(mergedContent.includes("original widgets spec"));
  assert.ok(mergedContent.includes("Existing"));
  assert.ok(mergedContent.includes("NewOne"));
  assert.ok(mergedContent.includes("From change: archive-change-2"));
});

await test("changePaths with empty cwd produces clean relative paths", async () => {
  const paths = changePaths("", "my-id");
  assert.equal(paths.proposal, "readyset/changes/my-id/proposal.md");
  assert.equal(paths.tasks, "readyset/changes/my-id/tasks.md");
  assert.equal(paths.specsDir, "readyset/changes/my-id/specs");
});

await test("listSubmodules: no .gitmodules -> empty array", async () => {
  const cwd = await freshCwd();
  const result = await listSubmodules(cwd);
  assert.deepEqual(result, []);
});

await test("listSubmodules: parses multiple submodules, including the one that got dropped live", async () => {
  const cwd = await freshCwd();
  await writeFile(
    join(cwd, ".gitmodules"),
    [
      '[submodule "services/platform-api"]',
      "\tpath = services/platform-api",
      "\turl = git@example.com:oca/platform-api.git",
      "",
      '[submodule "services/portal"]',
      "\tpath = services/portal",
      "\turl = git@example.com:oca/portal.git",
    ].join("\n"),
    "utf8",
  );
  const result = await listSubmodules(cwd);
  assert.equal(result.length, 2);
  assert.ok(result.some((s) => s.name === "services/platform-api" && s.path === "services/platform-api"));
  assert.ok(result.some((s) => s.name === "services/portal" && s.path === "services/portal"));
});

await test("hasExploration: false when missing/empty, true once written", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "exp-change");
  assert.equal(await hasExploration(cwd, "exp-change"), false);
  const paths = changePaths(cwd, "exp-change");
  await writeFile(paths.exploration, "   \n", "utf8"); // whitespace-only still counts as empty
  assert.equal(await hasExploration(cwd, "exp-change"), false);
  await writeFile(paths.exploration, "## Findings\n\nsubmodule X pinned at commit Y\n", "utf8");
  assert.equal(await hasExploration(cwd, "exp-change"), true);
});

await test("appendContext/readContext: creates file, appends in order, tags phase+timestamp", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "ctx-change");
  assert.equal(await readContext(cwd, "ctx-change"), undefined);
  await appendContext(cwd, "ctx-change", "Explore", "Found two submodules, both pinned to old commits.");
  await appendContext(cwd, "ctx-change", "Propose", "Wrote proposal.md citing both submodule findings.");
  const content = await readContext(cwd, "ctx-change");
  assert.match(content, /## Explore —/);
  assert.match(content, /## Propose —/);
  assert.ok(content.indexOf("## Explore") < content.indexOf("## Propose"));
  assert.match(content, /Found two submodules/);
});

await test("checkTaskVerification: counts checked tasks missing a _Verified: note", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "verify-change");
  await writeFile(
    paths.tasks,
    [
      "- [x] 1.1 did the thing",
      "  _Verified: ran `npm test`, 5/5 pass_",
      "- [x] 1.2 did another thing",
      "- [ ] 1.3 not done yet",
      "- [x] 1.4 also did this",
      "  _Verified: curl returned 200_",
    ].join("\n"),
    "utf8",
  );
  const result = await checkTaskVerification(cwd, "verify-change");
  assert.deepEqual(result, { checkedTasks: 3, withVerificationNote: 2, missing: 1 });
});

await test("checkTaskVerification: no tasks.md -> undefined", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "no-tasks-change");
  const result = await checkTaskVerification(cwd, "no-tasks-change");
  assert.equal(result, undefined);
});

await test("readReview: undefined when missing, content once written", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "review-change");
  assert.equal(await readReview(cwd, "review-change"), undefined);
  await writeFile(paths.review, "## Findings\n\nNo blockers found.\n", "utf8");
  assert.match(await readReview(cwd, "review-change"), /No blockers found/);
});

await test("taskCheckedStates: maps task id -> checked/unchecked", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "states-change");
  await writeFile(
    paths.tasks,
    ["- [x] 1.1 done", "- [ ] 1.2 not done", "- [x] 2.1 also done"].join("\n"),
    "utf8",
  );
  const states = await taskCheckedStates(cwd, "states-change");
  assert.equal(states.get("1.1"), true);
  assert.equal(states.get("1.2"), false);
  assert.equal(states.get("2.1"), true);
  assert.equal(states.get("9.9"), undefined);
});

await test("taskCheckedStates: no tasks.md -> empty map", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "no-tasks-states");
  const states = await taskCheckedStates(cwd, "no-tasks-states");
  assert.equal(states.size, 0);
});

await test("archiveChange: ADDED-only delta produces no unappliedModifications warning", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "archive-added-only");
  await writeFile(paths.proposal, "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await mkdir(join(paths.specsDir, "widgets"), { recursive: true });
  await writeFile(
    join(paths.specsDir, "widgets", "spec.md"),
    "## Purpose\n\nwidgets\n\n## ADDED Requirements\n\n### Requirement: Spin\n\n#### Scenario: spins\n\n- **WHEN** spun\n- **THEN** it spins\n",
    "utf8",
  );
  await writeFile(paths.tasks, "- [x] 1.1 done\n", "utf8");

  const result = await archiveChange(cwd, "archive-added-only");
  assert.deepEqual(result.unappliedModifications, []);
});

await test("archiveChange: MODIFIED/REMOVED delta is flagged as unappliedModifications (append-only merge doesn't apply them)", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "archive-mod-removed");
  await writeFile(paths.proposal, "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await mkdir(join(paths.specsDir, "widgets"), { recursive: true });
  await writeFile(
    join(paths.specsDir, "widgets", "spec.md"),
    [
      "## Purpose",
      "",
      "widgets",
      "",
      "## MODIFIED Requirements",
      "",
      "### Requirement: Spin",
      "",
      "#### Scenario: spins faster now",
      "",
      "- **WHEN** spun",
      "- **THEN** it spins at configurable speed",
      "",
      "## REMOVED Requirements",
      "",
      "### Requirement: LegacyExport",
      "",
      "#### Scenario: removed",
      "",
      "- **WHEN** n/a",
      "- **THEN** n/a",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(paths.tasks, "- [x] 1.1 done\n", "utf8");

  const result = await archiveChange(cwd, "archive-mod-removed");
  assert.equal(result.unappliedModifications.length, 2);
  assert.ok(result.unappliedModifications.some((u) => u.verb === "MODIFIED" && u.requirement === "Spin"));
  assert.ok(result.unappliedModifications.some((u) => u.verb === "REMOVED" && u.requirement === "LegacyExport"));
  // and the merge itself is still exactly the same append-only behavior as before -- the old
  // requirement text, if any existed, would remain untouched (nothing to assert here since
  // there was no prior canonical spec in this test, covered by the existing append test above).
});

await test("checkPhaseViolations: clean planning state has no violations", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "clean");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".ai", "brainstorms"), { recursive: true });
  const violations = await checkPhaseViolations(cwd, "clean", [
    "readyset/changes/clean/proposal.md",
    ".ai/brainstorms/x.md",
  ]);
  assert.equal(violations.length, 0);
});

await test("checkPhaseViolations: product-code write during planning is a phase-write", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "leak");
  const violations = await checkPhaseViolations(cwd, "leak", [
    "readyset/changes/leak/proposal.md",
    "src/ledger.mjs",
    "test/balance-cache.test.mjs",
  ]);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((v) => v.kind === "phase-write"));
  assert.ok(violations.some((v) => v.path === "src/ledger.mjs"));
});

await test("checkPhaseViolations: self-archive is detected even with no stray files", async () => {
  const cwd = await freshCwd();
  // scaffold then move away, the way T12 did by renaming the change dir itself
  await scaffoldChange(cwd, "gone");
  const { rename } = await import("node:fs/promises");
  await ensureReadysetRoot(cwd);
  await rename(join(cwd, "readyset", "changes", "gone"), join(cwd, "readyset", "changes", "archive", "2026-09-20-gone"));
  const violations = await checkPhaseViolations(cwd, "gone", []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "self-archive");
});

await test("checkPhaseViolations: a file with the change id as a prefix is still a violation", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "my-change");
  // "readyset/changes/my-change-evil/x.md" must not pass the prefix check for "my-change"
  const violations = await checkPhaseViolations(cwd, "my-change", ["readyset/changes/my-change-evil/x.md"]);
  assert.equal(violations.length, 1);
});

await test("readScopeContract: parses the Files section, bullets and bare paths", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "scoped");
  await writeFile(
    paths.proposal,
    ["# P", "", "## Why", "", "x", "", "## Files This Change Will Touch", "", "- src/a.ts", "test/b.test.mjs", "- prose without a path", "", "## What Changes", "", "- y"].join("\n"),
    "utf8",
  );
  const contract = await readScopeContract(cwd, "scoped");
  assert.deepEqual(contract.files, ["src/a.ts", "test/b.test.mjs"]);
});

await test("readScopeContract: absent section -> no contract, not an empty allowlist", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "unscoped");
  await writeFile(paths.proposal, "# P\n\n## Why\n\nx\n", "utf8");
  const contract = await readScopeContract(cwd, "unscoped");
  assert.equal(contract.files, undefined);
});

await test("checkScope: in-contract paths and the workspace dirs pass; the rest is outside", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "check");
  await writeFile(paths.proposal, "# P\n\n## Files This Change Will Touch\n\n- src/a.ts\n", "utf8");
  const result = await checkScope(cwd, "check", [
    "src/a.ts",
    "readyset/changes/check/proposal.md",
    ".ai/brainstorms/x.md",
    "src/unlisted.ts",
    "bench/scratch.mjs",
  ]);
  assert.equal(result.noContract, false);
  assert.deepEqual(result.outside, ["src/unlisted.ts", "bench/scratch.mjs"]);
});

await test("checkScope: no contract -> noContract true, never a silent pass", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "nocontract");
  const result = await checkScope(cwd, "nocontract", ["src/a.ts"]);
  assert.equal(result.noContract, true);
  assert.deepEqual(result.outside, []);
});

await test("readScopeContract: a trailing (new) is split into newFiles, not files", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "newsplit");
  await writeFile(
    paths.proposal,
    ["# P", "", "## Files This Change Will Touch", "", "- src/a.ts", "- src/b.ts (new)", "- `src/c.ts` (new) -- with commentary", "", "## What Changes", "", "- y"].join("\n"),
    "utf8",
  );
  const contract = await readScopeContract(cwd, "newsplit");
  assert.deepEqual(contract.files, ["src/a.ts"]);
  assert.deepEqual(contract.newFiles, ["src/b.ts", "src/c.ts"]);
});

await test("checkScope: a (new) path is in scope (creating it is allowed)", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "newscope");
  await writeFile(paths.proposal, "# P\n\n## Files This Change Will Touch\n\n- src/a.ts\n- src/brand-new.ts (new)\n", "utf8");
  const result = await checkScope(cwd, "newscope", ["src/a.ts", "src/brand-new.ts", "src/rogue.ts"]);
  assert.equal(result.noContract, false);
  assert.deepEqual(result.outside, ["src/rogue.ts"]);
});

await test("checkScopeRefs: flags an unmarked path that doesn't exist, ignores (new) and existing paths", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "refs");
  // src/exists.ts is created so it resolves; src/dangling.ts is named but never created and is
  // not marked (new) -- a dangling reference. src/created.ts (new) doesn't exist yet, but that's
  // expected, so it must NOT be flagged.
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "exists.ts"), "x", "utf8");
  await writeFile(
    paths.proposal,
    "# P\n\n## Files This Change Will Touch\n\n- src/exists.ts\n- src/dangling.ts\n- src/created.ts (new)\n",
    "utf8",
  );
  const result = await checkScopeRefs(cwd, "refs");
  assert.equal(result.noContract, false);
  assert.deepEqual(result.missing, ["src/dangling.ts"]);
});

await test("checkScopeRefs: no contract -> noContract true, empty missing", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "refsnocontract");
  const result = await checkScopeRefs(cwd, "refsnocontract");
  assert.equal(result.noContract, true);
  assert.deepEqual(result.missing, []);
});

await test("validateChange: inspection-only THEN is flagged as unobservable", async () => {
  // The real UC2 miss: "WHEN src/registry.ts is inspected THEN it contains no direct
  // filesystem calls" passed validation, but no test or run could ever observe it.
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "unobservable");
  await writeFile(paths.proposal, "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await mkdir(join(paths.specsDir, "cap"), { recursive: true });
  await writeFile(
    join(paths.specsDir, "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n" +
      "### Requirement: No fs in registry\n\n#### Scenario: code inspection\n\n- **WHEN** src/registry.ts is inspected\n- **THEN** it contains no direct filesystem calls\n",
    "utf8",
  );
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  const result = await validateChange(cwd, "unobservable");
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((i) => i.problem.includes('"No fs in registry"') && i.problem.includes("no test or run could observe")),
    `expected an unobservable-THEN issue, got: ${JSON.stringify(result.issues)}`,
  );
});

await test("validateChange: observable THENs still pass (exit, stdout, status, file)", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "observable");
  await writeFile(paths.proposal, "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await mkdir(join(paths.specsDir, "cap"), { recursive: true });
  await writeFile(
    join(paths.specsDir, "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n" +
      "### Requirement: Fails loud\n\n#### Scenario: bad input\n\n- **WHEN** the flag is missing\n- **THEN** the command exits 2 and prints usage to stderr\n\n" +
      "### Requirement: Writes the file\n\n#### Scenario: happy path\n\n- **WHEN** the sync runs\n- **THEN** `state.json` is created with the new record\n",
    "utf8",
  );
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  const result = await validateChange(cwd, "observable");
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
});

await test("ensureDirtyBaseline/readDirtyBaseline: round-trip, idempotent, missing -> empty", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "base");

  // Missing baseline reads as empty, never throws.
  assert.deepEqual([...(await readDirtyBaseline(cwd, "base"))], []);

  // First capture wins.
  const stored = await ensureDirtyBaseline(cwd, "base", ["unrelated.txt", "notes/scratch.md"]);
  assert.deepEqual(stored.paths, ["notes/scratch.md", "unrelated.txt"]);
  assert.deepEqual([...(await readDirtyBaseline(cwd, "base"))], ["notes/scratch.md", "unrelated.txt"]);

  // A later, dirtier tree must not widen what counts as pre-existing.
  const again = await ensureDirtyBaseline(cwd, "base", ["unrelated.txt", "notes/scratch.md", "src/new.ts"]);
  assert.deepEqual(again.paths, ["notes/scratch.md", "unrelated.txt"]);
});

await test("checkPhaseViolations through a baseline: pre-existing dirt is not a violation", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "filter");
  await ensureDirtyBaseline(cwd, "filter", ["unrelated.txt"]);
  const baseline = await readDirtyBaseline(cwd, "filter");
  // The extension subtracts the baseline from the current dirty set; simulate that here.
  const current = ["unrelated.txt", "src/ledger.mjs"];
  const authored = current.filter((p) => !baseline.has(p));
  const violations = await checkPhaseViolations(cwd, "filter", authored);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, "src/ledger.mjs");
});

await test("baseline entry survives inside CONTEXT.md without breaking context reads", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "ctxbase");
  await appendContext(cwd, "ctxbase", "Explore", "did some exploration");
  await ensureDirtyBaseline(cwd, "ctxbase", ["a.txt"]);
  const raw = await readContext(cwd, "ctxbase");
  assert.ok(raw?.includes("## Explore —"), "phase entries must survive the baseline append");
  assert.ok(raw?.includes("<!-- readyset-baseline-dirty -->"), "baseline marker must be present");
  assert.deepEqual([...(await readDirtyBaseline(cwd, "ctxbase"))], ["a.txt"]);
});

await test("baseline survives later CONTEXT.md content containing braces (e.g. Refine feedback)", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "braces");
  // Real runtime order: baseline is captured right after scaffoldChange, before Explore even
  // runs — every later entry lands after it.
  await ensureDirtyBaseline(cwd, "braces", ["unrelated.txt"]);
  // Simulates appendContext("Refine", `User feedback: ${feedback}`) where the feedback itself
  // contains a brace — unsanitized user input in the actual code path.
  await appendContext(cwd, "braces", "Refine", "User feedback: make it return {status: 'ok'}");
  assert.deepEqual([...(await readDirtyBaseline(cwd, "braces"))], ["unrelated.txt"]);
});

await test("baseline parse is scoped to its own fence, not the last brace in the file", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "fence");
  await ensureDirtyBaseline(cwd, "fence", ["a.txt"]);
  await appendContext(
    cwd,
    "fence",
    "Propose",
    "explored {nested: {deep: '{'}} and found } stray } braces",
  );
  assert.deepEqual([...(await readDirtyBaseline(cwd, "fence"))], ["a.txt"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
