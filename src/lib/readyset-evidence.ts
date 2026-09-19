/**
 * Runtime evidence capture for Readyset changes — a deliberately dumb primitive.
 *
 * The distinction this file exists to preserve, everywhere it touches:
 *
 *   Runtime Evidence  =  proof that a specific execution happened and produced a specific result
 *
 * It is NOT:
 *
 *   Proof of Correctness
 *
 * `npm test` exiting 0 means "npm test executed successfully" — it does not mean "the
 * implementation satisfies the requirement." This file (and the `readyset_verify` tool built
 * on it, in readyset-review.ts) only ever captures the former. Judging the latter stays the
 * job of the human review gate and the separate Code-review turn, exactly as before — nothing
 * here marks a task done, edits `_Verified:`, or infers requirement satisfaction. See
 * `readyset-review.ts`'s `registerVerifyTool` doc comment for the tool-level contract.
 *
 * Persistence follows this package's existing artifact convention: plain markdown with flat
 * YAML frontmatter (reusing `readyset-brainstorm.ts`'s `parseFrontmatter`/`setFrontmatterFields`),
 * not JSON — every other Readyset artifact (proposal/design/spec/tasks/CONTEXT/REVIEW) is
 * markdown, and evidence records are deliberately not the first exception. Free-form,
 * possibly-multiline content (the command itself, stdout, stderr) lives in fenced sections in
 * the body, not the frontmatter — the frontmatter parser here is a flat, single-line-per-key
 * parser (see readyset-brainstorm.ts), so anything that can contain a literal newline or a
 * stray `key:`-looking line has to live outside it.
 *
 * Each `readyset_verify` call writes a NEW file (`E001.md`, `E002.md`, ...) — evidence records
 * are immutable once written; repeated verification of the same task accumulates records
 * rather than overwriting the previous one.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter, setFrontmatterFields } from "./readyset-brainstorm.ts";
import { changePaths, taskCheckedStates } from "./readyset-spec.ts";

/**
 * 300 seconds — matches `TOOL_TIMEOUTS.bash`'s own `default` in real omp source
 * (`src/tools/tool-timeouts.ts`: `{ default: 300, min: 1, max: 3600 }`), not invented. A
 * verification command is the same kind of thing an agent would otherwise run through the
 * ordinary bash tool, so it gets the same conservative default rather than a bespoke number.
 */
export const EVIDENCE_TIMEOUT_MS = 300_000;

/**
 * 50 KiB per stream — matches `DEFAULT_MAX_BYTES` in real omp source
 * (`@oh-my-pi/pi-tui/tools/streaming-output.ts`: `50 * 1024`), the same inline-output cap the
 * native bash tool itself uses. Applied independently to stdout and stderr.
 */
export const EVIDENCE_MAX_OUTPUT_BYTES = 50 * 1024;

export interface EvidenceRecord {
	/** "E001", "E002", ... — sequential per change, never reused. */
	id: string;
	taskId: string;
	command: string;
	cwd: string;
	/** ISO 8601 timestamp of when the command was started. */
	startedAt: string;
	durationMs: number;
	/** null when the process never produced a real exit code (killed by signal, spawn error). */
	exitCode: number | null;
	timedOut: boolean;
	signal: string | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}

function evidenceDir(cwd: string, changeId: string): string {
	return join(changePaths(cwd, changeId).dir, "evidence");
}

/** Caps `text` at `maxBytes` (UTF-8 byte length, not char length) and reports whether it had
 *  to. Applied independently to stdout/stderr so one noisy stream never crowds out the other. */
export function truncateForCapture(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) return { text, truncated: false };
	return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export interface RunCommandResult {
	exitCode: number | null;
	timedOut: boolean;
	signal: string | null;
	stdout: string;
	stderr: string;
	durationMs: number;
}

/**
 * Executes `command` and captures its real result. This is Readyset's own direct
 * `node:child_process` call — there is no OMP-provided execution mechanism reachable from
 * `ExtensionContext`/`ExtensionAPI` for a `pi.registerTool()`-registered tool to reuse
 * (confirmed against real omp source, not assumed: `CustomToolAPI.exec()` belongs to a
 * different, file-loaded custom-tools mechanism this package doesn't use;
 * `ExtensionContext.invokeTool()` is explicitly same-tool-name-only, for a tool wrapping an
 * existing built-in of its own name, not usable for a net-new tool calling another tool).
 *
 * `shell: true` (rather than a bare `spawn(program, args)` or a custom tokenizer) is
 * deliberate: a verification command is realistically going to be something like
 * `npm test && npm run lint` or `git diff | grep -q foo` — shell composition (`&&`, `|`,
 * redirects) is normal, expected usage here, the same way it is for the model's ordinary bash
 * tool. The alternative to `shell: true` isn't a safer `shell: false` — it's either refusing
 * compound commands outright, or writing a bespoke shell tokenizer, which this package
 * deliberately does not do. `shell: true` instead delegates all of that parsing to the real
 * OS shell (the same thing omp's own bash tool ultimately does — see `wrapShellLineForClientTerminal`
 * in real omp source, which wraps a raw command line into a real shell invocation for its ACP
 * terminal path). This is not a new execution privilege: the model already has unrestricted
 * shell access via its ordinary bash tool during Apply; this only changes who captures the
 * result (Readyset's own code, not the model's paraphrase of it).
 *
 * `stdin` is closed (`"ignore"`) so an interactive command fails fast instead of hanging until
 * timeout. `cwd` is passed through unchanged by the caller (the repo root) — this function
 * does not itself constrain it further.
 */
export function runCommand(command: string, cwd: string, timeoutMs: number = EVIDENCE_TIMEOUT_MS): Promise<RunCommandResult> {
	return new Promise((resolve) => {
		const start = Date.now();
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, {
				cwd,
				shell: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			resolve({
				exitCode: null,
				timedOut: false,
				signal: null,
				stdout: "",
				stderr: `[spawn error: ${err instanceof Error ? err.message : String(err)}]`,
				durationMs: Date.now() - start,
			});
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		// Doesn't keep the process alive just for this guard.
		timer.unref?.();

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode: null,
				timedOut,
				signal: null,
				stdout,
				stderr: stderr ? `${stderr}\n[process error: ${err.message}]` : `[process error: ${err.message}]`,
				durationMs: Date.now() - start,
			});
		});

		child.on("close", (code, sig) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode: code,
				timedOut,
				signal: sig,
				stdout,
				stderr,
				durationMs: Date.now() - start,
			});
		});
	});
}

function fencedSection(heading: string, content: string): string {
	return `## ${heading}\n\n\`\`\`\n${content || "(empty)"}\n\`\`\`\n`;
}

function extractFencedSection(body: string, heading: string): string | undefined {
	const re = new RegExp(`^##\\s*${heading}\\s*\\n\\n\`\`\`\\n([\\s\\S]*?)\\n\`\`\``, "m");
	const m = body.match(re);
	return m ? m[1] : undefined;
}

/** Next sequential evidence id for this change — "E001", "E002", ... Determined by scanning
 *  the directory rather than keeping any in-memory counter, so it stays correct across process
 *  restarts and never collides. Not designed for two concurrent `readyset_verify` calls in the
 *  same change racing each other — same accepted single-session trade-off `grillRoundState`
 *  documents elsewhere in this package. */
async function nextEvidenceId(dir: string): Promise<string> {
	const entries = await readdir(dir).catch(() => [] as string[]);
	const nums = entries
		.map((f) => /^E(\d{3,})\.md$/.exec(f))
		.filter((m): m is RegExpExecArray => !!m)
		.map((m) => Number.parseInt(m[1], 10));
	const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
	return `E${String(next).padStart(3, "0")}`;
}

/** Writes a new, immutable evidence record for `changeId` and returns it with its assigned
 *  id. Never overwrites a prior record — every call creates a new file. */
export async function persistEvidence(
	cwd: string,
	changeId: string,
	record: Omit<EvidenceRecord, "id">,
): Promise<EvidenceRecord> {
	const dir = evidenceDir(cwd, changeId);
	await mkdir(dir, { recursive: true });
	const id = await nextEvidenceId(dir);
	const full: EvidenceRecord = { id, ...record };

	const frontmatter = setFrontmatterFields("", {
		id: full.id,
		taskId: full.taskId,
		cwd: full.cwd,
		startedAt: full.startedAt,
		durationMs: String(full.durationMs),
		exitCode: full.exitCode === null ? "null" : String(full.exitCode),
		timedOut: String(full.timedOut),
		signal: full.signal ?? "none",
		stdoutTruncated: String(full.stdoutTruncated),
		stderrTruncated: String(full.stderrTruncated),
	});

	const body =
		"\n" +
		fencedSection("Command", full.command) +
		"\n" +
		fencedSection("Stdout", full.stdout) +
		"\n" +
		fencedSection("Stderr", full.stderr);

	await writeFile(join(dir, `${id}.md`), frontmatter + body, "utf8");
	return full;
}

/** Reads every evidence record for `changeId`, oldest first. Tolerant of a missing
 *  `evidence/` directory (returns []) and of a malformed individual record (skipped, not
 *  thrown) — one bad file must never crash the whole review flow. */
export async function readAllEvidence(cwd: string, changeId: string): Promise<EvidenceRecord[]> {
	const dir = evidenceDir(cwd, changeId);
	const entries = await readdir(dir).catch(() => [] as string[]);
	const records: EvidenceRecord[] = [];
	for (const entry of entries.filter((e) => /^E\d{3,}\.md$/.test(e)).sort()) {
		const raw = await readFile(join(dir, entry), "utf8").catch(() => undefined);
		if (!raw) continue;
		const { meta, body } = parseFrontmatter(raw);
		if (!meta.id || !meta.taskId) continue; // malformed -- skip rather than crash
		const exitCodeRaw = meta.exitCode;
		const exitCode = exitCodeRaw === undefined || exitCodeRaw === "null" ? null : Number.parseInt(exitCodeRaw, 10);
		records.push({
			id: meta.id,
			taskId: meta.taskId,
			command: extractFencedSection(body, "Command") ?? "(unavailable)",
			cwd: meta.cwd ?? "",
			startedAt: meta.startedAt ?? "",
			durationMs: Number.parseInt(meta.durationMs ?? "0", 10) || 0,
			exitCode: exitCode !== null && Number.isFinite(exitCode) ? exitCode : null,
			timedOut: meta.timedOut === "true",
			signal: !meta.signal || meta.signal === "none" ? null : meta.signal,
			stdout: extractFencedSection(body, "Stdout") ?? "",
			stderr: extractFencedSection(body, "Stderr") ?? "",
			stdoutTruncated: meta.stdoutTruncated === "true",
			stderrTruncated: meta.stderrTruncated === "true",
		});
	}
	return records;
}

export interface TaskEvidenceSummary {
	taskId: string;
	records: EvidenceRecord[];
	/** Most recently recorded evidence for this task (records are read oldest-first, so this
	 *  is simply the last one appended). */
	latest: EvidenceRecord;
}

export interface TaskEvidenceOverview {
	byTask: Map<string, TaskEvidenceSummary>;
	totalRecords: number;
}

/** Groups every evidence record for `changeId` by the task it was recorded against. Pure
 *  read — does not touch tasks.md or judge anything. */
export async function checkTaskEvidence(cwd: string, changeId: string): Promise<TaskEvidenceOverview> {
	const all = await readAllEvidence(cwd, changeId);
	const byTask = new Map<string, TaskEvidenceSummary>();
	for (const rec of all) {
		const existing = byTask.get(rec.taskId);
		if (existing) {
			existing.records.push(rec);
			existing.latest = rec;
		} else {
			byTask.set(rec.taskId, { taskId: rec.taskId, records: [rec], latest: rec });
		}
	}
	return { byTask, totalRecords: all.length };
}

export interface EvidenceConflict {
	taskId: string;
	evidenceId: string;
	exitCode: number | null;
}

/**
 * The one and only judgment this file makes, and it's a purely mechanical one: a task marked
 * `[x]` in tasks.md (self-reported done) whose MOST RECENT runtime evidence exited non-zero
 * (or produced no exit code at all — a timeout or spawn error is at least as suspicious as a
 * non-zero exit). This is an objective mismatch between two signals, not a semantic judgment
 * about correctness — surfaced as-is (v1: passively, in the review panel — see
 * `readyset-review.ts`), never silently reconciled with `_Verified:` or auto-corrected.
 */
export async function findEvidenceConflicts(cwd: string, changeId: string): Promise<EvidenceConflict[]> {
	const { byTask } = await checkTaskEvidence(cwd, changeId);
	if (byTask.size === 0) return [];
	const checkedStates = await taskCheckedStates(cwd, changeId);
	const conflicts: EvidenceConflict[] = [];
	for (const [taskId, summary] of byTask) {
		if (checkedStates.get(taskId) === true && summary.latest.exitCode !== 0) {
			conflicts.push({ taskId, evidenceId: summary.latest.id, exitCode: summary.latest.exitCode });
		}
	}
	return conflicts;
}
