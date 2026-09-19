import assert from "node:assert/strict";
import { renderSidebarLayout, ReviewSidebarOverlay, type OverlaySection } from "../src/lib/readyset-review-overlay.ts";

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
	const lines = renderSidebarLayout("Review — my-change", sections(), 0, 0, 100, 20, "3/5 tasks ticked", "sections", 0, identity, identity, identity);
	assert.match(lines[0], /Review — my-change/);
	assert.ok(lines.some(l => l.includes("Exploration") && l.includes("done")));
	assert.ok(lines.some(l => l.includes("Proposal") && l.includes("proposal.md")));
	assert.ok(lines.some(l => l.includes("Tasks") && l.includes("2/3 ticked")));
	assert.ok(lines.at(-1)?.includes("Esc cancel"));
});

await test("selected section's body appears in the body column, unselected sections' bodies do not", () => {
	const lines = renderSidebarLayout("Title", sections(), 1, 0, 100, 20, "3/5 tasks ticked", "sections", 0, identity, identity, identity);
	const joined = lines.join("\n");
	assert.match(joined, /proposal line 0/);
	assert.ok(!joined.includes("line one"), "Exploration's body should not leak in when Proposal is selected");
	assert.ok(!joined.includes("- [x] task 1"), "Tasks' body should not leak in when Proposal is selected");
});

await test("scrollOffset shifts which body lines are visible", () => {
	const atTop = renderSidebarLayout("Title", sections(), 1, 0, 100, 20, "3/5 tasks ticked", "sections", 0, identity, identity, identity).join("\n");
	const scrolled = renderSidebarLayout("Title", sections(), 1, 10, 100, 20, "3/5 tasks ticked", "sections", 0, identity, identity, identity).join("\n");
	assert.match(atTop, /proposal line 0\b/);
	assert.ok(!scrolled.includes("proposal line 0 "), "scrolled view should no longer show the first line at the top");
	assert.match(scrolled, /proposal line 10\b/);
});

await test("overflow hint only appears when the section's body is taller than the visible body rows", () => {
	const shortSection: OverlaySection[] = [{ id: "a", heading: "Short", status: "ok", bodyLines: ["one line"] }];
	const noOverflow = renderSidebarLayout("Title", shortSection, 0, 0, 100, 20, "3/5 tasks ticked", "sections", 0, identity, identity, identity).join("\n");
	assert.ok(!noOverflow.includes("PgUp/PgDn"));

	const withOverflow = renderSidebarLayout("Title", sections(), 1, 0, 100, 20, "3/5 tasks ticked", "sections", 0, identity, identity, identity).join("\n");
	assert.match(withOverflow, /PgUp\/PgDn/);
});

await test("every line fits within the requested width (no ragged/overflowing rows)", () => {
	const width = 60;
	const lines = renderSidebarLayout("A reasonably long review title that could overflow", sections(), 0, 0, width, 20, "3/5 tasks ticked", "sections", 0, identity, identity, identity);
	for (const line of lines) {
		assert.ok(line.length <= width + 2, `line too wide: "${line}" (${line.length} chars, width ${width})`);
	}
});

await test("empty sections list does not throw and still renders a footer", () => {
	const lines = renderSidebarLayout("Empty", [], 0, 0, 80, 20, "3/5 tasks ticked", "sections", 0, identity, identity, identity);
	assert.ok(lines.length > 0);
	assert.ok(lines.at(-1)?.includes("Esc cancel"));
});

await test("sidebar drops a status that just repeats a count already baked into the heading", () => {
	const withCounts: OverlaySection[] = [
		{ id: "specs", heading: "Specs (1)", status: "1 file(s)", bodyLines: [] },
		{ id: "tasks", heading: "Tasks (0/30)", status: "0/30 ticked", bodyLines: [] },
	];
	const joined = renderSidebarLayout("Title", withCounts, 0, 0, 100, 20, "3/5 tasks ticked", "sections", 0, identity, identity, identity).join("\n");
	assert.match(joined, /Specs \(1\)/);
	assert.ok(!joined.includes("(1) (1 file(s))"), "should not double-show the same count");
	assert.match(joined, /Tasks \(0\/30\)/);
	assert.ok(!joined.includes("(0/30) (0/30 ticked)"), "should not double-show the same count");
});

await test("sidebar keeps a status that adds real information (not just a repeated count)", () => {
	const lines = renderSidebarLayout("Title", sections(), 0, 0, 100, 20, "3/5 tasks ticked", "sections", 0, identity, identity, identity);
	const joined = lines.join("\n");
	assert.match(joined, /Exploration \(done\)/);
	assert.match(joined, /Proposal \(proposal\.md\)/);
});

await test("long titles and footer hints are ellipsized, not chopped off with no indicator", () => {
	const longTitle = "Readyset review — Complete Embedded Signup Onboarding (System User, Phone Registration, WABA Sync, and a very long tail of extra detail that will not fit)";
	const lines = renderSidebarLayout(longTitle, sections(), 1, 0, 60, 20, "3/5 tasks ticked", "sections", 0, identity, identity, identity);
	assert.match(lines[0], /…$/, "truncated title should end with an ellipsis marker, not a hard cut");
});

const fakeTheme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as any;

/** A worst-case stub: `matches` says yes to EVERY logical action name, for every byte sequence —
 *  the scenario a real terminal run (2026-09-18) showed actually happens for PageUp/PageDown
 *  against "tui.select.up"/"down". If PageUp/PageDown still only scroll the body and never touch
 *  `selectedIndex`, the fix (checking them first, unconditionally, before any `keybindings.matches`
 *  call) holds regardless of how broadly a real KeybindingsManager binds those logical actions. */
const matchesEverything = { matches: () => true } as any;

await test("PageUp/PageDown always scroll the body, even when keybindings.matches also says yes to tui.select.up/down for them", () => {
	const overlay = new ReviewSidebarOverlay(fakeTheme, matchesEverything, "Title", sections(), "3/5 tasks ticked", () => {});
	// Only the sidebar half of each row (left of the " │ " divider) — the body half is expected
	// to change when scrolling, so comparing whole lines would conflate "selection moved" with
	// "body content changed at the same row".
	const sidebarHalf = (lines: string[]) => lines.map((l) => l.split(" │ ")[0]).filter((s) => s.includes("›"));

	const before = overlay.render(100);
	const beforeSidebar = sidebarHalf(before);
	overlay.handleInput("\x1b[6~"); // PageDown
	const afterPageDown = overlay.render(100);
	assert.deepEqual(beforeSidebar, sidebarHalf(afterPageDown), "PageDown must not move the sidebar selection");
	assert.notDeepEqual(before, afterPageDown, "PageDown must actually scroll the body");

	overlay.handleInput("\x1b[5~"); // PageUp
	assert.deepEqual(beforeSidebar, sidebarHalf(overlay.render(100)), "PageUp must not move the sidebar selection");
});

await test("cancel (Esc) still works even though PageUp/PageDown are checked first", () => {
	let cancelled = false;
	const cancelOnly = { matches: (_data: string, name: string) => name === "tui.select.cancel" } as any;
	const overlay = new ReviewSidebarOverlay(fakeTheme, cancelOnly, "Title", sections(), "3/5 tasks ticked", () => {
		cancelled = true;
	});
	overlay.handleInput("\x1b");
	assert.ok(cancelled, "Esc should still close the overlay");
});

await test("renders a CTA bar with Approve/Refine/Discard and the task summary, above the nav hint", () => {
	const lines = renderSidebarLayout("Title", sections(), 0, 0, 100, 20, "7/9 tasks ticked", "sections", 0, identity, identity, identity);
	const ctaLine = lines.at(-2);
	assert.ok(ctaLine?.includes("Approve & Execute"), "CTA bar should show Approve & Execute");
	assert.ok(ctaLine?.includes("7/9 tasks ticked"), "CTA bar should include the live task summary");
	assert.ok(ctaLine?.includes("Refine"), "CTA bar should show Refine");
	assert.ok(ctaLine?.includes("Discard"), "CTA bar should show Discard");
	assert.ok(lines.at(-1)?.includes("Esc cancel"), "nav hint stays on its own line below the CTA bar");
});

await test("A/R/D keystrokes act as the sidebar's own CTAs -- approve/refine/discard -- without going through a select() menu", () => {
	const noKeybindings = { matches: () => false } as any;

	let resultA: unknown;
	new ReviewSidebarOverlay(fakeTheme, noKeybindings, "Title", sections(), "0/1 tasks ticked", (r) => (resultA = r)).handleInput("a");
	assert.equal(resultA, "approve");

	let resultR: unknown;
	new ReviewSidebarOverlay(fakeTheme, noKeybindings, "Title", sections(), "0/1 tasks ticked", (r) => (resultR = r)).handleInput("R");
	assert.equal(resultR, "refine");

	let resultD: unknown;
	new ReviewSidebarOverlay(fakeTheme, noKeybindings, "Title", sections(), "0/1 tasks ticked", (r) => (resultD = r)).handleInput("D");
	assert.equal(resultD, "discard");
});

await test("A/R/D CTAs still work with zero sections, even though section-nav keys are inert there", () => {
	const noKeybindings = { matches: () => false } as any;
	let result: unknown;
	const overlay = new ReviewSidebarOverlay(fakeTheme, noKeybindings, "Title", [], "0/0 tasks ticked", (r) => (result = r));
	overlay.handleInput("a");
	assert.equal(result, "approve", "Approve should fire even when there are no sections to browse");
});

await test("Tab moves focus onto the CTA bar, marking the highlighted action with '\u203a' and switching the nav hint", () => {
	const noKeybindings = { matches: () => false } as any;
	const overlay = new ReviewSidebarOverlay(fakeTheme, noKeybindings, "Title", sections(), "3/5 tasks ticked", () => {});

	const beforeTab = overlay.render(100);
	assert.ok(!beforeTab.at(-2)?.includes("\u203a"), "no CTA should be marked before Tab is pressed");
	assert.ok(beforeTab.at(-1)?.includes("Tab: actions"), "nav hint should offer Tab to reach the actions while focus is on sections");

	overlay.handleInput("\t");
	const afterTab = overlay.render(100);
	assert.ok(afterTab.at(-2)?.includes("\u203a [A] Approve"), "Tab should focus the CTA bar on Approve (the first action) by default");
	assert.ok(afterTab.at(-1)?.includes("Enter confirm"), "nav hint should explain Enter once focus is on the actions");

	overlay.handleInput("\t");
	const afterSecondTab = overlay.render(100);
	assert.ok(!afterSecondTab.at(-2)?.includes("\u203a"), "a second Tab should return focus to the section list");
});

await test("Left/Right cycle the highlighted CTA (with wraparound) once focus is on the actions bar", () => {
	const noKeybindings = { matches: () => false } as any;
	const overlay = new ReviewSidebarOverlay(fakeTheme, noKeybindings, "Title", sections(), "3/5 tasks ticked", () => {});
	overlay.handleInput("\t"); // focus the CTA bar (starts on Approve)

	overlay.handleInput("\x1b[C"); // Right -> Refine
	assert.ok(overlay.render(100).at(-2)?.includes("\u203a [R] Refine"));

	overlay.handleInput("\x1b[C"); // Right -> Discard
	assert.ok(overlay.render(100).at(-2)?.includes("\u203a [D] Discard"));

	overlay.handleInput("\x1b[C"); // Right wraps back to Approve
	assert.ok(overlay.render(100).at(-2)?.includes("\u203a [A] Approve"));

	overlay.handleInput("\x1b[D"); // Left wraps back to Discard
	assert.ok(overlay.render(100).at(-2)?.includes("\u203a [D] Discard"));
});

await test("Enter confirms whichever CTA is highlighted, acting as a real select() once focus is on the actions bar", () => {
	const confirmOnly = { matches: (_data: string, name: string) => name === "tui.select.confirm" } as any;
	let result: unknown;
	const overlay = new ReviewSidebarOverlay(fakeTheme, confirmOnly, "Title", sections(), "3/5 tasks ticked", (r) => (result = r));

	overlay.handleInput("\t"); // focus the CTA bar (Approve)
	overlay.handleInput("\x1b[C"); // Right -> Refine
	overlay.handleInput("some-enter-byte-sequence"); // stands in for the real Enter sequence; the stub matches by name, not bytes

	assert.equal(result, "refine", "Enter should confirm the currently-highlighted action, not always the first one");
});

await test("section-nav keys (Up/Down/PgUp/PgDn) are inert while focus is on the CTA bar", () => {
	const everythingMatches = { matches: () => true } as any; // would normally move section selection on any of these
	const overlay = new ReviewSidebarOverlay(fakeTheme, everythingMatches, "Title", sections(), "3/5 tasks ticked", () => {});
	overlay.handleInput("\t"); // focus the CTA bar

	const before = overlay.render(100);
	overlay.handleInput("\x1b[A"); // an up-arrow-shaped byte sequence, not one of PgUp/PgDn/Tab/Left/Right/Enter/letters
	const after = overlay.render(100);
	assert.deepEqual(before, after, "an unrecognized key while focus is on the CTA bar should not change anything");
});

const upDownOnly = {
	matches: (data: string, name: string) => (data === "down" && name === "tui.select.down") || (data === "up" && name === "tui.select.up"),
} as any;

await test("Down scrolls the current section's content line by line, then advances into the next section once it's exhausted", () => {
	const overlay = new ReviewSidebarOverlay(fakeTheme, upDownOnly, "Title", sections(), "0/1", () => {});
	// Exploration (index 0) has 2 body lines -> maxScrollOffset 1.
	overlay.handleInput("down"); // scrollOffset 0 -> 1 (still within Exploration)
	let joined = overlay.render(100).join("\n");
	assert.match(joined, /› Exploration/, "still on Exploration after one Down (content wasn't exhausted yet)");
	assert.match(joined, /line two/, "should now show Exploration's second line");

	overlay.handleInput("down"); // Exploration's content is exhausted -> advance to Proposal, at its top
	joined = overlay.render(100).join("\n");
	assert.match(joined, /› Proposal/, "Down should advance to the next section once content is exhausted");
	assert.match(joined, /proposal line 0\b/, "the next section should open at its top, not mid-scroll");
});

await test("Up scrolls content upward, then goes back to the PREVIOUS section landing at ITS bottom (continuous-scroll feel, not reset-to-top)", () => {
	const overlay = new ReviewSidebarOverlay(fakeTheme, upDownOnly, "Title", sections(), "0/1", () => {});
	overlay.handleInput("down"); // Exploration: 0 -> 1
	overlay.handleInput("down"); // Exploration exhausted -> Proposal @ 0
	overlay.handleInput("up"); // Proposal is at scrollOffset 0 -> go back to Exploration, at ITS bottom

	const joined = overlay.render(100).join("\n");
	assert.match(joined, /› Exploration/, "Up from the top of Proposal's content should return to Exploration");
	assert.match(joined, /line two/, "should land on Exploration's LAST line, not jump back to its first");
});

await test("Down wraps from the last section back to the first, and Up wraps the other way", () => {
	const down = new ReviewSidebarOverlay(fakeTheme, upDownOnly, "Title", sections(), "0/1", () => {});
	down.handleInput("down"); // Tasks... no wait, starts on Exploration; drive it all the way around instead:
	// Exploration (2 lines) -> Proposal (30 lines) -> Tasks (2 lines) -> wraps to Exploration.
	for (let i = 0; i < 2 + 30; i++) down.handleInput("down"); // exhaust Exploration then Proposal
	assert.match(down.render(100).join("\n"), /› Tasks/, "should now be on the last section, Tasks");
	for (let i = 0; i < 2; i++) down.handleInput("down"); // exhaust Tasks
	assert.match(down.render(100).join("\n"), /› Exploration/, "Down past the last section's content should wrap to the first");

	const up = new ReviewSidebarOverlay(fakeTheme, upDownOnly, "Title", sections(), "0/1", () => {});
	up.handleInput("up"); // already at the top of the first section -> wraps to the last, at its bottom
	assert.match(up.render(100).join("\n"), /› Tasks/, "Up from the very top should wrap to the last section");
});

await test("Left/Right jump straight to the previous/next section, resetting scroll to the top and bypassing content", () => {
	const noKeybindings = { matches: () => false } as any; // Left/Right are raw-byte checks, independent of keybindings.matches
	const overlay = new ReviewSidebarOverlay(fakeTheme, noKeybindings, "Title", sections(), "0/1", () => {});

	overlay.handleInput("\x1b[C"); // Right: Exploration -> Proposal
	assert.match(overlay.render(100).join("\n"), /› Proposal/);

	overlay.handleInput("\x1b[C"); // Right: Proposal -> Tasks
	assert.match(overlay.render(100).join("\n"), /› Tasks/);

	overlay.handleInput("\x1b[C"); // Right wraps: Tasks -> Exploration
	assert.match(overlay.render(100).join("\n"), /› Exploration/);

	overlay.handleInput("\x1b[D"); // Left wraps back: Exploration -> Tasks
	const joined = overlay.render(100).join("\n");
	assert.match(joined, /› Tasks/);
	assert.match(joined, /- \[x\] task 1/, "a direct Left/Right jump should land at the top of that section's content, not mid-scroll");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
