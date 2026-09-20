/**
 * End-to-end test for `readyset-flow validate` -- deliberately runs `install.mjs` as a real
 * child process (not imported and called in-process) rather than a unit test, because the
 * thing actually being verified is the subprocess boundary itself: install.mjs staying
 * flag-free while spawning validate-runner.mts with `--experimental-strip-types`, and the
 * runner's stdout-is-one-line-of-JSON / exit-code contract between the two files. A unit test
 * that imported validateChange directly would exercise none of that.
 */
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const installMjs = join(__dirname, "..", "src", "cli", "install.mjs");

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

function runValidateCli(changeId: string | undefined, cwd: string) {
	const args = ["validate"];
	if (changeId) args.push(changeId);
	args.push("--cwd", cwd);
	return spawnSync(process.execPath, [installMjs, ...args], { encoding: "utf8" });
}

async function freshCwd(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "readyset-cli-"));
}

await test("readyset-flow validate: passes (exit 0) for a structurally valid change", async () => {
	const cwd = await freshCwd();
	const dir = join(cwd, "readyset", "changes", "good-cli-change");
	await mkdir(join(dir, "specs", "cap"), { recursive: true });
	await writeFile(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- x\n", "utf8");
	await writeFile(
		join(dir, "specs", "cap", "spec.md"),
		"## Purpose\n\nx\n\n## ADDED Requirements\n\n### Requirement: Foo\n\n#### Scenario: bar\n\n- **WHEN** a\n- **THEN** the command exits 0\n",
		"utf8",
	);
	await writeFile(join(dir, "tasks.md"), "- [ ] 1.1 x\n", "utf8");

	const result = runValidateCli("good-cli-change", cwd);
	assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
	assert.match(result.stdout, /validate: pass/);
});

await test("readyset-flow validate: fails (exit 1) and lists issues for a broken change", async () => {
	const cwd = await freshCwd();
	const dir = join(cwd, "readyset", "changes", "bad-cli-change");
	await mkdir(join(dir, "specs", "cap"), { recursive: true });
	await writeFile(join(dir, "proposal.md"), "no sections here\n", "utf8");
	await writeFile(join(dir, "specs", "cap", "spec.md"), "nothing here\n", "utf8");
	await writeFile(join(dir, "tasks.md"), "no boxes\n", "utf8");

	const result = runValidateCli("bad-cli-change", cwd);
	assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
	assert.match(result.stdout, /validate: \d+ issue/);
	assert.match(result.stdout, /- proposal\.md: missing '## Why' section/);
	assert.match(result.stdout, /spec\.md: no '### Requirement:' found/);
	assert.match(result.stdout, /- tasks\.md: no checkbox items found/);
});

await test("readyset-flow validate: missing change-id prints usage and exits 1, doesn't crash", async () => {
	const cwd = await freshCwd();
	const result = runValidateCli(undefined, cwd);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Usage: readyset-flow validate/);
});

await test("readyset-flow validate: a change that doesn't exist reports as missing artifacts, not a crash", async () => {
	const cwd = await freshCwd();
	const result = runValidateCli("does-not-exist", cwd);
	assert.equal(result.status, 1);
	assert.match(result.stdout, /proposal\.md: missing/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
