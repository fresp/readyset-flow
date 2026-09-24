import { writeFile } from "node:fs/promises";
import { checkTaskEvidence, findEvidenceConflicts } from "./readyset-evidence.ts";
import { applyDiffStats } from "./readyset-git.ts";
import type { ParsedReviewThresholds } from "./readyset-omp-config.ts";
import type { ReviewTriggerInput, ReviewTriggerResult } from "./readyset-review-trigger.ts";
import { changePaths, checkTaskVerification, getProgress, readPhaseEvents } from "./readyset-spec.ts";

/** Inputs for the risk-based review triggers, and the honest REVIEW.md stub when review is skipped. */
/**
 * Assembles the trigger input from the change's own on-disk state plus the values the caller
 * already has in scope. One place, so the main path and `runOnDemandReview` cannot disagree
 * about what "this run's diff/changed paths" means.
 *
 * `changedPaths` is passed in rather than re-derived: the caller already subtracted the dirty
 * baseline (`pathsChangedThisRun`), and re-running it here could observe a different tree.
 */
export async function buildReviewTriggerInput(
	cwd: string,
	changeId: string,
	unjustifiedDriftPaths: string[],
	changedPaths: string[],
	clarity: ReviewTriggerInput["clarity"],
	thresholds: ParsedReviewThresholds,
	openDecisions: number,
	protectedPatterns: string[],
	testPaths: string[],
): Promise<ReviewTriggerInput> {
	const [conflicts, evidence, verification, progress, events] = await Promise.all([
		findEvidenceConflicts(cwd, changeId),
		checkTaskEvidence(cwd, changeId),
		checkTaskVerification(cwd, changeId),
		getProgress(cwd, changeId),
		readPhaseEvents(cwd, changeId),
	]);
	// The diff is measured live against the approve base, so an on-demand review sees the code as
	// it is now (including fixes made after the handoff settled). The last `apply` `end` event's
	// recorded diff is only the fallback for a tree git cannot measure. (This used to look only
	// for outcome "applied", which the handed-off execution model never writes -- so the diff-size
	// trigger of an on-demand review always saw an empty diff.)
	const recordedDiff = [...events].reverse().find((e) => e.phase === "apply" && e.edge === "end" && e.diff !== undefined)?.diff;
	const liveDiff = await applyDiffStats(cwd, changeId, changedPaths).catch(() => undefined);
	const diff = liveDiff && liveDiff.files > 0 ? liveDiff : (recordedDiff ?? liveDiff ?? { files: 0, added: 0, deleted: 0 });
	return {
		unjustifiedDriftPaths,
		evidenceConflicts: conflicts,
		evidenceTotal: evidence.totalRecords,
		verification,
		checkedTasks: progress?.done ?? 0,
		diff,
		changedPaths,
		clarity,
		openDecisions,
		protectedPatterns,
		testPaths,
		verifiedCommandNotes: verification?.withCommandNote ?? 0,
		thresholds,
	};
}

/**
 * Writes the honest skip stub in place of a review turn's findings: what policy decided this,
 * and every trigger the evaluator looked at with its observed value. The point is that a reader
 * of REVIEW.md can tell "nothing was checked" from "everything was checked and it was clean" —
 * a missing file would read as the former.
 */
export async function writeReviewSkipStub(cwd: string, changeId: string, result: ReviewTriggerResult, mode: string): Promise<void> {
	const header = mode === "never"
		? "Review skipped (never): readyset.review.mode = never"
		: "Review skipped (auto): no risk trigger";
	const lines = result.evaluated.map((e) => `- ${e.name}: ${e.value} — ${e.fired ? "fired" : "not fired"}`);
	await writeFile(
		changePaths(cwd, changeId).review,
		`# Code review\n\n${header}\n\nMode: ${mode}\nTriggers evaluated:\n${lines.join("\n")}\n`,
		"utf8",
	);
}
