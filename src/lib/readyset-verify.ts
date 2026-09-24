import { existsSync, readFileSync } from "node:fs";
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
	/** Names of the failing tests, parsed from the full output (see parseFailures); absent when the
	 *  run passed or the runner's output format was not recognised. */
	failures?: string[];
	at: string;
}

/** The verification settings a handoff carries (resolved at approve). */
export interface VerifySettings {
	/** The test command Readyset runs itself; undefined when there is none to run. */
	command?: string;
	/** Where the command came from: `readyset.verify.command`, or auto-detected from the repo. */
	source?: "config" | "detected";
	/** Whether checked tasks must carry `_Verified:` notes (session_stop gate, readyset_done). */
	requireNotes: boolean;
	/** The test run taken at approve, before any code changed. A failure that was already in it is
	 *  not this change's failure, so it never blocks "done" (see judgeTestRun). */
	baseline?: TestBaseline;
}

/** What is kept of the approve-time run (no output tail): also the shape stored in state.json. */
export type TestBaseline = Pick<TestRun, "command" | "passed" | "exitCode" | "timedOut" | "failures" | "at">;

export function toBaseline(t: TestRun): TestBaseline {
	return { command: t.command, passed: t.passed, exitCode: t.exitCode, timedOut: t.timedOut, ...(t.failures ? { failures: t.failures } : {}), at: t.at };
}

function fileText(cwd: string, name: string): string | undefined {
	try {
		return readFileSync(join(cwd, name), "utf8");
	} catch {
		return undefined;
	}
}

const has = (cwd: string, name: string): boolean => existsSync(join(cwd, name));

/**
 * Detects the project's test command from what the repo declares, in this order:
 * - package.json with a real `scripts.test` (not npm's init placeholder): run through the package
 *   manager its lockfile names (pnpm / yarn / bun), else npm;
 * - go.mod: `go test ./...`; Cargo.toml: `cargo test`;
 * - pytest configured (pytest.ini, conftest.py, `[tool.pytest` in pyproject.toml, `[tool:pytest]`
 *   in setup.cfg): `python -m pytest -q`;
 * - a Makefile with a `test:` target: `make test`.
 * Undefined when nothing matches; the caller then falls back to `_Verified:` notes.
 */
export function detectTestCommand(cwd: string): string | undefined {
	const pkgRaw = fileText(cwd, "package.json");
	if (pkgRaw !== undefined) {
		try {
			const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> };
			const test = pkg.scripts?.test;
			if (typeof test === "string" && test.trim() !== "" && !/no test specified/i.test(test)) {
				if (has(cwd, "pnpm-lock.yaml")) return "pnpm test";
				if (has(cwd, "yarn.lock")) return "yarn test";
				if (has(cwd, "bun.lockb") || has(cwd, "bun.lock")) return "bun run test";
				return "npm test";
			}
		} catch {
			/* unreadable package.json: keep looking */
		}
	}
	if (has(cwd, "go.mod")) return "go test ./...";
	if (has(cwd, "Cargo.toml")) return "cargo test";
	if (
		has(cwd, "pytest.ini") ||
		has(cwd, "conftest.py") ||
		/^\[tool\.pytest/m.test(fileText(cwd, "pyproject.toml") ?? "") ||
		/^\[tool:pytest\]/m.test(fileText(cwd, "setup.cfg") ?? "")
	) {
		return "python -m pytest -q";
	}
	if (/^test\s*:/m.test(fileText(cwd, "Makefile") ?? "")) return "make test";
	return undefined;
}

/** The handoff's verification settings for this repo. With no command to run (nothing detected, and
 *  `readyset.verify.command` not set to `none`), `_Verified:` notes are required instead, so a repo
 *  Readyset cannot test never ends up with no verification at all. */
export function resolveVerifySettings(cwd: string, configured: { command?: string; disabled: boolean; requireNotes: boolean }): VerifySettings {
	if (configured.disabled) return { requireNotes: configured.requireNotes };
	if (configured.command) return { command: configured.command, source: "config", requireNotes: configured.requireNotes };
	const detected = detectTestCommand(cwd);
	if (detected) return { command: detected, source: "detected", requireNotes: configured.requireNotes };
	return { requireNotes: true };
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

/** Failing-test names in a runner's output: TAP (`not ok N - name`, node --test), node's spec
 *  reporter and jest/vitest (`✖ name`, `✕ name`, `× name`), pytest (`FAILED path::name`), go
 *  (`--- FAIL: Name`) and cargo (`test name ... FAILED`). Durations are stripped so the same test
 *  compares equal across runs. [] when nothing is recognised. */
export function parseFailures(output: string): string[] {
	const found = new Set<string>();
	const add = (name: string | undefined) => {
		const n = (name ?? "").replace(/\s*\((?:[\d.]+\s*m?s)\)\s*$/, "").replace(/\s+#.*$/, "").trim();
		if (n !== "" && !/^(failing tests|tests? failed)\b/i.test(n)) found.add(n);
	};
	const patterns = [
		/^\s*not ok \d+ - (.+)$/gm,
		/^\s*[✖✕×✗] (.+)$/gm,
		/^FAILED (\S+)/gm,
		/^\s*--- FAIL: (\S+)/gm,
		/^test (\S+) \.\.\. FAILED$/gm,
	];
	for (const re of patterns) for (const m of output.matchAll(re)) add(m[1]);
	return [...found];
}

/** Runs the test command in `cwd`. Never throws: a spawn failure is a failed run with a tail. */
export async function runTestCommand(cwd: string, command: string, timeoutMs: number = EVIDENCE_TIMEOUT_MS): Promise<TestRun> {
	const at = new Date().toISOString();
	const r = await runCommand(command, cwd, timeoutMs);
	const passed = r.exitCode === 0 && !r.timedOut;
	const output = `${r.stdout}\n${r.stderr}`;
	const failures = passed ? [] : parseFailures(output);
	return {
		command,
		exitCode: r.exitCode,
		timedOut: r.timedOut,
		passed,
		durationMs: r.durationMs,
		tail: tailOf(output),
		...(failures.length > 0 ? { failures } : {}),
		at,
	};
}

/** Whether a test run should hold up "done", given the run taken at approve.
 *  - passed: never blocks;
 *  - no baseline, or the baseline passed: any failure is this change's, so it blocks;
 *  - the baseline failed too: blocks only on failing tests that were not failing before. When
 *    either run's failures could not be parsed, it does not block (it cannot tell), and says so. */
export interface TestVerdict {
	blocking: boolean;
	/** Failing tests that were not failing at approve (when both runs could be parsed). */
	newFailures: string[];
	/** True when the run fails only in ways that predate this change (or cannot be told apart). */
	preexisting: boolean;
}

export function judgeTestRun(current: TestRun, baseline?: TestBaseline): TestVerdict {
	if (current.passed) return { blocking: false, newFailures: [], preexisting: false };
	if (!baseline || baseline.passed) return { blocking: true, newFailures: current.failures ?? [], preexisting: false };
	if (current.failures && baseline.failures) {
		const before = new Set(baseline.failures);
		const newFailures = current.failures.filter((f) => !before.has(f));
		return { blocking: newFailures.length > 0, newFailures, preexisting: newFailures.length === 0 };
	}
	return { blocking: false, newFailures: [], preexisting: true };
}

/** One line describing a baseline that already failed, for prompts and notices. */
export function baselineFailureLine(baseline: TestBaseline): string {
	const names = baseline.failures ?? [];
	return `\`${baseline.command}\` already failed before this change (${baseline.timedOut ? "timed out" : `exit ${baseline.exitCode ?? "none"}`}` +
		(names.length > 0 ? `; failing: ${names.slice(0, 10).join(", ")}${names.length > 10 ? `, +${names.length - 10} more` : ""}` : "") +
		")";
}

/** The compact shape recorded on phase events (no output tail). */
export function testRunSummary(t: TestRun): { command: string; exitCode: number | null; passed: boolean; durationMs: number } {
	return { command: t.command, exitCode: t.exitCode, passed: t.passed, durationMs: t.durationMs };
}
