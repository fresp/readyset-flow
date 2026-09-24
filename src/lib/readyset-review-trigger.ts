/**
 * The risk evaluator behind `readyset.review.mode: auto` — decides whether the post-Apply
 * code-review turn is worth its cost on THIS change. Every trigger is a cheap, mechanical
 * observation (a count, a mismatch, a glob hit), never a judgment about correctness: the
 * review turn remains the only thing that judges, this file only decides whether to pay for it.
 *
 * Deliberately has no import from `readyset-review.ts` (that file imports this one; the other
 * direction would be a cycle). Pure: takes a fully-assembled input, returns a result — the
 * caller (readyset-review.ts) owns every fs read, so this module is trivially unit-testable.
 *
 * Trigger order below is the order persisted in the `review` phase event and the skip stub, so
 * a run's audit trail is deterministic.
 */

import { matchesAnyGlob } from "./readyset-glob.ts";

export type ReviewTriggerName =
	| "scope-drift"
	| "evidence-conflict"
	| "no-evidence"
	| "diff-size"
	| "sensitive-path"
	| "protected-path"
	| "clarity"
	| "open-decisions"
	| "tests-failing";

export interface ReviewTriggerInput {
	/** Unjustified post-reconciliation drift paths (outside contract, no deviation entry). */
	unjustifiedDriftPaths: string[];
	/** From findEvidenceConflicts(): tasks checked [x] whose latest evidence exited non-zero. */
	evidenceConflicts: { taskId: string; evidenceId: string; exitCode: number | null }[];
	/** Total readyset_verify records for the change (checkTaskEvidence().totalRecords). */
	evidenceTotal: number;
	/** Notes-format verification check for the same change. */
	verification: { checkedTasks: number; withVerificationNote: number; missing: number; withCommandNote?: number } | undefined;
	/** Numbers of checked tasks (getProgress().done) — 0 means nothing finished, so the
	 *  "no evidence" trigger cannot fire. */
	checkedTasks: number;
	/** Apply end-event diff stats: { files, added, deleted }. */
	diff: { files: number; added: number; deleted: number };
	/** Paths changed by this run (baseline-subtracted). */
	changedPaths: string[];
	/** Brainstorm clarity, when the run's source brainstorm carries one. */
	clarity: "clear" | "partial" | "ambiguous" | undefined;
	/** proposal.md's `## Open Decisions` count at review time; > 0 fires the `open-decisions` trigger. */
	openDecisions: number;
	/** `readyset.scope.protectedPaths` patterns; a changed path matching one fires `protected-path`. */
	protectedPatterns: string[];
	/** `readyset.review.testPaths` patterns; matched paths are excluded from the `diff-size` count. */
	testPaths: string[];
	/** Checked tasks whose `_Verified:` note names a runnable command; > 0 satisfies `no-evidence`. */
	verifiedCommandNotes: number;
	/** The project's test command as Readyset ran it itself (readyset-verify.ts), when it did.
	 *  A failing run fires `tests-failing`; a passing one satisfies `no-evidence`. */
	tests?: { command: string; exitCode: number | null; passed: boolean };
	thresholds: { maxLines: number; maxFiles: number; sensitivePaths: string[] };
}

export interface ReviewTriggerResult {
	/** Every trigger evaluated, with the observed value, in a fixed order. */
	evaluated: { name: ReviewTriggerName; fired: boolean; value: string }[];
	/** Names of the triggers that fired. */
	fired: ReviewTriggerName[];
	/** Fired sensitive-path patterns (the globs that matched, de-duplicated and sorted). */
	firedSensitivePaths: string[];
}

/** Evaluates every trigger in a fixed order and reports which fired. Any single fired trigger
 *  is enough: the caller reviews when `fired.length > 0`. Test paths (readyset.review.testPaths)
 *  are excluded from the `diff-size` file count — a large test suite is not itself a reason to
 *  review — while `protected-path` fires on any protected-pattern hit regardless of the contract. */
export function evaluateReviewTriggers(input: ReviewTriggerInput): ReviewTriggerResult {
	const evaluated: ReviewTriggerResult["evaluated"] = [];

	const drift = input.unjustifiedDriftPaths.length;
	evaluated.push({
		name: "scope-drift",
		fired: drift > 0,
		value: drift > 0 ? `${drift} unjustified path(s)` : "none",
	});

	const conflicts = input.evidenceConflicts.length;
	evaluated.push({
		name: "evidence-conflict",
		fired: conflicts > 0,
		value: conflicts > 0 ? `${conflicts} conflict(s)` : "none",
	});

	// "Finished work with nothing to show for it": at least one task checked, yet the change
	// carries no readyset_verify record at all AND no `_Verified:` note names a runnable command.
	// A command-bearing note (or one readyset_verify record anywhere) satisfies this trigger —
	// readyset_verify is optional by design, and a per-task requirement would fire on most runs
	// and erase the saving.
	const noEvidence = input.checkedTasks > 0 && input.evidenceTotal === 0 && input.verifiedCommandNotes === 0 && input.tests?.passed !== true;
	evaluated.push({
		name: "no-evidence",
		fired: noEvidence,
		value:
			input.checkedTasks === 0
				? "no tasks checked"
				: noEvidence
					? `${input.checkedTasks} checked task(s), 0 evidence records, no _Verified: note names a command either`
					: `${input.evidenceTotal} evidence record(s), ${input.verifiedCommandNotes} command note(s)${input.tests ? `, tests ${input.tests.passed ? "passed" : "failed"}` : ""}`,
	});

	// Test-only files do not count toward the size threshold: a large test suite is not itself a
	// reason to review. `input.diff.files` is still reported by the Apply phase event; the trigger
	// counts are recomputed here from `changedPaths` minus the test patterns.
	const productFiles = input.changedPaths.filter((p) => !matchesAnyGlob(p, input.testPaths)).length;
	const lines = input.diff.added + input.diff.deleted;
	evaluated.push({
		name: "diff-size",
		fired: productFiles > input.thresholds.maxFiles || lines > input.thresholds.maxLines,
		value: `${productFiles} non-test file(s), ${lines} lines`,
	});

	const firedSensitivePaths = input.thresholds.sensitivePaths
		.filter((pattern, index, all) => all.indexOf(pattern) === index)
		.filter((pattern) => input.changedPaths.some((path) => matchesAnyGlob(path, [pattern])))
		.sort();
	evaluated.push({
		name: "sensitive-path",
		fired: firedSensitivePaths.length > 0,
		value: firedSensitivePaths.length > 0 ? `${firedSensitivePaths.length} sensitive path(s)` : "none",
	});

	const firedProtected = input.protectedPatterns
		.filter((pattern, index, all) => all.indexOf(pattern) === index)
		.filter((pattern) => input.changedPaths.some((path) => matchesAnyGlob(path, [pattern])))
		.sort();
	evaluated.push({
		name: "protected-path",
		fired: firedProtected.length > 0,
		value: firedProtected.length > 0 ? `${firedProtected.length} protected path(s)` : "none",
	});

	evaluated.push({
		name: "clarity",
		fired: input.clarity === "partial" || input.clarity === "ambiguous",
		value: input.clarity ?? "absent",
	});

	evaluated.push({
		name: "open-decisions",
		fired: input.openDecisions > 0,
		value: input.openDecisions > 0 ? `${input.openDecisions} open decision(s)` : "none",
	});

	evaluated.push({
		name: "tests-failing",
		fired: input.tests !== undefined && !input.tests.passed,
		value: input.tests ? `\`${input.tests.command}\` exited ${input.tests.exitCode ?? "without an exit code"}` : "not run",
	});

	return { evaluated, fired: evaluated.filter((e) => e.fired).map((e) => e.name), firedSensitivePaths };
}
