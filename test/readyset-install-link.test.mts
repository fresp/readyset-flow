/**
 * Tests `install.mjs`'s `linkExtension`/`unlinkExtension` (the install/uninstall halves of the
 * settings.json "extensions" merge) and `clearConfigBlock` (uninstall's config.yml cleanup).
 * Exercises the real functions against scratch files (fs, not mocked): no settings.json yet, an
 * existing one with unrelated extensions, a stale readyset-review.ts path (repo moved),
 * re-running against an already-up-to-date file (idempotent, no rewrite), and the uninstall
 * side of each of those.
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
	unlinkExtension: (agentDir: string) => Promise<{ status: string; settingsPath: string }>;
	clearConfigBlock: (configPath: string) => Promise<boolean>;
	EXTENSION_ENTRY_POINT: string;
};
const { linkExtension, unlinkExtension, clearConfigBlock, EXTENSION_ENTRY_POINT } = mod;

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

await test("unlinkExtension: removes our entry, leaves unrelated ones alone", async () => {
	const agentDir = await freshAgentDir();
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ extensions: ["/home/x/.omp/agent/extensions/some-other-thing.ts", EXTENSION_ENTRY_POINT], theme: "dark" }),
	);
	const result = await unlinkExtension(agentDir);
	assert.equal(result.status, "removed");
	const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.extensions, ["/home/x/.omp/agent/extensions/some-other-thing.ts"]);
	assert.equal(settings.theme, "dark", "unrelated top-level settings must survive");
});

await test("unlinkExtension: no settings.json at all -> not-found, nothing created", async () => {
	const agentDir = await freshAgentDir();
	const result = await unlinkExtension(agentDir);
	assert.equal(result.status, "not-found");
	await assert.rejects(() => readFile(join(agentDir, "settings.json"), "utf8"), /ENOENT/);
});

await test("unlinkExtension: settings.json exists but has no matching entry -> not-found, file untouched", async () => {
	const agentDir = await freshAgentDir();
	const before = JSON.stringify({ extensions: ["/home/x/.omp/agent/extensions/some-other-thing.ts"] });
	await writeFile(join(agentDir, "settings.json"), before);
	const result = await unlinkExtension(agentDir);
	assert.equal(result.status, "not-found");
	assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), before);
});

await test("unlinkExtension: stale (moved) readyset-review.ts path is still matched by basename and removed", async () => {
	const agentDir = await freshAgentDir();
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["/old/clone/location/src/extensions/readyset-review.ts"] }));
	const result = await unlinkExtension(agentDir);
	assert.equal(result.status, "removed");
	const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.extensions, []);
});

await test("unlinkExtension: malformed settings.json throws a clear error instead of clobbering it", async () => {
	const agentDir = await freshAgentDir();
	await writeFile(join(agentDir, "settings.json"), "{ not valid json");
	await assert.rejects(() => unlinkExtension(agentDir), /isn't valid JSON/);
});

async function freshConfigPath(initialContent?: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "readyset-clear-config-"));
	const configPath = join(dir, "config.yml");
	if (initialContent !== undefined) await writeFile(configPath, initialContent, "utf8");
	return configPath;
}

await test("clearConfigBlock: no config.yml at all -> false, nothing created", async () => {
	const dir = await mkdtemp(join(tmpdir(), "readyset-clear-config-"));
	const configPath = join(dir, "config.yml");
	const result = await clearConfigBlock(configPath);
	assert.equal(result, false);
	await assert.rejects(() => readFile(configPath, "utf8"), /ENOENT/);
});

await test("clearConfigBlock: config.yml exists but has no readyset: block -> false, file untouched", async () => {
	const configPath = await freshConfigPath("modelRoles:\n  default: eai1/foo\n");
	const before = await readFile(configPath, "utf8");
	const result = await clearConfigBlock(configPath);
	assert.equal(result, false);
	assert.equal(await readFile(configPath, "utf8"), before);
});

await test("clearConfigBlock: removes an existing readyset: block, leaves everything else untouched", async () => {
	const configPath = await freshConfigPath(
		"modelRoles:\n  default: eai1/foo\nreadyset:\n  lang: Indonesian\n  model:\n    default: eai2/gemini41\nadvisor:\n  x: 1\n",
	);
	const result = await clearConfigBlock(configPath);
	assert.equal(result, true);
	const after = await readFile(configPath, "utf8");
	assert.doesNotMatch(after, /readyset:/);
	assert.match(after, /modelRoles:/);
	assert.match(after, /advisor:/);
});

await test("clearConfigBlock: an inline readyset: value (unsupported shape) is left alone, not guessed at", async () => {
	const configPath = await freshConfigPath("readyset: some-inline-value\n");
	const before = await readFile(configPath, "utf8");
	const result = await clearConfigBlock(configPath);
	assert.equal(result, false);
	assert.equal(await readFile(configPath, "utf8"), before, "the unrecognized shape must be left byte-for-byte alone");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
