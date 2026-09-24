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
  hasDirtyBaseline,
  readDirtyBaseline,
  readApproveBase,
  writeApproveBase,
  readScopeContract,
  readScopeDeviations,
  readOpenDecisions,
  readAssumptions,
  readAssumedScenarios,
  readBlockingFindings,
  docMentions,
  findMissingRequestedDocs,
  findDocFileWarnings,
  brainstormRequestText,
  brainstormDecisionText,
  docRequests,
  parseContractLine,
  checkScope,
  checkScopeRefs,
  hasBeenApplied,
  readReview,
  taskCheckedStates,
  appendPhaseEvent,
  readPhaseEvents,
  PHASE_MARKER,
  type PhaseEvent,
  readChangeLane,
  readArtifactSizes,
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

const FAST_PROPOSAL = (acceptance: string) =>
  `---\nlane: fast\n---\n## Why\n\nBecause reasons.\n\n## What Changes\n\n- did a thing\n\n## Files This Change Will Touch\n\n- src/thing.ts (new)\n\n## Acceptance\n\n${acceptance}\n`;

await test("validateChange: fast lane pass (no specs/ dir, acceptance in proposal)", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "fast-ok");
  await rm(paths.specsDir, { recursive: true, force: true });
  await writeFile(paths.proposal, FAST_PROPOSAL("- **WHEN** a\n- **THEN** the command exits 0\n"), "utf8");
  await writeFile(paths.tasks, "- [ ] 1.1 do the thing\n", "utf8");
  const result = await validateChange(cwd, "fast-ok");
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
});

await test("validateChange: fast lane with an explicit lane arg also passes", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "fast-arg");
  await rm(paths.specsDir, { recursive: true, force: true });
  // proposal has no lane: line — the explicit "fast" arg must still select the fast-lane set.
  await writeFile(
    paths.proposal,
    "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- x (new)\n\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n",
    "utf8",
  );
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  const result = await validateChange(cwd, "fast-arg", "fast");
  assert.equal(result.ok, true);
});

await test("validateChange: fast lane missing '## Acceptance' is flagged by name", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "fast-noaccept");
  await rm(paths.specsDir, { recursive: true, force: true });
  await writeFile(paths.proposal, "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- x (new)\n", "utf8");
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  const result = await validateChange(cwd, "fast-noaccept");
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.file === "proposal.md" && i.problem.includes("## Acceptance")));
  assert.ok(!result.issues.some((i) => i.file === "specs/"), "fast lane must not require a spec delta");
});

await test("validateChange: fast lane '## Acceptance' with only prose (no WHEN/THEN) is flagged", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "fast-prose");
  await rm(paths.specsDir, { recursive: true, force: true });
  await writeFile(paths.proposal, FAST_PROPOSAL("It should work well and be nice."), "utf8");
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  const result = await validateChange(cwd, "fast-prose");
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.problem.includes("no WHEN/THEN scenario")));
});

await test("validateChange: fast lane '## Acceptance' THEN that is a code property is flagged as unobservable", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "fast-unobservable");
  await rm(paths.specsDir, { recursive: true, force: true });
  await writeFile(paths.proposal, FAST_PROPOSAL("- **WHEN** src/registry.ts is inspected\n- **THEN** it contains no direct calls\n"), "utf8");
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  const result = await validateChange(cwd, "fast-unobservable");
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.problem.includes("no test or run could observe")));
});

await test("validateChange: fast lane with no tasks.md is flagged", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "fast-notasks");
  await rm(paths.specsDir, { recursive: true, force: true });
  await writeFile(paths.proposal, FAST_PROPOSAL("- **WHEN** a\n- **THEN** the command exits 0\n"), "utf8");
  const result = await validateChange(cwd, "fast-notasks");
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.file === "tasks.md" && i.problem === "missing"));
});

await test("validateChange: full lane with explicit 'lane: full' + spec delta passes; removing the delta fails on specs/", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "full-explicit");
  await writeFile(paths.proposal, "---\nlane: full\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  await mkdir(join(paths.specsDir, "cap"), { recursive: true });
  await writeFile(
    join(paths.specsDir, "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** the command exits 0\n",
    "utf8",
  );
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  const okResult = await validateChange(cwd, "full-explicit");
  assert.equal(okResult.ok, true);

  await rm(paths.specsDir, { recursive: true, force: true });
  const failResult = await validateChange(cwd, "full-explicit");
  assert.equal(failResult.ok, false);
  assert.ok(failResult.issues.some((i) => i.file === "specs/"));
});

await test("readChangeLane: missing proposal -> full; unrecognized -> full; lane: fast -> fast", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "lane-read");
  assert.equal(await readChangeLane(cwd, "lane-read"), "full", "missing proposal defaults to full");
  await writeFile(paths.proposal, "---\nlane: sideways\n---\n## Why\n\nx\n", "utf8");
  assert.equal(await readChangeLane(cwd, "lane-read"), "full", "unrecognized lane defaults to full");
  await writeFile(paths.proposal, "---\nlane: FAST\n---\n## Why\n\nx\n", "utf8");
  assert.equal(await readChangeLane(cwd, "lane-read"), "fast", "trimmed, lowercased value matches");
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
  assert.equal(result.specsMergeSkipped, false, "full lane merges specs");

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

await test("archiveChange: fast lane skips the spec merge and reports it", async () => {
  const cwd = await freshCwd();
  await ensureReadysetRoot(cwd);
  const paths = await scaffoldChange(cwd, "archive-fast");
  await writeFile(paths.proposal, "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  // A stray spec file under a fast-lane change must NOT be merged — the lane, not the file
  // search, is what gates the merge.
  await mkdir(join(paths.specsDir, "stray"), { recursive: true });
  await writeFile(join(paths.specsDir, "stray", "spec.md"), "## Purpose\n\nstray\n", "utf8");
  await writeFile(paths.tasks, "- [x] 1.1 done\n", "utf8");

  const result = await archiveChange(cwd, "archive-fast");
  assert.equal(result.specsMergeSkipped, true);
  assert.deepEqual(result.mergedSpecFiles, []);
  assert.deepEqual(result.unappliedModifications, []);

  // The canonical readyset/specs/ tree is untouched: no stray/ capability was created.
  const created = await readFile(join(cwd, "readyset", "specs", "stray", "spec.md"), "utf8").catch(() => undefined);
  assert.equal(created, undefined, "fast lane must not merge any delta spec");
});

await test("readArtifactSizes: absent proposal -> no key; two spec files sum into specs", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "sizes");
  const empty = await readArtifactSizes(cwd, "sizes");
  assert.equal(empty.proposal, undefined);
  assert.equal(empty.tasks, undefined);
  assert.equal(empty.specs, 0);

  await writeFile(paths.proposal, "hello", "utf8");
  await writeFile(paths.tasks, "tasks!", "utf8");
  await mkdir(join(paths.specsDir, "a"), { recursive: true });
  await mkdir(join(paths.specsDir, "b"), { recursive: true });
  await writeFile(join(paths.specsDir, "a", "spec.md"), "12345", "utf8");
  await writeFile(join(paths.specsDir, "b", "spec.md"), "678", "utf8");
  const sizes = await readArtifactSizes(cwd, "sizes");
  assert.equal(sizes.proposal, 5);
  assert.equal(sizes.tasks, 6);
  assert.equal(sizes.specs, 8);
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
  // `_Verified: ran \`npm test\`...` has a backticked span; `curl returned 200` starts with a
  // known runner token; 1.2 has no note at all.
  assert.deepEqual(result, { checkedTasks: 3, withVerificationNote: 2, missing: 1, withCommandNote: 2 });
});

await test("checkTaskVerification: withCommandNote counts notes naming a runnable command", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "cmdnote-change");
  await writeFile(
    paths.tasks,
    [
      "- [x] 1.1 a",
      "  _Verified: ran `npm test`, 5/5 pass_",
      "- [x] 1.2 b",
      "  _Verified: cargo build succeeded_",
      "- [x] 1.3 c",
      "  _Verified: looks correct_",
      "- [x] 1.4 d",
      "  _Verified: doc-only, no behavior to check_",
    ].join("\n"),
    "utf8",
  );
  const result = await checkTaskVerification(cwd, "cmdnote-change");
  assert.equal(result?.withVerificationNote, 4);
  assert.equal(result?.withCommandNote, 2, "only the backticked and the runner-token notes count");
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
  assert.equal(result.specsMergeSkipped, false, "full lane merges specs");
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

await test("parseContractLine: the reproduction section parses completely", async () => {
  assert.deepEqual(parseContractLine("- app/handler.go"), { path: "app/handler.go", isNew: false , isDelete: false });
  assert.deepEqual(parseContractLine("- packages/core/index.ts"), { path: "packages/core/index.ts", isNew: false , isDelete: false });
  assert.deepEqual(parseContractLine("- .github/workflows/ci.yml"), { path: ".github/workflows/ci.yml", isNew: false , isDelete: false });
  assert.deepEqual(parseContractLine("- src/a.ts (new)"), { path: "src/a.ts", isNew: true , isDelete: false });
  assert.deepEqual(parseContractLine("- `src/b.ts` (new)"), { path: "src/b.ts", isNew: true , isDelete: false });
  assert.deepEqual(parseContractLine("- src/c.ts (new) -- helper"), { path: "src/c.ts", isNew: true , isDelete: false });
  assert.deepEqual(parseContractLine("- src/d.ts — modified"), { path: "src/d.ts", isNew: false , isDelete: false });
  assert.deepEqual(parseContractLine("- Makefile"), { path: "Makefile", isNew: false , isDelete: false });
  assert.deepEqual(parseContractLine("- src/e.tsx"), { path: "src/e.tsx", isNew: false , isDelete: false });
});

await test("readScopeContract: the reproduction section keeps every path and splits (new)", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "repro");
  await writeFile(
    paths.proposal,
    [
      "# P",
      "",
      "## Files This Change Will Touch",
      "",
      "- app/handler.go",
      "- packages/core/index.ts",
      "- .github/workflows/ci.yml",
      "- src/a.ts (new)",
      "- `src/b.ts` (new)",
      "- src/c.ts (new) -- helper",
      "- src/d.ts — modified",
      "- Makefile",
      "- src/e.tsx",
      "- src/old.ts (delete)",
      "",
      "## What Changes",
      "",
      "- y",
    ].join("\n"),
    "utf8",
  );
  const contract = await readScopeContract(cwd, "repro");
  assert.deepEqual(contract.files, ["app/handler.go", "packages/core/index.ts", ".github/workflows/ci.yml", "src/d.ts", "Makefile", "src/e.tsx"]);
  assert.deepEqual(contract.newFiles, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.deepEqual(contract.deleteFiles, ["src/old.ts"]);
});

await test("parseContractLine: numbered list items and (new) after other commentary", async () => {
  assert.deepEqual(parseContractLine("1. src/x.ts"), { path: "src/x.ts", isNew: false , isDelete: false });
  assert.deepEqual(parseContractLine("1) src/y.ts"), { path: "src/y.ts", isNew: false , isDelete: false });
  assert.deepEqual(parseContractLine("- src/c.ts -- helper (new)"), { path: "src/c.ts", isNew: true , isDelete: false });
  assert.deepEqual(parseContractLine("- src/z.ts: (new)"), { path: "src/z.ts", isNew: true , isDelete: false });
  assert.deepEqual(parseContractLine("- src/y.ts (new, helper)"), { path: "src/y.ts", isNew: true , isDelete: false });
  assert.deepEqual(parseContractLine("- src/x.ts (NEW file)"), { path: "src/x.ts", isNew: true , isDelete: false });
  assert.deepEqual(parseContractLine("- src/z.ts (renewed)"), { path: "src/z.ts", isNew: false , isDelete: false });
});

await test("parseContractLine: tokens that are not paths are skipped", async () => {
  for (const line of ["- prose without a path", "**Existing files:**", "None", "- https://example.com/x", "- e.g.", "- i.e", "- .", "- ..", ""]) {
    assert.equal(parseContractLine(line), undefined);
  }
});

await test("parseContractLine: (delete)/(deleted)/(remove)/(removed) markers", async () => {
  assert.deepEqual(parseContractLine("- src/gone.ts (delete)"), { path: "src/gone.ts", isNew: false, isDelete: true });
  assert.deepEqual(parseContractLine("- src/gone.ts (deleted)"), { path: "src/gone.ts", isNew: false, isDelete: true });
  assert.deepEqual(parseContractLine("- src/gone.ts (remove)"), { path: "src/gone.ts", isNew: false, isDelete: true });
  assert.deepEqual(parseContractLine("- src/gone.ts (removed)"), { path: "src/gone.ts", isNew: false, isDelete: true });
  assert.equal(parseContractLine("- src/gone.ts (deletion)")?.isDelete, false, "a different word is not a delete marker");
  assert.deepEqual(parseContractLine("- src/a.ts"), { path: "src/a.ts", isNew: false, isDelete: false });
});

await test("parseContractLine: (new) and (delete) are mutually exclusive", async () => {
  const line = parseContractLine("- src/a.ts (new) (delete)");
  assert.equal(line?.isNew, true, "(new) wins when both markers appear");
  assert.equal(line?.isDelete, false);
});

await test("parseContractLine: extensionless files, dotfiles and stray punctuation", async () => {
  assert.equal(parseContractLine("- Dockerfile")?.path, "Dockerfile");
  assert.equal(parseContractLine("- .gitignore")?.path, ".gitignore");
  assert.equal(parseContractLine("- ./src/a.ts")?.path, "src/a.ts");
  assert.equal(parseContractLine("- src/a.ts.")?.path, "src/a.ts");
  assert.equal(parseContractLine("- **src/a.ts**")?.path, "src/a.ts");
  assert.equal(parseContractLine("- go.mod")?.path, "go.mod");
  assert.equal(parseContractLine("- build.gradle.kts")?.path, "build.gradle.kts");
  assert.deepEqual(parseContractLine("- `Makefile`"), { path: "Makefile", isNew: false , isDelete: false });
  assert.deepEqual(parseContractLine("- Makefile:"), { path: "Makefile", isNew: false , isDelete: false });
  assert.equal(parseContractLine("- e.g., the handler"), undefined);
  assert.equal(parseContractLine("- a.go"), undefined);
  assert.deepEqual(parseContractLine("- bin/readyset-flow"), { path: "bin/readyset-flow", isNew: false , isDelete: false });
  assert.deepEqual(parseContractLine("- scripts/deploy"), { path: "scripts/deploy", isNew: false , isDelete: false });
  assert.equal(parseContractLine("- N/A"), undefined);
  assert.equal(parseContractLine("- and/or tests"), undefined);
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

await test("checkScope: a path under app/ named in the contract is not reported outside", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "appscope");
  await writeFile(paths.proposal, "# P\n\n## Files This Change Will Touch\n\n- app/handler.go\n- src/rogue.ts\n", "utf8");
  const result = await checkScope(cwd, "appscope", ["app/handler.go", "app/rogue.go"]);
  assert.equal(result.noContract, false);
  assert.deepEqual(result.outside, ["app/rogue.go"]);
});

await test("checkScopeRefs: an unmarked path under packages/ IS reported dangling", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "pkgrefs");
  await writeFile(paths.proposal, "# P\n\n## Files This Change Will Touch\n\n- packages/x/y.ts\n- packages/x/z.ts (new)\n", "utf8");
  const result = await checkScopeRefs(cwd, "pkgrefs");
  assert.equal(result.noContract, false);
  assert.deepEqual(result.missing, ["packages/x/y.ts"]);
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

await test("checkScopeRefs: (new) that already exists is newButExists, not missing", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "nbe");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "exists.ts"), "x", "utf8");
  await writeFile(paths.proposal, "# P\n\n## Files This Change Will Touch\n\n- src/exists.ts (new)\n- src/created.ts (new)\n", "utf8");
  const result = await checkScopeRefs(cwd, "nbe");
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.newButExists, ["src/exists.ts"]);
  assert.deepEqual(result.deleteButMissing, []);
});

await test("checkScopeRefs: (delete) that is missing is deleteButMissing, and afterApply ignores it", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "dbm");
  await writeFile(paths.proposal, "# P\n\n## Files This Change Will Touch\n\n- src/gone.ts (delete)\n", "utf8");
  const before = await checkScopeRefs(cwd, "dbm");
  assert.deepEqual(before.deleteButMissing, ["src/gone.ts"]);
  const after = await checkScopeRefs(cwd, "dbm", { afterApply: true });
  assert.deepEqual(after.deleteButMissing, []);
  assert.deepEqual(after.missing, []);
});

await test("checkScopeRefs: no contract -> all three lists empty, noContract true", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "refsnocontract2");
  const result = await checkScopeRefs(cwd, "refsnocontract2");
  assert.equal(result.noContract, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.newButExists, []);
  assert.deepEqual(result.deleteButMissing, []);
});

await test("checkScope: a (delete) path is in scope", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "delscope");
  await writeFile(paths.proposal, "# P\n\n## Files This Change Will Touch\n\n- src/gone.ts (delete)\n- src/rogue.ts\n", "utf8");
  const result = await checkScope(cwd, "delscope", ["src/gone.ts", "src/other.ts"]);
  assert.equal(result.noContract, false);
  assert.deepEqual(result.outside, ["src/other.ts"]);
});

await test("checkScopeRefs: a contract entry that is a directory is not reported dangling", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "dirrefs");
  await mkdir(join(cwd, "src", "lib"), { recursive: true });
  await writeFile(
    paths.proposal,
    "# P\n\n## Files This Change Will Touch\n\n- src/lib/\n- src/missing/no-such-dir/\n",
    "utf8",
  );
  const result = await checkScopeRefs(cwd, "dirrefs");
  assert.equal(result.noContract, false);
  // src/lib/ is a real directory (exists), src/missing/no-such-dir/ is not.
  assert.deepEqual(result.missing, ["src/missing/no-such-dir/"]);
});

await test("checkScope: a directory contract entry matches anything under it by prefix", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "dirscope");
  await mkdir(join(cwd, "src", "lib"), { recursive: true });
  await writeFile(paths.proposal, "# P\n\n## Files This Change Will Touch\n\n- src/lib/\n", "utf8");
  const result = await checkScope(cwd, "dirscope", ["src/lib/thing.ts", "src/lib/nested/deep.ts", "src/other.ts"]);
  assert.equal(result.noContract, false);
  assert.deepEqual(result.outside, ["src/other.ts"]);
});

await test("hasBeenApplied: false before Apply, true once applied or a task is done", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "applied");
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  assert.equal(await hasBeenApplied(cwd, "applied"), false);

  // A done task alone is enough (tasks.md already reflects Apply).
  await writeFile(paths.tasks, "- [x] 1.1 x\n", "utf8");
  assert.equal(await hasBeenApplied(cwd, "applied"), true);

  // The phase log alone is enough too, even with no tasks ticked.
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  await appendPhaseEvent(cwd, "applied", {
    phase: "apply",
    edge: "end",
    at: new Date().toISOString(),
    lane: "full",
    laneSource: "brainstorm",
    outcome: "applied",
  });
  assert.equal(await hasBeenApplied(cwd, "applied"), true);
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

await test("writeApproveBase/readApproveBase: round-trip, first-write-wins, missing -> undefined", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "approve-base");

  // Missing base reads as undefined, never throws.
  assert.equal(await readApproveBase(cwd, "approve-base"), undefined);

  await writeApproveBase(cwd, "approve-base", "abc1234");
  assert.equal(await readApproveBase(cwd, "approve-base"), "abc1234");

  // A second write must not move the base -- a re-approve after Refine keeps the first capture.
  await writeApproveBase(cwd, "approve-base", "def5678");
  assert.equal(await readApproveBase(cwd, "approve-base"), "abc1234");

  // undefined sha (no commits yet) is a no-op, not a write of "undefined".
  await writeApproveBase(cwd, "no-commits", undefined);
  assert.equal(await readApproveBase(cwd, "no-commits"), undefined);

  // A change dir that does not exist at all reads undefined, not throw.
  assert.equal(await readApproveBase(cwd, "does-not-exist"), undefined);
});

await test("hasDirtyBaseline: false with no baseline, true after a capture (even an empty one)", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "hb");
  // No baseline captured yet.
  assert.equal(await hasDirtyBaseline(cwd, "hb"), false);
  // An EMPTY capture still marks a real baseline: readDirtyBaseline would return an empty set
  // either way, but hasDirtyBaseline must distinguish "the tree was clean" from "no capture".
  await ensureDirtyBaseline(cwd, "hb", []);
  assert.equal(await hasDirtyBaseline(cwd, "hb"), true);
  assert.deepEqual([...(await readDirtyBaseline(cwd, "hb"))], []);

  // A change dir that does not exist at all reads false, not throw.
  assert.equal(await hasDirtyBaseline(cwd, "does-not-exist"), false);
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

await test("phase events round-trip in file order", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "ph");
  const first: PhaseEvent = {
    phase: "explore",
    edge: "start",
    at: "2026-01-01T00:00:00.000Z",
    lane: "fast",
    laneSource: "flag",
    model: "small/fast",
  };
  const second: PhaseEvent = {
    phase: "explore",
    edge: "end",
    at: "2026-01-01T00:01:00.000Z",
    lane: "fast",
    laneSource: "flag",
    outcome: "exploration-written",
  };
  await appendPhaseEvent(cwd, "ph", first);
  await appendPhaseEvent(cwd, "ph", second);
  assert.deepEqual(await readPhaseEvents(cwd, "ph"), [first, second]);
});

await test("phase events round-trip the new laneSource values and the grill payload", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "ph2");
  const auto: PhaseEvent = {
    phase: "explore",
    edge: "end",
    at: "2026-01-02T00:00:00.000Z",
    lane: "fast",
    laneSource: "config-auto",
  };
  const userPick: PhaseEvent = {
    phase: "grill",
    edge: "end",
    at: "2026-01-02T00:01:00.000Z",
    lane: "full",
    laneSource: "user-pick",
    outcome: "grilled",
    grill: {
      clarity: "partial",
      openDecisions: 1,
      questionsAsked: 2,
      recommendedLane: "full",
      laneReason: "narrow but migration-bound",
      riskFlag: "migration",
    },
  };
  await appendPhaseEvent(cwd, "ph2", auto);
  await appendPhaseEvent(cwd, "ph2", userPick);
  assert.deepEqual(await readPhaseEvents(cwd, "ph2"), [auto, userPick]);
});

await test("readPhaseEvents returns [] when there is no CONTEXT.md", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "none");
  const { rm: rmFile } = await import("node:fs/promises");
  await rmFile(changePaths(cwd, "none").context, { force: true });
  assert.deepEqual(await readPhaseEvents(cwd, "none"), []);
});

await test("phase events coexist with the baseline and human-readable entries", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "mix");
  await ensureDirtyBaseline(cwd, "mix", ["a.txt"]);
  await appendContext(cwd, "mix", "Explore", "did exploration");
  const event: PhaseEvent = {
    phase: "propose",
    edge: "start",
    at: "2026-01-01T00:02:00.000Z",
    lane: "full",
    laneSource: "brainstorm",
    model: "big/model",
  };
  await appendPhaseEvent(cwd, "mix", event);
  assert.deepEqual([...(await readDirtyBaseline(cwd, "mix"))], ["a.txt"]);
  assert.deepEqual(await readPhaseEvents(cwd, "mix"), [event]);
  const raw = await readContext(cwd, "mix");
  assert.ok(raw?.includes("## Explore —"), "human entry must survive");
  assert.ok(raw?.includes(PHASE_MARKER), "phase marker must be present");
});

await test("phase parse is fence-scoped: braces in a Refine entry don't corrupt later events", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "br");
  const start: PhaseEvent = {
    phase: "propose",
    edge: "start",
    at: "2026-01-01T00:03:00.000Z",
    lane: "full",
    laneSource: "brainstorm",
  };
  const end: PhaseEvent = {
    phase: "propose",
    edge: "end",
    at: "2026-01-01T00:04:00.000Z",
    lane: "full",
    laneSource: "brainstorm",
    outcome: "proposed",
  };
  await appendPhaseEvent(cwd, "br", start);
  await appendContext(cwd, "br", "Refine", "User feedback: make it return {status: 'ok'}");
  await appendPhaseEvent(cwd, "br", end);
  assert.deepEqual(await readPhaseEvents(cwd, "br"), [start, end]);
});

await test("malformed phase entries are skipped, never thrown", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "bad");
  const good: PhaseEvent = {
    phase: "apply",
    edge: "end",
    at: "2026-01-01T00:05:00.000Z",
    lane: "fast",
    laneSource: "flag",
    outcome: "applied",
  };
  const raw = [
    "# Context log",
    "",
    PHASE_MARKER,
    "```json",
    JSON.stringify(good),
    "```",
    "",
    PHASE_MARKER,
    "```json",
    "not json",
    "```",
    "",
    PHASE_MARKER,
    "```json",
    '{"phase":"propose"}',
    "```",
    "",
  ].join("\n");
  await writeFile(changePaths(cwd, "bad").context, raw, "utf8");
  assert.deepEqual(await readPhaseEvents(cwd, "bad"), [good]);
});

await test("readScopeDeviations: parses bullets with reasons, tolerant of backticks and separators", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "deviations");
  await writeFile(
    paths.tasks,
    [
      "- [ ] 1.1 x",
      "",
      "## Scope deviations",
      "",
      "- src/a.ts — needed a shared helper",
      "- `src/b.ts`: the spec scenario requires it",
      "- src/c.ts",
      "- prose without a path",
      "",
      "## Notes",
      "",
      "- src/d.ts — after the section ends, so not a deviation",
    ].join("\n"),
    "utf8",
  );
  const deviations = await readScopeDeviations(cwd, "deviations");
  assert.deepEqual(deviations.map((d) => d.path), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.equal(deviations[0].reason, "needed a shared helper");
  assert.equal(deviations[1].reason, "the spec scenario requires it");
  assert.equal(deviations[2].reason, "");
});

await test("readScopeDeviations: absent section -> empty, never a throw", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "nodeviations");
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  assert.deepEqual(await readScopeDeviations(cwd, "nodeviations"), []);
});

await test("readScopeDeviations: missing tasks.md -> empty", async () => {
  const cwd = await freshCwd();
  await scaffoldChange(cwd, "notasks");
  assert.deepEqual(await readScopeDeviations(cwd, "notasks"), []);
});

await test("readOpenDecisions: parses ### blocks with a Recommended line, ignores 'none', [] when absent", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "opendec");

  // Absent section -> [].
  await writeFile(paths.proposal, "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
  assert.deepEqual(await readOpenDecisions(cwd, "opendec"), []);

  // Section whose only content is "none" -> [].
  await writeFile(paths.proposal, "## Why\n\nx\n\n## Open Decisions\n\nnone\n", "utf8");
  assert.deepEqual(await readOpenDecisions(cwd, "opendec"), []);

  // Two decisions, the second without a Recommended line.
  await writeFile(
    paths.proposal,
    [
      "## Why",
      "",
      "x",
      "",
      "## Open Decisions",
      "",
      "### Which store?",
      "- Options: sqlite | postgres",
      "- Recommended: sqlite, simpler for one process",
      "- Changes per option: postgres adds a migration step",
      "",
      "### Which port?",
      "- Options: 3000 | 8080",
      "",
      "## Assumptions",
      "",
      "- default timeout — 30s",
    ].join("\n"),
    "utf8",
  );
  const decisions = await readOpenDecisions(cwd, "opendec");
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].question, "Which store?");
  assert.equal(decisions[0].recommended, "sqlite, simpler for one process");
  assert.equal(decisions[1].question, "Which port?");
  assert.equal(decisions[1].recommended, undefined);

  // readAssumptions reads the level-2 section, keeping level-3 lines out of the decision body.
  assert.equal(await readAssumptions(cwd, "opendec"), "- default timeout — 30s");
});

await test("validateChange: an open decision without a recommended option is flagged; with one it passes", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "odvalidate");
  await writeFile(
    paths.proposal,
    "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/a.ts (new)\n\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n\n## Open Decisions\n\n### Which store?\n- Options: sqlite | postgres\n",
    "utf8",
  );
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  const bad = await validateChange(cwd, "odvalidate");
  assert.ok(
    bad.issues.some((i) => i.file === "proposal.md" && /open decision "Which store\?" has no recommended option/.test(i.problem)),
    "a decision with no Recommended line is flagged",
  );

  await writeFile(
    paths.proposal,
    "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/a.ts (new)\n\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n\n## Open Decisions\n\n### Which store?\n- Options: sqlite | postgres\n- Recommended: sqlite\n",
    "utf8",
  );
  const good = await validateChange(cwd, "odvalidate");
  assert.ok(!good.issues.some((i) => /open decision/.test(i.problem)), "a recommended decision passes");
});

await test("readBlockingFindings: bullets under ## Blocking; 'none' and a missing section both give []", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "blocking");

  // No REVIEW.md at all.
  assert.deepEqual(await readBlockingFindings(cwd, "blocking"), []);

  await writeFile(paths.review, "## Findings\n\nlooks fine\n\n## Blocking\n\nnone\n", "utf8");
  assert.deepEqual(await readBlockingFindings(cwd, "blocking"), []);

  await writeFile(
    paths.review,
    "## Findings\n\nx\n\n## Blocking\n\n- scenario S1 is not met\n- the deprecation warning is missing its type\n\n## Fix turn\n\n- fixed the first\n",
    "utf8",
  );
  const bullets = await readBlockingFindings(cwd, "blocking");
  assert.deepEqual(bullets, ["scenario S1 is not met", "the deprecation warning is missing its type"]);
});
await test("docMentions/findMissingRequestedDocs: a CHANGELOG mention absent from the contract is reported", async () => {
  assert.deepEqual(docMentions("Update the code and CHANGELOG."), ["changelog"]);

  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "requested-docs");
  await writeFile(
    paths.proposal,
    ["## Why", "", "x", "", "## What Changes", "", "- x", "", "## Files This Change Will Touch", "", "- src/thing.ts"].join("\n"),
    "utf8",
  );
  assert.deepEqual(
    await findMissingRequestedDocs(cwd, "requested-docs", "Please update CHANGELOG.", "No request text."),
    ["changelog"],
  );

  await writeFile(
    paths.proposal,
    ["## Why", "", "x", "", "## What Changes", "", "- x", "", "## Files This Change Will Touch", "", "- src/thing.ts", "- CHANGELOG.md (new)"].join("\n"),
    "utf8",
  );
  assert.deepEqual(
    await findMissingRequestedDocs(cwd, "requested-docs", "Please update CHANGELOG.", "No request text."),
    [],
  );
});

await test("docRequests: action-verb gating with negation veto", async () => {
  assert.deepEqual(docRequests("Please add a CHANGELOG entry under Unreleased."), ["changelog"]);
  assert.deepEqual(docRequests("Update the README and docs/getting-started.md."), ["docs/", "readme"]);
  assert.deepEqual(docRequests("don't touch the README"), []);
  assert.deepEqual(docRequests("Do not update the CHANGELOG."), []);
  assert.deepEqual(docRequests("README says rounding is half-up"), []);
  assert.deepEqual(docRequests("We never document in docs/"), []);
});

await test("brainstormRequestText/brainstormDecisionText: only the request and decision sections", async () => {
  const raw = [
    "---",
    "lane: full",
    "---",
    "## Problem / Context",
    "",
    "The rounding mode is wrong.",
    "",
    "## Scope",
    "",
    "- in scope: the formatter",
    "",
    "## Acceptance Criteria",
    "",
    "- WHEN x THEN y",
    "",
    "## Decision",
    "",
    "- Chosen option: A",
    "",
    "## Technical Constraints & Notes from Repo",
    "",
    "- README says rounding is half-up",
    "",
  ].join("\n");
  assert.equal(brainstormRequestText(raw), "The rounding mode is wrong.");
  const decision = brainstormDecisionText(raw);
  assert.ok(decision.includes("the formatter"));
  assert.ok(decision.includes("WHEN x THEN y"));
  assert.ok(decision.includes("Chosen option: A"));
  assert.ok(!decision.includes("half-up"), "a Notes section is never decision-bearing");
});

await test("findMissingRequestedDocs: a cited-but-unrequested doc in a Notes section yields no repair item", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "scoped-docs");
  await writeFile(
    paths.proposal,
    ["## Why", "", "x", "", "## Files This Change Will Touch", "", "- src/thing.ts"].join("\n"),
    "utf8",
  );
  const brainstorm = [
    "---",
    "lane: full",
    "---",
    "## Problem / Context",
    "",
    "Fix the rounding.",
    "",
    "## Technical Constraints & Notes from Repo",
    "",
    "- README says rounding is half-up",
    "",
  ].join("\n");
  assert.deepEqual(
    await findMissingRequestedDocs(cwd, "scoped-docs", brainstormRequestText(brainstorm), brainstorm),
    [],
    "a Notes citation never forces a doc into the contract",
  );

  // A decision-bearing request DOES produce a repair item.
  const requested = `${brainstorm}\n\n## Scope\n\n- Add a CHANGELOG entry under Unreleased.\n`;
  assert.deepEqual(
    await findMissingRequestedDocs(cwd, "scoped-docs", brainstormRequestText(requested), requested),
    ["changelog"],
  );
});

await test("findDocFileWarnings: deprecation advisory only, never a repair item", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "doc-warnings");
  await writeFile(
    paths.proposal,
    ["## Why", "", "x", "", "## Files This Change Will Touch", "", "- src/thing.ts"].join("\n"),
    "utf8",
  );
  const brainstorm = "## Problem / Context\n\nFix the rounding.\n\n## Scope\n\n- Follow the deprecation path in the code.\n";
  assert.deepEqual(
    await findMissingRequestedDocs(cwd, "doc-warnings", brainstormRequestText(brainstorm), brainstorm),
    [],
    "a deprecation mention is never a repair item",
  );
  assert.deepEqual(await findDocFileWarnings(cwd, "doc-warnings", brainstormRequestText(brainstorm), brainstorm), [
    "requested deprecation has no matching contract entry or existing file — warning only, not a repair item",
  ]);

  // A matching on-disk file silences the advisory.
  await writeFile(join(cwd, "DEPRECATIONS.md"), "# Deprecations\n", "utf8");
  assert.deepEqual(await findDocFileWarnings(cwd, "doc-warnings", brainstormRequestText(brainstorm), brainstorm), []);

  // No contract section at all -> [].
  await writeFile(paths.proposal, "## Why\n\nx\n", "utf8");
  assert.deepEqual(await findDocFileWarnings(cwd, "doc-warnings", "Follow the deprecation path.", "No request text."), []);
});

await test("readOpenDecisions: bullet decisions parse with inline and indented Recommended", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "bullet-dec");
  await writeFile(
    paths.proposal,
    [
      "## Why",
      "",
      "x",
      "",
      "## Open Decisions",
      "",
      "- Which store? Recommended: sqlite, simpler for one process",
      "- Which port?",
      "  - Recommended: 8080, matches the existing default",
      "- none",
      "",
      "## Assumptions",
      "",
      "- default timeout — 30s",
    ].join("\n"),
    "utf8",
  );
  const decisions = await readOpenDecisions(cwd, "bullet-dec");
  assert.equal(decisions.length, 2, "the 'none' bullet is skipped");
  assert.equal(decisions[0].question, "Which store?");
  assert.equal(decisions[0].recommended, "sqlite, simpler for one process");
  assert.equal(decisions[1].question, "Which port?");
  assert.equal(decisions[1].recommended, "8080, matches the existing default");
});

await test("validateChange: prose-only non-none Open Decisions yields the no-parsable-decisions warning", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "od-prose");
  await writeFile(
    paths.proposal,
    "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/a.ts (new)\n\n## Acceptance\n\n- **WHEN** a\n- **THEN** the command exits 0\n\n## Open Decisions\n\nWe still have not decided which store to use.\n",
    "utf8",
  );
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  const result = await validateChange(cwd, "od-prose");
  assert.ok(
    result.issues.some((i) => i.file === "proposal.md" && i.problem === "open decisions section has content but no parsable decisions"),
    "prose-only Open Decisions is warned about verbatim",
  );
});

await test("readAssumedScenarios: full-lane spec block and fast-lane acceptance bullet; [] when none", async () => {
  const cwd = await freshCwd();
  const full = await scaffoldChange(cwd, "assumed-full");
  await mkdir(join(full.dir, "specs", "cap"), { recursive: true });
  await writeFile(
    join(full.dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: empty sort is default order (assumed)\n\n- **WHEN** empty sort is requested\n- **THEN** the command exits 0\n\n#### Scenario: ordinary behavior\n\n- **WHEN** something else happens\n- **THEN** the command exits 0\n",
    "utf8",
  );
  assert.deepEqual(await readAssumedScenarios(cwd, "assumed-full"), ["empty sort is default order (assumed)"]);

  const fast = await scaffoldChange(cwd, "assumed-fast");
  await writeFile(
    fast.proposal,
    "---\nlane: fast\n---\n## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/a.ts (new)\n\n## Acceptance\n\n- **WHEN** a sorted list is empty **THEN** the command exits 0 (assumed)\n- **WHEN** another input arrives **THEN** the command exits 0\n",
    "utf8",
  );
  assert.deepEqual(await readAssumedScenarios(cwd, "assumed-fast"), [
    "- **WHEN** a sorted list is empty **THEN** the command exits 0 (assumed)",
  ]);

  const none = await scaffoldChange(cwd, "assumed-none");
  await mkdir(join(none.dir, "specs", "cap"), { recursive: true });
  await writeFile(
    join(none.dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: ordinary behavior\n\n- **WHEN** something happens\n- **THEN** the command exits 0\n",
    "utf8",
  );
  assert.deepEqual(await readAssumedScenarios(cwd, "assumed-none"), []);
});

await test("validateChange still passes on an older change with no (assumed) markers", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "assumed-legacy");
  await mkdir(join(paths.dir, "specs", "cap"), { recursive: true });
  await writeFile(paths.proposal, "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/a.ts (new)\n", "utf8");
  await writeFile(
    join(paths.dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: ordinary behavior\n\n- **WHEN** something happens\n- **THEN** the command exits 0\n",
    "utf8",
  );
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  assert.deepEqual(await readAssumedScenarios(cwd, "assumed-legacy"), []);
  assert.equal((await validateChange(cwd, "assumed-legacy")).ok, true);
});

await test("validateChange: a body mention of an internal term is flagged; the same text under `## Grounding` is not", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "internal-terms");
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  await mkdir(join(paths.dir, "specs", "cap"), { recursive: true });
  await writeFile(
    join(paths.dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: ordinary behavior\n\n- **WHEN** something happens\n- **THEN** the command exits 0\n",
    "utf8",
  );
  await writeFile(
    paths.proposal,
    "## Why\n\nSee readyset/changes/foo for background.\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/a.ts (new)\n",
    "utf8",
  );
  const flagged = await validateChange(cwd, "internal-terms");
  assert.ok(
    flagged.issues.some((issue) => issue.file === "proposal.md" && /Readyset-internal term "readyset\/changes"/.test(issue.problem)),
    "a workflow path in the proposal body is flagged",
  );

  await writeFile(
    paths.proposal,
    "## Why\n\nx\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/a.ts (new)\n\n## Grounding\n\nSee readyset/changes/foo for background.\n",
    "utf8",
  );
  assert.ok(
    !(await validateChange(cwd, "internal-terms")).issues.some((issue) => /Readyset-internal term/.test(issue.problem)),
    "the same anchor under `## Grounding` is not flagged",
  );
});

await test("validateChange: 'lane' matches as a word, not a substring", async () => {
  const cwd = await freshCwd();
  const paths = await scaffoldChange(cwd, "internal-lane");
  await writeFile(paths.tasks, "- [ ] 1.1 x\n", "utf8");
  await mkdir(join(paths.dir, "specs", "cap"), { recursive: true });
  await writeFile(
    join(paths.dir, "specs", "cap", "spec.md"),
    "## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: ordinary behavior\n\n- **WHEN** something happens\n- **THEN** the command exits 0\n",
    "utf8",
  );
  await writeFile(
    paths.proposal,
    "## Why\n\nWe considered airplanes and planed wood, but the plain route won.\n\n## What Changes\n\n- x\n\n## Files This Change Will Touch\n\n- src/a.ts (new)\n",
    "utf8",
  );
  assert.ok(
    !(await validateChange(cwd, "internal-lane")).issues.some((issue) => /Readyset-internal term/.test(issue.problem)),
    "`planes` does not trip the `lane` word check",
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
