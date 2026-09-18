/**
 * Readyset's own change-artifact format: scaffolding a change directory, a structural
 * (not full-schema) validation pass, task-progress tracking, and archiving. No external
 * binary or CLI required — everything here is plain fs operations and regex over markdown.
 * The proposal/design/spec/tasks split follows the same shape as other spec-driven-development
 * tooling (credited in the package README), but this is Readyset's own format under its own
 * directory — it does not read, write, or stay compatible with any other such tool's files.
 *
 * `validateChange` is a shallow structural check (required sections and headers exist, at
 * least one requirement/scenario pair, at least one task) — good enough to catch a
 * genuinely empty or malformed artifact, not real schema/compliance checking (cross-file
 * references, config-driven rules, etc.). Say so plainly wherever this is surfaced to the
 * user.
 *
 * Lives next to brainstorm.ts (OUTSIDE agent/extensions/, for the same one-level-scan
 * reason documented there).
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const READYSET_ROOT = "readyset";

export interface ChangePaths {
	dir: string;
	proposal: string;
	design: string;
	tasks: string;
	specsDir: string;
	exploration: string;
	context: string;
	review: string;
}

export function changePaths(cwd: string, changeId: string): ChangePaths {
	const dir = join(cwd, READYSET_ROOT, "changes", changeId);
	return {
		dir,
		proposal: join(dir, "proposal.md"),
		design: join(dir, "design.md"),
		tasks: join(dir, "tasks.md"),
		specsDir: join(dir, "specs"),
		exploration: join(dir, "EXPLORATION.md"),
		context: join(dir, "CONTEXT.md"),
		review: join(dir, "REVIEW.md"),
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

async function isDir(path: string): Promise<boolean> {
	try {
		const { stat } = await import("node:fs/promises");
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** Ensures `readyset/{changes,specs}` exist. Safe to call even if `readyset/` was never
 *  initialized — this is the standalone entry point; there is no separate init step. */
export async function ensureReadysetRoot(cwd: string): Promise<void> {
	await mkdir(join(cwd, READYSET_ROOT, "changes"), { recursive: true });
	await mkdir(join(cwd, READYSET_ROOT, "changes", "archive"), { recursive: true });
	await mkdir(join(cwd, READYSET_ROOT, "specs"), { recursive: true });
}

/** Creates the change directory (and its specs/ subfolder) if missing. Idempotent — safe
 *  to call on every run. */
export async function scaffoldChange(cwd: string, changeId: string): Promise<ChangePaths> {
	const paths = changePaths(cwd, changeId);
	await mkdir(paths.dir, { recursive: true });
	await mkdir(paths.specsDir, { recursive: true });
	return paths;
}

export interface SubmoduleEntry {
	name: string;
	path: string;
}

/**
 * Parses the repo root `.gitmodules`, if any. This exists so the Explore phase's prompt can
 * be handed an explicit, complete list of submodules rather than relying on the model to
 * notice and enumerate them all itself — the exact gap that let one submodule (of two) get
 * silently dropped from a real reconciliation task in testing. Returns [] if there is no
 * `.gitmodules` (not a submodule repo) or it can't be read.
 */
export async function listSubmodules(cwd: string): Promise<SubmoduleEntry[]> {
	const raw = await readFile(join(cwd, ".gitmodules"), "utf8").catch(() => undefined);
	if (raw === undefined) return [];
	const entries: SubmoduleEntry[] = [];
	const blocks = raw.split(/(?=^\[submodule )/m);
	for (const block of blocks) {
		const nameMatch = block.match(/^\[submodule "([^"]+)"\]/);
		const pathMatch = block.match(/^\s*path\s*=\s*(.+)$/m);
		if (nameMatch && pathMatch) {
			entries.push({ name: nameMatch[1].trim(), path: pathMatch[1].trim() });
		}
	}
	return entries;
}

/** Whether an Explore-phase writeup already exists for this change. Used to gate Propose —
 *  see the header note on why grounding is a structural prerequisite, not just an
 *  instruction inside the propose prompt. */
export async function hasExploration(cwd: string, changeId: string): Promise<boolean> {
	const paths = changePaths(cwd, changeId);
	const raw = await readFile(paths.exploration, "utf8").catch(() => undefined);
	return !!raw && raw.trim().length > 0;
}

/**
 * Appends a dated, phase-tagged entry to this change's CONTEXT.md, creating the file if it
 * doesn't exist. This is called by the extension itself after each phase (deterministic,
 * not something the model can skip) as a lightweight audit trail — it does not depend on the
 * model choosing to write anything useful into it, though the phase prompts also ask the
 * model to add its own notes there for anything a later phase needs to not re-litigate.
 */
export async function appendContext(cwd: string, changeId: string, phase: string, text: string): Promise<void> {
	const paths = changePaths(cwd, changeId);
	const stamp = new Date().toISOString();
	const entry = `## ${phase} — ${stamp}\n\n${text.trim()}\n`;
	const existing = await readFile(paths.context, "utf8").catch(() => undefined);
	const next = existing === undefined ? `# Context log\n\n${entry}` : `${existing.trimEnd()}\n\n${entry}`;
	await writeFile(paths.context, next, "utf8");
}

export async function readContext(cwd: string, changeId: string): Promise<string | undefined> {
	const paths = changePaths(cwd, changeId);
	return readFile(paths.context, "utf8").catch(() => undefined);
}

export interface ValidationIssue {
	file: string;
	problem: string;
}

export interface ValidateResult {
	ok: boolean;
	summary: string;
	issues: ValidationIssue[];
}

/** Every markdown file directly under specs/**\/spec.md (any capability, any depth). */
/** Recursively finds every `spec.md` under a specs directory (`specs/<capability>/spec.md`,
 *  possibly nested deeper). Exported for callers that want to display or enumerate a change's
 *  delta specs directly (e.g. building a review document), not just validate them. */
export async function findSpecFiles(specsDir: string): Promise<string[]> {
	const found: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			if (entry === "spec.md") {
				found.push(full);
				continue;
			}
			if (await isDir(full)) await walk(full);
		}
	}
	await walk(specsDir);
	return found;
}

interface RequirementBlock {
	name: string;
	body: string;
}

/**
 * Splits a spec.md's raw text into one block per `### Requirement: <name>` heading, each
 * block's body running from just after that heading up to (but not including) the next `##`
 * or `###` heading — or end of file. A `#### Scenario:` heading (four `#`s) is deliberately
 * NOT a boundary, so every scenario under a requirement stays inside that requirement's block.
 *
 * This exists so validation can check each requirement individually for its own WHEN/THEN
 * pair, rather than checking "does a WHEN/THEN exist anywhere in the file" — the old check,
 * which let a file with three requirements and only one scenario pass silently, because the
 * one real scenario satisfied a file-wide regex regardless of which requirement it belonged to.
 */
function splitRequirementBlocks(raw: string): RequirementBlock[] {
	const headingRe = /^###[ \t]*Requirement:[ \t]*(.+)$/gim;
	const matches = [...raw.matchAll(headingRe)];
	const boundaryRe = /^#{2,3}[ \t]/m;

	return matches.map((m) => {
		const start = m.index! + m[0].length;
		const rest = raw.slice(start);
		const boundary = rest.match(boundaryRe);
		const end = boundary ? start + boundary.index! : raw.length;
		return { name: m[1].trim(), body: raw.slice(start, end) };
	});
}

/**
 * Structural validation — not a real schema check (see file header), but scoped per
 * requirement rather than per file (see `splitRequirementBlocks`). Verifies:
 *   - proposal.md exists with a "## Why" and a "## What Changes" section
 *   - at least one specs/<capability>/spec.md exists
 *   - each spec.md has at least one "## ADDED/MODIFIED/REMOVED Requirements" section —
 *     openspec's own delta-spec convention this format is modeled on, and the thing that
 *     makes a spec a *delta* against `readyset/specs/` rather than an unscoped restatement
 *   - each spec.md has at least one "### Requirement:", and EVERY one of them individually
 *     carries its own WHEN and THEN — not just one requirement in the file having a scenario
 *     while its siblings have none
 *   - tasks.md exists with at least one checkbox line
 */
export async function validateChange(cwd: string, changeId: string): Promise<ValidateResult> {
	const paths = changePaths(cwd, changeId);
	const issues: ValidationIssue[] = [];

	const proposalRaw = (await readFile(paths.proposal, "utf8").catch(() => undefined)) as string | undefined;
	if (proposalRaw === undefined) {
		issues.push({ file: "proposal.md", problem: "missing" });
	} else {
		if (!/^##\s*Why\b/im.test(proposalRaw)) issues.push({ file: "proposal.md", problem: "missing '## Why' section" });
		if (!/^##\s*What Changes\b/im.test(proposalRaw))
			issues.push({ file: "proposal.md", problem: "missing '## What Changes' section" });
	}

	const specFiles = await findSpecFiles(paths.specsDir);
	if (specFiles.length === 0) {
		issues.push({ file: "specs/", problem: "no spec.md found under specs/<capability>/" });
	} else {
		for (const specFile of specFiles) {
			const raw = await readFile(specFile, "utf8").catch(() => "");

			if (!/^##[ \t]*(ADDED|MODIFIED|REMOVED)[ \t]+Requirements\b/im.test(raw)) {
				issues.push({ file: specFile, problem: "no '## ADDED/MODIFIED/REMOVED Requirements' section found" });
			}

			const requirements = splitRequirementBlocks(raw);
			if (requirements.length === 0) {
				issues.push({ file: specFile, problem: "no '### Requirement:' found" });
				continue;
			}
			for (const req of requirements) {
				const hasWhen = /\*\*WHEN\*\*/im.test(req.body);
				const hasThen = /\*\*THEN\*\*/im.test(req.body);
				if (!hasWhen || !hasThen) {
					issues.push({ file: specFile, problem: `Requirement "${req.name}" has no WHEN/THEN scenario` });
				}
			}
		}
	}

	const tasksRaw = (await readFile(paths.tasks, "utf8").catch(() => undefined)) as string | undefined;
	if (tasksRaw === undefined) {
		issues.push({ file: "tasks.md", problem: "missing" });
	} else if (!/^\s*-\s*\[[ xX]\]/m.test(tasksRaw)) {
		issues.push({ file: "tasks.md", problem: "no checkbox items found" });
	}

	const ok = issues.length === 0;
	return {
		ok,
		summary: ok ? "validate: pass (structural check)" : `validate: ${issues.length} issue(s) (structural check)`,
		issues,
	};
}

export interface Progress {
	done: number;
	total: number;
	state: "not_started" | "in_progress" | "all_done";
}

export async function getProgress(cwd: string, changeId: string): Promise<Progress | undefined> {
	const paths = changePaths(cwd, changeId);
	const raw = await readFile(paths.tasks, "utf8").catch(() => undefined);
	if (raw === undefined) return undefined;
	const boxes = raw.match(/^\s*-\s*\[([ xX])\]/gm) ?? [];
	const done = boxes.filter((b) => /\[[xX]\]/.test(b)).length;
	const total = boxes.length;
	const state: Progress["state"] = total === 0 ? "not_started" : done === total ? "all_done" : "in_progress";
	return { done, total, state };
}

export interface VerificationCheck {
	checkedTasks: number;
	withVerificationNote: number;
	missing: number;
}

/**
 * TDD-style check: a task marked `- [x]` is only as trustworthy as the evidence attached to
 * it. This counts, among checked tasks, how many are immediately followed by a line starting
 * with `_Verified:` (the note format `applyTurnPrompt` asks the model to leave — the actual
 * command run and its result). This is still just a structural check (a note that says
 * "_Verified: ran it, looks fine_" passes exactly the same as one with real command output
 * pasted in) — it cannot confirm the verification is genuine, only that one was left. Surface
 * the `missing` count to the user; a run of checked tasks with no verification notes at all
 * is a strong signal the model claimed completion without checking.
 */
export async function checkTaskVerification(cwd: string, changeId: string): Promise<VerificationCheck | undefined> {
	const paths = changePaths(cwd, changeId);
	const raw = await readFile(paths.tasks, "utf8").catch(() => undefined);
	if (raw === undefined) return undefined;
	const lines = raw.split(/\r?\n/);
	let checkedTasks = 0;
	let withVerificationNote = 0;
	for (let i = 0; i < lines.length; i++) {
		if (!/^\s*-\s*\[[xX]\]/.test(lines[i])) continue;
		checkedTasks++;
		// The note may be the very next non-blank line, indented under the task.
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim() === "") continue;
			if (/^\s*-\s*\[[ xX]\]/.test(lines[j])) break; // hit the next task, no note found
			if (/^\s*_Verified:/i.test(lines[j])) withVerificationNote++;
			break;
		}
	}
	return { checkedTasks, withVerificationNote, missing: checkedTasks - withVerificationNote };
}

/** Reads REVIEW.md (the code-review phase's output), if it exists. */
export async function readReview(cwd: string, changeId: string): Promise<string | undefined> {
	const paths = changePaths(cwd, changeId);
	return readFile(paths.review, "utf8").catch(() => undefined);
}

export interface ArchiveResult {
	archivedDir: string;
	mergedSpecFiles: string[];
}

/**
 * Best-effort archive: moves the change directory to changes/archive/<date>-<id>/, and
 * copies each specs/<capability>/spec.md's content into readyset/specs/<capability>/spec.md
 * (creating it if missing, appending under a "## From change: <id>" marker if it already
 * exists).
 *
 * This is intentionally NOT a correct ADDED/MODIFIED/REMOVED merge — that needs matching
 * requirements by name across the delta and the existing spec and handling each verb
 * differently, which is real parsing work a full schema-aware archiver would do. Doing it
 * wrong silently would corrupt the main spec, so this does the safe subset (append, never
 * delete or rewrite existing text) and tells the caller to review the result.
 */
export async function archiveChange(cwd: string, changeId: string): Promise<ArchiveResult> {
	const paths = changePaths(cwd, changeId);
	const date = new Date().toISOString().slice(0, 10);
	const archivedDir = join(cwd, READYSET_ROOT, "changes", "archive", `${date}-${changeId}`);
	await mkdir(join(cwd, READYSET_ROOT, "changes", "archive"), { recursive: true });
	await rename(paths.dir, archivedDir);

	const mergedSpecFiles: string[] = [];
	const archivedSpecsDir = join(archivedDir, "specs");
	const specFiles = await findSpecFiles(archivedSpecsDir).catch(() => [] as string[]);
	for (const deltaSpec of specFiles) {
		const rel = deltaSpec.slice(archivedSpecsDir.length + 1); // "<capability>/spec.md" (or deeper)
		const targetPath = join(cwd, READYSET_ROOT, "specs", rel);
		const deltaRaw = await readFile(deltaSpec, "utf8").catch(() => "");
		if (!deltaRaw) continue;
		await mkdir(join(targetPath, ".."), { recursive: true });
		const targetExists = await exists(targetPath);
		if (!targetExists) {
			await writeFile(targetPath, deltaRaw, "utf8");
		} else {
			const existing = await readFile(targetPath, "utf8");
			await writeFile(targetPath, `${existing.trimEnd()}\n\n## From change: ${changeId}\n\n${deltaRaw}`, "utf8");
		}
		mergedSpecFiles.push(targetPath);
	}

	return { archivedDir, mergedSpecFiles };
}
