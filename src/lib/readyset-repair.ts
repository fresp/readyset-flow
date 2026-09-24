import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AUTO_TURN_RESERVE, type TurnBudget, turnsAvailableFor } from "./readyset-budget.ts";
import { pathsChangedThisRun } from "./readyset-git.ts";
import { spendTurn, withPhaseModel } from "./readyset-host.ts";
import type { ArtifactBudgets } from "./readyset-omp-config.ts";
import { type TrimOverrun, contractRepairPrompt, trimPrompt } from "./readyset-prompts.ts";
import { type ArtifactSizes, type ChangeLane, type PhaseEvent, type PhaseName, appendContext, brainstormRequestText, checkPhaseViolations, checkScopeRefs, findMissingRequestedDocs, hasBeenApplied, readArtifactSizes } from "./readyset-spec.ts";
import type { ReviewCtx } from "./readyset-types.ts";

/** The two automatic follow-up turns after Propose/Refine: scope-contract repair and trim. */
/** The three problem kinds the contract-repair prompt can name, in the order it lists them. */
export function scopeRefProblems(refs: Awaited<ReturnType<typeof checkScopeRefs>>): string[] {
	const lines: string[] = [];
	for (const p of refs.missing) lines.push(`${p} — named but does not exist (is it really the right path? or should it be marked (new)?)`);
	for (const p of refs.newButExists) lines.push(`${p} — marked (new) but the file already exists (drop the (new) if it will be modified)`);
	for (const p of refs.deleteButMissing) lines.push(`${p} — marked (delete) but there is no such file to remove`);
	return lines;
}

/**
 * Bounded, one-shot contract repair: if the scope contract has dangling refs, a `(new)` path that
 * already exists, or a `(delete)` path that doesn't, fire ONE repair turn (riding the propose phase
 * model), re-check the planning boundary, and re-check the contract. Never loops — one turn per
 * Propose/Refine. A `turn-needing` result is recorded as an appendContext entry and a
 * `contract-repair` phase event. Callers then take their snapshot as usual; whatever is still wrong
 * shows in the gate as a warning, exactly as today.
 *
 * `record` is the caller's `recordPhase` (the handler's factory-local one, or the module-scope loop
 * one) so the event carries the run's lane/laneSource. Returns the post-repair refs so the caller
 * does not re-check.
 *
 * Once the change has been applied (`hasBeenApplied`), the contract is read with post-Apply
 * semantics and the repair turn never fires: a `(new)` file Apply created and a `(delete)` file it
 * removed would otherwise look wrong, and "repairing" them would strip correct markers. Remaining
 * problems only warn. When not applied, the turn is additionally reserved — it fires only while a
 * user Refine would still fit afterwards (`turnsAvailableFor(budget, AUTO_TURN_RESERVE)`).
 */
export async function runContractRepair(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	budget: TurnBudget,
	changeId: string,
	phaseModels: Map<string, { model: string; source: string }>,
	record: (phase: PhaseName, edge: "start" | "end", extra?: { model?: string; outcome?: string }) => Promise<void>,
	brainstormRaw = "",
): Promise<Awaited<ReturnType<typeof checkScopeRefs>>> {
	const applied = await hasBeenApplied(ctx.cwd, changeId);
	const appliedRefs = applied ? { afterApply: true as const } : {};
	const beforeRaw = await checkScopeRefs(ctx.cwd, changeId, appliedRefs);
	const before = applied ? { ...beforeRaw, newButExists: [] } : beforeRaw;
	// Doc mentions that the request/brainstorm asked for but the contract omits are folded into the
	// same one-shot repair turn, so a requested doc can never be silently dropped at planning time.
	const missingDocs = await findMissingRequestedDocs(ctx.cwd, changeId, brainstormRequestText(brainstormRaw), brainstormRaw);
	const problems = [
		...scopeRefProblems(before),
		...missingDocs.map((d) => `requested doc missing from contract: ${d} (add it to \`## Files This Change Will Touch\`, marked (new) if the file does not exist yet)`),
	];
	if (problems.length === 0) return before; // nothing to repair: no event, no turn

	if (applied) {
		ctx.ui.notify(
			`The scope contract for "${changeId}" has ${problems.length} problem(s), but this change has already been applied — not firing a repair turn (it would strip correct (new)/(delete) markers). Showing them in the gate instead.`,
			"warning",
		);
		return before;
	}

	if (!turnsAvailableFor(budget, AUTO_TURN_RESERVE)) {
		ctx.ui.notify(
			`The scope contract for "${changeId}" has ${problems.length} problem(s), but repairing them now would leave no turn for a Refine — keeping the turn and showing them in the gate instead.`,
			"warning",
		);
		await record("contract-repair", "end", { outcome: "skipped-budget" });
		return before;
	}

	ctx.ui.notify(`Repairing the scope contract for "${changeId}" (${problems.length} problem(s))...`, "info");
	await record("contract-repair", "start", { model: phaseModels.get("propose")?.model });
	await withPhaseModel(pi, ctx, "propose", phaseModels, () =>
		spendTurn(pi, ctx, budget, "Contract repair", contractRepairPrompt(problems)),
	);

	// The repair turn is a planning turn: it may only touch the change directory. Checked the same
	// way the Propose turn is, before the contract is trusted again.
	const violations = await checkPhaseViolations(ctx.cwd, changeId, await pathsChangedThisRun(ctx.cwd, changeId));
	if (violations.length > 0) {
		ctx.ui.notify(
			`The contract-repair turn for "${changeId}" changed files outside the change directory (${violations.map((v) => v.path).join(", ")}) — treating the repair as failed.`,
			"error",
		);
		await appendContext(ctx.cwd, changeId, "Contract repair", `Repair turn wrote outside the change dir: ${violations.map((v) => `${v.path} (${v.detail})`).join("; ")}.`);
		await record("contract-repair", "end", { model: phaseModels.get("propose")?.model, outcome: "partial" });
		return checkScopeRefs(ctx.cwd, changeId, appliedRefs);
	}

	const afterRaw = await checkScopeRefs(ctx.cwd, changeId, appliedRefs);
	const after = applied ? { ...afterRaw, newButExists: [] } : afterRaw;
	const remaining = scopeRefProblems(after).length;
	await appendContext(
		ctx.cwd,
		changeId,
		"Contract repair",
		`${problems.length} issue(s) before, ${remaining} after: ${scopeRefProblems(after).map((p) => p.split(" — ")[0]).join(", ") || "(all fixed)"}`,
	);
	await record("contract-repair", "end", { model: phaseModels.get("propose")?.model, outcome: remaining === 0 ? "fixed" : "partial" });
	return after;
}

/** The artifacts a lane can trim, in the order the prompt lists them. Fast lane: the fast lane
 *  writes no design.md and no spec delta, so only proposal.md and tasks.md are candidates. */
export function trimmableSizes(sizes: ArtifactSizes, lane: ChangeLane): { file: keyof ArtifactBudgets; size: number | undefined }[] {
	const all: { file: keyof ArtifactBudgets; size: number | undefined }[] = [
		{ file: "proposal", size: sizes.proposal },
		{ file: "design", size: sizes.design },
		{ file: "specs", size: lane === "fast" ? undefined : sizes.specs },
		{ file: "tasks", size: sizes.tasks },
	];
	return all;
}

/** Which artifacts exceed `1.5 * budget` right now (the only ones that trigger a trim turn). */
export function trimOverruns(sizes: ArtifactSizes, budgets: ArtifactBudgets, lane: ChangeLane): TrimOverrun[] {
	const out: TrimOverrun[] = [];
	for (const { file, size } of trimmableSizes(sizes, lane)) {
		const budget = budgets[file];
		if (!Number.isFinite(budget) || size === undefined) continue;
		if (size > 1.5 * budget) out.push({ file, chars: size, budget });
	}
	return out;
}

/**
 * Bounded, one-shot Trim turn: if a planning artifact exceeds 1.5x its budget, fire ONE turn
 * (riding the propose phase model) that rewrites it down to budget by removing restated content,
 * then re-check the planning boundary and re-measure. Never loops — one turn per Propose/Refine.
 * An ordinary overrun (<= 1.5x) does not reach here at all: it only warns in the gate panel.
 *
 * `record` is the caller's `recordPhase`/`recordRepair` so the event carries the run's
 * lane/laneSource. The turn is reserved — it fires only while a user Refine would still fit
 * afterwards (`turnsAvailableFor(budget, AUTO_TURN_RESERVE)`); otherwise the overrun only warns.
 */
export async function runTrim(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	budget: TurnBudget,
	changeId: string,
	phaseModels: Map<string, { model: string; source: string }>,
	budgets: ArtifactBudgets,
	lane: ChangeLane,
	record: (phase: PhaseName, edge: "start" | "end", extra?: { model?: string; outcome?: string; artifactChars?: PhaseEvent["artifactChars"] }) => Promise<void>,
): Promise<void> {
	const before = await readArtifactSizes(ctx.cwd, changeId);
	const overruns = trimOverruns(before, budgets, lane);
	if (overruns.length === 0) return; // nothing past 1.5x: no event, no turn

	if (!turnsAvailableFor(budget, AUTO_TURN_RESERVE)) {
		ctx.ui.notify(
			`The planning artifacts for "${changeId}" are far over budget (${overruns.map((o) => `${o.file} ${o.chars}/${o.budget}`).join(", ")}), ` +
				"but trimming them now would leave no turn for a Refine — keeping the turns and only warning in the gate.",
			"warning",
		);
		await record("trim", "end", { outcome: "skipped-budget", artifactChars: { before, after: before } });
		return;
	}

	ctx.ui.notify(`Trimming over-budget planning artifacts for "${changeId}" (${overruns.map((o) => o.file).join(", ")})...`, "info");
	await record("trim", "start", { model: phaseModels.get("propose")?.model });
	await withPhaseModel(pi, ctx, "propose", phaseModels, () =>
		spendTurn(pi, ctx, budget, "Trim", trimPrompt(overruns)),
	);

	// The trim turn is a planning turn: it may only touch the change directory. Checked the same
	// way the Propose turn is; a violation treats the trim as failed (mirrors runContractRepair).
	const violations = await checkPhaseViolations(ctx.cwd, changeId, await pathsChangedThisRun(ctx.cwd, changeId));
	const after = await readArtifactSizes(ctx.cwd, changeId);
	if (violations.length > 0) {
		ctx.ui.notify(
			`The trim turn for "${changeId}" changed files outside the change directory (${violations.map((v) => v.path).join(", ")}) — treating the trim as failed.`,
			"error",
		);
		await appendContext(ctx.cwd, changeId, "Trim", `Trim turn wrote outside the change dir: ${violations.map((v) => `${v.path} (${v.detail})`).join("; ")}.`);
		await record("trim", "end", { model: phaseModels.get("propose")?.model, outcome: "partial", artifactChars: { before, after } });
		return;
	}

	// Trimmed when every file that was over 1.5x is now at or under its budget.
	const remaining = trimOverruns(after, budgets, lane);
	await appendContext(
		ctx.cwd,
		changeId,
		"Trim",
		`${overruns.length} artifact(s) over 1.5x budget before: ${overruns.map((o) => `${o.file} ${o.chars}/${o.budget}`).join(", ")}; ` +
			`${remaining.length} still over after.`,
	);
	await record("trim", "end", {
		model: phaseModels.get("propose")?.model,
		outcome: remaining.length === 0 ? "trimmed" : "partial",
		artifactChars: { before, after },
	});
}
