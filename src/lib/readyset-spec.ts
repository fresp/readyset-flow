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

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { structuralCheckSummary } from "./readyset-structural-check.ts";
import { parseFrontmatter } from "./readyset-brainstorm.ts";
import type { Clarity, Lane, RiskFlag } from "./readyset-brainstorm.ts";

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
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function isDir(path: string): Promise<boolean> {
	try {
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
 * model choosing to write anything useful into it (no phase prompt asks the model to).
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

/**
 * The set of repo-relative paths that were already dirty *before* this change's own planning
 * turns ever ran, so later `git status` reads can subtract them. Without this, any file that
 * is dirty for unrelated reasons (a WIP edit elsewhere, an untracked scratch note) gets
 * misattributed to the current change — hard-stopping a well-behaved run at the gate
 * invariant, or painting a false OUT-OF-SCOPE warning on every gate render.
 *
 * Stored as a marker entry inside CONTEXT.md rather than a separate dotfile: CONTEXT.md
 * already has a deterministic append path (this file's own appendContext), it rides along
 * automatically when the change is archived, and no new file can leak into the change dir
 * as something validateChange or findSpecFiles might trip over.
 */
export interface DirtyBaseline {
	/** Repo-relative paths that were dirty when the baseline was captured. */
	paths: string[];
	/** ISO timestamp of the capture. */
	capturedAt: string;
}

/** Marker line that opens the baseline entry inside CONTEXT.md. */
export const BASELINE_MARKER = "<!-- readyset-baseline-dirty -->";

/** Opening fence the writer uses for the baseline JSON, and the closing fence it pairs with. */
const BASELINE_FENCE_OPEN = "```json";
const BASELINE_FENCE_CLOSE = "```";

/**
 * Reads the baseline out of CONTEXT.md, scoped to the fence the writer itself created.
 *
 * Deliberately NOT "first `{` to last `}` in the rest of the file": CONTEXT.md is append-only
 * and the baseline is written once, before Explore even runs — every later phase entry lands
 * *after* the marker, and the Refine branch appends raw user feedback verbatim. A `}` in that
 * feedback (e.g. "make it return `{status: 'ok'}`") would become the outer brace, the slice
 * would span unrelated text, JSON.parse would throw, and readDirtyBaseline would silently
 * fall back to an empty set — quietly reverting to the pre-04cf4bb false-positive bug for the
 * rest of the run. Parsing between the fence markers is immune to whatever is appended later.
 */
function parseBaselineEntry(raw: string): DirtyBaseline | undefined {
	const idx = raw.indexOf(BASELINE_MARKER);
	if (idx === -1) return undefined;
	const after = raw.slice(idx + BASELINE_MARKER.length);
	const fenceStart = after.indexOf(BASELINE_FENCE_OPEN);
	if (fenceStart === -1) return undefined;
	const bodyStart = fenceStart + BASELINE_FENCE_OPEN.length;
	const fenceEnd = after.indexOf(BASELINE_FENCE_CLOSE, bodyStart);
	if (fenceEnd === -1) return undefined;
	const body = after.slice(bodyStart, fenceEnd).trim();
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed === null || typeof parsed !== "object") return undefined;
		const paths = (parsed as { paths?: unknown }).paths;
		const capturedAt = (parsed as { capturedAt?: unknown }).capturedAt;
		if (!Array.isArray(paths) || !paths.every((p): p is string => typeof p === "string")) return undefined;
		if (typeof capturedAt !== "string") return undefined;
		return { paths, capturedAt };
	} catch {
		return undefined;
	}
}

/**
 * Captures the currently-dirty paths as this change's baseline — but only if no baseline
 * exists yet. A later, dirtier tree must not widen what counts as pre-existing, so the
 * first capture wins and every later call is a no-op. Returns the stored baseline.
 */
export async function ensureDirtyBaseline(cwd: string, changeId: string, currentDirty: string[]): Promise<DirtyBaseline> {
	const paths = changePaths(cwd, changeId);
	const existing = await readFile(paths.context, "utf8").catch(() => undefined);
	if (existing !== undefined) {
		const parsed = parseBaselineEntry(existing);
		if (parsed !== undefined) return parsed;
	}
	const baseline: DirtyBaseline = { paths: [...currentDirty].sort(), capturedAt: new Date().toISOString() };
	const entry = `\n\n${BASELINE_MARKER}\n\`\`\`json\n${JSON.stringify(baseline)}\n\`\`\`\n`;
	const next =
		existing === undefined ? `# Context log\n${entry}` : `${existing.trimEnd()}\n${entry}`;
	await writeFile(paths.context, next, "utf8");
	return baseline;
}

/**
 * Reads this change's dirty baseline. Returns an empty set when there is none (a change that
 * predates this mechanism) or when it cannot be parsed — callers then fall back to the old
 * unbaselined behavior rather than crashing.
 */
export async function readDirtyBaseline(cwd: string, changeId: string): Promise<Set<string>> {
	const raw = await readFile(changePaths(cwd, changeId).context, "utf8").catch(() => undefined);
	if (raw === undefined) return new Set();
	const parsed = parseBaselineEntry(raw);
	return new Set(parsed?.paths ?? []);
}

/** True when this change actually has a captured dirty baseline. Distinguishes "the baseline was
 *  empty" from "there is no baseline at all" (an older change, or a failed capture) — the latter
 *  must not be read as "nothing was dirty before the run", or every pre-existing dirty file
 *  becomes a revert candidate. */
export async function hasDirtyBaseline(cwd: string, changeId: string): Promise<boolean> {
	const raw = await readFile(changePaths(cwd, changeId).context, "utf8").catch(() => undefined);
	if (raw === undefined) return false;
	return parseBaselineEntry(raw) !== undefined;
}

/** Marker line that opens the approve-base entry inside CONTEXT.md — `git rev-parse HEAD` at the
 *  moment the change was approved and execution was handed off. Recorded so later diffing (scope,
 *  review triggers, the Apply `end` event's diff stats) can measure against the commit the run
 *  actually started from, not just the working tree — commits made during a long-running handoff
 *  execution are otherwise invisible to a working-tree-only diff. Same fenced-JSON-inside-
 *  CONTEXT.md pattern as `BASELINE_MARKER`, for the same reasons (see its doc comment). */
export const APPROVE_BASE_MARKER = "<!-- readyset-approve-base -->";

interface ApproveBaseEntry {
	sha: string;
	capturedAt: string;
}

function parseApproveBaseEntry(raw: string): ApproveBaseEntry | undefined {
	const idx = raw.indexOf(APPROVE_BASE_MARKER);
	if (idx === -1) return undefined;
	const after = raw.slice(idx + APPROVE_BASE_MARKER.length);
	const fenceStart = after.indexOf(BASELINE_FENCE_OPEN);
	if (fenceStart === -1) return undefined;
	const bodyStart = fenceStart + BASELINE_FENCE_OPEN.length;
	const fenceEnd = after.indexOf(BASELINE_FENCE_CLOSE, bodyStart);
	if (fenceEnd === -1) return undefined;
	const body = after.slice(bodyStart, fenceEnd).trim();
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed === null || typeof parsed !== "object") return undefined;
		const sha = (parsed as { sha?: unknown }).sha;
		const capturedAt = (parsed as { capturedAt?: unknown }).capturedAt;
		if (typeof sha !== "string" || sha === "" || typeof capturedAt !== "string") return undefined;
		return { sha, capturedAt };
	} catch {
		return undefined;
	}
}

/** Records this change's approve-base commit — only if none is recorded yet (a Refine loop that
 *  re-approves after the first handoff already settled must not silently move the base forward).
 *  `sha` is `undefined` for a repo with no commits yet, in which case this is a no-op: there is no
 *  base to diff against, and callers fall back to their pre-base-tracking behavior. */
export async function writeApproveBase(cwd: string, changeId: string, sha: string | undefined): Promise<void> {
	if (!sha) return;
	const paths = changePaths(cwd, changeId);
	const existing = await readFile(paths.context, "utf8").catch(() => undefined);
	if (existing !== undefined && parseApproveBaseEntry(existing) !== undefined) return;
	const entry = `\n\n${APPROVE_BASE_MARKER}\n\`\`\`json\n${JSON.stringify({ sha, capturedAt: new Date().toISOString() })}\n\`\`\`\n`;
	const next = existing === undefined ? `# Context log${entry}` : `${existing.trimEnd()}\n${entry}`;
	await writeFile(paths.context, next, "utf8");
}

/** Reads this change's approve-base commit sha, or `undefined` when none was ever recorded (a
 *  change that predates this mechanism, or one whose approve base failed to write). */
export async function readApproveBase(cwd: string, changeId: string): Promise<string | undefined> {
	const raw = await readFile(changePaths(cwd, changeId).context, "utf8").catch(() => undefined);
	if (raw === undefined) return undefined;
	return parseApproveBaseEntry(raw)?.sha;
}

/** The phases a Readyset run records boundaries for. */
export type PhaseName =
	| "grill" | "explore" | "propose" | "refine" | "gate" | "apply" | "review" | "archive"
	| "contract-repair" | "scope-reconcile" | "trim" | "compact" | "review-fix";

/** One boundary event in the machine-parseable phase log. */
export interface PhaseEvent {
	phase: PhaseName;
	edge: "start" | "end";
	at: string;
	lane: "fast" | "full";
	laneSource: "flag" | "config-auto" | "user-pick" | "brainstorm";
	model?: string;
	outcome?: string;
	/** `scope-reconcile` only: drift counts for the bench. Also carries the review-fix turn's
	 *  blocking-finding counts (`blockingBefore`/`blockingAfter`). */
	counts?: { outsideBefore: number; reverted: number; justified: number; unjustifiedAfter: number; blockingBefore?: number; blockingAfter?: number };
	/** `apply` `end` only: final Apply diff size for the bench. */
	diff?: { files: number; added: number; deleted: number };
	/** `compact` only: which boundary this compaction preceded. */
	boundary?: "explore" | "propose" | "apply";
	/** `compact` only: context usage before/after when the host reported it. */
	context?: { beforePercent?: number; afterPercent?: number };
	/** `propose`/`trim` only: per-artifact character counts, for the bench's planning-size
	 *  report. `lane` on this same event already carries the lane, so the bench can split
	 *  planning size by lane. On `propose`, `before` and `after` are the same measurement
	 *  (the Propose turn's output) — a trim turn, which has its own event, is the only thing
	 *  that changes them afterward. */
	artifactChars?: { before: ArtifactSizes; after: ArtifactSizes };
	/** `grill` `end` only: the grilling signal behind this run's lane. */
	grill?: {
		clarity: Clarity;
		openDecisions?: number;
		questionsAsked?: number;
		recommendedLane: Lane;
		laneReason?: string;
		riskFlag?: RiskFlag;
	};
	/** `review` `end` only: how the risk-based review policy resolved for this run. */
	review?: {
		mode: "auto" | "always" | "never";
		/** One entry per trigger evaluated, in evaluateReviewTriggers' fixed order. Empty when the
		 *  mode was never/always (triggers were not evaluated). */
		triggersEvaluated: { name: string; fired: boolean; value: string }[];
		/** Names of the triggers that fired (subset of `triggersEvaluated`). */
		triggersFired: string[];
		outcome: "ran" | "skipped-no-trigger" | "skipped-flag" | "on-demand";
	};
	/** gate `end` only: how many items proposal.md's `## Open Decisions` still carried at approval. */
	openDecisions?: number;
	/** gate `end` only: how many tool calls this run observed reaching outside the repository
	 *  (stay-in-repo tripwire). Advisory — never blocks, never fails a phase. */
	outsideRepo?: number;
	/** gate `end` only: tool calls using a scratch directory under /tmp — reported, never part of
	 *  the headline `outsideRepo` count (stay-in-repo tripwire). Advisory. */
	outsideRepoTmp?: number;
}

/** Marker line that opens one phase-event entry inside CONTEXT.md. */
export const PHASE_MARKER = "<!-- readyset-phase -->";

/**
 * Appends one phase boundary event to this change's CONTEXT.md as its own marker entry, using the
 * same append path appendContext uses. Every entry is `PHASE_MARKER` followed by a one-line ```json
 * fence, so a reader can find each event's own fence without scanning the whole file (CONTEXT.md is
 * append-only and may later contain braces in raw user text — see parseBaselineEntry's doc comment).
 */
export async function appendPhaseEvent(cwd: string, changeId: string, event: PhaseEvent): Promise<void> {
	const paths = changePaths(cwd, changeId);
	const entry = `\n\n${PHASE_MARKER}\n\`\`\`json\n${JSON.stringify(event)}\n\`\`\`\n`;
	const existing = await readFile(paths.context, "utf8").catch(() => undefined);
	const next = existing === undefined ? `# Context log${entry}` : `${existing.trimEnd()}\n${entry}`;
	await writeFile(paths.context, next, "utf8");
}

/**
 * Parses a single marker entry's own ```json fence: the first PHASE_MARKER at or after `from`,
 * then the fence the writer itself created. Returns undefined when there is none or the JSON is
 * malformed. Never "first { to last }" — see parseBaselineEntry for why that breaks once later
 * entries (e.g. Refine feedback) contain braces.
 */
function parsePhaseEntry(raw: string, from: number): { event?: PhaseEvent; next: number } | undefined {
	const idx = raw.indexOf(PHASE_MARKER, from);
	if (idx === -1) return undefined;
	const searchFrom = idx + PHASE_MARKER.length;
	const fenceStart = raw.indexOf("```json", searchFrom);
	if (fenceStart === -1) return { next: searchFrom };
	const bodyStart = fenceStart + "```json".length;
	const fenceEnd = raw.indexOf("```", bodyStart);
	if (fenceEnd === -1) return { next: bodyStart };
	const body = raw.slice(bodyStart, fenceEnd).trim();
	const next = fenceEnd + 3;
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed === null || typeof parsed !== "object") return { next };
		const e = parsed as Partial<PhaseEvent>;
		if (typeof e.phase !== "string" || (e.edge !== "start" && e.edge !== "end")) return { next };
		if (typeof e.at !== "string" || typeof e.lane !== "string") return { next };
		return { event: e as PhaseEvent, next };
	} catch {
		return { next };
	}
}

/**
 * Reads this change's phase-event log in file order. Returns an empty array when there is none or
 * CONTEXT.md is unreadable. Malformed entries are skipped, never thrown.
 */
export async function readPhaseEvents(cwd: string, changeId: string): Promise<PhaseEvent[]> {
	const raw = await readFile(changePaths(cwd, changeId).context, "utf8").catch(() => undefined);
	if (raw === undefined) return [];
	const events: PhaseEvent[] = [];
	let cursor = 0;
	for (;;) {
		const found = parsePhaseEntry(raw, cursor);
		if (!found) break;
		if (found.event) events.push(found.event);
		cursor = found.next;
	}
	return events;
}

/**
 * True once this change has actually been applied at least once: the phase log has an `apply`
 * `end` event with outcome `"applied"`, or tasks.md already has one or more done tasks. Used to
 * switch contract checks to post-Apply semantics when the gate reopens after Apply (e.g. "Address
 * findings first" then /readyset again, or Refine after Apply) — otherwise every `(new)` file the
 * change created reads NEW-BUT-EXISTS and every `(delete)` file reads DELETE-BUT-MISSING.
 */
export async function hasBeenApplied(cwd: string, changeId: string): Promise<boolean> {
	const events = await readPhaseEvents(cwd, changeId);
	if (events.some((e) => e.phase === "apply" && e.edge === "end" && e.outcome === "applied")) return true;
	const progress = await getProgress(cwd, changeId);
	return (progress?.done ?? 0) > 0;
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
	/** Repo-relative paths from the "## Files This Change Will Touch" section that are NOT marked
	 *  `(new)` or `(delete)` — i.e. files that must already exist. Undefined when the section is
	 *  absent. */
	files: string[] | undefined;
	/** Repo-relative paths marked `(new)` — files this change will create. Always present (empty
	 *  when none are marked, or when there is no contract). */
	newFiles: string[];
	/** Repo-relative paths marked `(delete)` — files this change will delete. Must exist before
	 *  Apply and may be absent after it. Always present (empty when none are marked, or when there
	 *  is no contract). */
	deleteFiles: string[];
	/** Raw section body, for display in the gate. */
	raw: string | undefined;
}

/** The frontmatter key that records the lane on disk, in proposal.md. */
export const PROPOSAL_FRONTMATTER_LANE_KEY = "lane";

/** The lane a change runs on. Recorded on disk in proposal.md's frontmatter (see
 *  `readChangeLane`), so validate/archive/review can read it with no run context and no phase
 *  log — the standalone `readyset-flow validate` CLI included. */
export type ChangeLane = "fast" | "full";

/** Reads the lane from proposal.md's flat frontmatter (`lane: fast|full`). Returns "full"
 *  when proposal.md is missing/unreadable or the line is absent or unrecognized — the
 *  full-lane requirements are the safe default (validate asks for more, never less). */
export async function readChangeLane(cwd: string, changeId: string): Promise<ChangeLane> {
	const paths = changePaths(cwd, changeId);
	const raw = await readFile(paths.proposal, "utf8").catch(() => undefined);
	if (raw === undefined) return "full";
	const { meta } = parseFrontmatter(raw);
	const value = (meta[PROPOSAL_FRONTMATTER_LANE_KEY] ?? "").trim().toLowerCase();
	return value === "fast" ? "fast" : "full";
}

/** Result of parsing one line of a `## Files This Change Will Touch` body. */
export interface ContractLine {
	/** Repo-relative path, without any leading `./`, backticks, quotes, or bullet. */
	path: string;
	/** True when the commentary after the path contains a `(new)` marker. */
	isNew: boolean;
	/** True when the commentary after the path contains a `(delete)`/`(deleted)`/`(remove)`/
	 *  `(removed)` marker. Never true when `isNew` is true. */
	isDelete: boolean;
}

/**
 * Parses one line of a `## Files This Change Will Touch` body into a path, or returns undefined
 * when the line names no path (prose, a bold header, `None`, a URL).
 */
export function parseContractLine(line: string): ContractLine | undefined {
	let token = line.trim();
	// Strip a bullet or a list number: "- x", "* x", "+ x", "1. x", "1) x".
	token = token.replace(/^([-*+]|\d+[.)])\s+/, "");
	// Strip surrounding bold markers before reading the first token, so "**src/a.ts**" yields the
	// bare path rather than "**src/a.ts**".
	token = token.replace(/^\*+(?=\S)/, "").replace(/\*+$/, "").trim();
	// The path is the first whitespace-delimited token; everything after it is commentary,
	// whatever separator follows (" -- ", "—", "–", ": ", "(modified)", "(new)", ...).
	const match = token.match(/^(\S+)([\s\S]*)$/);
	if (!match) return undefined;
	const first = match[1];
	const commentary = match[2];
	const path = first
		.replace(/^[`'"]+/, "") // opening backtick/quote
		.replace(/[`'"]+$/, "") // closing backtick/quote
		.replace(/[.,;:]+$/, "") // trailing sentence punctuation
		.replace(/^\.\//, ""); // a leading "./" is noise, not part of the repo-relative path
	if (!looksLikePath(path)) return undefined;
	if (!path || path === "." || path === "..") return undefined;
	const isNew = /\(\s*new\b[^)]*\)/i.test(commentary);
	const isDelete = !isNew && /\(\s*(delete|deleted|remove|removed)\b[^)]*\)/i.test(commentary);
	return { path, isNew, isDelete };
}

// The previous implementation gated paths on a hard-coded directory whitelist
// (src|test|tests|bin|examples|lib|docs|scripts|assets|resources|config) plus a root-level
// JS/MD/YAML extension whitelist. Both were wrong for a language-agnostic tool: "app/handler.go",
// "packages/core/index.ts", ".github/workflows/ci.yml" and "Makefile" were silently dropped from
// the contract, which made checkScope report them OUT OF SCOPE once Apply touched them and made
// checkScopeRefs skip them entirely. The replacement decides from the token's own shape instead.

/** Known files that legitimately have no extension. */
const EXTENSIONLESS_FILES: Record<string, true> = {
	Makefile: true, GNUmakefile: true, Dockerfile: true, Containerfile: true, Jenkinsfile: true, Procfile: true,
	Gemfile: true, Rakefile: true, Brewfile: true, Vagrantfile: true, Justfile: true, justfile: true, Taskfile: true,
	LICENSE: true, CODEOWNERS: true,
};

/** Common prose slash-words that are not paths. Compared case-insensitively. */
const PROSE_SLASH_WORDS: Record<string, true> = {
	"n/a": true, "and/or": true, "either/or": true, "input/output": true, "read/write": true,
};

/**
 * Language-agnostic "is this token a file path?" test.
 */
function looksLikePath(token: string): boolean {
	if (token === "" || token === "." || token === "..") return false;
	if (/\s/.test(token)) return false;
	if (token.includes("://")) return false;
	if (token.startsWith("#")) return false; // an ATX heading is never a path
	if (PROSE_SLASH_WORDS[token.toLowerCase()]) return false; // "N/A", "and/or", ...
	if (EXTENSIONLESS_FILES[token]) return true;
	const base = token.slice(token.lastIndexOf("/") + 1);
	if (base.startsWith(".") && base.length > 1) return true; // dotfile: .gitignore, .env.example
	// A directory separator between path characters: "app/handler.go", ".github/workflows/ci.yml",
	// and extensionless files inside a directory ("bin/readyset-flow", "scripts/deploy").
	if (/^[\w.-]+\/[\w.-]/.test(token)) return true;
	// A root-level token must be "name.ext" with a 2+ char stem: reject "e.g"/"i.e", accept "go.mod".
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return false;
	const stem = base.slice(0, dot);
	const ext = base.slice(dot + 1);
	return stem.length >= 2 && ext.length >= 1;
}

/**
 * Reads the scope contract from proposal.md's `## Files This Change Will Touch` section; the body
 * runs until the next `##` heading. A line is a contract line when its first token — after an
 * optional `-`/`*`/`+` bullet or `1.`/`1)` list number, and after any surrounding `**` — looks
 * like a path (see `looksLikePath`). Everything after that first token is commentary, whatever the
 * separator (` -- `, an em/en dash, `: `, `(modified)`, ...).
 *
 * A `(new)` marker anywhere in that commentary (case-insensitive) marks a file this change creates
 * and is split into `newFiles`; an unmarked path means "must already exist" — the distinction
 * `checkScopeRefs` relies on to tell a dangling reference from a file that is simply new. Lines
 * whose first token is not a path (prose, `**Existing files:**`, `None`, a URL) are skipped. A
 * leading `./` is stripped; trailing `.,;:` and surrounding backticks/quotes are stripped too.
 * Returns `files: undefined` when the section is absent entirely (older changes, or a Propose turn
 * that predates the contract) — callers treat that as "no contract", never as "everything allowed".
 */
export async function readScopeContract(cwd: string, changeId: string): Promise<ScopeContract> {
	const paths = changePaths(cwd, changeId);
	const raw = await readFile(paths.proposal, "utf8").catch(() => undefined);
	if (raw === undefined) return { files: undefined, newFiles: [], deleteFiles: [], raw: undefined };
	const match = raw.match(/^##[ \t]*Files This Change Will Touch[ \t]*\r?$/im);
	if (!match || match.index === undefined) return { files: undefined, newFiles: [], deleteFiles: [], raw: undefined };
	const rest = raw.slice(match.index + match[0].length);
	const nextHeading = rest.match(/^##[ \t]/m);
	const body = (nextHeading && nextHeading.index !== undefined ? rest.slice(0, nextHeading.index) : rest).trim();
	if (!body) return { files: [], newFiles: [], deleteFiles: [], raw: body };
	const files: string[] = [];
	const newFiles: string[] = [];
	const deleteFiles: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		const parsed = parseContractLine(line);
		if (parsed === undefined) continue;
		if (parsed.isNew) newFiles.push(parsed.path);
		else if (parsed.isDelete) deleteFiles.push(parsed.path);
		else files.push(parsed.path);
	}
	return { files, newFiles, deleteFiles, raw: body };
}

/** One entry from tasks.md's `## Scope deviations` section: a file changed outside the contract,
 *  with the model's one-line reason. */
export interface ScopeDeviation {
	/** Repo-relative path, normalized the same way `parseContractLine` normalizes a contract path. */
	path: string;
	/** The commentary after the path — the model's reason. Empty when the line names a path only. */
	reason: string;
}

/**
 * Parses the `## Scope deviations` section of tasks.md: one bullet per out-of-contract file the
 * Apply turn touched, as `- <path> — <reason>` (any separator: ` -- `, an em/en dash, `: `, or
 * nothing). The path is read with `parseContractLine`'s own path rules (bullets, backticks, quotes,
 * `**` and a leading `./` all stripped; a non-path first token is skipped), so a deviation line is
 * written exactly like a scope-contract line plus a reason. The section body runs to the next `##`
 * heading. Returns an empty array when the file or section is absent — an absent section means "no
 * deviations declared", never an error.
 */
export async function readScopeDeviations(cwd: string, changeId: string): Promise<ScopeDeviation[]> {
	const raw = await readFile(changePaths(cwd, changeId).tasks, "utf8").catch(() => undefined);
	if (raw === undefined) return [];
	const match = raw.match(/^##[ \t]*Scope deviations[ \t]*\r?$/im);
	if (!match || match.index === undefined) return [];
	const rest = raw.slice(match.index + match[0].length);
	const nextHeading = rest.match(/^##[ \t]/m);
	const body = (nextHeading && nextHeading.index !== undefined ? rest.slice(0, nextHeading.index) : rest).trim();
	if (!body) return [];
	const deviations: ScopeDeviation[] = [];
	for (const line of body.split(/\r?\n/)) {
		const parsed = parseContractLine(line);
		if (parsed === undefined) continue;
		// `parseContractLine` strips a trailing backtick/quote only when it is the last character, so a
		// wrapped path followed by a separator (`` `src/b.ts`: ``) keeps them. Strip the wrappers and
		// trailing punctuation here so the path matches what `checkScope` reports for the same file.
		const path = parsed.path.replace(/^[`'"*]+/, "").replace(/[`'"*]+$/, "").replace(/[.,;:]+$/, "");
		if (path === "") continue;
		// Recover the trailing reason from the raw line: everything after the path token, with the
		// separator (and any wrapper leftovers) removed.
		const idx = line.indexOf(path);
		const reason = idx === -1 ? "" : line.slice(idx + path.length).replace(/^[\s:`'"*—–-]+/, "").replace(/[\s`'"*.]+$/, "").trim();
		deviations.push({ path, reason });
	}
	return deviations;
}

/** Body of a `## <heading>` (level-2 only) section, up to the next level-2 heading — unlike
 *  `sectionBody`, level-3 sub-headings inside stay in the body. Used for `## Open Decisions`,
 *  whose items are `### <question>` blocks. */
function level2Body(raw: string, heading: string): string {
	const re = new RegExp(`^##[ \\t]*${heading}[ \\t]*$`, "im");
	const match = raw.match(re);
	if (!match || match.index === undefined) return "";
	const rest = raw.slice(match.index + match[0].length);
	const boundary = rest.match(/^##[ \t]/m);
	return (boundary && boundary.index !== undefined ? rest.slice(0, boundary.index) : rest).trim();
}

/** One item from proposal.md's `## Open Decisions` section. */
export interface OpenDecision {
	/** The `### <question>` heading text. */
	question: string;
	/** The recommended option, parsed from a `- Recommended:` line. Undefined when absent. */
	recommended?: string;
	/** The raw block body, for display in the gate. */
	raw: string;
}

/** Parses proposal.md's `## Open Decisions` section. Two formats are accepted: one
 *  `### <question>` block per decision, each optionally carrying a `- Recommended: ...` line, or
 *  top-level `- <question>` bullets (inline `Recommended: <option>` on the same line, or on the
 *  lines that follow). Returns [] when the section is absent or empty, or when its only content
 *  is "none" — an older change (or a proposal that wrote no section) reads exactly as it did
 *  before. */
export async function readOpenDecisions(cwd: string, changeId: string): Promise<OpenDecision[]> {
	const raw = await readFile(changePaths(cwd, changeId).proposal, "utf8").catch(() => undefined);
	if (raw === undefined) return [];
	const body = level2Body(raw, "Open Decisions");
	if (!body || /^none\b/i.test(body.trim())) return [];
	const decisions: OpenDecision[] = [];
	// Split on `###` headings; text before the first heading is ignored.
	const blocks = body.split(/^###[ \t]+/m).slice(1);
	for (const block of blocks) {
		const nl = block.indexOf("\n");
		const question = (nl === -1 ? block : block.slice(0, nl)).trim();
		const rest = nl === -1 ? "" : block.slice(nl + 1).trim();
		if (question === "") continue;
		const recommended = rest.match(/^[-*][ \t]*Recommended[ \t]*:[ \t]*(.+)$/im)?.[1]?.trim();
		decisions.push({ question, recommended, raw: rest });
	}
	// Bullet format: blank the headed spans, then read top-level bullets from the remainder.
	const remainder = body.replace(/^###[ \t]+.*(?:\r?\n(?!(?:###|##)[ \t]).*)*/gm, "");
	const lines = remainder.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const bullet = lines[i].match(/^[-*][ \t]+(.+)$/);
		if (!bullet) continue;
		const text = bullet[1].trim();
		if (text === "" || /^none\b/i.test(text) || /\*\*WHEN\*\*/i.test(text)) continue;
		const inline = text.match(/\bRecommended\s*:\s*(.+)$/i);
		if (inline) {
			const question = text.slice(0, inline.index ?? text.length).replace(/[—–-]\s*$/, "").trim();
			if (question === "") continue;
			decisions.push({ question, recommended: inline[1].trim(), raw: text });
			continue;
		}
		const restLines: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j];
			if (/^[-*][ \t]/.test(next) || /^#{1,6}[ \t]/.test(next)) break;
			restLines.push(next);
		}
		const rest = restLines.join("\n").trim();
		const recommended = rest.match(/^[ \t]*[-*][ \t]*Recommended[ \t]*:[ \t]*(.+)$/im)?.[1]?.trim();
		decisions.push({ question: text, recommended, raw: rest });
	}
	return decisions;
}

/** The body of proposal.md's `## Assumptions` section, or undefined when absent/empty/"none".
 *  Level-2 extraction (see `level2Body`) so a nested `###` line stays in the body. */
export async function readAssumptions(cwd: string, changeId: string): Promise<string | undefined> {
	const raw = await readFile(changePaths(cwd, changeId).proposal, "utf8").catch(() => undefined);
	if (raw === undefined) return undefined;
	const body = level2Body(raw, "Assumptions");
	if (!body || /^none\b/i.test(body)) return undefined;
	return body;
}

/** Scenarios (full lane, from specs/**\/spec.md) or fast-lane `## Acceptance` bullets whose text
 *  carries an `(assumed)` marker. Used by the gate to show assumptions before approval. Returns
 *  [] when nothing is marked. */
export async function readAssumedScenarios(cwd: string, changeId: string): Promise<string[]> {
	const lane = await readChangeLane(cwd, changeId);
	if (lane === "fast") {
		const raw = await readFile(changePaths(cwd, changeId).proposal, "utf8").catch(() => undefined);
		if (raw === undefined) return [];
		const acceptance = sectionBody(raw, "Acceptance");
		if (!acceptance) return [];
		return acceptance
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => /^[-*][ \t]+\*\*WHEN\*\*/i.test(line) && /\(assumed\)/i.test(line));
	}
	const specsDir = changePaths(cwd, changeId).specsDir;
	const assumed: string[] = [];
	for (const specFile of await findSpecFiles(specsDir)) {
		const raw = await readFile(specFile, "utf8").catch(() => undefined);
		if (raw === undefined) continue;
		const blocks = raw.split(/^####[ \t]+Scenario:[ \t]*/m).slice(1);
		for (const block of blocks) {
			const firstLine = (block.split(/\r?\n/, 1)[0] ?? "").trim();
			if (firstLine !== "" && /\(assumed\)/i.test(firstLine)) assumed.push(firstLine);
		}
	}
	return assumed;
}

/** Doc files a change's request/brainstorm text mentions. Scans the given text for the doc
 *  vocabulary (README, CHANGELOG, "docs", "document", "release note", "migration guide",
 *  "deprecation") and returns the concrete doc path names found, lower-cased for comparison:
 *  "readme", "changelog", or "docs/" when the word "docs"/"documentation" appears without a
 *  concrete file. */
export function docMentions(text: string): string[] {
	const found = new Set<string>();
	const re = /\b(README(?:\.md)?|CHANGELOG(?:\.md)?|docs?\/|documentation|release notes?|migration guide|deprecat\w*)\b/gi;
	for (const match of text.matchAll(re)) {
		const raw = match[0].toLowerCase();
		if (raw.startsWith("readme")) found.add("readme");
		else if (raw.startsWith("changelog")) found.add("changelog");
		else if (raw.startsWith("doc/") || raw.startsWith("docs/") || raw.startsWith("documentation")) found.add("docs/");
		else if (raw.startsWith("release note")) found.add("release notes");
		else if (raw.startsWith("migration guide")) found.add("migration guide");
		else if (raw.startsWith("deprecat")) found.add("deprecation");
	}
	return [...found].sort();
}

/** The original request text a brainstorm carries: the body of its `## Problem / Context`
 *  section. No raw request is persisted anywhere, so this is the closest on-disk stand-in —
 *  a brainstorm without that section contributes nothing. */
export function brainstormRequestText(raw: string): string {
	return level2Body(parseFrontmatter(raw).body, "Problem / Context");
}

/** The decision-bearing sections of a brainstorm — `Scope`, `Acceptance Criteria`, and
 *  `Decision` bodies joined with blank lines. Notes/constraints/context sections are
 *  deliberately excluded: a doc cited there is context, not a request. */
export function brainstormDecisionText(raw: string): string {
	const body = parseFrontmatter(raw).body;
	return ["Scope", "Acceptance Criteria", "Decision"]
		.map((heading) => level2Body(body, heading))
		.filter((text) => text !== "")
		.join("\n\n");
}

/** Doc paths a request/decision text actually *asks for*, as opposed to merely mentions. A
 *  concrete doc token (README/CHANGELOG/docs//documentation) counts only when its own sentence
 *  window carries an action verb and no negation — so "README says rounding is half-up" and
 *  "don't touch the README" both yield nothing. Returns only the repair set: "readme",
 *  "changelog", "docs/". Migration/release/deprecation mentions are advisory only (see
 *  `findDocFileWarnings`), never repair items. */
export function docRequests(text: string): string[] {
	const found = new Set<string>();
	const re = /\b(README(?:\.md)?|CHANGELOG(?:\.md)?|docs?\/|documentation)\b/gi;
	for (const match of text.matchAll(re)) {
		const raw = match[0].toLowerCase();
		const name = raw.startsWith("readme")
			? "readme"
			: raw.startsWith("changelog")
				? "changelog"
				: "docs/";
		const before = text.slice(0, match.index ?? 0);
		const sentenceStart = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n"));
		const window = before.slice(sentenceStart + 1).slice(-160);
		if (/\b(?:add|update|document|write|mention|record|include|revise|change|modify|create|reflect|capture|describe)\b/i.test(window) &&
			!/\b(?:don't|do not|doesn't|does not|never|no need|without|not|n't|skip|avoid|leave|untouched)\b/i.test(window)) {
			found.add(name);
		}
	}
	return [...found].sort();
}

/** Doc requests (docRequests) that are NOT named anywhere in proposal.md's
 *  `## Files This Change Will Touch` contract. Each is reported as
 *  `requested doc missing from contract: <name>`. Only README/CHANGELOG/docs/ can be repair
 *  items — migration/release/deprecation mentions are advisory (`findDocFileWarnings`). */
export async function findMissingRequestedDocs(cwd: string, changeId: string, requestText: string, brainstormRaw: string): Promise<string[]> {
	const mentions = [...new Set([...docRequests(requestText), ...docRequests(brainstormDecisionText(brainstormRaw))])];
	if (mentions.length === 0) return [];
	const contract = await readScopeContract(cwd, changeId);
	if (contract.files === undefined) return [];
	const entries = [...contract.files, ...contract.newFiles, ...contract.deleteFiles].map((p) => p.toLowerCase());
	const named = (name: string): boolean => {
		if (name === "docs/") return entries.some((e) => e.startsWith("docs/") || e.includes("/docs/"));
		return entries.some((e) => {
			const base = e.split("/").pop() ?? e;
			return base === `${name}.md` || base === name || base.startsWith(name) || e.includes(name);
		});
	};
	return mentions.filter((m) => !named(m)).map((m) => m);
}

/** Advisory warnings for migration/release/deprecation docs a request or decision text mentions
 *  with no matching contract entry or on-disk file. One string per kind; never a repair item.
 *  Returns [] when the contract section is absent. */
export async function findDocFileWarnings(cwd: string, changeId: string, requestText: string, brainstormRaw: string): Promise<string[]> {
	const text = `${requestText}\n\n${brainstormDecisionText(brainstormRaw)}`;
	const contract = await readScopeContract(cwd, changeId);
	if (contract.files === undefined) return [];
	const entries = [...contract.files, ...contract.newFiles, ...contract.deleteFiles].map((p) => p.toLowerCase());
	const kinds = [
		{ kind: "migration guide", mention: /migrat\w*/i, file: /migrat/i },
		{ kind: "release notes", mention: /release notes?/i, file: /release[-_ ]?notes?/i },
		{ kind: "deprecation", mention: /deprecat\w*/i, file: /deprecat/i },
	];
	const warnings: string[] = [];
	for (const { kind, mention, file } of kinds) {
		if (!mention.test(text)) continue;
		const inContract = entries.some((e) => file.test(e));
		const onDisk = inContract ? true : await hasMatchingFile(cwd, file);
		if (inContract || onDisk) continue;
		warnings.push(`requested ${kind} has no matching contract entry or existing file — warning only, not a repair item`);
	}
	return warnings;
}

/** Recursively checks whether any file's basename under `cwd` matches `pattern`. Skips the
 *  directories that are never doc homes (node_modules, .git, readyset, .ai). */
async function hasMatchingFile(cwd: string, pattern: RegExp): Promise<boolean> {
	const skip = new Set(["node_modules", ".git", "readyset", ".ai"]);
	async function walk(dir: string): Promise<boolean> {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (skip.has(entry.name)) continue;
				if (await walk(join(dir, entry.name))) return true;
			} else if (pattern.test(entry.name)) {
				return true;
			}
		}
		return false;
	}
	return walk(cwd);
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
 *
 * A contract entry ending in `/`, or one that is an existing directory, means "anything under
 * it" and matches by prefix (in addition to an exact match on the normalized entry).
 */
export async function checkScope(cwd: string, changeId: string, changedPaths: string[]): Promise<ScopeCheck> {
	const contract = await readScopeContract(cwd, changeId);
	if (contract.files === undefined) return { outside: [], noContract: true };
	// New files are in scope too — Apply is allowed to create anything the contract names as
	// `(new)`, not just modify files that already exist.
	const entries = [...contract.files, ...contract.newFiles, ...contract.deleteFiles];
	const allowed = new Set(entries.map((f) => join(cwd, f)));
	// A trailing `/` (or a real directory on disk) widens the entry to a prefix match.
	const prefixes = new Set<string>();
	for (const entry of entries) {
		const normalized = entry.replace(/\/+$/, "");
		if (entry.endsWith("/") || (await isDir(join(cwd, normalized)))) prefixes.add(normalized);
	}
	const outside: string[] = [];
	for (const rawPath of changedPaths) {
		const abs = join(cwd, rawPath);
		if (abs.startsWith(join(cwd, READYSET_ROOT) + sep)) continue;
		if (abs.startsWith(join(cwd, ".ai", "brainstorms") + sep)) continue;
		if (allowed.has(abs)) continue;
		const rel = rawPath.replace(/\/+$/, "");
		if ([...prefixes].some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
		outside.push(rawPath);
	}
	return { outside, noContract: false };
}

export interface ScopeRefs {
	/** Contract paths (not marked `(new)`/`(delete)`) that don't exist on the filesystem. Empty
	 *  when all resolve. */
	missing: string[];
	/** Paths marked `(new)` that already exist — the plan would overwrite a real file believing it
	 *  creates one. Empty when none. */
	newButExists: string[];
	/** Paths marked `(delete)` that don't exist — there is nothing to delete. Empty when none, and
	 *  always empty when `afterApply` is set. */
	deleteButMissing: string[];
	/** True when there is no contract at all (section absent) — not a pass, an unknown. */
	noContract: boolean;
}

/**
 * Stats every path in the scope contract that isn't marked `(new)` and reports the ones that
 * don't exist. A `(new)` path is a file the change will create, so its absence now is expected,
 * not a dangling reference; an unmarked path claims the file already exists, so if it doesn't the
 * plan named a file to modify that isn't there. Advisory, mirroring `checkScope` — it flags, it
 * never blocks. The section-absent case is reported as noContract, never as a pass. A `(new)` path
 * that already exists (`newButExists`) means the plan would overwrite a real file believing it
 * creates one. A `(delete)` path that doesn't exist is reported as `deleteButMissing` — unless
 * `options.afterApply` is set, in which case a deleted file's absence is the expected outcome, not
 * a problem.
 */
export async function checkScopeRefs(
	cwd: string,
	changeId: string,
	options: { afterApply?: boolean } = {},
): Promise<ScopeRefs> {
	const contract = await readScopeContract(cwd, changeId);
	if (contract.files === undefined) {
		return { missing: [], newButExists: [], deleteButMissing: [], noContract: true };
	}
	const missing: string[] = [];
	for (const f of contract.files) {
		if (!(await exists(join(cwd, f)))) missing.push(f);
	}
	const newButExists: string[] = [];
	for (const f of contract.newFiles) {
		if (await exists(join(cwd, f))) newButExists.push(f);
	}
	const deleteButMissing: string[] = [];
	if (!options.afterApply) {
		for (const f of contract.deleteFiles) {
			if (!(await exists(join(cwd, f)))) deleteButMissing.push(f);
		}
	}
	return { missing, newButExists, deleteButMissing, noContract: false };
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

/** Character counts per artifact for one change: proposal.md and tasks.md by their raw
 *  text length, specs by the SUM of every specs/**\/spec.md. An absent file has no key
 *  (proposal/design/tasks) or contributes 0 (specs). */
export interface ArtifactSizes { proposal?: number; design?: number; specs: number; tasks?: number }

/** Measures this change's artifact sizes. Pure fs work (no LLM turn); used by the Propose
 *  prompt's budgets, the gate's overrun line, and the bounded Trim turn's before/after report. */
export async function readArtifactSizes(cwd: string, changeId: string): Promise<ArtifactSizes> {
	const paths = changePaths(cwd, changeId);
	const [proposalRaw, designRaw, tasksRaw] = await Promise.all([
		readFile(paths.proposal, "utf8").catch(() => undefined),
		readFile(paths.design, "utf8").catch(() => undefined),
		readFile(paths.tasks, "utf8").catch(() => undefined),
	]);
	let specs = 0;
	for (const specFile of await findSpecFiles(paths.specsDir)) {
		const raw = await readFile(specFile, "utf8").catch(() => undefined);
		if (raw !== undefined) specs += raw.length;
	}
	const sizes: ArtifactSizes = { specs };
	if (proposalRaw !== undefined) sizes.proposal = proposalRaw.length;
	if (designRaw !== undefined) sizes.design = designRaw.length;
	if (tasksRaw !== undefined) sizes.tasks = tasksRaw.length;
	return sizes;
}

/**
 * Extracts the body of a `## <heading>` (or `###`) section: from just after the heading line up
 * to the next `#{}`-level heading or EOF. Used by the fast-lane Acceptance check to hand
 * `hasObservableThen` the section text the same way the spec-delta check hands it a requirement
 * block's body. Heading match is exact (case-insensitive), not a substring: `## Acceptance` does
 * not match `## Acceptance Criteria Extra`.
 */
function sectionBody(raw: string, heading: string): string {
	const re = new RegExp(`^#{2,3}[ \\t]*${heading}[ \\t]*$`, "im");
	const match = raw.match(re);
	if (!match || match.index === undefined) return "";
	const rest = raw.slice(match.index + match[0].length);
	const boundary = rest.match(/^#{2,3}[ \t]/m);
	return (boundary && boundary.index !== undefined ? rest.slice(0, boundary.index) : rest).trim();
}

/** Readyset-internal vocabulary that must not appear in an artifact's body — the implementer-facing
 *  plan is about the user's repo, not about Readyset's own workflow. Small, closed list. */
const INTERNAL_TERMS = ["readyset/changes", "EXPLORATION.md", "CONTEXT.md", "lane", "review gate", "spec delta", "readyset-review", "expectedTouch"];

/** Body text of `raw` with its trailing `## Grounding` section removed, so a legitimate grounding
 *  anchor does not trip the check. A leading YAML frontmatter block is also removed: proposal.md's
 *  required `lane:` line is metadata, not artifact prose, and must not itself trip the `lane` term. */
function bodyWithoutGrounding(raw: string): string {
	const withoutFrontmatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
	const idx = withoutFrontmatter.search(/^##[ \t]*Grounding[ \t]*$/im);
	return idx === -1 ? withoutFrontmatter : withoutFrontmatter.slice(0, idx);
}

/** A case-insensitive matcher for one internal term. `lane` needs word boundaries so ordinary
 *  prose like `planes` does not trip it; the other terms are matched as literal substrings. */
function internalTermPattern(term: string): RegExp {
	if (term === "lane") return /\blane\b/i;
	return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/** Advisory: one issue per internal term found in a body outside `## Grounding`. */
function internalTermIssues(file: string, raw: string): ValidationIssue[] {
	const body = bodyWithoutGrounding(raw);
	const issues: ValidationIssue[] = [];
	for (const term of INTERNAL_TERMS) {
		if (internalTermPattern(term).test(body)) {
			issues.push({ file, problem: `body mentions Readyset-internal term "${term}" outside a ## Grounding section` });
		}
	}
	return issues;
}

/**
 * Structural validation — not a real schema check (see file header), but scoped per
 * requirement rather than per file (see `splitRequirementBlocks`). The required set depends on
 * the change's lane (read from proposal.md's `lane:` frontmatter; see `readChangeLane`):
 *
 * Full lane (the default):
 *   - proposal.md exists with a "## Why" and a "## What Changes" section
 *   - at least one specs/<capability>/spec.md exists
 *   - each spec.md has at least one "## ADDED/MODIFIED/REMOVED Requirements" section —
 *     openspec's own delta-spec convention this format is modeled on, and the thing that
 *     makes a spec a *delta* against `readyset/specs/` rather than an unscoped restatement
 *   - each spec.md has at least one "### Requirement:", and EVERY one of them individually
 *     carries its own WHEN and THEN — not just one requirement in the file having a scenario
 *     while its siblings have none
 *   - tasks.md exists with at least one checkbox line
 *
 * Fast lane (proposal.md carries `lane: fast`):
 *   - proposal.md exists with "## Why", "## What Changes", "## Files This Change Will Touch",
 *     and "## Acceptance" sections
 *   - the "## Acceptance" body has at least one observable WHEN/THEN pair (same observability
 *     rule the full lane's spec-delta check applies)
 *   - tasks.md exists with at least one checkbox line
 *   - no specs/ requirement at all — the fast lane carries no delta spec
 *
 * design.md is not checked on either lane (it never was).
 */
export async function validateChange(cwd: string, changeId: string, lane?: ChangeLane): Promise<ValidateResult> {
	const paths = changePaths(cwd, changeId);
	const issues: ValidationIssue[] = [];
	const effectiveLane = lane ?? (await readChangeLane(cwd, changeId));
	const proposalRaw = (await readFile(paths.proposal, "utf8").catch(() => undefined)) as string | undefined;

	if (effectiveLane === "fast") {
		if (proposalRaw === undefined) {
			issues.push({ file: "proposal.md", problem: "missing" });
		} else {
			if (!/^##\s*Why\b/im.test(proposalRaw)) issues.push({ file: "proposal.md", problem: "missing '## Why' section (fast lane)" });
			if (!/^##\s*What Changes\b/im.test(proposalRaw))
				issues.push({ file: "proposal.md", problem: "missing '## What Changes' section (fast lane)" });
			if (!/^##[ \t]*Files This Change Will Touch[ \t]*\r?$/im.test(proposalRaw))
				issues.push({ file: "proposal.md", problem: "missing '## Files This Change Will Touch' section (fast lane)" });
			if (!/^#{2,3}[ \t]*Acceptance[ \t]*$/im.test(proposalRaw)) {
				issues.push({ file: "proposal.md", problem: "missing '## Acceptance' section (fast lane)" });
			} else {
				const acceptance = sectionBody(proposalRaw, "Acceptance");
				// Fast lane deliberately does NOT require `[Sn]` scenario ids — only >=1 observable
				// WHEN/THEN pair. Do not add an id requirement here.
				const hasWhen = /\*\*WHEN\*\*/im.test(acceptance);
				const hasThen = /\*\*THEN\*\*/im.test(acceptance);
				if (!hasWhen || !hasThen) {
					issues.push({ file: "proposal.md", problem: "fast lane: '## Acceptance' has no WHEN/THEN scenario" });
				} else if (!hasObservableThen(acceptance)) {
					// Same observability rule the full lane's spec-delta check uses (hasObservableThen).
					issues.push({
						file: "proposal.md",
						problem: "fast lane: '## Acceptance' has a THEN that no test or run could observe — describe an externally checkable behavior (exit code, stdout, HTTP status, file content), not a code property",
					});
				}
			}
		}
		// Fast lane: no specs/ requirement at all — do not run findSpecFiles, do not push a
		// specs/ issue. A stray spec file under a fast-lane change is not merged at archive either
		// (see archiveChange), so it is simply out of scope for this lane.
	} else {
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
				issues.push(...internalTermIssues(specFile, raw));

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
	}

	// Open decisions must not slip through the gate: every decision in proposal.md's
	// `## Open Decisions` must name a recommended option, or the user is approving a plan whose
	// behavior is still undecided. Warning-only (a `ValidationIssue`), consistent with the rest.
	if (proposalRaw !== undefined) {
		const decisions = await readOpenDecisions(cwd, changeId);
		for (const d of decisions) {
			if (d.recommended === undefined || d.recommended === "") {
				issues.push({ file: "proposal.md", problem: `open decision "${d.question}" has no recommended option` });
			}
		}
		if (decisions.length === 0) {
			const openBody = level2Body(proposalRaw, "Open Decisions").trim();
			if (openBody !== "" && !/^none\b/i.test(openBody)) {
				issues.push({ file: "proposal.md", problem: "open decisions section has content but no parsable decisions" });
			}
		}
		issues.push(...internalTermIssues("proposal.md", proposalRaw));
	}

	const tasksRaw = (await readFile(paths.tasks, "utf8").catch(() => undefined)) as string | undefined;
	const designRaw = await readFile(paths.design, "utf8").catch(() => undefined);
	if (designRaw !== undefined) issues.push(...internalTermIssues("design.md", designRaw));
	if (tasksRaw === undefined) {
		issues.push({ file: "tasks.md", problem: "missing" });
	} else {
		if (!/^\s*-\s*\[[ xX]\]/m.test(tasksRaw)) {
			issues.push({ file: "tasks.md", problem: "no checkbox items found" });
		}
		issues.push(...internalTermIssues("tasks.md", tasksRaw));
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
	/** Checked tasks whose `_Verified:` note text names a runnable command (a backticked span, or a
	 *  leading token matching a known runner). Used by the review's `no-evidence` trigger. */
	withCommandNote: number;
}

/**
 * TDD-style check: a task marked `- [x]` is only as trustworthy as the evidence attached to
 * it. This counts, among checked tasks, how many are immediately followed by a line starting
 * with `_Verified:` (the note format `applyTurnPrompt` asks the model to leave — the actual
 * command run and its result). The note may also be written as a sub-bullet
 * (`  - _Verified: …_`, `*` or `+` too): models reach for that form often, and treating it as
 * missing made the `session_stop` gate block a run that had in fact verified every task. This is
 * still just a structural check (a note that says
 * "_Verified: ran it, looks fine_" passes exactly the same as one with real command output
 * pasted in) — it cannot confirm the verification is genuine, only that one was left. Surface
 * the `missing` count to the user; a run of checked tasks with no verification notes at all
 * is a strong signal the model claimed completion without checking.
 */
/** A `_Verified:` note line: indented, optionally as a `-`/`*`/`+` sub-bullet. */
const VERIFIED_NOTE_RE = /^\s*(?:[-*+]\s+)?_Verified:/i;
/** The same prefix plus trailing whitespace, stripped to get at the note's own text. */
const VERIFIED_NOTE_PREFIX_RE = /^\s*(?:[-*+]\s+)?_Verified:\s*/i;

export async function checkTaskVerification(cwd: string, changeId: string): Promise<VerificationCheck | undefined> {
	const paths = changePaths(cwd, changeId);
	const raw = await readFile(paths.tasks, "utf8").catch(() => undefined);
	if (raw === undefined) return undefined;
	const lines = raw.split(/\r?\n/);
	let checkedTasks = 0;
	let withVerificationNote = 0;
	let withCommandNote = 0;
	for (let i = 0; i < lines.length; i++) {
		if (!/^\s*-\s*\[[xX]\]/.test(lines[i])) continue;
		checkedTasks++;
		// The note may be the very next non-blank line, indented under the task.
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim() === "") continue;
			if (/^\s*-\s*\[[ xX]\]/.test(lines[j])) break; // hit the next task, no note found
			if (VERIFIED_NOTE_RE.test(lines[j])) {
				withVerificationNote++;
				if (noteNamesCommand(lines[j])) withCommandNote++;
			}
			break;
		}
	}
	return { checkedTasks, withVerificationNote, missing: checkedTasks - withVerificationNote, withCommandNote };
}

/** Heuristic: does a `_Verified:` note line name a runnable command? True when it contains a
 *  backticked span, or its text after `_Verified:` starts with a known runner token. Used only to
 *  decide whether the review's `no-evidence` trigger is satisfied — a false negative costs one
 *  review turn, a false positive is the reason this is deliberately generous about backticks. */
function noteNamesCommand(noteLine: string): boolean {
	const after = noteLine.replace(VERIFIED_NOTE_PREFIX_RE, "");
	if (/`[^`]+`/.test(after)) return true;
	const firstToken = after.match(/^\s*([A-Za-z0-9_.-]+)/)?.[1] ?? "";
	return /^(npm|pnpm|yarn|bun|node|npx|deno|go|cargo|make|python|python3|pytest|mvn|gradle|dotnet|ruby|php|curl|bash|sh|git|docker)\b/.test(firstToken);
}

/** Reads REVIEW.md (the code-review phase's output), if it exists. */
export async function readReview(cwd: string, changeId: string): Promise<string | undefined> {
	const paths = changePaths(cwd, changeId);
	return readFile(paths.review, "utf8").catch(() => undefined);
}

/** The findings bullets under REVIEW.md's `## Blocking` section. Empty when the section is
 *  absent, when its body is "none", or when REVIEW.md does not exist. */
export async function readBlockingFindings(cwd: string, changeId: string): Promise<string[]> {
	const raw = await readReview(cwd, changeId);
	if (raw === undefined) return [];
	const body = level2Body(raw, "Blocking").trim();
	if (!body || /^none\b/i.test(body)) return [];
	return body
		.split(/\r?\n/)
		.map((l) => l.replace(/^[-*]\s*/, "").trim())
		.filter((l) => l.length > 0);
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
	/** Fast lane only: no delta specs exist, so nothing was merged. The merge loop was
	 *  skipped by design, not because it found nothing. */
	specsMergeSkipped: boolean;
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
	// Read the lane before the rename: the change dir is gone after it, and proposal.md (the
	// lane's source of truth) moves with it.
	const lane = await readChangeLane(cwd, changeId);
	const date = new Date().toISOString().slice(0, 10);
	const archivedDir = join(cwd, READYSET_ROOT, "changes", "archive", `${date}-${changeId}`);
	await mkdir(join(cwd, READYSET_ROOT, "changes", "archive"), { recursive: true });
	await rename(paths.dir, archivedDir);

	const mergedSpecFiles: string[] = [];
	const unappliedModifications: ArchiveResult["unappliedModifications"] = [];
	// Fast lane: there is no delta spec to merge. Gate on the lane rather than relying on
	// findSpecFiles returning [] — a stray spec file under a fast-lane change must not be merged.
	const specsMergeSkipped = lane === "fast";
	const archivedSpecsDir = join(archivedDir, "specs");
	const specFiles = specsMergeSkipped ? [] : await findSpecFiles(archivedSpecsDir).catch(() => [] as string[]);
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

	return { archivedDir, mergedSpecFiles, unappliedModifications, specsMergeSkipped };
}
