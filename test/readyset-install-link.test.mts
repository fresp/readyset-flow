/**
 * Tests `install.mjs`'s `linkExtension` -- the function that merges Readyset's extension entry
 * point into a target `<agentDir>/settings.json`, instead of copying the `.ts` files there.
 * Exercises the real function against a scratch directory (fs, not mocked): no settings.json
 * yet, an existing one with unrelated extensions, a stale readyset-review.ts path (repo moved),
 * and re-running against an already-up-to-date file (idempotent, no rewrite).
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const installMjsPath = join(__dirname, "..", "src", "cli", "install.mjs");

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

async function freshAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "readyset-install-link-"));
	const agentDir = join(dir, "agent");
	await mkdir(agentDir, { recursive: true });
	return agentDir;
}

const mod = (await import(`${installMjsPath}?t=${Date.now()}-${Math.random()}`)) as {
	linkExtension: (agentDir: string) => Promise<{ status: string; settingsPath: string }>;
	EXTENSION_ENTRY_POINT: string;
};
const { linkExtension, EXTENSION_ENTRY_POINT } = mod;

await test("no settings.json yet: creates one with just our entry", async () => {
	const agentDir = await freshAgentDir();
	const result = await linkExtension(agentDir);
	assert.equal(result.status, "added");
	const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.extensions, [EXTENSION_ENTRY_POINT]);
});

await test("existing settings.json with unrelated extensions: ours is appended, theirs kept", async () => {
	const agentDir = await freshAgentDir();
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ extensions: ["/home/x/.omp/agent/extensions/some-other-thing.ts"], theme: "dark" }),
	);
	const result = await linkExtension(agentDir);
	assert.equal(result.status, "added");
	const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.extensions, ["/home/x/.omp/agent/extensions/some-other-thing.ts", EXTENSION_ENTRY_POINT]);
	assert.equal(settings.theme, "dark", "unrelated top-level settings must survive the merge");
});

await test("stale readyset-review.ts path (repo moved): replaced, not duplicated", async () => {
	const agentDir = await freshAgentDir();
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ extensions: ["/old/clone/location/src/extensions/readyset-review.ts"] }),
	);
	const result = await linkExtension(agentDir);
	assert.equal(result.status, "updated");
	const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.extensions, [EXTENSION_ENTRY_POINT]);
});

await test("already up to date: re-running is a no-op (file untouched, status unchanged)", async () => {
	const agentDir = await freshAgentDir();
	await linkExtension(agentDir);
	const before = await readFile(join(agentDir, "settings.json"), "utf8");
	const result = await linkExtension(agentDir);
	assert.equal(result.status, "unchanged");
	const after = await readFile(join(agentDir, "settings.json"), "utf8");
	assert.equal(after, before);
});

await test("malformed settings.json: throws a clear error instead of clobbering it", async () => {
	const agentDir = await freshAgentDir();
	await writeFile(join(agentDir, "settings.json"), "{ not valid json");
	await assert.rejects(() => linkExtension(agentDir), /isn't valid JSON/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
