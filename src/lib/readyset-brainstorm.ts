/**
 * Shared helpers for Readyset's brainstorm-driven workflow.
 *
 * Lives OUTSIDE `agent/extensions/` on purpose: omp's extension discovery scans one
 * subdirectory level under the extensions dir, so a helper placed at
 * `extensions/lib/*.ts` could be picked up and executed as an extension.
 * From an extension, import it as `../lib/readyset-brainstorm.ts`.
 *
 * If this repo gains other commands that also read brainstorms, they should import from
 * here rather than keeping their own copy — divergent copies of the branch regex are
 * exactly the kind of drift this file was extracted to prevent.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { structuralCheckSummary } from "./readyset-structural-check.ts";

export const BRAINSTORM_DIR = ".ai/brainstorms";
export const READYSET_DIR = "readyset";

/** Branch types from the brainstorm-ai skill (rule #7), mapped to a workflow lane. */
export const FAST_LANE_TYPES = new Set(["bugfix", "hotfix", "refactor", "chore", "docs", "test", "release"]);
export const FULL_LANE_TYPES = new Set(["feature", "adjust", "experimental"]);

export type Lane = "full" | "fast";

/** Statuses a brainstorm moves through. "planned" is a legacy value from an earlier,
 *  native-/plan-based flow and is still accepted wherever "proposed" is. "approved" is a
 *  manual gate crossed via /readyset's review step, between "proposed" and
 *  "archived" — it is also treated as "already proposed" everywhere that matters, so
 *  reconciliation never downgrades it back to "proposed". */
export type BrainstormStatus = "open" | "planned" | "proposed" | "approved" | "archived" | (string & {});

export interface BrainstormMeta {
	file: string;
	raw: string;
	title: string;
	slug?: string;
	status: BrainstormStatus;
	created?: string;
	namespace?: string;
	lane: Lane;
	laneSource: "frontmatter" | "branch" | "default";
	changeId: string;
	branch?: string;
}

/** Minimal flat-YAML frontmatter parser — good enough for our known,
 *  single-level key: value schema. Avoids pulling in a yaml dependency. */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { meta: {}, body: raw };
	const meta: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
		if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
	}
	return { meta, body: raw.slice(match[0].length) };
}

/** Update or insert flat keys in the frontmatter block, leaving every other line
 *  and the body untouched. Preserves the file's existing line endings. */
export function setFrontmatterFields(raw: string, updates: Record<string, string>): string {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) {
		const block = Object.entries(updates)
			.map(([k, v]) => `${k}: ${v}`)
			.join("\n");
		return `---\n${block}\n---\n${raw}`;
	}
	const eol = match[0].includes("\r\n") ? "\r\n" : "\n";
	const pending = new Map(Object.entries(updates));
	const lines = match[1].split(/\r?\n/).map((line) => {
		const kv = line.match(/^([a-zA-Z0-9_-]+):/);
		if (kv && pending.has(kv[1])) {
			const value = pending.get(kv[1])!;
			pending.delete(kv[1]);
			return `${kv[1]}: ${value}`;
		}
		return line;
	});
	for (const [k, v] of pending) lines.push(`${k}: ${v}`);
	return `---${eol}${lines.join(eol)}${eol}---${raw.slice(match[0].length)}`;
}

/**
 * The one branch regex. Tolerates every shape the skill may emit:
 *   - Branch: feature/otp-generate
 *   - **Branch**: feature/otp-generate
 *   - **Branch:** `feature/otp-generate`
 *   * Branch: feature/otp-generate
 */
const BRANCH_RE =
	/^\s*[-*]\s*(?:\*\*|__)?\s*Branch\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*`?([a-z]+)\/([a-z0-9][a-z0-9._/-]*)/im;

export function parseBranch(text: string): { type: string; name: string } | undefined {
	const m = text.match(BRANCH_RE);
	if (!m) return undefined;
	return { type: m[1].toLowerCase(), name: `${m[1].toLowerCase()}/${m[2]}` };
}

/** Convenience wrapper returning just the branch name. */
export function parseBranchLine(text: string): string | undefined {
	return parseBranch(text)?.name;
}

/** Derives a Readyset change id from a slug or a date-prefixed brainstorm filename. */
export function toChangeId(input: string): string {
	return input
		.toLowerCase()
		.replace(/^\d{4}-\d{2}-\d{2}-/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function resolveLane(
	meta: Record<string, string>,
	branchType?: string,
): Pick<BrainstormMeta, "lane" | "laneSource"> {
	if (meta.lane === "full" || meta.lane === "fast") return { lane: meta.lane, laneSource: "frontmatter" };
	if (branchType && FAST_LANE_TYPES.has(branchType)) return { lane: "fast", laneSource: "branch" };
	if (branchType && FULL_LANE_TYPES.has(branchType)) return { lane: "full", laneSource: "branch" };
	// Unknown or missing branch type: full lane is the safer default — it asks for a
	// proposal rather than silently skipping the review gate.
	return { lane: "full", laneSource: "default" };
}

/** True once a brainstorm has a Readyset change, whichever spelling wrote it — this
 *  includes "approved" on purpose: reconcileStatuses uses !isProposed(...) to decide
 *  whether to bump status to "proposed", and an approved change must never be bumped
 *  back down. Use status === "approved" directly wherever "already reviewed" (not just
 *  "already proposed") is the actual question. */
export function isProposed(status: BrainstormStatus): boolean {
	return status === "proposed" || status === "planned" || status === "approved";
}

export async function isDir(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export async function hasReadysetRoot(cwd: string): Promise<boolean> {
	return isDir(join(cwd, READYSET_DIR));
}

/** Archived changes live in changes/archive/<YYYY-MM-DD>-<id>; match the id exactly,
 *  never by suffix, so "login" does not match "add-login". */
export function archiveEntryMatches(entry: string, id: string): boolean {
	if (entry === id) return true;
	const m = entry.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
	return m?.[1] === id;
}

export async function changeState(cwd: string, id: string): Promise<"active" | "archived" | "none"> {
	const changes = join(cwd, READYSET_DIR, "changes");
	if (await isDir(join(changes, id))) return "active";
	try {
		const archived = await readdir(join(changes, "archive"));
		if (archived.some((entry) => archiveEntryMatches(entry, id))) return "archived";
	} catch {
		// no archive folder yet
	}
	return "none";
}

export async function loadBrainstorms(cwd: string): Promise<BrainstormMeta[]> {
	const dir = join(cwd, BRAINSTORM_DIR);
	let entries: string[];
	try {
		entries = (await readdir(dir)).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}

	const items: BrainstormMeta[] = [];
	for (const file of entries) {
		const full = join(dir, file);
		const raw = await readFile(full, "utf8").catch(() => "");
		if (!raw) continue;
		const { meta, body } = parseFrontmatter(raw);
		const branch = parseBranch(body);
		items.push({
			file: full,
			raw,
			title: meta.title ?? file.replace(/\.md$/, ""),
			slug: meta.slug,
			status: meta.status ?? "open",
			created: meta.created,
			namespace: meta.namespace,
			...resolveLane(meta, branch?.type),
			changeId: toChangeId(meta.change_id || meta.slug || file.replace(/\.md$/, "")),
			branch: branch?.name,
		});
	}

	// Newest first — falls back to filename (date-prefixed) when `created` is missing.
	items.sort((a, b) => (b.created ?? b.file).localeCompare(a.created ?? a.file));
	return items;
}

/**
 * Brings brainstorm status in line with what actually exists under readyset/changes,
 * mutating the passed items in place and returning how many files were rewritten.
 *
 * Derived from the filesystem rather than from what a command *intended* to do, so a
 * propose that failed halfway leaves the brainstorm untouched.
 *
 * Lane is deliberately not consulted. An earlier version skipped `lane !== "full"` here,
 * on the theory that a fast-lane brainstorm never has a change to reconcile against — the
 * extension writes no `readyset/changes/<id>/` for it. That theory is false for the fast
 * lane as it actually runs (it still goes through Propose and writes a change dir), and the
 * skip was not harmless: the review gate only opens for a brainstorm whose status is
 * `proposed` (see the `isProposed` check in readyset-review.ts), so every fast-lane change
 * dead-ended at "Propose doesn't look finished" with no gate ever shown. Measured on
 * `readyset-bench` label `b1-subset-0.12`: all 5 fast-lane runs, 0 gates; all 7 full-lane
 * runs, 1 gate each. The status is already guarded by `changeState` below, so an untouched
 * fast-lane brainstorm with no change dir is still left alone.
 */
export async function reconcileStatuses(cwd: string, items: BrainstormMeta[]): Promise<number> {
	let updated = 0;
	for (const b of items) {
		if (b.status === "archived") continue;
		const state = await changeState(cwd, b.changeId);
		let next: string | undefined;
		if (state === "archived") next = "archived";
		else if (state === "active" && !isProposed(b.status)) next = "proposed";
		if (!next) continue;

		const raw = setFrontmatterFields(b.raw, { status: next, change_id: b.changeId });
		await writeFile(b.file, raw, "utf8");
		b.raw = raw;
		b.status = next;
		updated++;
	}
	return updated;
}

/** Reads readyset/changes/<id>/tasks.md and counts checkbox lines. Returns undefined if
 *  the change (or its tasks.md) doesn't exist yet — callers use that to fall back to a
 *  generic "review before approving" message instead of a task count. */
export async function countTasks(cwd: string, changeId: string): Promise<{ done: number; total: number } | undefined> {
	const path = join(cwd, READYSET_DIR, "changes", changeId, "tasks.md");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	const boxes = raw.match(/^\s*-\s*\[([ xX])\]/gm) ?? [];
	const done = boxes.filter((b) => /\[[xX]\]/.test(b)).length;
	return { done, total: boxes.length };
}

/**
 * Marks a brainstorm "approved" — the manual gate crossed in /brainstorm-propose's review
 * step, between "proposed" (files exist) and "archived" (merged). Mutates `item` in place
 * (raw + status) the same way reconcileStatuses does, so the caller can use the item
 * immediately after without re-reading it from disk.
 */
export async function markApproved(item: BrainstormMeta): Promise<void> {
	const raw = setFrontmatterFields(item.raw, { status: "approved" });
	await writeFile(item.file, raw, "utf8");
	item.raw = raw;
	item.status = "approved";
}

/** Finds the branch declared in the brainstorm linked to a Readyset change id. */
export async function findBrainstormBranch(cwd: string, changeId: string): Promise<string | undefined> {
	let files: string[];
	try {
		files = (await readdir(join(cwd, BRAINSTORM_DIR))).filter((f) => f.endsWith(".md"));
	} catch {
		return undefined;
	}
	for (const file of files) {
		const raw = await readFile(join(cwd, BRAINSTORM_DIR, file), "utf8").catch(() => "");
		if (!raw) continue;
		const { meta, body } = parseFrontmatter(raw);
		const id = toChangeId(meta.change_id || meta.slug || file.replace(/\.md$/, ""));
		if (id !== changeId) continue;
		return parseBranchLine(body);
	}
	return undefined;
}

export interface BrainstormContentIssue {
	section: string;
	problem: string;
}

export interface BrainstormContentCheck {
	ok: boolean;
	issues: BrainstormContentIssue[];
	summary: string;
}

/** Extracts the body of a level-2 (`## Heading`) section, up to the next level-2 heading or
 *  end of the body. Case-insensitive; tolerates trailing whitespace on the heading line. */
function extractSection(body: string, heading: string): string | undefined {
	const headingRe = new RegExp(`^##[ \\t]*${heading}[ \\t]*$`, "im");
	const m = body.match(headingRe);
	if (!m) return undefined;
	const start = m.index! + m[0].length;
	const rest = body.slice(start);
	const next = rest.match(/^##[ \t]/m);
	return rest.slice(0, next ? next.index : undefined);
}

/**
 * Structural — not semantic — check that a brainstorm's closing sections were actually filled
 * in, not left as the brainstorm-ai skill's own unfilled template text. Exists for the same
 * reason `validateChange` (readyset-spec.ts) exists for change artifacts: a brainstorm can now
 * come out of `/readyset --idea`'s own grilling turn, which — like every LLM turn
 * working from a prose instruction alone — can accept a passive answer and write the file early
 * despite being told not to (the same class of failure that motivated `listSubmodules()` being
 * injected into Explore's prompt deterministically, rather than trusted to a "check
 * .gitmodules" instruction). This catches the file that never actually got decided, not one
 * that made a bad but genuine decision — the same shallow-by-design trade-off `validateChange`
 * states about itself, stated here too rather than hidden.
 *
 * Deliberately does not require Options Explored / Spec Impact / Git Workflow to be filled — a
 * brainstorm can legitimately defer some of those (e.g. "not applicable, no OpenSpec here"), and
 * the four sections checked here (Decision, Seam, Scope, Acceptance Criteria) are exactly the
 * four the brainstorm-ai skill's own rule #6 says must never be left soft before writing the file
 * at all — the same bar this check enforces.
 */
export function validateBrainstormContent(raw: string): BrainstormContentCheck {
	const { body } = parseFrontmatter(raw);
	const issues: BrainstormContentIssue[] = [];

	const decision = extractSection(body, "Decision")?.trim();
	if (!decision) {
		issues.push({ section: "Decision", problem: "section missing or empty" });
	} else if (!/Chosen option\s*:\s*\S/i.test(decision)) {
		issues.push({ section: "Decision", problem: "no filled-in 'Chosen option:' line found" });
	}

	const seam = extractSection(body, "Seam")?.trim();
	if (!seam) {
		issues.push({ section: "Seam", problem: "section missing or empty" });
	} else if (/^<.*>$/s.test(seam)) {
		issues.push({ section: "Seam", problem: "still the unfilled '<...>' template placeholder" });
	}

	const scope = extractSection(body, "Scope")?.trim();
	if (!scope) {
		issues.push({ section: "Scope", problem: "section missing or empty" });
	} else if (/-\s*In scope\s*:\s*\.\.\.\s*$/im.test(scope) && /-\s*Out of scope\s*:\s*\.\.\.\s*$/im.test(scope)) {
		issues.push({ section: "Scope", problem: "still the unfilled 'In scope: ... / Out of scope: ...' template" });
	}

	const acceptance = extractSection(body, "Acceptance Criteria")?.trim();
	if (!acceptance) {
		issues.push({ section: "Acceptance Criteria", problem: "section missing or empty" });
	} else if (!/\bWHEN\b[\s\S]*?\bTHEN\b/i.test(acceptance)) {
		issues.push({ section: "Acceptance Criteria", problem: "no WHEN ... THEN-shaped criterion found" });
	}

	return {
		ok: issues.length === 0,
		issues,
		// "(structural check)" is deliberate, same wording readyset-spec.ts's validateChange
		// uses for the same reason: this confirms the four sections are filled in with
		// something that isn't the unfilled template, not that the content is actually good.
		// A brainstorm that clears this can still describe a bad plan -- that judgment happens
		// later, in the human back-and-forth during grilling itself and in the review gate, not
		// here. structuralCheckSummary (readyset-structural-check.ts) is what actually keeps the
		// wording identical to validateChange's -- see that file's doc comment for why this is a
		// shared function now instead of each check spelling out "(structural check)" by hand.
		summary: structuralCheckSummary({
			kind: "brainstorm",
			issueCount: issues.length,
			okDetail: "Decision/Seam/Scope/Acceptance Criteria filled in",
			issueNoun: "section(s) look unresolved",
			notOkDetail: issues.length > 0 ? "may not have been fully grilled" : undefined,
		}),
	};
}

/**
 * Inert default export. This file is not an extension, but omp's discovery scans one
 * subdirectory level under the extensions dir — if this ever ends up somewhere that
 * gets scanned, it loads and registers nothing instead of throwing.
 */
export default function () {
	/* not an extension */
}
