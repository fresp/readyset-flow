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
import { join, sep } from "node:path";
import { structuralCheckSummary } from "./readyset-structural-check.ts";

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

export type ViolationKind = "phase-write" | "self-archive";

export interface PhaseViolation {
	kind: ViolationKind;
	/** Repo-relative path for a write, or the archive destination for a self-archive. */
	path: string;
	detail: string;
}

/**
 * Phase-boundary invariant: while a planning turn (Explore or Propose) is in flight, nothing
 * outside the change's own directory and `.ai/brainstorms/` may change. T12 on the benchmark
 * ran a full implementation out of the Propose turn — editing src/, writing tests, writing
 * REVIEW.md, and archiving the change itself — then shipped with no approval. Prompt text says
 * "planning artifacts only"; this is the structural check that says it. Call it after a
 * planning turn fires, before the next phase; a non-empty result means stop, do not offer the
 * gate. Pure fs, no LLM involvement — it cannot be talked around.
 */
export async function checkPhaseViolations(
	cwd: string,
	changeId: string,
	changedPaths: string[],
): Promise<PhaseViolation[]> {
	const violations: PhaseViolation[] = [];

	for (const rawPath of changedPaths) {
		const abs = join(cwd, rawPath);
		const inChangeDir = abs.startsWith(join(cwd, READYSET_ROOT, "changes", changeId) + sep);
		// BRAINSTORM_DIR (".ai/brainstorms") lives in readyset-brainstorm.ts; hard-coded here
		// because readyset-brainstorm.ts imports from this file, so importing it back would be a
		// cycle. Kept in sync by the phase-boundary test below.
		const inBrainstorms = abs.startsWith(join(cwd, ".ai", "brainstorms") + sep);
		// An archive move is checked separately below (it is a rename the model performed
		// itself, not a path in a porcelain listing).
		if (inChangeDir || inBrainstorms) continue;
		violations.push({
			kind: "phase-write",
			path: rawPath,
			detail: `file outside readyset/changes/${changeId}/ and .ai/brainstorms/ changed during a planning turn`,
		});
	}

	// A change directory that moved into changes/archive/ without the extension firing
	// archiveChange is a self-archive: the turn skipped the gate by finishing the workflow
	// itself. In T12 the model archived to a dated name of its own choosing, so the check is
	// "is the live change dir gone", not "does a specific archive path exist".
	const paths = changePaths(cwd, changeId);
	if (!(await isDir(paths.dir))) {
		violations.push({
			kind: "self-archive",
			path: join(READYSET_ROOT, "changes", "archive"),
			detail: `change directory readyset/changes/${changeId}/ no longer exists — it was archived or moved without an approval decision`,
		});
	}

	return violations;
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

export interface ScopeContract {
	/** Repo-relative paths from the "## Files This Change Will Touch" section, or undefined when the section is absent. */
	files: string[] | undefined;
	/** Raw section body, for display in the gate. */
	raw: string | undefined;
}

/**
 * Reads the scope contract from proposal.md's "## Files This Change Will Touch" section. A
 * bullet or plain line naming a repo-relative path counts; prose lines that name no path do
 * not. Returns `files: undefined` when the section is absent entirely (older changes, or a
 * Propose turn that predates the contract) — callers treat that as "no contract", never as
 * "everything allowed".
 */
export async function readScopeContract(cwd: string, changeId: string): Promise<ScopeContract> {
	const paths = changePaths(cwd, changeId);
	const raw = await readFile(paths.proposal, "utf8").catch(() => undefined);
	if (raw === undefined) return { files: undefined, raw: undefined };
	const match = raw.match(/^##[ \t]*Files This Change Will Touch[ \t]*\r?$/im);
	if (!match || match.index === undefined) return { files: undefined, raw: undefined };
	const rest = raw.slice(match.index + match[0].length);
	const nextHeading = rest.match(/^##[ \t]/m);
	const body = (nextHeading && nextHeading.index !== undefined ? rest.slice(0, nextHeading.index) : rest).trim();
	if (!body) return { files: [], raw: body };
	const files: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		// Bullet ("- src/x.ts") or bare path ("src/x.ts"); strip inline commentary after " -- ".
		const stripped = line
			.replace(/^\s*[-*+]\s+/, "")
			.replace(/\s+--\s+.*$/, "")
			.trim()
			.replace(/^[`'"]+|[`'".,;:]+$/g, "");
		if (!stripped || /\s/.test(stripped)) continue;
		if (/^(src|test|tests|bin|examples|lib|docs|scripts|assets|resources|config)\//.test(stripped) || /^[\w.-]+\.(mjs|js|ts|mts|json|md|ya?ml|mjs)$/.test(stripped)) {
			files.push(stripped.replace(/^\.\//, ""));
		}
	}
	return { files, raw: body };
}

export interface ScopeCheck {
	/** Repo-relative paths outside the contract. Empty when everything is in scope. */
	outside: string[];
	/** True when there is no contract at all (section absent) — not a pass, an unknown. */
	noContract: boolean;
}

/**
 * Checks changed repo paths against the scope contract. Paths under readyset/ itself (the
 * change's own artifacts) and .ai/brainstorms/ are always in scope — they are the planning
 * workspace, not product code. Everything else must be named in the contract; an absent
 * contract is reported as noContract, never silently treated as a pass.
 */
export async function checkScope(cwd: string, changeId: string, changedPaths: string[]): Promise<ScopeCheck> {
	const contract = await readScopeContract(cwd, changeId);
	if (contract.files === undefined) return { outside: [], noContract: true };
	const allowed = new Set(contract.files.map((f) => join(cwd, f)));
	const outside: string[] = [];
	for (const rawPath of changedPaths) {
		const abs = join(cwd, rawPath);
		if (abs.startsWith(join(cwd, READYSET_ROOT) + sep)) continue;
		if (abs.startsWith(join(cwd, ".ai", "brainstorms") + sep)) continue;
		if (!allowed.has(abs)) outside.push(rawPath);
	}
	return { outside, noContract: false };
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
 * A THEN is observable when at least one of its lines names something checkable from outside
 * the code: an exit code, stdout/stderr text, an HTTP status, a file's content, a command's
 * real result — not a property of the source ("contains", "is inspected", "has no direct
 * calls"). A real UC2 run shipped "WHEN src/registry.ts is inspected THEN it contains no
 * direct filesystem calls" and the check passed it; no test or run could ever observe that.
 * This is still structural (it matches signal words, it does not understand the requirement),
 * so a vague-but-well-worded THEN can slip through — the bar is catching the uncheckable
 * kind, not certifying the good kind.
 */
function hasObservableThen(body: string): boolean {
	const lines = body.split(/\r?\n/);
	let sawThen = false;
	for (const line of lines) {
		if (/\*\*WHEN\*\*/i.test(line)) sawThen = false;
		if (/\*\*THEN\*\*/i.test(line)) sawThen = true;
		if (!sawThen) continue;
		const lower = line.toLowerCase();
		if (
			/\b(exit( code|s)?\b|exit\()/.test(lower) ||
			/stdout|stderr|output\b/.test(lower) ||
			/http\b|\bstatus\b|\b200\b|\b201\b|\b400\b|\b403\b|\b404\b|\b409\b|\b429\b|\b500\b|\b503\b/.test(lower) ||
			/file\b|writes? to|creates?|deletes?|contains the line|matches\b/.test(lower) ||
			/returns?\b|responds?\b|prints?\b|emits?\b|exits?\b|fails?\b|passes?\b|succeeds?\b|lists?\b/.test(lower) ||
			/`[^`]+`\s*(is|are|equals?|contains?|shows?|prints?|returns?)/.test(line)
		) {
			return true;
		}
	}
	return false;
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
					continue;
				}
				if (!hasObservableThen(req.body)) {
					issues.push({
						file: specFile,
						problem: `Requirement "${req.name}" has a THEN that no test or run could observe — describe an externally checkable behavior (exit code, stdout, HTTP status, file content), not a code property`,
					});
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
		summary: structuralCheckSummary({ kind: "validate", issueCount: issues.length, okDetail: "pass", issueNoun: "issue(s)" }),
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

const TASK_LINE_RE = /^\s*-\s*\[([ xX])\]\s*(\S+)/;

/** Maps each task's leading id token (the "N.M" `applyTurnPrompt` asks for, e.g. "2.1") to
 *  whether its checkbox is currently ticked. Used to correlate runtime evidence
 *  (readyset-evidence.ts) back to tasks.md's own completion state — kept here rather than in
 *  readyset-evidence.ts since it's a tasks.md-format concern like the other functions in this
 *  file, not an evidence-format concern. Returns an empty map if tasks.md doesn't exist; a
 *  task line without a recognizable id token is simply not included (best-effort, not a hard
 *  format requirement). */
export async function taskCheckedStates(cwd: string, changeId: string): Promise<Map<string, boolean>> {
	const paths = changePaths(cwd, changeId);
	const raw = await readFile(paths.tasks, "utf8").catch(() => undefined);
	const map = new Map<string, boolean>();
	if (raw === undefined) return map;
	for (const line of raw.split(/\r?\n/)) {
		const m = TASK_LINE_RE.exec(line);
		if (!m) continue;
		map.set(m[2], /[xX]/.test(m[1]));
	}
	return map;
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
	/**
	 * Requirements declared MODIFIED or REMOVED in a delta spec merged during this archive.
	 * `archiveChange`'s merge is (and stays) append-only — see its doc comment. For an ADDED
	 * requirement that's harmless: appending is genuinely correct. For MODIFIED/REMOVED it is
	 * NOT: the old requirement block in the canonical spec is left completely untouched, and
	 * the delta is appended as more text alongside it — so the canonical spec ends up
	 * containing both the old and new/removed text for the same requirement name, with
	 * nothing marking which is current. This list exists so the archive notification can warn
	 * specifically about THESE requirements (the ones actually at risk of being silently
	 * misleading) rather than a generic "review the merged spec" that reads the same whether
	 * the change only added things or actually needs manual cleanup.
	 */
	unappliedModifications: { specFile: string; verb: "MODIFIED" | "REMOVED"; requirement: string }[];
}

interface VerbSection {
	verb: "ADDED" | "MODIFIED" | "REMOVED";
	requirementNames: string[];
}

/** Splits a delta spec into its `## ADDED/MODIFIED/REMOVED Requirements` sections and lists
 *  the `### Requirement:` names declared under each — used only to warn about MODIFIED/REMOVED
 *  requirements that `archiveChange`'s append-only merge won't actually apply (see
 *  `ArchiveResult.unappliedModifications`). Not a general-purpose spec parser: it does not
 *  attempt to diff or apply anything, only to name what a human should double-check. */
function splitVerbSections(raw: string): VerbSection[] {
	const headingRe = /^##[ \t]*(ADDED|MODIFIED|REMOVED)[ \t]+Requirements\b/gim;
	const matches = [...raw.matchAll(headingRe)];
	const boundaryRe = /^##[ \t]/m; // next level-2 heading ends this section (### is not a match)

	return matches.map((m) => {
		const verb = m[1].toUpperCase() as VerbSection["verb"];
		const start = m.index! + m[0].length;
		const rest = raw.slice(start);
		const boundary = rest.match(boundaryRe);
		const end = boundary ? start + boundary.index! : raw.length;
		const body = raw.slice(start, end);
		const requirementNames = [...body.matchAll(/^###[ \t]*Requirement:[ \t]*(.+)$/gim)].map((r) => r[1].trim());
		return { verb, requirementNames };
	});
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
	const unappliedModifications: ArchiveResult["unappliedModifications"] = [];
	const archivedSpecsDir = join(archivedDir, "specs");
	const specFiles = await findSpecFiles(archivedSpecsDir).catch(() => [] as string[]);
	for (const deltaSpec of specFiles) {
		const rel = deltaSpec.slice(archivedSpecsDir.length + 1); // "<capability>/spec.md" (or deeper)
		const targetPath = join(cwd, READYSET_ROOT, "specs", rel);
		const deltaRaw = await readFile(deltaSpec, "utf8").catch(() => "");
		if (!deltaRaw) continue;

		for (const section of splitVerbSections(deltaRaw)) {
			if (section.verb === "ADDED") continue; // append is genuinely correct for ADDED -- nothing to warn about
			for (const requirement of section.requirementNames) {
				unappliedModifications.push({ specFile: targetPath, verb: section.verb, requirement });
			}
		}

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

	return { archivedDir, mergedSpecFiles, unappliedModifications };
}
