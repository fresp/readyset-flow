import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
	parseFallbackChain,
	parseFallbackModel,
	parseLanguageOverride,
	parseModelOverride,
	parseOmpDefaultModel,
	parseYamlSubset,
	readFallbackChain,
	readFallbackModel,
	readPinnedModel,
	readPreferredLanguage,
} from "../src/lib/readyset-omp-config.ts";

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

await test("parseOmpDefaultModel: the exact shape from omp's own README example", () => {
  const raw = "modelRoles:\n  default: spark/minimax-m3\n";
  assert.equal(parseOmpDefaultModel(raw), "spark/minimax-m3");
});

await test("parseOmpDefaultModel: ignores unrelated top-level and sibling keys", () => {
  const raw = ["approvalMode: manual", "modelRoles:", "  fast: openai/gpt-5-mini", "  default: anthropic/claude-opus-5", "otherThing: yes"].join(
    "\n",
  );
  assert.equal(parseOmpDefaultModel(raw), "anthropic/claude-opus-5");
});

await test("parseOmpDefaultModel: no modelRoles section -> undefined", () => {
  assert.equal(parseOmpDefaultModel("approvalMode: manual\n"), undefined);
});

await test("parseOmpDefaultModel: modelRoles present but no default sub-key -> undefined", () => {
  assert.equal(parseOmpDefaultModel("modelRoles:\n  fast: openai/gpt-5-mini\n"), undefined);
});

await test("parseOmpDefaultModel: strips comments and matching quotes", () => {
  const raw = ["modelRoles: # role config", "  default: \"anthropic/claude-opus-5\" # pinned"].join("\n");
  assert.equal(parseOmpDefaultModel(raw), "anthropic/claude-opus-5");
});

await test("parseOmpDefaultModel: a later top-level key ends the modelRoles block", () => {
  const raw = ["modelRoles:", "  fast: openai/gpt-5-mini", "approvalMode: manual", "  default: should-not-count"].join("\n");
  assert.equal(parseOmpDefaultModel(raw), undefined);
});

await test("parseModelOverride: reads readyset.model, same one-level-nested shape as modelRoles", () => {
  const raw = "readyset:\n  model: anthropic/claude-opus-5\n";
  assert.equal(parseModelOverride(raw), "anthropic/claude-opus-5");
});

await test("parseModelOverride: no readyset section -> undefined", () => {
  assert.equal(parseModelOverride("modelRoles:\n  default: spark/minimax-m3\n"), undefined);
});

await test("readPinnedModel: reads a real file at an overridden path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "modelRoles:\n  default: spark/minimax-m3\n", "utf8");
  assert.deepEqual(await readPinnedModel(configPath), {
    model: "spark/minimax-m3",
    source: "modelRoles.default in ~/.omp/agent/config.yml",
  });
});

await test("readPinnedModel: readyset.model wins over modelRoles.default when both are set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(
    configPath,
    ["modelRoles:", "  default: spark/minimax-m3", "readyset:", "  model: anthropic/claude-opus-5"].join("\n"),
    "utf8",
  );
  assert.deepEqual(await readPinnedModel(configPath), {
    model: "anthropic/claude-opus-5",
    source: "readyset.model in ~/.omp/agent/config.yml",
  });
});

await test("readPinnedModel: missing file -> {model: undefined, source: undefined}, never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  assert.deepEqual(await readPinnedModel(join(dir, "does-not-exist.yml")), { model: undefined, source: undefined });
});

await test("readPinnedModel: neither section set -> {model: undefined, source: undefined}", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "approvalMode: manual\n", "utf8");
  assert.deepEqual(await readPinnedModel(configPath), { model: undefined, source: undefined });
});

await test("parseFallbackModel: reads readyset.fallbackModel, sibling to readyset.model", () => {
  const raw = "readyset:\n  model: anthropic/claude-opus-5\n  fallbackModel: anthropic/claude-sonnet-5\n";
  assert.equal(parseFallbackModel(raw), "anthropic/claude-sonnet-5");
});

await test("parseFallbackModel: not set -> undefined", () => {
  assert.equal(parseFallbackModel("readyset:\n  model: anthropic/claude-opus-5\n"), undefined);
});

await test("readFallbackModel: reads a real file at an overridden path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  fallbackModel: anthropic/claude-sonnet-5\n", "utf8");
  assert.deepEqual(await readFallbackModel(configPath), {
    model: "anthropic/claude-sonnet-5",
    source: "readyset.fallbackModel in ~/.omp/agent/config.yml",
  });
});

await test("readFallbackModel: missing file or key -> {model: undefined, source: undefined}", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  assert.deepEqual(await readFallbackModel(join(dir, "does-not-exist.yml")), { model: undefined, source: undefined });
});

await test("parseLanguageOverride: reads readyset.language, sibling to readyset.model", () => {
  const raw = "readyset:\n  model: anthropic/claude-opus-5\n  language: Indonesian\n";
  assert.equal(parseLanguageOverride(raw), "Indonesian");
});

await test("parseLanguageOverride: not set -> undefined", () => {
  assert.equal(parseLanguageOverride("readyset:\n  model: anthropic/claude-opus-5\n"), undefined);
});

await test("readPreferredLanguage: reads a real file at an overridden path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  language: Indonesian\n", "utf8");
  assert.deepEqual(await readPreferredLanguage(configPath), {
    language: "Indonesian",
    source: "readyset.language in ~/.omp/agent/config.yml",
  });
});

await test("readPreferredLanguage: missing file or key -> {language: undefined, source: undefined}", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  assert.deepEqual(await readPreferredLanguage(join(dir, "does-not-exist.yml")), { language: undefined, source: undefined });
});

await test("parseYamlSubset: nested mapping under a mapping (readyset.model.default)", () => {
  const raw = "readyset:\n  model:\n    default: anthropic/claude-opus-5\n";
  const doc = parseYamlSubset(raw) as any;
  assert.equal(doc.readyset.model.default, "anthropic/claude-opus-5");
});

await test("parseYamlSubset: a list under a nested key (fallbackChains)", () => {
  const raw = "readyset:\n  model:\n    default: a\n    fallbackChains:\n      - b\n      - c\n";
  const doc = parseYamlSubset(raw) as any;
  assert.deepEqual(doc.readyset.model.fallbackChains, ["b", "c"]);
});

await test("parseYamlSubset: strips comments and quotes on both mapping and list lines", () => {
  const raw = ["readyset:", "  model:", '    default: "a/b" # pinned', "    fallbackChains:", "      - 'c/d' # first try", "      - e/f"].join("\n");
  const doc = parseYamlSubset(raw) as any;
  assert.equal(doc.readyset.model.default, "a/b");
  assert.deepEqual(doc.readyset.model.fallbackChains, ["c/d", "e/f"]);
});

await test("parseYamlSubset: blank lines and comment-only lines are ignored", () => {
  const raw = ["# top comment", "readyset:", "", "  # nested comment", "  model: a/b", ""].join("\n");
  const doc = parseYamlSubset(raw) as any;
  assert.equal(doc.readyset.model, "a/b");
});

await test("parseModelOverride: nested readyset.model.default (current shape)", () => {
  const raw = "readyset:\n  model:\n    default: anthropic/claude-opus-5\n    fallbackChains:\n      - anthropic/claude-sonnet-5\n";
  assert.equal(parseModelOverride(raw), "anthropic/claude-opus-5");
});

await test("parseModelOverride: bare readyset.model (legacy shape) still works", () => {
  const raw = "readyset:\n  model: anthropic/claude-opus-5\n";
  assert.equal(parseModelOverride(raw), "anthropic/claude-opus-5");
});

await test("parseFallbackChain: reads readyset.model.fallbackChains as an ordered list", () => {
  const raw = "readyset:\n  model:\n    default: a\n    fallbackChains:\n      - b\n      - c\n      - d\n";
  assert.deepEqual(parseFallbackChain(raw), ["b", "c", "d"]);
});

await test("parseFallbackChain: falls back to legacy readyset.fallbackModel as a one-element chain", () => {
  const raw = "readyset:\n  model: a\n  fallbackModel: b\n";
  assert.deepEqual(parseFallbackChain(raw), ["b"]);
});

await test("parseFallbackChain: fallbackChains wins over legacy fallbackModel when both are set", () => {
  const raw = "readyset:\n  model:\n    default: a\n    fallbackChains:\n      - b\n      - c\n  fallbackModel: z\n";
  assert.deepEqual(parseFallbackChain(raw), ["b", "c"]);
});

await test("parseFallbackChain: neither set -> empty array", () => {
  assert.deepEqual(parseFallbackChain("readyset:\n  model: a\n"), []);
});

await test("readFallbackChain: reads a real file with a multi-entry chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(
    configPath,
    "readyset:\n  model:\n    default: eai1/cbai/deepseek-v4.1-flash\n    fallbackChains:\n      - eai1/cbai/deepseek-v4.1-flash\n      - eai2/muse-spark-1.3-contributor\n",
    "utf8",
  );
  assert.deepEqual(await readFallbackChain(configPath), {
    chain: ["eai1/cbai/deepseek-v4.1-flash", "eai2/muse-spark-1.3-contributor"],
    source: "readyset.model.fallbackChains in ~/.omp/agent/config.yml",
  });
});

await test("readFallbackChain: missing file or key -> {chain: [], source: undefined}", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  assert.deepEqual(await readFallbackChain(join(dir, "does-not-exist.yml")), { chain: [], source: undefined });
});

await test("readFallbackModel (deprecated): still returns the chain's first entry for backward compat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  model:\n    default: a\n    fallbackChains:\n      - b\n      - c\n", "utf8");
  assert.deepEqual(await readFallbackModel(configPath), {
    model: "b",
    source: "readyset.model.fallbackChains in ~/.omp/agent/config.yml",
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
