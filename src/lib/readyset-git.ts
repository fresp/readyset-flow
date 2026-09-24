import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { READYSET_ROOT, getProgress, readApproveBase, readDirtyBaseline } from "./readyset-spec.ts";

/** Git-derived measurements: what this run changed, diff stats against the approve base, and
 *  the run's own changed paths. Never throws on a non-repo; callers treat that as "nothing changed". */
/**
 * True when the handed-off execution has run every task to completion. An unreadable tasks.md
 * counts as done, so a missing/renamed file cannot leave the handoff armed forever.
 * Reuses getProgress (readyset-spec.ts) — the same counting helper the gate and trigger input use,
 * so "all done" means the same thing everywhere.
 */
export async function executionComplete(cwd: string, changeId: string): Promise<boolean> {
	const progress = await getProgress(cwd, changeId).catch(() => undefined);
	return progress === undefined || progress.total === 0 || progress.done === progress.total;
}


/**
 * Runs `git status --porcelain` in the repo root and returns the repo-relative paths of every
 * currently dirty file (tracked modifications plus untracked files; renames are reported as
 * their destination). Despite the old name, this never diffed against a baseline — it is just
 * the raw current-dirty read; the subtraction happens in `pathsChangedThisRun`. Throws when
 * git is unavailable or the cwd is not a repo — a planning turn in a non-repo has no git
 * boundary to violate, so callers treat that as "nothing to check", not as a violation.
 */
export async function currentDirtyPaths(cwd: string): Promise<string[]> {
	const run = promisify(execFile);
	const { stdout } = await run("git", ["status", "--porcelain", "-uall"], { cwd, timeout: 30000 });
	const paths: string[] = [];
	for (const line of stdout.split("\n")) {
		if (line.length < 4) continue;
		// Porcelain v1: XY + space + path, or "R  old -> new" for renames.
		const rest = line.slice(3);
		const arrow = rest.indexOf(" -> ");
		paths.push(arrow === -1 ? rest : rest.slice(arrow + 4));
	}
	return paths.filter((p) => p !== "");
}

/**
 * Repo-relative paths this change's approve-base commit (`readApproveBase`) has committed since
 * it was captured — `git diff --name-only <base>..HEAD`. Empty when there is no recorded base
 * (an older change, or one still at Propose/Refine — no approve has happened yet) or git fails.
 * Exists so a commit made mid-execution during a long handoff (the model committing its own
 * work) is not invisible to callers that only look at the current working tree.
 */
export async function pathsCommittedSinceApproveBase(cwd: string, changeId: string): Promise<string[]> {
	const base = await readApproveBase(cwd, changeId);
	if (!base) return [];
	const run = promisify(execFile);
	try {
		const { stdout } = await run("git", ["diff", "--name-only", `${base}..HEAD`], { cwd, timeout: 30000 });
		return stdout.split("\n").map((p) => p.trim()).filter((p) => p !== "");
	} catch {
		return [];
	}
}

/**
 * What this run itself changed: current dirty paths minus whatever was already dirty before
 * this change's planning turns ever ran (the baseline captured at scaffold time), UNIONED with
 * whatever this change's approve-base commit has committed since approval
 * (`pathsCommittedSinceApproveBase`). Without the subtraction, any file dirty for unrelated
 * reasons — a WIP edit elsewhere, an untracked scratch note — gets misattributed to the current
 * change. Without the union, a commit made during a handed-off Apply execution (the model
 * committing its own work, leaving the tree clean again) would silently disappear from scope/
 * review-trigger accounting — a working-tree-only read sees nothing changed.
 */
export async function pathsChangedThisRun(cwd: string, changeId: string): Promise<string[]> {
	const [current, baseline, committed] = await Promise.all([
		currentDirtyPaths(cwd).catch(() => [] as string[]),
		readDirtyBaseline(cwd, changeId),
		pathsCommittedSinceApproveBase(cwd, changeId),
	]);
	const dirty = current.filter((p) => !baseline.has(p));
	return [...new Set([...dirty, ...committed])];
}

/** True for a path that only Readyset's own planning artifacts touch: `readyset/**` (change
 *  directories, specs) and `.ai/brainstorms/**`. Excluded from product-code measurements
 *  (`applyDiffStats`) and from what counts toward a review trigger (`buildReviewTriggerInput`) —
 *  the model updating its own tasks.md/CONTEXT.md is not a reason to flag drift or recommend
 *  review, and it is not part of the bench's product-diff number either. */
export function isPlanningPath(p: string): boolean {
	return p.startsWith(`${READYSET_ROOT}/`) || p.startsWith(".ai/brainstorms/");
}

/** Final Apply diff size for the bench: files changed and lines added/deleted, from
 *  `git diff <base> --numstat` against the change's approve-base commit (so commits made during
 *  a handed-off execution are included, not just the working tree), falling back to `git diff
 *  HEAD` and then plain `git diff` when there is no recorded base or no HEAD (a fresh repo), over
 *  the run's own changed paths, with untracked new files counted by their line count. Excludes
 *  readyset/ (planning artifacts) and .ai/brainstorms/** (isPlanningPath) so the number reflects
 *  product code. Returns zeros when git is unavailable. */
export async function applyDiffStats(cwd: string, changeId: string, changedPaths: string[]): Promise<{ files: number; added: number; deleted: number }> {
	const product = changedPaths.filter((p) => !isPlanningPath(p));
	if (product.length === 0) return { files: 0, added: 0, deleted: 0 };
	const run = promisify(execFile);
	let files = 0, added = 0, deleted = 0;
	try {
		const base = await readApproveBase(cwd, changeId);
		let stdout: string;
		try {
			({ stdout } = await run("git", ["diff", ...(base ? [base] : ["HEAD"]), "--numstat", "--", ...product], { cwd, timeout: 30000 }));
		} catch {
			// No recorded base and no HEAD (a fresh repo): `git diff HEAD` errors ("unknown
			// revision"), so fall back to the plain working-tree diff.
			({ stdout } = await run("git", ["diff", "--numstat", "--", ...product], { cwd, timeout: 30000 }));
		}
		for (const line of stdout.split("\n")) {
			if (line.trim() === "") continue;
			const [a, d] = line.split("\t");
			files++;
			added += a === "-" ? 0 : Number(a) || 0;
			deleted += d === "-" ? 0 : Number(d) || 0;
		}
	} catch {
		return { files: 0, added: 0, deleted: 0 };
	}
	// Untracked new files: `git diff --numstat` omits them. Count their lines as additions.
	try {
		const { stdout } = await run("git", ["ls-files", "--others", "--exclude-standard", "--", ...product], { cwd, timeout: 30000 });
		for (const rel of stdout.split("\n")) {
			if (rel.trim() === "") continue;
			const text = await readFile(join(cwd, rel), "utf8").catch(() => "");
			files++;
			added += text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
		}
	} catch {
		/* ls-files unavailable — the tracked numbers still stand */
	}
	return { files, added, deleted };
}
