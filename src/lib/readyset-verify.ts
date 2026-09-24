import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_TIMEOUT_MS, runCommand } from "./readyset-evidence.ts";

/** Deterministic verification: Readyset runs the project's own test command itself, instead of
 *  trusting (or regex-parsing) what the executing model wrote about its checks. One real exit code
 *  is a stronger signal than any number of `_Verified:` notes. */

/** One run of the project's test command, as recorded on the handoff and the phase events. */
export interface TestRun {
	command: string;
	exitCode: number | null;
	timedOut: boolean;
	passed: boolean;
	durationMs: number;
	/** The last lines of combined output, for a refusal message or the review prompt. */
	tail: string;
	at: string;
}

/** The verification settings a handoff carries (resolved at approve). */
export interface VerifySettings {
	/** The test command Readyset runs itself; undefined when there is none to run. */
	command?: string;
	/** Whether checked tasks must carry `_Verified:` notes (session_stop gate, readyset_done). */
	requireNotes: boolean;
}

/** `npm test` when package.json declares a real test script (not npm's init placeholder). */
export function detectTestCommand(cwd: string): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
		const test = pkg.scripts?.test;
		if (typeof test === "string" && test.trim() !== "" && !/no test specified/i.test(test)) return "npm test";
	} catch {
		/* no package.json, or unreadable: nothing detected */
	}
	return undefined;
}

/** The configured command wins; `readyset.verify.command: none` disables; else auto-detect. */
export function resolveTestCommand(cwd: string, configured: { command?: string; disabled: boolean }): string | undefined {
	if (configured.disabled) return undefined;
	return configured.command ?? detectTestCommand(cwd);
}

function tailOf(text: string, lines = 40, maxChars = 4000): string {
	const t = text.trimEnd().split("\n").slice(-lines).join("\n");
	return t.length > maxChars ? t.slice(-maxChars) : t;
}

/** Runs the test command in `cwd`. Never throws: a spawn failure is a failed run with a tail. */
export async function runTestCommand(cwd: string, command: string, timeoutMs: number = EVIDENCE_TIMEOUT_MS): Promise<TestRun> {
	const at = new Date().toISOString();
	const r = await runCommand(command, cwd, timeoutMs);
	return {
		command,
		exitCode: r.exitCode,
		timedOut: r.timedOut,
		passed: r.exitCode === 0 && !r.timedOut,
		durationMs: r.durationMs,
		tail: tailOf(`${r.stdout}\n${r.stderr}`),
		at,
	};
}

/** The compact shape recorded on phase events (no output tail). */
export function testRunSummary(t: TestRun): { command: string; exitCode: number | null; passed: boolean; durationMs: number } {
	return { command: t.command, exitCode: t.exitCode, passed: t.passed, durationMs: t.durationMs };
}
