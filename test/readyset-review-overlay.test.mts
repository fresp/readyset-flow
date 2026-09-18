import assert from "node:assert/strict";
import { renderSidebarLayout, type OverlaySection } from "../src/lib/readyset-review-overlay.ts";

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

const identity = (s: string) => s;

function sections(): OverlaySection[] {
	return [
		{ id: "a", heading: "Exploration", status: "done", bodyLines: ["line one", "line two"] },
		{ id: "b", heading: "Proposal", status: "proposal.md", bodyLines: Array.from({ length: 30 }, (_, i) => `proposal line ${i}`) },
		{ id: "c", heading: "Tasks", status: "2/3 ticked", bodyLines: ["- [x] task 1", "- [ ] task 2"] },
	];
}

await test("renders a title line and one row per section header, plus a footer hint", () => {
	const lines = renderSidebarLayout("Review — my-change", sections(), 0, 0, 100, 20, identity, identity, identity);
	assert.match(lines[0], /Review — my-change/);
	assert.ok(lines.some(l => l.includes("Exploration") && l.includes("done")));
	assert.ok(lines.some(l => l.includes("Proposal") && l.includes("proposal.md")));
	assert.ok(lines.some(l => l.includes("Tasks") && l.includes("2/3 ticked")));
	assert.ok(lines.at(-1)?.includes("Esc back to review"));
});

await test("selected section's body appears in the body column, unselected sections' bodies do not", () => {
	const lines = renderSidebarLayout("Title", sections(), 1, 0, 100, 20, identity, identity, identity);
	const joined = lines.join("\n");
	assert.match(joined, /proposal line 0/);
	assert.ok(!joined.includes("line one"), "Exploration's body should not leak in when Proposal is selected");
	assert.ok(!joined.includes("- [x] task 1"), "Tasks' body should not leak in when Proposal is selected");
});

await test("scrollOffset shifts which body lines are visible", () => {
	const atTop = renderSidebarLayout("Title", sections(), 1, 0, 100, 20, identity, identity, identity).join("\n");
	const scrolled = renderSidebarLayout("Title", sections(), 1, 10, 100, 20, identity, identity, identity).join("\n");
	assert.match(atTop, /proposal line 0\b/);
	assert.ok(!scrolled.includes("proposal line 0 "), "scrolled view should no longer show the first line at the top");
	assert.match(scrolled, /proposal line 10\b/);
});

await test("overflow hint only appears when the section's body is taller than the visible body rows", () => {
	const shortSection: OverlaySection[] = [{ id: "a", heading: "Short", status: "ok", bodyLines: ["one line"] }];
	const noOverflow = renderSidebarLayout("Title", shortSection, 0, 0, 100, 20, identity, identity, identity).join("\n");
	assert.ok(!noOverflow.includes("PgUp/PgDn"));

	const withOverflow = renderSidebarLayout("Title", sections(), 1, 0, 100, 20, identity, identity, identity).join("\n");
	assert.match(withOverflow, /PgUp\/PgDn to scroll/);
});

await test("every line fits within the requested width (no ragged/overflowing rows)", () => {
	const width = 60;
	const lines = renderSidebarLayout("A reasonably long review title that could overflow", sections(), 0, 0, width, 20, identity, identity, identity);
	for (const line of lines) {
		assert.ok(line.length <= width + 2, `line too wide: "${line}" (${line.length} chars, width ${width})`);
	}
});

await test("empty sections list does not throw and still renders a footer", () => {
	const lines = renderSidebarLayout("Empty", [], 0, 0, 80, 20, identity, identity, identity);
	assert.ok(lines.length > 0);
	assert.ok(lines.at(-1)?.includes("Esc back to review"));
});

await test("sidebar drops a status that just repeats a count already baked into the heading", () => {
	const withCounts: OverlaySection[] = [
		{ id: "specs", heading: "Specs (1)", status: "1 file(s)", bodyLines: [] },
		{ id: "tasks", heading: "Tasks (0/30)", status: "0/30 ticked", bodyLines: [] },
	];
	const joined = renderSidebarLayout("Title", withCounts, 0, 0, 100, 20, identity, identity, identity).join("\n");
	assert.match(joined, /Specs \(1\)/);
	assert.ok(!joined.includes("(1) (1 file(s))"), "should not double-show the same count");
	assert.match(joined, /Tasks \(0\/30\)/);
	assert.ok(!joined.includes("(0/30) (0/30 ticked)"), "should not double-show the same count");
});

await test("sidebar keeps a status that adds real information (not just a repeated count)", () => {
	const lines = renderSidebarLayout("Title", sections(), 0, 0, 100, 20, identity, identity, identity);
	const joined = lines.join("\n");
	assert.match(joined, /Exploration \(done\)/);
	assert.match(joined, /Proposal \(proposal\.md\)/);
});

await test("long titles and footer hints are ellipsized, not chopped off with no indicator", () => {
	const longTitle = "Readyset review — Complete Embedded Signup Onboarding (System User, Phone Registration, WABA Sync, and a very long tail of extra detail that will not fit)";
	const lines = renderSidebarLayout(longTitle, sections(), 1, 0, 60, 20, identity, identity, identity);
	assert.match(lines[0], /…$/, "truncated title should end with an ellipsis marker, not a hard cut");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
