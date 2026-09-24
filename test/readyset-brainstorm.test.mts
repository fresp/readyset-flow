import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BRAINSTORM_DIR,
	READYSET_DIR,
	loadBrainstorms,
	reconcileStatuses,
	validateBrainstormContent,
	readClaritySignal,
	deriveClarity,
	recommendLane,
	parseFrontmatter,
	setFrontmatterFields,
} from "../src/lib/readyset-brainstorm.ts";

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

function withFrontmatter(body: string): string {
	return `---\ntitle: Something\nslug: something\nstatus: open\n---\n${body}`;
}

const FULLY_RESOLVED = `## Decision
- Chosen option: Option A
- Rationale: simplest fit

## Seam

The auth service boundary.

## Scope
- In scope: login flow
- Out of scope: signup flow

## Acceptance Criteria
- WHEN the user logs in THEN a session token is issued
`;

await test("a fully resolved brainstorm passes with no issues", () => {
	const result = validateBrainstormContent(withFrontmatter(FULLY_RESOLVED));
	assert.equal(result.ok, true);
	assert.deepEqual(result.issues, []);
});

await test("completely empty body -> flags all four sections missing", () => {
	const result = validateBrainstormContent(withFrontmatter(""));
	assert.equal(result.ok, false);
	const sections = result.issues.map((i) => i.section).sort();
	assert.deepEqual(sections, ["Acceptance Criteria", "Decision", "Scope", "Seam"]);
});

await test("Decision present but no 'Chosen option:' line -> flagged", () => {
	const body = FULLY_RESOLVED.replace("- Chosen option: Option A\n- Rationale: simplest fit", "Still thinking about it.");
	const result = validateBrainstormContent(withFrontmatter(body));
	assert.ok(result.issues.some((i) => i.section === "Decision" && /chosen option/i.test(i.problem)));
});

await test("Seam left as the literal unfilled '<...>' template placeholder -> flagged", () => {
	const body = FULLY_RESOLVED.replace(
		"The auth service boundary.",
		"<the module/boundary where this change will be built and tested -- ideally just one>",
	);
	const result = validateBrainstormContent(withFrontmatter(body));
	assert.ok(result.issues.some((i) => i.section === "Seam"));
});

await test("Scope left as the literal unfilled 'In scope: ... / Out of scope: ...' template -> flagged", () => {
	const body = FULLY_RESOLVED.replace("- In scope: login flow\n- Out of scope: signup flow", "- In scope: ...\n- Out of scope: ...");
	const result = validateBrainstormContent(withFrontmatter(body));
	assert.ok(result.issues.some((i) => i.section === "Scope"));
});

await test("a real Scope that merely mentions '...' elsewhere is NOT flagged (only the exact unfilled template is)", () => {
	const body = FULLY_RESOLVED.replace(
		"- In scope: login flow\n- Out of scope: signup flow",
		"- In scope: login flow, including the retry path...\n- Out of scope: signup flow entirely",
	);
	const result = validateBrainstormContent(withFrontmatter(body));
	assert.ok(!result.issues.some((i) => i.section === "Scope"));
});

await test("Acceptance Criteria present but not WHEN/THEN shaped -> flagged", () => {
	const body = FULLY_RESOLVED.replace("- WHEN the user logs in THEN a session token is issued", "- It should work correctly.");
	const result = validateBrainstormContent(withFrontmatter(body));
	assert.ok(result.issues.some((i) => i.section === "Acceptance Criteria"));
});

await test("summary text differs between ok and not-ok results", () => {
	const ok = validateBrainstormContent(withFrontmatter(FULLY_RESOLVED));
	const notOk = validateBrainstormContent(withFrontmatter(""));
	assert.notEqual(ok.summary, notOk.summary);
	assert.match(notOk.summary, /\d+ section\(s\) look unresolved/);
});

// --- reconcileStatuses vs lane -------------------------------------------------------
//
// Regression: reconcileStatuses used to skip every brainstorm whose lane wasn't "full", so a
// fast-lane change never had its brainstorm status bumped to "proposed". The review gate only
// opens for a proposed brainstorm, so every fast-lane run dead-ended with "Propose doesn't look
// finished" and no gate (readyset-bench label b1-subset-0.12: 5 fast-lane runs, 0 gates).

async function scratchRepo(): Promise<string> {
	const { mkdtemp } = await import("node:fs/promises");
	return mkdtemp(join(tmpdir(), "rs-bs-"));
}

function writeBrainstorm(cwd: string, id: string, lane: string): void {
	const dir = join(cwd, BRAINSTORM_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `2026-09-21-${id}.md`),
		`---\ntitle: T\nslug: ${id}\nstatus: open\nlane: ${lane}\nchange_id:\ncreated: 2026-09-21\n---\n\n## Problem / Context\n\nbody\n`,
		"utf8",
	);
}

function writeChangeDir(cwd: string, id: string): void {
	const dir = join(cwd, READYSET_DIR, "changes", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "proposal.md"), "## Why\n\nx\n\n## What Changes\n\n- y\n", "utf8");
}

await test("a fast-lane brainstorm with a real change dir IS reconciled to proposed", async () => {
	const cwd = await scratchRepo();
	writeBrainstorm(cwd, "fast-thing", "fast");
	writeChangeDir(cwd, "fast-thing");

	const items = await loadBrainstorms(cwd);
	assert.ok(items.some((b) => b.changeId === "fast-thing"), "brainstorm must be discoverable");
	await reconcileStatuses(cwd, items);

	const after = items.find((b) => b.changeId === "fast-thing");
	assert.equal(after?.status, "proposed", "fast lane must not be skipped");
	const rewritten = readFileSync(join(cwd, BRAINSTORM_DIR, "2026-09-21-fast-thing.md"), "utf8");
	assert.ok(rewritten.includes("status: proposed"), "frontmatter must be rewritten");
});

await test("a fast-lane brainstorm with NO change dir is still left untouched", async () => {
	const cwd = await scratchRepo();
	writeBrainstorm(cwd, "not-proposed-fast", "fast");

	const items = await loadBrainstorms(cwd);
	const updated = await reconcileStatuses(cwd, items);

	assert.equal(updated, 0, "a brainstorm with no change under readyset/changes must not be bumped");
	assert.equal(items.find((b) => b.changeId === "not-proposed-fast")?.status, "open");
});

await test("a full-lane brainstorm is still reconciled (unchanged behavior)", async () => {
	const cwd = await scratchRepo();
	writeBrainstorm(cwd, "full-thing", "full");
	writeChangeDir(cwd, "full-thing");

	const items = await loadBrainstorms(cwd);
	await reconcileStatuses(cwd, items);
	assert.equal(items.find((b) => b.changeId === "full-thing")?.status, "proposed");
});

// --- clarity signal + lane recommendation --------------------------------------------

await test("deriveClarity: 0 -> clear, 1-2 -> partial, 3+ -> ambiguous, undefined -> ambiguous", () => {
	assert.equal(deriveClarity(0), "clear");
	assert.equal(deriveClarity(1), "partial");
	assert.equal(deriveClarity(2), "partial");
	assert.equal(deriveClarity(3), "ambiguous");
	assert.equal(deriveClarity(undefined), "ambiguous");
});

await test("recommendLane: the clarity -> lane rule with risk-flag escalation", () => {
	assert.equal(recommendLane({ openDecisions: 0 }).lane, "fast");
	assert.equal(recommendLane({ openDecisions: 3 }).lane, "full");
	assert.equal(recommendLane({ openDecisions: 1 }).lane, "fast");
	const escalated = recommendLane({ openDecisions: 1, riskFlag: "cross-cutting" });
	assert.equal(escalated.lane, "full");
	assert.equal(escalated.escalatedBy, "cross-cutting");
	assert.equal(recommendLane({ clarity: "partial" }).lane, "fast");
	assert.equal(recommendLane({ clarity: "ambiguous" }).lane, "full");
	assert.equal(recommendLane({}).lane, "full", "unknown clarity reads as ambiguous -> full");
});

await test("recommendLane: openDecisions wins over the model's clarity field when both are present", () => {
	// model claimed clear but counted 3 open decisions -> the count is what code trusts.
	const rec = recommendLane({ clarity: "clear", openDecisions: 3 });
	assert.equal(rec.clarity, "ambiguous");
	assert.equal(rec.lane, "full");
});

await test("readClaritySignal: reads valid keys, rejects unknown/malformed values", () => {
	const good = readClaritySignal({ clarity: "partial", openDecisions: "1", riskFlag: "migration" });
	assert.deepEqual(good, { clarity: "partial", openDecisions: 1, riskFlag: "migration" });

	const bad = readClaritySignal({ clarity: "sorta", openDecisions: "abc", riskFlag: "nonsense" });
	assert.deepEqual(bad, { clarity: undefined, openDecisions: undefined, riskFlag: undefined });

	const negative = readClaritySignal({ openDecisions: "-1" });
	assert.equal(negative.openDecisions, undefined);

	assert.deepEqual(readClaritySignal({}), { clarity: undefined, openDecisions: undefined, riskFlag: undefined });
});

await test("setFrontmatterFields -> parseFrontmatter round-trips the new fields", () => {
	const raw = "---\ntitle: T\nstatus: open\n---\n\nbody\n";
	const next = setFrontmatterFields(raw, { clarity: "partial", openDecisions: "1" });
	const { meta } = parseFrontmatter(next);
	assert.equal(meta.clarity, "partial");
	assert.equal(meta.openDecisions, "1");
});

await test("loadBrainstorms: new clarity fields populate; a file without them leaves them undefined", async () => {
	const cwd = await scratchRepo();
	const dir = join(cwd, BRAINSTORM_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "2026-10-01-with-clarity.md"),
		"---\ntitle: T\nslug: with-clarity\nstatus: open\nlane: full\nchange_id:\ncreated: 2026-10-01\n" +
			"clarity: partial\nopenDecisions: 1\nquestionsAsked: 2\nlaneReason: \"narrow but risky\"\nriskFlag: migration\n---\n\nbody\n",
		"utf8",
	);
	writeFileSync(
		join(dir, "2026-10-02-old.md"),
		"---\ntitle: O\nslug: old\nstatus: open\nlane: full\nchange_id:\ncreated: 2026-10-02\n---\n\nbody\n",
		"utf8",
	);

	const items = await loadBrainstorms(cwd);
	const withClarity = items.find((b) => b.changeId === "with-clarity");
	assert.equal(withClarity?.clarity, "partial");
	assert.equal(withClarity?.openDecisions, 1);
	assert.equal(withClarity?.questionsAsked, 2);
	assert.equal(withClarity?.laneReason, "narrow but risky");
	assert.equal(withClarity?.riskFlag, "migration");
	// partial + migration risk flag escalates to full.
	assert.equal(withClarity?.recommendedLane, "full");

	const old = items.find((b) => b.changeId === "old");
	assert.equal(old?.clarity, undefined, "an old brainstorm has no clarity signal");
	assert.equal(old?.openDecisions, undefined);
	assert.equal(old?.recommendedLane, "full", "no signal -> ambiguous -> full");
});


await test("Decision that opens with 'Option X' (how grilled brainstorms phrase it) counts as resolved", () => {
	for (const decision of ["Option A — inline in `src/routes/products.mjs`.", "- Option B: a separate sort module", "**Option A** — inline comparator map", "- Add `sort` handling inline in `src/routes/products.mjs` (Option A)."]) {
		const body = FULLY_RESOLVED.replace("- Chosen option: Option A\n- Rationale: simplest fit", decision);
		const result = validateBrainstormContent(body);
		assert.ok(!result.issues.some((i) => i.section === "Decision"), `resolved: ${decision}`);
	}
	const placeholder = FULLY_RESOLVED.replace("- Chosen option: Option A", "- Chosen option: <Option A / Option B>");
	assert.ok(validateBrainstormContent(placeholder).issues.some((i) => i.section === "Decision"), "the unfilled template placeholder is still flagged");
	const torn = FULLY_RESOLVED.replace("- Chosen option: Option A\n- Rationale: simplest fit", "Option A vs Option B — still weighing both.");
	assert.ok(validateBrainstormContent(torn).issues.some((i) => i.section === "Decision"), "weighing two options is not a decision");
});

await test("grill prompt's brainstorm template carries the Chosen option line the validator looks for", async () => {
	const { grillTurnPrompt } = await import("../src/lib/readyset-prompts.ts");
	assert.match(grillTurnPrompt("idea", "2026-01-01", "ask"), /## Decision\n- Chosen option: <Option A \/ Option B>/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
