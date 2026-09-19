/**
 * A real, persistent two-pane sidebar+content overlay for `/readyset-review` — built from the
 * same public extension API native `/plan`'s own review sidebar uses under the hood
 * (`ctx.ui.custom()`), not a simulation of one.
 *
 * This exists because an earlier version of this file's sibling code (the "Jump to section"
 * menu in `readyset-review.ts`) was built on a wrong premise: that omp's extension API has no
 * way to render a persistent sidebar at all, only modal dialogs and single stacked widgets. That
 * premise came from `docs/extensions.md`'s *RPC-mode* method list ("Extensions cannot create
 * sidebars, tree views, webviews..."), read as if it applied to every invocation context. It
 * doesn't — RPC mode is one of several UI contexts (`docs/extensions.md`: Interactive mode /
 * RPC mode / ACP mode / print-headless), and RPC mode is specifically for extensions driven
 * over omp's JSON-RPC protocol by an external client, not for a person typing at an interactive
 * `omp` terminal prompt (which is how this package is actually used — see the screenshots that
 * prompted this file). In Interactive mode, `ExtensionUIContext.custom()` is fully supported:
 * "Show a custom component with keyboard focus" — the exact mechanism `PlanReviewOverlay`
 * (`@oh-my-pi/pi-tui/overlays/plan-review-overlay.ts`, confirmed by reading the real published
 * package source) is built from.
 *
 * `custom()`'s factory receives `(tui, theme, keybindings, done)` and must return an object
 * implementing `Component` from `@oh-my-pi/pi-tui`: `render(width): string[]` and an optional
 * `handleInput(data): void`. A real third-party extension already ships exactly this pattern —
 * `pi-intercom`'s `SessionListOverlay` (github.com/nicobailon/pi-intercom, ui/session-list.ts) —
 * confirmed by reading its actual source, not assumed. This file follows that same proven shape:
 * hand-drawn box characters and `theme`/`keybindings` passed into the factory, not native
 * `/plan`'s own internal `SelectList`/`ScrollView`/`SplitPane` composition (those are also
 * exported from `@oh-my-pi/pi-tui`'s public `index.ts`, so they're not off-limits in principle —
 * but going through them pulls in more of that package's runtime surface than this needs, and
 * `pi-intercom`'s simpler, already-proven approach is enough for a read-only section browser).
 *
 * Import surface: `Component`/`Theme`/`KeybindingsManager` are type-only (erased at
 * `--experimental-strip-types`, same as every other `@oh-my-pi/*` import in this package) — this
 * file has NO real runtime dependency on `@oh-my-pi/pi-tui` being installed or resolvable from
 * an extension's module graph. That was a genuine open question (`pi-intercom` imports
 * `truncateToWidth`/`visibleWidth` from it as real runtime code, which would have been a
 * reasonable thing to do too — real precedent, not a guess), but it's untested from here (no
 * live omp to actually run it in yet), so this file plays it safe and implements its own tiny
 * width helpers below instead, matching this package's existing zero-runtime-dependency stance
 * (see the YAML parser in `readyset-omp-config.ts` for the same trade-off). They're ASCII-width
 * only — not Unicode-grapheme-aware like the real `truncateToWidth`/`visibleWidth` — good enough
 * for this package's own plain-ASCII output (headings, statuses, file contents), not a general
 * substitute.
 *
 * Caveat: `docs.md` calls out an unrelated bug (issue #8419, fixed in #8423) where
 * `ExtensionContext.mode` — meant to read `"tui"` in Interactive mode, so extensions can guard
 * TUI-only UI — was never actually populated. This package doesn't guard on `ctx.mode` at all;
 * `readyset-review.ts` instead feature-detects `typeof ctx.ui.custom === "function"` before
 * offering the sidebar, and falls back to the older per-section menu view when it's absent.
 *
 * Width caveat (confirmed against `@oh-my-pi/pi-tui@18.2.6`'s real published source,
 * `src/tui.ts`'s `OverlayOptions`/`#resolveOverlayLayout`): `overlayOptions.fullscreen` only
 * controls whether the overlay borrows the terminal's alt-screen buffer -- it does NOT affect
 * width. Width defaults to `Math.min(80, availableWidth)` when `overlayOptions.width` isn't set,
 * which is why an early version of this overlay rendered as a narrow ~80-column box even on a
 * wide terminal. `readyset-review.ts`'s `openSidebarOverlay` now passes `width: "90%"` explicitly
 * (`OverlayOptions.width` accepts a percentage string) to actually use the terminal's width.
 */

import type { Component, KeybindingsManager, Theme } from "@oh-my-pi/pi-tui";

/** ASCII-width string length. Not Unicode-grapheme-aware — see the module doc comment. */
function asciiWidth(text: string): number {
	return text.length;
}

/** Truncate to at most `width` ASCII columns, no ellipsis — used only where an ellipsis itself
 *  wouldn't fit (width <= 1). Everywhere else, prefer `truncateWithEllipsis`. */
function asciiTruncate(text: string, width: number): string {
	return text.length <= width ? text : text.slice(0, Math.max(0, width));
}

/** Truncate to at most `width` columns, marking the cut with a single `…` instead of chopping
 *  mid-word. A hard, silent cut (the previous behavior) reads as broken rendering rather than
 *  "there's more, scroll or widen the pane" — the ellipsis is the whole fix. */
function truncateWithEllipsis(text: string, width: number): string {
	if (width <= 0) return "";
	if (asciiWidth(text) <= width) return text;
	if (width === 1) return "…";
	return asciiTruncate(text, width - 1) + "…";
}

export interface OverlaySection {
	id: string;
	heading: string;
	status: string;
	/** Pre-rendered body, already split on newlines — this overlay does not fetch or re-render. */
	bodyLines: string[];
}

/**
 * "approve"/"compact"/"refine"/"discard" when the user picks one of the CTAs baked into the
 * sidebar footer (see `handleInput` below); `undefined` when they cancel with Esc instead --
 * the caller (`reviewAndMaybeExecute` in readyset-review.ts) treats a cancel exactly like an
 * explicit "discard" (both just leave the change as proposed and return), so this is a
 * distinction the overlay preserves for clarity/logging, not one the gate logic depends on.
 * "compact" is Approve & Execute's sibling: same destination (Apply fires next either way), but
 * the caller runs `ctx.compact()` first -- see readyset-review.ts's `reviewAndMaybeExecute` for
 * why that's safe for a Readyset change specifically (everything Explore/Propose produced is
 * already persisted under readyset/changes/<id>/, so nothing material is lost by summarizing
 * away the conversation that produced it).
 */
export type ReviewOverlayResult = "approve" | "compact" | "refine" | "discard" | undefined;

/** The four CTAs, in on-screen left-to-right / Left-Right-cycling order. Shared between
 *  `renderCtaBar` (display) and `ReviewSidebarOverlay.handleInput` (Left/Right cycling, Enter
 *  confirming `CTA_ACTIONS[actionIndex]`) so the two can never drift out of sync. */
const CTA_ACTIONS = ["approve", "compact", "refine", "discard"] as const;
type CtaAction = (typeof CTA_ACTIONS)[number];
const CTA_KEYS: Record<CtaAction, string> = { approve: "A", compact: "C", refine: "R", discard: "D" };

const MIN_SIDEBAR_WIDTH = 22;
const MAX_SIDEBAR_WIDTH = 36;
const BODY_SCROLL_STEP = 10;

/** The furthest a section's content can be scrolled -- the offset at which its LAST line is
 *  still the top visible line (not "the last full page", which would need the viewport height
 *  this function deliberately doesn't take, so it works the same whether called from render()
 *  or from handleInput(), which has no width/height of its own to compute a real page with). */
function maxScrollOffset(section: OverlaySection | undefined): number {
	return section ? Math.max(0, section.bodyLines.length - 1) : 0;
}

/** Pad-or-truncate a single line to exactly `width` visible columns. */
function fitLine(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateWithEllipsis(text, width);
	const pad = Math.max(0, width - asciiWidth(clipped));
	return clipped + " ".repeat(pad);
}

/**
 * Splits a section's heading + status into the two pieces to render, dropping the status
 * entirely when it's redundant with the heading. Several sections bake their count straight
 * into the heading (`Specs (1)`, `Tasks (0/30)`) — appending the status on top of that
 * (`Specs (1) (1 file(s))`, `Tasks (0/30) (0/30 ticked)`) says the same number twice and, in a
 * narrow sidebar, is exactly what gets chopped off first. The check only looks at the trailing
 * `(...)` of the heading (if any) and drops the status when it starts with that same text — so
 * it only fires on genuine repeated data (a shared count), never on a heading/status that merely
 * share an ordinary word (`Proposal` has no trailing parenthetical, so `proposal.md` still shows
 * — the filename is real information there).
 */
function sidebarParts(heading: string, status: string): { heading: string; status: string | undefined } {
	const headingParen = heading.match(/\(([^)]+)\)\s*$/)?.[1];
	if (headingParen && status.startsWith(headingParen)) {
		return { heading, status: undefined };
	}
	return { heading, status };
}

/**
 * Renders the CTA bar's plain text (no ANSI yet -- the caller wraps the whole line in one style
 * call, same as every other footer line here). `focus` and `actionIndex` come from
 * `ReviewSidebarOverlay`'s own state: Tab moves `focus` onto this bar, Left/Right cycle
 * `actionIndex` through `CTA_ACTIONS`, and Enter confirms whichever one is marked with `›` --
 * i.e. this bar behaves like a real (if compact) select() list, not just three static hints.
 */
function renderCtaBar(taskSummary: string, focus: "sections" | "actions", actionIndex: number, width: number): string {
	const labels: Record<CtaAction, string> = {
		approve: `Approve & Execute — ${taskSummary}`,
		compact: "Approve & Compact",
		refine: "Refine",
		discard: "Discard",
	};
	const parts = CTA_ACTIONS.map((action, i) => {
		const marker = focus === "actions" && i === actionIndex ? "› " : "  ";
		return `${marker}[${CTA_KEYS[action]}] ${labels[action]}`;
	});
	return fitLine(` ${parts.join("   ")}`, width);
}

/** Pure layout function, separated from the Component class so it can be unit tested without a
 *  real TUI/theme/keybindings — it takes plain strings in, plain strings out. */
export function renderSidebarLayout(
	title: string,
	sections: readonly OverlaySection[],
	selectedIndex: number,
	scrollOffset: number,
	width: number,
	height: number,
	taskSummary: string,
	focus: "sections" | "actions",
	actionIndex: number,
	fg: (text: string) => string,
	bold: (text: string) => string,
	dim: (text: string) => string,
): string[] {
	const innerWidth = Math.max(20, width);
	const sidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(innerWidth * 0.3)));
	const bodyWidth = Math.max(10, innerWidth - sidebarWidth - 3); // 3 = " │ "
	const bodyRows = Math.max(3, height - 5); // minus title, header rule, footer rule, CTA bar, nav hint

	const lines: string[] = [];
	lines.push(bold(fitLine(` ${title}`, innerWidth)));
	lines.push(fg("─".repeat(innerWidth)));

	const section = sections[selectedIndex];
	const visibleBody = section ? section.bodyLines.slice(scrollOffset, scrollOffset + bodyRows) : [];
	const bodyOverflow = section ? Math.max(0, section.bodyLines.length - bodyRows) : 0;

	for (let row = 0; row < bodyRows; row++) {
		const isSelected = row < sections.length && row === selectedIndex;
		const sideCell = row < sections.length ? renderSideCell(sections[row], isSelected, sidebarWidth, fg, bold, dim) : " ".repeat(sidebarWidth);

		const bodyLine = visibleBody[row] ?? "";
		const bodyCell = fitLine(bodyLine, bodyWidth);

		lines.push(`${sideCell} ${dim("│")} ${bodyCell}`);
	}

	lines.push(fg("─".repeat(innerWidth)));
	// The CTA bar: this overlay IS the review gate now (opened automatically as soon as the
	// artifacts are ready -- see readyset-review.ts's reviewAndMaybeExecute), not an optional
	// read-only "Sidebar view" a separate ctx.ui.select() menu offered alongside Approve/Refine/
	// Discard. So those three actions live here as CTAs instead, bold/undimmed to read as the
	// primary controls; the quieter nav hint stays dim below it. They also behave like a select()
	// (see renderCtaBar) once Tab moves focus onto them, not just direct A/R/D keystrokes.
	lines.push(bold(renderCtaBar(taskSummary, focus, actionIndex, innerWidth)));
	// ↑/↓ scroll the CURRENT section's content and cross into the next/previous one once it's
	// exhausted (see handleInput); ←/→ jump straight to a section, bypassing its content.
	const scrollHint = bodyOverflow > 0 ? ` · PgUp/PgDn ±${BODY_SCROLL_STEP} (${scrollOffset}/${section?.bodyLines.length ?? 0})` : "";
	const focusHint = focus === "actions" ? "←/→ move · Enter confirm · Tab: sections" : "←/→ section · Tab: actions";
	lines.push(dim(fitLine(` ↑/↓ scroll${scrollHint} · ${focusHint} · Esc cancel`, innerWidth)));

	return lines;
}

/**
 * Renders one sidebar row: the marker + heading get the "selected" treatment (bold + accent
 * color), the status — when it isn't dropped as redundant by `sidebarParts` — stays dim
 * regardless of selection, so it reads as secondary metadata rather than competing with the
 * heading for attention. Padded to exactly `width` visible columns so the `│` divider lines up
 * across every row.
 */
function renderSideCell(
	section: OverlaySection,
	isSelected: boolean,
	width: number,
	fg: (text: string) => string,
	bold: (text: string) => string,
	dim: (text: string) => string,
): string {
	const marker = isSelected ? "› " : "  ";
	const avail = Math.max(0, width - asciiWidth(marker));
	const { heading, status } = sidebarParts(section.heading, section.status);

	const headingFit = truncateWithEllipsis(heading, avail);
	const headingWidth = asciiWidth(headingFit);
	let statusFit = "";
	if (status) {
		const remaining = avail - headingWidth;
		// " (" + ")" = 3 columns of overhead; need at least one more for a truncated status to
		// be worth showing at all, otherwise just drop it rather than render "()" or " (…)".
		if (remaining >= 4) {
			statusFit = ` (${truncateWithEllipsis(status, remaining - 3)})`;
		}
	}

	const pad = Math.max(0, avail - headingWidth - asciiWidth(statusFit));
	const headingStyled = isSelected ? bold(fg(headingFit)) : headingFit;
	const statusStyled = statusFit ? dim(statusFit) : "";
	return marker + headingStyled + statusStyled + " ".repeat(pad);
}

export class ReviewSidebarOverlay implements Component {
	#theme: Theme;
	#keybindings: KeybindingsManager;
	#title: string;
	#sections: OverlaySection[];
	#taskSummary: string;
	#done: (result: ReviewOverlayResult) => void;
	#selectedIndex = 0;
	#scrollOffset = 0;
	#focus: "sections" | "actions" = "sections";
	#actionIndex = 0;

	constructor(
		theme: Theme,
		keybindings: KeybindingsManager,
		title: string,
		sections: OverlaySection[],
		taskSummary: string,
		done: (result: ReviewOverlayResult) => void,
	) {
		this.#theme = theme;
		this.#keybindings = keybindings;
		this.#title = title;
		this.#sections = sections;
		this.#taskSummary = taskSummary;
		this.#done = done;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		// PageUp/PageDown are checked FIRST and unconditionally, before anything routed through
		// `keybindings.matches`. A real terminal run (2026-09-18) showed PgUp/PgDn moving the
		// sidebar *selection* instead of scrolling the body — i.e. `keybindings.matches(data,
		// "tui.select.up"/"down")` was evaluating true for the PageUp/PageDown byte sequences too
		// (most likely because those logical actions are bound more broadly than just the arrow
		// keys in the real KeybindingsManager, e.g. as a coarser "move selection" gesture). Rather
		// than guess at exactly why, these two raw checks are now unconditional and go first, so
		// PgUp/PgDn always scroll the body regardless of what `keybindings.matches` decides about
		// them — the ordering itself is the fix, not just the check's existence (which was already
		// here before and simply never got reached).
		if (data === "\x1b[5~") {
			this.#scrollOffset = Math.max(0, this.#scrollOffset - BODY_SCROLL_STEP);
			return;
		}
		if (data === "\x1b[6~") {
			const maxOffset = maxScrollOffset(this.#sections[this.#selectedIndex]);
			this.#scrollOffset = Math.min(maxOffset, this.#scrollOffset + BODY_SCROLL_STEP);
			return;
		}

		if (this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#done(undefined);
			return;
		}

		// Direct-execute CTA shortcuts -- Approve & Execute / Approve & Compact / Refine / Discard
		// live in the sidebar itself now (see the module doc comment and `ReviewOverlayResult`),
		// so a/c/r/d fire immediately regardless of `#focus`, no need to Tab onto the CTA bar
		// first. Checked before the section-nav early return below so they still work even with
		// zero sections -- a change with no renderable sections shouldn't make Approve/Discard
		// unreachable.
		if (data === "a" || data === "A") {
			this.#done("approve");
			return;
		}
		if (data === "c" || data === "C") {
			this.#done("compact");
			return;
		}
		if (data === "r" || data === "R") {
			this.#done("refine");
			return;
		}
		if (data === "d" || data === "D") {
			this.#done("discard");
			return;
		}

		// Tab moves focus onto the CTA bar (and back) -- once there, it behaves like a real
		// select() list: Left/Right cycle the highlighted action, Enter (`tui.select.confirm`)
		// confirms it. This is in addition to, not instead of, the a/r/d shortcuts above.
		if (data === "\t") {
			this.#focus = this.#focus === "sections" ? "actions" : "sections";
			return;
		}

		if (this.#focus === "actions") {
			if (data === "\x1b[D") {
				this.#actionIndex = (this.#actionIndex + CTA_ACTIONS.length - 1) % CTA_ACTIONS.length;
				return;
			}
			if (data === "\x1b[C") {
				this.#actionIndex = (this.#actionIndex + 1) % CTA_ACTIONS.length;
				return;
			}
			if (this.#keybindings.matches(data, "tui.select.confirm") || data === "\n" || data === "\r") {
				this.#done(CTA_ACTIONS[this.#actionIndex]);
				return;
			}
			return; // section-nav keys are inert while focus is on the CTA bar
		}

		if (this.#sections.length === 0) return;

		// Left/Right jump straight to the previous/next section, bypassing whatever's left of the
		// current one's content -- for someone who already knows which section they want and
		// doesn't care to scroll through this one first. Always lands at the top (scrollOffset 0):
		// unlike Up/Down below, this is an explicit "go to this section" jump, not a continuation
		// of reading. Checked as raw byte sequences, before `keybindings.matches`, for the same
		// reason PageUp/PageDown are up top -- no risk of a broadly-bound logical action
		// intercepting them first.
		if (data === "\x1b[D") {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#sections.length - 1 : this.#selectedIndex - 1;
			this.#scrollOffset = 0;
			return;
		}
		if (data === "\x1b[C") {
			this.#selectedIndex = this.#selectedIndex === this.#sections.length - 1 ? 0 : this.#selectedIndex + 1;
			this.#scrollOffset = 0;
			return;
		}

		// Up/Down scroll the CURRENT section's content one line at a time, and only cross into
		// the neighboring section once that content is exhausted -- so browsing a long design.md
		// no longer requires reaching for PgUp/PgDn (still there for a bigger jump within the
		// same section; see the PageUp/PageDown handling up top, unchanged). Down at the bottom
		// advances to the next section at its top; Up at the top goes back to the previous
		// section at ITS bottom, matching how scrolling up through a continuous, merged document
		// would read (not reset to its top, which would read as jumping past what you just saw).
		if (this.#keybindings.matches(data, "tui.select.down")) {
			const current = this.#sections[this.#selectedIndex];
			const maxOffset = maxScrollOffset(current);
			if (this.#scrollOffset < maxOffset) {
				this.#scrollOffset += 1;
			} else {
				this.#selectedIndex = this.#selectedIndex === this.#sections.length - 1 ? 0 : this.#selectedIndex + 1;
				this.#scrollOffset = 0;
			}
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.up")) {
			if (this.#scrollOffset > 0) {
				this.#scrollOffset -= 1;
			} else {
				this.#selectedIndex = this.#selectedIndex === 0 ? this.#sections.length - 1 : this.#selectedIndex - 1;
				this.#scrollOffset = maxScrollOffset(this.#sections[this.#selectedIndex]);
			}
			return;
		}
	}

	render(width: number): string[] {
		const height = process.stdout.rows || 40;
		return renderSidebarLayout(
			this.#title,
			this.#sections,
			this.#selectedIndex,
			this.#scrollOffset,
			width,
			height,
			this.#taskSummary,
			this.#focus,
			this.#actionIndex,
			(text: string) => this.#theme.fg("accent", text),
			(text: string) => this.#theme.bold(text),
			(text: string) => this.#theme.fg("dim", text),
		);
	}
}
