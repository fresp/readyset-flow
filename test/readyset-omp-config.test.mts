import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
	DEFAULT_COMPACT_MIN_CONTEXT_PERCENT,
	parseCompactMinContextPercent,
	parsePhaseBudgetMinutes,
	parseVerifyConfig,
	parseFallbackChain,
	parseFallbackModel,
	parseLanguageOverride,
	parseModelOverride,
	parseOmpDefaultModel,
	parsePhaseModels,
	parseYamlSubset,
	parseLaneDefault,
	parseArtifactBudgets,
	DEFAULT_ARTIFACT_BUDGETS,
	DEFAULT_REVIEW_MAX_FILES,
	DEFAULT_REVIEW_MAX_LINES,
	DEFAULT_REVIEW_SENSITIVE_PATHS,
	DEFAULT_SCOPE_PROTECTED_PATHS,
	DEFAULT_TEST_PATH_PATTERNS,
	parseReviewFullLane,
	parseReviewMode,
	parseReviewThresholds,
	parseScopeProtectedPaths,
	parseTestPaths,
	readArtifactBudgets,
	readCompactMinContextPercent,
	readFallbackChain,
	readFallbackModel,
	readLaneDefault,
	readPhaseModels,
	readPinnedModel,
	readPreferredLanguage,
	readReviewFullLane,
	readReviewMode,
	readReviewThresholds,
	readScopeProtectedPaths,
	readTestPaths,
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

await test("parseLanguageOverride: readyset.lang works as an alias for readyset.language", () => {
  const raw = 'readyset:\n  lang: "Indonesian"\n  model:\n    default: a\n';
  assert.equal(parseLanguageOverride(raw), "Indonesian");
});

await test("parseLanguageOverride: readyset.language wins over readyset.lang when both are set", () => {
  const raw = "readyset:\n  language: Indonesian\n  lang: English\n";
  assert.equal(parseLanguageOverride(raw), "Indonesian");
});

await test("readPreferredLanguage: reads readyset.lang from a real file, labels the source accordingly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, 'readyset:\n  lang: "Indonesian"\n', "utf8");
  assert.deepEqual(await readPreferredLanguage(configPath), {
    language: "Indonesian",
    source: "readyset.lang in ~/.omp/agent/config.yml",
  });
});

await test("readPreferredLanguage: matches the user's real config.yml shape (lang + nested model.fallbackChains)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(
    configPath,
    [
      "readyset:",
      '  lang: "Indonesian"',
      "  model:",
      "    default: eai1/cbai/deepseek-v4.1-flash",
      "    fallbackChains: ",
      "      - eai1/cbai/deepseek-v4.1-flash",
      "      - eai2/muse-spark-1.3-contributor",
    ].join("\n"),
    "utf8",
  );
  assert.deepEqual(await readPreferredLanguage(configPath), {
    language: "Indonesian",
    source: "readyset.lang in ~/.omp/agent/config.yml",
  });
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

await test("parsePhaseModels: reads readyset.model.phases keyed by phase", () => {
  const raw = "readyset:\n  model:\n    default: big/main\n    phases:\n      explore: small/fast\n      Grill: small/fast\n";
  assert.deepEqual(parsePhaseModels(raw), [
    { phase: "explore", model: "small/fast" },
    { phase: "grill", model: "small/fast" },
  ]);
});

await test("parsePhaseModels: no phases key -> empty array", () => {
  assert.deepEqual(parsePhaseModels("readyset:\n  model:\n    default: a\n"), []);
});

await test("parsePhaseModels: non-mapping phases value -> empty array", () => {
  assert.deepEqual(parsePhaseModels("readyset:\n  model:\n    phases: just-a-string\n"), []);
});

await test("readPhaseModels: reads a real file and tags the source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  model:\n    default: a\n    phases:\n      explore: b\n", "utf8");
  assert.deepEqual(await readPhaseModels(configPath), {
    entries: [{ phase: "explore", model: "b", source: "readyset.model.phases in ~/.omp/agent/config.yml" }],
  });
});

await test("readPhaseModels: missing file -> empty entries, never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  assert.deepEqual(await readPhaseModels(join(dir, "does-not-exist.yml")), { entries: [] });
});

// -- parsePhaseBudgetMinutes ---------------------------------------------------------------

await test("parsePhaseBudgetMinutes: absent -> default 20; fractions and 0 accepted; junk warns", () => {
  assert.deepEqual(parsePhaseBudgetMinutes("readyset:\n  language: Indonesian\n"), { minutes: 20, warning: undefined });
  assert.deepEqual(parsePhaseBudgetMinutes("readyset:\n  phaseBudget:\n    minutes: 7.5\n"), { minutes: 7.5, warning: undefined });
  assert.deepEqual(parsePhaseBudgetMinutes("readyset:\n  phaseBudget:\n    minutes: 0\n"), { minutes: 0, warning: undefined });
  const bad = parsePhaseBudgetMinutes("readyset:\n  phaseBudget:\n    minutes: -3\n");
  assert.equal(bad.minutes, 20);
  assert.match(bad.warning ?? "", /isn't a number >= 0/);
});

// -- parseCompactMinContextPercent ----------------------------------------------------------

await test("parseCompactMinContextPercent: absent key -> default, no warning, present=false", () => {
  assert.deepEqual(parseCompactMinContextPercent("readyset:\n  language: Indonesian\n"), {
    percent: DEFAULT_COMPACT_MIN_CONTEXT_PERCENT,
    warning: undefined,
    present: false,
  });
});

await test("parseCompactMinContextPercent: reads a valid numeric value", () => {
  assert.deepEqual(parseCompactMinContextPercent("readyset:\n  compact:\n    minContextPercent: 40\n"), {
    percent: 40,
    warning: undefined,
    present: true,
  });
});

await test("parseCompactMinContextPercent: accepts the 0 and 100 boundaries", () => {
  assert.equal(parseCompactMinContextPercent("readyset:\n  compact:\n    minContextPercent: 0\n").percent, 0);
  assert.equal(parseCompactMinContextPercent("readyset:\n  compact:\n    minContextPercent: 100\n").percent, 100);
});

await test("parseCompactMinContextPercent: accepts a quoted numeric string", () => {
  const parsed = parseCompactMinContextPercent('readyset:\n  compact:\n    minContextPercent: "40"\n');
  assert.equal(parsed.percent, 40);
  assert.equal(parsed.present, true);
  assert.equal(parsed.warning, undefined);
});

await test("parseCompactMinContextPercent: invalid values warn and fall back to the default", () => {
  for (const bad of ["abc", "-1", "101"]) {
    const parsed = parseCompactMinContextPercent(`readyset:\n  compact:\n    minContextPercent: ${bad}\n`);
    assert.equal(parsed.percent, DEFAULT_COMPACT_MIN_CONTEXT_PERCENT, `"${bad}" should fall back to the default`);
    assert.equal(parsed.present, true, `"${bad}" is present even though rejected`);
    assert.ok(parsed.warning && parsed.warning.length > 0, `"${bad}" should carry a warning`);
  }
});

await test("parseCompactMinContextPercent: an empty value reads as unset (no warning), never a crash", () => {
  // `minContextPercent:` with nothing after it is an empty mapping to the subset parser, not an
  // empty string -- so it reads as absent: the default, no warning. Documented so a later change
  // doesn't "fix" this into a warning the parser can't actually produce.
  assert.deepEqual(parseCompactMinContextPercent("readyset:\n  compact:\n    minContextPercent:\n"), {
    percent: DEFAULT_COMPACT_MIN_CONTEXT_PERCENT,
    warning: undefined,
    present: false,
  });
});

await test("readCompactMinContextPercent: missing file -> default, no warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  assert.deepEqual(await readCompactMinContextPercent(join(dir, "does-not-exist.yml")), {
    percent: DEFAULT_COMPACT_MIN_CONTEXT_PERCENT,
    warning: undefined,
  });
});

await test("readCompactMinContextPercent: reads a valid value from a real file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  compact:\n    minContextPercent: 60\n", "utf8");
  assert.deepEqual(await readCompactMinContextPercent(configPath), { percent: 60, warning: undefined });
});

await test("readCompactMinContextPercent: an invalid stored value yields the default plus a warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  compact:\n    minContextPercent: nope\n", "utf8");
  const parsed = await readCompactMinContextPercent(configPath);
  assert.equal(parsed.percent, DEFAULT_COMPACT_MIN_CONTEXT_PERCENT);
  assert.ok(parsed.warning && parsed.warning.length > 0);
});

await test("parseLaneDefault: absent key -> undefined", () => {
  assert.equal(parseLaneDefault("readyset:\n  language: Indonesian\n"), undefined);
});

await test("parseLaneDefault: each of ask|auto|fast|full (and uppercase) parses", () => {
  for (const value of ["ask", "auto", "fast", "full"]) {
    assert.equal(parseLaneDefault(`readyset:\n  lane:\n    default: ${value}\n`), value);
  }
  assert.equal(parseLaneDefault("readyset:\n  lane:\n    default: AUTO\n"), "auto");
});

await test("parseLaneDefault: an unknown value -> undefined (caller warns and falls back)", () => {
  assert.equal(parseLaneDefault("readyset:\n  lane:\n    default: sometimes\n"), undefined);
});

await test("readLaneDefault: missing file -> ask, no warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  assert.deepEqual(await readLaneDefault(join(dir, "does-not-exist.yml")), { laneDefault: "ask", warning: undefined });
});

await test("readLaneDefault: a valid value is read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  lane:\n    default: auto\n", "utf8");
  assert.deepEqual(await readLaneDefault(configPath), { laneDefault: "auto", warning: undefined });
});

await test("readLaneDefault: a present but invalid value -> ask plus a warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  lane:\n    default: sometimes\n", "utf8");
  const parsed = await readLaneDefault(configPath);
  assert.equal(parsed.laneDefault, "ask");
  assert.ok(parsed.warning && parsed.warning.length > 0);
});

await test("parseArtifactBudgets: absent key -> base unchanged", () => {
  assert.deepEqual(parseArtifactBudgets("readyset:\n  lane:\n    default: ask\n", DEFAULT_ARTIFACT_BUDGETS.full), DEFAULT_ARTIFACT_BUDGETS.full);
});

await test("parseArtifactBudgets: a valid override changes only that file", () => {
  const out = parseArtifactBudgets("readyset:\n  artifacts:\n    budget:\n      proposal: 1234\n", DEFAULT_ARTIFACT_BUDGETS.full);
  assert.equal(out.proposal, 1234);
  assert.equal(out.design, DEFAULT_ARTIFACT_BUDGETS.full.design);
  assert.equal(out.specs, DEFAULT_ARTIFACT_BUDGETS.full.specs);
  assert.equal(out.tasks, DEFAULT_ARTIFACT_BUDGETS.full.tasks);
});

await test("parseArtifactBudgets: non-numeric / 0 / negative / empty each keep the base value", () => {
  const base = DEFAULT_ARTIFACT_BUDGETS.full;
  for (const bad of ["abc", "0", "-5", ""]) {
    const raw = `readyset:\n  artifacts:\n    budget:\n      proposal: ${bad === "" ? '""' : bad}\n`;
    assert.equal(parseArtifactBudgets(raw, base).proposal, base.proposal, `value "${bad}" must keep the default`);
  }
});

await test("parseArtifactBudgets: specs overrides the total", () => {
  const out = parseArtifactBudgets("readyset:\n  artifacts:\n    budget:\n      specs: 999\n", DEFAULT_ARTIFACT_BUDGETS.fast);
  assert.equal(out.specs, 999);
});

await test("readArtifactBudgets: missing file -> both lanes' defaults; one block overrides both lanes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const missing = await readArtifactBudgets(join(dir, "does-not-exist.yml"));
  assert.deepEqual(missing.fast, DEFAULT_ARTIFACT_BUDGETS.fast);
  assert.deepEqual(missing.full, DEFAULT_ARTIFACT_BUDGETS.full);

  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  artifacts:\n    budget:\n      proposal: 2500\n", "utf8");
  const read = await readArtifactBudgets(configPath);
  assert.equal(read.fast.proposal, 2500, "the flat key overrides the fast lane too");
  assert.equal(read.full.proposal, 2500);
  assert.equal(read.fast.design, Infinity, "the fast lane's design budget stays Infinity");
});

await test("readReviewMode: absent key -> auto, no warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  lane:\n    default: ask\n", "utf8");
  const parsed = await readReviewMode(configPath);
  assert.equal(parsed.mode, "auto");
  assert.equal(parsed.warning, undefined);

  const missing = await readReviewMode(join(dir, "does-not-exist.yml"));
  assert.equal(missing.mode, "auto");
  assert.equal(missing.warning, undefined);
});

await test("readReviewMode: each valid mode is read, case-insensitively", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  for (const [raw, expected] of [["auto", "auto"], ["always", "always"], ["never", "never"], ["Always", "always"]] as const) {
    await writeFile(configPath, `readyset:\n  review:\n    mode: ${raw}\n`, "utf8");
    const parsed = await readReviewMode(configPath);
    assert.equal(parsed.mode, expected, `mode "${raw}"`);
    assert.equal(parsed.warning, undefined);
  }
});

await test("readReviewMode: a present but invalid value -> auto plus a warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  review:\n    mode: sometimes\n", "utf8");
  const parsed = await readReviewMode(configPath);
  assert.equal(parsed.mode, "auto");
  assert.match(parsed.warning ?? "", /isn't one of auto, always, never/);
});

await test("readReviewFullLane: absent -> always; each valid value; invalid -> always plus a warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");

  const missing = await readReviewFullLane(join(dir, "does-not-exist.yml"));
  assert.equal(missing.fullLane, "always");
  assert.equal(missing.warning, undefined);

  await writeFile(configPath, "readyset:\n  review:\n    mode: auto\n", "utf8");
  const absent = await readReviewFullLane(configPath);
  assert.equal(absent.fullLane, "always");
  assert.equal(absent.warning, undefined);

  for (const value of ["always", "auto"] as const) {
    await writeFile(configPath, `readyset:\n  review:\n    fullLane: ${value}\n`, "utf8");
    const parsed = await readReviewFullLane(configPath);
    assert.equal(parsed.fullLane, value);
    assert.equal(parsed.warning, undefined);
  }

  await writeFile(configPath, "readyset:\n  review:\n    fullLane: sometimes\n", "utf8");
  const invalid = await readReviewFullLane(configPath);
  assert.equal(invalid.fullLane, "always");
  assert.match(invalid.warning ?? "", /isn't one of always, auto/);
});

await test("readReviewThresholds: missing file and absent keys -> all defaults, no warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const missing = await readReviewThresholds(join(dir, "does-not-exist.yml"));
  assert.equal(missing.maxLines, DEFAULT_REVIEW_MAX_LINES);
  assert.equal(missing.maxFiles, DEFAULT_REVIEW_MAX_FILES);
  assert.deepEqual(missing.sensitivePaths, DEFAULT_REVIEW_SENSITIVE_PATHS);
  assert.equal(missing.warning, undefined);

  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  review:\n    mode: auto\n", "utf8");
  const absent = await readReviewThresholds(configPath);
  assert.equal(absent.maxLines, DEFAULT_REVIEW_MAX_LINES);
  assert.equal(absent.maxFiles, DEFAULT_REVIEW_MAX_FILES);
  assert.deepEqual(absent.sensitivePaths, DEFAULT_REVIEW_SENSITIVE_PATHS);
  assert.equal(absent.warning, undefined);
});

await test("readReviewThresholds: a valid override replaces each threshold", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(
    configPath,
    "readyset:\n  review:\n    maxLines: 40\n    maxFiles: 2\n    sensitivePaths:\n      - auth/**\n      - \"**/keys/**\"\n",
    "utf8",
  );
  const parsed = await readReviewThresholds(configPath);
  assert.equal(parsed.maxLines, 40);
  assert.equal(parsed.maxFiles, 2);
  assert.deepEqual(parsed.sensitivePaths, ["auth/**", "**/keys/**"]);
  assert.equal(parsed.warning, undefined);
});

await test("readReviewThresholds: a rejected maxLines warns and keeps the default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  for (const bad of ["abc", "0", "-5", "2.5", '""']) {
    await writeFile(configPath, `readyset:\n  review:\n    maxLines: ${bad}\n`, "utf8");
    const parsed = await readReviewThresholds(configPath);
    assert.equal(parsed.maxLines, DEFAULT_REVIEW_MAX_LINES, `value "${bad}" must keep the default`);
    assert.match(parsed.warning ?? "", /maxLines .* isn't a positive integer/, `value "${bad}" must warn`);
  }
});

await test("readReviewThresholds: a present but non-array sensitivePaths warns and uses the defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  await writeFile(configPath, "readyset:\n  review:\n    sensitivePaths: auth/**\n", "utf8");
  const parsed = await readReviewThresholds(configPath);
  assert.deepEqual(parsed.sensitivePaths, DEFAULT_REVIEW_SENSITIVE_PATHS);
  assert.match(parsed.warning ?? "", /isn't a list/);
});

await test("parseScopeProtectedPaths/readScopeProtectedPaths: defaults, overrides, and non-list warning", async () => {
  assert.deepEqual(parseScopeProtectedPaths("readyset:\n  scope: {}\n").paths, DEFAULT_SCOPE_PROTECTED_PATHS);
  const parsed = parseScopeProtectedPaths(
    "readyset:\n  scope:\n    protectedPaths:\n      - db/seeds/**\n      - src/fixtures/**\n",
  );
  assert.deepEqual(parsed.paths, ["db/seeds/**", "src/fixtures/**"]);
  assert.equal(parsed.warning, undefined);

  const invalid = parseScopeProtectedPaths("readyset:\n  scope:\n    protectedPaths: db/seeds/**\n");
  assert.deepEqual(invalid.paths, DEFAULT_SCOPE_PROTECTED_PATHS);
  assert.match(invalid.warning ?? "", /isn't a list/);

  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  assert.deepEqual((await readScopeProtectedPaths(join(dir, "missing.yml"))).paths, DEFAULT_SCOPE_PROTECTED_PATHS);
  await writeFile(configPath, "readyset:\n  scope:\n    protectedPaths:\n      - fixtures/**\n", "utf8");
  assert.deepEqual((await readScopeProtectedPaths(configPath)).paths, ["fixtures/**"]);
});

await test("parseTestPaths/readTestPaths: defaults, overrides, and non-list warning", async () => {
  assert.deepEqual(parseTestPaths("readyset:\n  review:\n    mode: auto\n").paths, DEFAULT_TEST_PATH_PATTERNS);
  const parsed = parseTestPaths("readyset:\n  review:\n    testPaths:\n      - src/test/**\n");
  assert.deepEqual(parsed.paths, ["src/test/**"]);
  assert.equal(parsed.warning, undefined);

  const invalid = parseTestPaths("readyset:\n  review:\n    testPaths: src/test/**\n");
  assert.deepEqual(invalid.paths, DEFAULT_TEST_PATH_PATTERNS);
  assert.match(invalid.warning ?? "", /isn't a list/);

  const dir = await mkdtemp(join(tmpdir(), "omp-cfg-"));
  const configPath = join(dir, "config.yml");
  assert.deepEqual((await readTestPaths(join(dir, "missing.yml"))).paths, DEFAULT_TEST_PATH_PATTERNS);
  await writeFile(configPath, "readyset:\n  review:\n    testPaths:\n      - unit/**\n", "utf8");
  assert.deepEqual((await readTestPaths(configPath)).paths, ["unit/**"]);
});

await test("parseVerifyConfig: command, none/off disables, requireNotes defaults to false", () => {
  assert.deepEqual(parseVerifyConfig("readyset:\n  language: x\n"), { command: undefined, disabled: false, requireNotes: false, warning: undefined });
  assert.deepEqual(parseVerifyConfig("readyset:\n  verify:\n    command: pnpm test --silent\n"), { command: "pnpm test --silent", disabled: false, requireNotes: false, warning: undefined });
  assert.equal(parseVerifyConfig("readyset:\n  verify:\n    command: none\n").disabled, true);
  assert.equal(parseVerifyConfig("readyset:\n  verify:\n    requireNotes: true\n").requireNotes, true);
  const bad = parseVerifyConfig("readyset:\n  verify:\n    requireNotes: sometimes\n");
  assert.equal(bad.requireNotes, false);
  assert.match(bad.warning ?? "", /isn't true or false/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);