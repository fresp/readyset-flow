/**
 * Shared helpers for Readyset's brainstorm-driven workflow.
 *
 * Lives OUTSIDE `agent/extensions/` on purpose: omp's extension discovery scans one
 * subdirectory level under the extensions dir, so a helper placed at
 * `extensions/lib/*.ts` could be picked up and executed as an extension.
 * From an extension, import it as `../lib/brainstorm.ts`.
 *
 * If this repo gains other commands that also read brainstorms, they should import from
 * here rather than keeping their own copy — divergent copies of the branch regex are
 * exactly the kind of drift this file was extracted to prevent.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const BRAINSTORM_DIR = ".ai/brainstorms";
export const READYSET_DIR = "readyset";

/** Branch types from the brainstorm-ai skill (rule #7), mapped to a workflow lane. */
export const FAST_LANE_TYPES = new Set(["bugfix", "hotfix", "refactor", "chore", "docs", "test", "release"]);
export const FULL_LANE_TYPES = new Set(["feature", "adjust", "experimental"]);

export type Lane = "full" | "fast";

/** Statuses a brainstorm moves through. "planned" is a legacy value from an earlier,
 *  native-/plan-based flow and is still accepted wherever "proposed" is. "approved" is a
 *  manual gate crossed via /readyset-review's review step, between "proposed" and
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
 * propose that failed halfway leaves the brainstorm untouched. Fast-lane brainstorms
 * are never touched: they have no change to reconcile against.
 */
export async function reconcileStatuses(cwd: string, items: BrainstormMeta[]): Promise<number> {
	let updated = 0;
	for (const b of items) {
		if (b.lane !== "full" || b.status === "archived") continue;
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

/**
 * Inert default export. This file is not an extension, but omp's discovery scans one
 * subdirectory level under the extensions dir — if this ever ends up somewhere that
 * gets scanned, it loads and registers nothing instead of throwing.
 */
export default function () {
	/* not an extension */
}
