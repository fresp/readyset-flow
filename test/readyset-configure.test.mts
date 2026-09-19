/**
 * Tests `configure.mjs` -- the plain-text splice logic behind `readyset-flow configure`
 * (`findReadysetBlock`/`buildReadysetBlockLines`/`spliceReadysetBlock`, pure and directly
 * exercised), plus `runConfigureWizard` end-to-end against a scratch config.yml with scripted
 * stdin/stdout, including one real subprocess run of `configure-runner.mts` to confirm the
 * whole pipeline (not just the pure functions) actually works.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { spawnSync as realSpawnSync } from "node:child_process";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configureMjsPath = join(__dirname, "..", "src", "cli", "configure.mjs");
const runnerPath = join(__dirname, "..", "src", "cli", "configure-runner.mts");

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

async function freshConfigPath(initialContent?: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "readyset-configure-"));
	const agentDir = join(dir, "agent");
	await mkdir(agentDir, { recursive: true });
	const configPath = join(agentDir, "config.yml");
	if (initialContent !== undefined) await writeFile(configPath, initialContent, "utf8");
	return configPath;
}

/** Feeds `answers` as lines on a stream that's deliberately never `end()`-ed and never pushed
 *  all at once. Two separate readline gotchas rule out the obvious `Readable.from(fullString)`:
 *  (1) `Readable.from` ends the stream the instant its string is drained, and node's readline
 *  auto-closes its Interface once the underlying input stream ends -- even if some scripted
 *  answers haven't been consumed by a `.question()` call yet, which crashes later questions
 *  with ERR_USE_AFTER_CLOSE. (2) even with the stream kept open, pushing every line in one
 *  chunk makes readline emit all their 'line' events synchronously and eagerly -- any line
 *  emitted before the next `.question()` call has attached its one-time listener is silently
 *  dropped, so only the first scripted answer would ever be seen. Drip-feeding one line per
 *  `setImmediate` tick gives the caller's `await rl.question(...)` a chance to register its
 *  listener between lines. `runConfigureWizard`'s own `rl.close()` (in its `finally`) is what
 *  actually ends the interface, once every question has been asked. */
function scriptedInput(answers: string[]): Readable {
	const r = new Readable({ read() {} });
	(async () => {
		for (const answer of answers) {
			await new Promise((resolve) => setImmediate(resolve));
			r.push(`${answer}\n`);
		}
	})();
	return r;
}

function collectingOutput(): Writable & { text: () => string } {
	const chunks: string[] = [];
	const w = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(chunk.toString());
			cb();
		},
	}) as Writable & { text: () => string };
	w.text = () => chunks.join("");
	return w;
}

/** A fake `spawnSync` for tests that don't want to actually spawn `configure-runner.mts` --
 *  returns canned "current config" JSON, matching the real runner's stdout contract. */
function fakeSpawnSync(current: { language?: string; modelDefault?: string; fallbackChain?: string[] }) {
	return () => ({
		error: undefined,
		status: 0,
		stdout: JSON.stringify({ language: undefined, modelDefault: undefined, fallbackChain: [], ...current }),
	});
}

const mod = (await import(`${configureMjsPath}?t=${Date.now()}-${Math.random()}`)) as {
	findReadysetBlock: (lines: string[]) => { start: number; end: number } | { conflict: true } | null;
	buildReadysetBlockLines: (v: { language?: string; modelDefault?: string; fallbackChain?: string[] }) => string[];
	spliceReadysetBlock: (raw: string, blockLines: string[]) => string;
	runConfigureWizard: (
		configPath: string,
		opts: { spawnSync: typeof realSpawnSync; runnerPath: string; input: Readable; output: Writable },
	) => Promise<void>;
};
const { findReadysetBlock, buildReadysetBlockLines, spliceReadysetBlock, runConfigureWizard } = mod;

// -- findReadysetBlock --------------------------------------------------------------------

await test("findReadysetBlock: no readyset key -> null", () => {
	assert.equal(findReadysetBlock(["modelRoles:", "  default: spark/minimax-m3"]), null);
});

await test("findReadysetBlock: block runs to EOF when nothing follows it", () => {
	const lines = ["modelRoles:", "  default: x", "readyset:", "  language: Indonesian"];
	assert.deepEqual(findReadysetBlock(lines), { start: 2, end: 4 });
});

await test("findReadysetBlock: block stops at the next top-level key", () => {
	const lines = ["readyset:", "  language: Indonesian", "retry:", "  fallbackChains: []"];
	assert.deepEqual(findReadysetBlock(lines), { start: 0, end: 2 });
});

await test("findReadysetBlock: inline value flags a conflict rather than guessing", () => {
	assert.deepEqual(findReadysetBlock(["readyset: {model: x}"]), { conflict: true });
});

// -- buildReadysetBlockLines ---------------------------------------------------------------

await test("buildReadysetBlockLines: everything unset -> empty (no block)", () => {
	assert.deepEqual(buildReadysetBlockLines({}), []);
});

await test("buildReadysetBlockLines: language only", () => {
	assert.deepEqual(buildReadysetBlockLines({ language: "Indonesian" }), ["readyset:", "  language: Indonesian"]);
});

await test("buildReadysetBlockLines: model default only, no fallback list line", () => {
	assert.deepEqual(buildReadysetBlockLines({ modelDefault: "anthropic/claude-opus-5" }), [
		"readyset:",
		"  model:",
		"    default: anthropic/claude-opus-5",
	]);
});

await test("buildReadysetBlockLines: fallbackChain only, no default line", () => {
	assert.deepEqual(buildReadysetBlockLines({ fallbackChain: ["a", "b"] }), [
		"readyset:",
		"  model:",
		"    fallbackChains:",
		"      - a",
		"      - b",
	]);
});

await test("buildReadysetBlockLines: all three fields together", () => {
	assert.deepEqual(buildReadysetBlockLines({ language: "Indonesian", modelDefault: "m1", fallbackChain: ["m2", "m3"] }), [
		"readyset:",
		"  language: Indonesian",
		"  model:",
		"    default: m1",
		"    fallbackChains:",
		"      - m2",
		"      - m3",
	]);
});

await test("buildReadysetBlockLines: a value needing quoting gets quoted", () => {
	const lines = buildReadysetBlockLines({ language: "weird # value" });
	assert.equal(lines[1], '  language: "weird # value"');
});

// -- spliceReadysetBlock -------------------------------------------------------------------

await test("spliceReadysetBlock: replaces an existing block, leaves everything else untouched", () => {
	const raw = "modelRoles:\n  default: x\nreadyset:\n  language: Old\nretry:\n  fallbackChains: []\n";
	const result = spliceReadysetBlock(raw, ["readyset:", "  language: New"]);
	assert.equal(result, "modelRoles:\n  default: x\nreadyset:\n  language: New\nretry:\n  fallbackChains: []\n");
});

await test("spliceReadysetBlock: appends when no readyset: block exists yet", () => {
	const raw = "modelRoles:\n  default: x\n";
	const result = spliceReadysetBlock(raw, ["readyset:", "  language: Indonesian"]);
	assert.equal(result, "modelRoles:\n  default: x\n\nreadyset:\n  language: Indonesian\n");
});

await test("spliceReadysetBlock: appending to an empty file adds no leading blank line", () => {
	const result = spliceReadysetBlock("", ["readyset:", "  language: Indonesian"]);
	assert.equal(result, "readyset:\n  language: Indonesian\n");
});

await test("spliceReadysetBlock: removes an existing block entirely when the new block is empty", () => {
	const raw = "modelRoles:\n  default: x\nreadyset:\n  language: Old\nretry:\n  fallbackChains: []\n";
	const result = spliceReadysetBlock(raw, []);
	assert.equal(result, "modelRoles:\n  default: x\nretry:\n  fallbackChains: []\n");
});

await test("spliceReadysetBlock: no existing block, empty new block -> unchanged (plus trailing newline)", () => {
	const raw = "modelRoles:\n  default: x";
	const result = spliceReadysetBlock(raw, []);
	assert.equal(result, "modelRoles:\n  default: x\n");
});

await test("spliceReadysetBlock: throws on an inline readyset: value rather than guessing", () => {
	assert.throws(() => spliceReadysetBlock("readyset: {model: x}\n", ["readyset:", "  language: New"]), /block-mapping shape/);
});

// -- runConfigureWizard (end-to-end, scripted stdin/stdout) --------------------------------

await test("runConfigureWizard: answering 'n' to the first prompt writes nothing", async () => {
	const configPath = await freshConfigPath("modelRoles:\n  default: x\n");
	const before = await readFile(configPath, "utf8");
	const output = collectingOutput();
	await runConfigureWizard(configPath, {
		spawnSync: fakeSpawnSync({}) as unknown as typeof realSpawnSync,
		runnerPath,
		input: scriptedInput(["n"]),
		output,
	});
	const after = await readFile(configPath, "utf8");
	assert.equal(after, before, "declining the wizard must not touch the file");
	assert.match(output.text(), /Skipped -- nothing written/);
	assert.match(output.text(), /readyset:\n {2}language: Indonesian/, "must show the manual-edit block on skip");
});

await test("runConfigureWizard: fresh answers on an empty config write a full block", async () => {
	const configPath = await freshConfigPath();
	const output = collectingOutput();
	await runConfigureWizard(configPath, {
		spawnSync: fakeSpawnSync({}) as unknown as typeof realSpawnSync,
		runnerPath,
		input: scriptedInput(["y", "Indonesian", "anthropic/claude-opus-5", "anthropic/claude-sonnet-5, spark/minimax-m3"]),
		output,
	});
	const written = await readFile(configPath, "utf8");
	assert.equal(
		written,
		"readyset:\n  language: Indonesian\n  model:\n    default: anthropic/claude-opus-5\n    fallbackChains:\n      - anthropic/claude-sonnet-5\n      - spark/minimax-m3\n",
	);
	assert.match(output.text(), /Wrote readyset:/);
});

await test("runConfigureWizard: blank answers keep every current value, and the file is untouched", async () => {
	const initial = "modelRoles:\n  default: spark/minimax-m3\nreadyset:\n  language: Indonesian\n  model:\n    default: m1\n    fallbackChains:\n      - m2\n";
	const configPath = await freshConfigPath(initial);
	const output = collectingOutput();
	await runConfigureWizard(configPath, {
		spawnSync: fakeSpawnSync({ language: "Indonesian", modelDefault: "m1", fallbackChain: ["m2"] }) as unknown as typeof realSpawnSync,
		runnerPath,
		input: scriptedInput(["y", "", "", ""]),
		output,
	});
	const after = await readFile(configPath, "utf8");
	assert.equal(after, initial, "blank answers that match current values must not rewrite the file");
	assert.match(output.text(), /No changes/);
});

await test("runConfigureWizard: a literal '-' clears an existing value, others carry over", async () => {
	const initial = "readyset:\n  language: Indonesian\n  model:\n    default: m1\n    fallbackChains:\n      - m2\n";
	const configPath = await freshConfigPath(initial);
	const output = collectingOutput();
	await runConfigureWizard(configPath, {
		spawnSync: fakeSpawnSync({ language: "Indonesian", modelDefault: "m1", fallbackChain: ["m2"] }) as unknown as typeof realSpawnSync,
		runnerPath,
		input: scriptedInput(["y", "-", "", ""]),
		output,
	});
	const after = await readFile(configPath, "utf8");
	assert.equal(after, "readyset:\n  model:\n    default: m1\n    fallbackChains:\n      - m2\n");
});

await test("runConfigureWizard: clearing every field removes the readyset: block entirely", async () => {
	const initial = "modelRoles:\n  default: x\nreadyset:\n  language: Indonesian\n";
	const configPath = await freshConfigPath(initial);
	const output = collectingOutput();
	await runConfigureWizard(configPath, {
		spawnSync: fakeSpawnSync({ language: "Indonesian" }) as unknown as typeof realSpawnSync,
		runnerPath,
		input: scriptedInput(["y", "-", "", ""]),
		output,
	});
	const after = await readFile(configPath, "utf8");
	assert.equal(after, "modelRoles:\n  default: x\n");
	assert.match(output.text(), /Cleared the readyset: section/);
});

await test("runConfigureWizard: unreadable current config (fake spawnSync failure) still lets the wizard proceed", async () => {
	const configPath = await freshConfigPath();
	const output = collectingOutput();
	const failingSpawnSync = (() => ({ error: new Error("boom"), status: null, stdout: "" })) as unknown as typeof realSpawnSync;
	await runConfigureWizard(configPath, {
		spawnSync: failingSpawnSync,
		runnerPath,
		input: scriptedInput(["y", "Indonesian", "", ""]),
		output,
	});
	assert.match(output.text(), /couldn't read current config\.yml values/);
	const written = await readFile(configPath, "utf8");
	assert.equal(written, "readyset:\n  language: Indonesian\n");
});

await test("runConfigureWizard: real configure-runner.mts subprocess reads an existing block correctly", async () => {
	const initial = "readyset:\n  language: Indonesian\n  model:\n    default: m1\n    fallbackChains:\n      - m2\n      - m3\n";
	const configPath = await freshConfigPath(initial);
	const output = collectingOutput();
	await runConfigureWizard(configPath, {
		spawnSync: realSpawnSync,
		runnerPath,
		input: scriptedInput(["y", "", "", ""]),
		output,
	});
	assert.match(output.text(), /Current: language=Indonesian, model\.default=m1, fallbackChains=\[m2, m3\]/);
	assert.match(output.text(), /No changes/);
	const after = await readFile(configPath, "utf8");
	assert.equal(after, initial, "the real subprocess round-trip must not alter the file when nothing changed");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
