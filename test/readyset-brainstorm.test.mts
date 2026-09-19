import assert from "node:assert/strict";
import { validateBrainstormContent } from "../src/lib/readyset-brainstorm.ts";

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
	assert.ok(result.issues.some((i) => i.section === "Decision" && /Chosen option/.test(i.problem)));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
