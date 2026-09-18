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
 */

import type { Component, KeybindingsManager, Theme } from "@oh-my-pi/pi-tui";

/** ASCII-width string length. Not Unicode-grapheme-aware — see the module doc comment. */
function asciiWidth(text: string): number {
	return text.length;
}

/** Truncate to at most `width` ASCII columns, no ellipsis (matches this file's plain output). */
function asciiTruncate(text: string, width: number): string {
	return text.length <= width ? text : text.slice(0, Math.max(0, width));
}

export interface OverlaySection {
	id: string;
	heading: string;
	status: string;
	/** Pre-rendered body, already split on newlines — this overlay does not fetch or re-render. */
	bodyLines: string[];
}

export type ReviewOverlayResult = undefined;

const MIN_SIDEBAR_WIDTH = 20;
const MAX_SIDEBAR_WIDTH = 34;
const BODY_SCROLL_STEP = 10;

/** Pad-or-truncate a single line to exactly `width` visible columns. */
function fitLine(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = asciiTruncate(text, width);
	const pad = Math.max(0, width - asciiWidth(clipped));
	return clipped + " ".repeat(pad);
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
	fg: (text: string) => string,
	bold: (text: string) => string,
	dim: (text: string) => string,
): string[] {
	const innerWidth = Math.max(20, width);
	const sidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(innerWidth * 0.28)));
	const bodyWidth = Math.max(10, innerWidth - sidebarWidth - 3); // 3 = " │ "
	const bodyRows = Math.max(3, height - 4); // minus title, header rule, footer, footer rule

	const lines: string[] = [];
	lines.push(bold(fitLine(` ${title}`, innerWidth)));
	lines.push(fg("─".repeat(innerWidth)));

	const section = sections[selectedIndex];
	const visibleBody = section ? section.bodyLines.slice(scrollOffset, scrollOffset + bodyRows) : [];
	const bodyOverflow = section ? Math.max(0, section.bodyLines.length - bodyRows) : 0;

	for (let row = 0; row < bodyRows; row++) {
		const isSelected = row < sections.length && row === selectedIndex;
		let sideText: string;
		if (row < sections.length) {
			const s = sections[row];
			const marker = row === selectedIndex ? "› " : "  ";
			sideText = `${marker}${s.heading} (${s.status})`;
		} else {
			sideText = "";
		}
		const sideCell = isSelected ? bold(fg(fitLine(sideText, sidebarWidth))) : fitLine(sideText, sidebarWidth);

		const bodyLine = visibleBody[row] ?? "";
		const bodyCell = fitLine(bodyLine, bodyWidth);

		lines.push(`${sideCell} ${dim("│")} ${bodyCell}`);
	}

	lines.push(fg("─".repeat(innerWidth)));
	const scrollHint = bodyOverflow > 0 ? ` · PgUp/PgDn to scroll (${scrollOffset}/${section?.bodyLines.length ?? 0})` : "";
	lines.push(dim(fitLine(` ↑/↓ section${scrollHint} · Esc back to review`, innerWidth)));

	return lines;
}

export class ReviewSidebarOverlay implements Component {
	#theme: Theme;
	#keybindings: KeybindingsManager;
	#title: string;
	#sections: OverlaySection[];
	#done: (result: ReviewOverlayResult) => void;
	#selectedIndex = 0;
	#scrollOffset = 0;

	constructor(theme: Theme, keybindings: KeybindingsManager, title: string, sections: OverlaySection[], done: (result: ReviewOverlayResult) => void) {
		this.#theme = theme;
		this.#keybindings = keybindings;
		this.#title = title;
		this.#sections = sections;
		this.#done = done;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#done(undefined);
			return;
		}
		if (this.#sections.length === 0) return;

		if (this.#keybindings.matches(data, "tui.select.up")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#sections.length - 1 : this.#selectedIndex - 1;
			this.#scrollOffset = 0;
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.down")) {
			this.#selectedIndex = this.#selectedIndex === this.#sections.length - 1 ? 0 : this.#selectedIndex + 1;
			this.#scrollOffset = 0;
			return;
		}
		// Raw VT sequences for PageUp/PageDown — deliberately not routed through `keybindings`
		// (there is no `tui.select.pageUp` equivalent for "scroll the body pane" in this design;
		// see the module doc comment for why Up/Down are reserved for section navigation instead).
		if (data === "\x1b[5~") {
			this.#scrollOffset = Math.max(0, this.#scrollOffset - BODY_SCROLL_STEP);
			return;
		}
		if (data === "\x1b[6~") {
			const section = this.#sections[this.#selectedIndex];
			const maxOffset = section ? Math.max(0, section.bodyLines.length - 1) : 0;
			this.#scrollOffset = Math.min(maxOffset, this.#scrollOffset + BODY_SCROLL_STEP);
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
			(text: string) => this.#theme.fg("accent", text),
			(text: string) => this.#theme.bold(text),
			(text: string) => this.#theme.fg("dim", text),
		);
	}
}
