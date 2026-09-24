import type { ExtensionAPI, ExtensionUISelectOption } from "@oh-my-pi/pi-coding-agent";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseReadysetArgs } from "../lib/readyset-args.ts";
import { createRuntime } from "../lib/readyset-runtime.ts";
import { baselineFailureLine, judgeTestRun, resolveTestCommand, resolveVerifySettings, runTestCommand, testRunSummary, toBaseline } from "../lib/readyset-verify.ts";
import { BRAINSTORM_DIR, type BrainstormMeta, type Lane, changeState, isProposed, loadBrainstorms, markApproved, parseFrontmatter, readClaritySignal, recommendLane, reconcileStatuses, validateBrainstormContent } from "../lib/readyset-brainstorm.ts";
import { type TurnBudget, createTurnBudget, phaseBudgetExceeded, phaseBudgetLine, startPhaseBudget } from "../lib/readyset-budget.ts";
import { buildReviewDocument, classicGateSelect, openSidebarOverlay, showReviewPanel, takeReviewSnapshot } from "../lib/readyset-gate-ui.ts";
import { currentDirtyPaths, pathsChangedThisRun } from "../lib/readyset-git.ts";
import { asHostEvents, asReviewCtx, compactForPhase, fireTurnAndWait, resolveHostSetModel, sessionMatches, spendTurn, withPhaseModel } from "../lib/readyset-host.ts";
import { type ParsedReviewThresholds, type ReviewFullLane, type ReviewMode, readArtifactBudgets, readCompactMinContextPercent, readFallbackChain, readLaneDefault, readPhaseBudgetMinutes, readPhaseModels, readVerifyConfig, type VerifyConfig, readPinnedModel, readPreferredLanguage, readReviewFullLane, readReviewMode, readReviewThresholds, readScopeProtectedPaths, readTestPaths } from "../lib/readyset-omp-config.ts";
import { classifyOutsideRepoAccess } from "../lib/readyset-outside-repo.ts";
import { applyTurnPrompt, codeReviewTurnPrompt, compactBeforeExecuteGuidance, compactBeforeExploreGuidance, compactBeforeProposeGuidance, exploreTurnPrompt, proposeTurnPrompt, refineTurnPrompt } from "../lib/readyset-prompts.ts";
import { runContractRepair, runTrim } from "../lib/readyset-repair.ts";
import type { ReviewOverlayResult } from "../lib/readyset-review-overlay.ts";
import { buildReviewTriggerInput } from "../lib/readyset-review-policy.ts";
import { evaluateReviewTriggers } from "../lib/readyset-review-trigger.ts";
import { type ArtifactSizes, type PhaseEvent, type PhaseName, appendContext, appendPhaseEvent, archiveChange, changePaths, checkPhaseViolations, checkScope, ensureDirtyBaseline, ensureReadysetRoot, hasExploration, listSubmodules, readArtifactSizes, readChangeLane, readHandoffState, readOpenDecisions, readReview, readScopeDeviations, readTestBaseline, scaffoldChange, validateChange, writeApproveBase, writeTestBaseline } from "../lib/readyset-spec.ts";
import { type BrainstormExecutionOptions, type GateRunOptions, type ReadysetState, type ReviewCtx, createReadysetState } from "../lib/readyset-types.ts";

/** This module instance's state. */
const state: ReadysetState = createReadysetState();

/** The stateful half of the extension, bound to this instance's state (lib/readyset-runtime.ts). */
const rt = createRuntime(state, { executeBrainstorm });
export const {
	outsideRepoCount,
	outsideRepoTmpCount,
	resetOutsideRepoWatch,
	withPinnedModel,
	resetActiveGrillSession,
	resetPendingHandoff,
	rehydratePendingHandoff,
	startGrilling,
	applyGrillModel,
	restoreGrillModel,
	findNewlyWrittenBrainstorm,
	handleGrillEndTransition,
	settleHandoff,
	handlePendingHandoff,
	supersedePendingHandoff,
} = rt;
const {
	persistPendingHandoff,
	flushOutsideRepoEntries,
	noteOutsideRepoCall,
	sessionStopVerificationCheck,
	registerAskTool,
	registerVerifyTool,
	registerDoneTool,
	MAX_VERIFICATION_SENDBACKS,
} = rt;

// Public API that used to live in this file, re-exported so importers (and tests) are unaffected.
export {
	STAY_IN_REPO_RULE,
	applyTurnPrompt,
	codeReviewTurnPrompt,
	contractRepairPrompt,
	exploreTurnPrompt,
	grillTurnPrompt,
	proposeTurnPrompt,
	refineTurnPrompt,
	trimPrompt,
} from "../lib/readyset-prompts.ts";
export { classifyOutsideRepoAccess } from "../lib/readyset-outside-repo.ts";
export { withPhaseModel } from "../lib/readyset-host.ts";
export { parseReadysetArgs, type ReadysetArgs } from "../lib/readyset-args.ts";
export {
	createReadysetState,
	type ActiveGrillSession,
	type ArmedReviewPolicy,
	type BrainstormExecutionOptions,
	type GateRunOptions,
	type GrillModelPin,
	type HandoffSignal,
	type OutsideRepoKind,
	type PendingHandoff,
	type ReadysetState,
} from "../lib/readyset-types.ts";

/**
 * /readyset — Readyset's core command: grill a brainstorm, propose a change against real repo
 * state, and hold it at the Review Gate until a human approves it. Execution itself is handed
 * off to core omp; the code review and the archive offer stay here, on demand.
 *
 * "Readyset" names what this fuses from three sources, each enforced structurally below (not
 * just described in doc comments):
 * - omp `/plan`'s grounding discipline — a dedicated Explore turn runs before Propose,
 *   writes EXPLORATION.md, and has `.gitmodules` submodules injected into its prompt
 *   explicitly (listSubmodules()) so none can be silently dropped the way one was in an
 *   earlier version of this command's own output.
 * - the proposal/design/spec/tasks split and review-then-apply discipline popularized by
 *   spec-driven-development tooling (Open Questions preserved, a gate before execution).
 * - mattpocock/skills prompting hygiene — Apply requires a machine-checkable `_Verified:`
 *   note under every completed task (checkTaskVerification()) before the gate lets you move
 *   on, and code review is its own turn with adversarial framing, writing REVIEW.md — not a
 *   fresh session, which omp's extension API does not offer, and not the same turn that wrote
 *   the code grading itself. It runs on demand (`/readyset --review <change-id>`) against the
 *   applied change rather than automatically after Apply, because execution itself now belongs
 *   to core omp. CONTEXT.md logs every phase
 *   transition deterministically (appendContext(), not left to the model to remember).
 * See the package README for the full mapping.
 *
 * Neither /plan nor any external CLI binary is used here — this extension does not shell
 * out to anything. It implements its own change-artifact format (readyset-spec.ts: scaffold,
 * structural validate, progress tracking, archive), in plain TypeScript, over its own
 * `readyset/` directory layout. This is Readyset's own format; it does not read from, write to,
 * or stay compatible with any other spec-driven-development tool's files.
 *
 * Trade-off, stated plainly: `validateChange` here is a shallow structural check
 * (required sections, at least one requirement+scenario, at least one task) — not a real
 * schema validator. It catches an empty or malformed artifact, not every compliance issue a
 * full schema-aware tool would. `archiveChange` merges delta specs into the main spec by
 * append-only, never a real ADDED/MODIFIED/REMOVED diff-merge — safe, but cruder than a
 * proper archiver. Both are said in the review panel, not hidden.
 *
 * Deterministic steps (scaffold, validate, progress, archive) run here in plain
 * TypeScript — no LLM turn, no token cost, no chance of being skipped. Only steps that
 * need judgment (writing proposal/design/spec/tasks) go through a triggered agent turn, which
 * is told the exact file paths and section shapes to use so it doesn't need any CLI either.
 * Implementation is not one of those steps any more: the gate dispatches the apply prompt into
 * core omp via `pi.sendUserMessage` and returns, so the executing turn is a normal omp turn
 * with subagents, parallelism, and live task updates rather than one this extension babysits.
 *
 * Review "screen": omp's extension API has no full-screen custom view (confirmed against
 * upstream docs — dialogs are limited to select/confirm/input/editor, plus a 10-line
 * setWidget panel). This uses setWidget as a persistent summary panel and ctx.ui.select
 * for the decision — the closest a third-party extension can get, not a recreation of
 * /plan's native Plan Review surface.
 */

async function reviewAndMaybeExecute(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	initial: BrainstormMeta,
	budget: TurnBudget,
	opts: GateRunOptions,
): Promise<void> {
	const {
		phaseModels,
		lane: reviewLane,
		laneSource: reviewLaneSource,
		compactMode,
		minContextPercent,
		artifactBudgets,
		reviewMode,
		reviewFullLane,
		reviewThresholds,
		protectedPaths,
		testPaths,
		pinnedModel,
		pinnedModelSource,
	} = opts;
	let chosen = initial;

	// This loop owns the gate/refine/apply/review/archive boundaries. It is module-scope, so it
	// has no access to the handler's `recordPhase`; this local writer records the same shape.
	// Never throws -- a phase log is diagnostics, not control flow. The archive `end` event lands
	// *after* archiveChange moved the change directory away, so its write legitimately fails.
	const recordPhase = async (
		changeId: string,
		phase: PhaseName,
		edge: "start" | "end",
		extra: { model?: string; outcome?: string; diff?: PhaseEvent["diff"]; boundary?: PhaseEvent["boundary"]; context?: PhaseEvent["context"]; artifactChars?: PhaseEvent["artifactChars"]; review?: PhaseEvent["review"]; counts?: PhaseEvent["counts"]; openDecisions?: number; outsideRepo?: number; outsideRepoTmp?: number } = {},
	): Promise<void> => {
		await appendPhaseEvent(ctx.cwd, changeId, {
			phase,
			edge,
			at: new Date().toISOString(),
			lane: reviewLane,
			laneSource: reviewLaneSource,
			...extra,
		}).catch(() => {});
	};

	const recordRepair = (phase: PhaseName, edge: "start" | "end", extra: { model?: string; outcome?: string; artifactChars?: PhaseEvent["artifactChars"] } = {}) =>
		recordPhase(chosen.changeId, phase, edge, extra);

	for (;;) {
		// Gate boundary opens before the review snapshot is taken (the panel the user sees) and
		// closes once `choice` is resolved. The gate is UI, not a model turn, so no `model` field.
		await recordPhase(chosen.changeId, "gate", "start");
		const snapshot = await takeReviewSnapshot(ctx, chosen, { outside: outsideRepoCount(), tmp: outsideRepoTmpCount() });
		await flushOutsideRepoEntries(ctx.cwd, chosen.changeId);
		showReviewPanel(ctx, chosen, snapshot, budget, reviewLane, artifactBudgets, opts.verify);
		ctx.ui.setEditorText(await buildReviewDocument(ctx, chosen, snapshot));
		const taskSummary = snapshot.counted
			? `${snapshot.counted.done}/${snapshot.counted.total} tasks ticked`
			: "tasks.md not found yet";

		// `ui.custom` existing is not enough: omp's RPC host implements it as a stub that resolves
		// `undefined` immediately ("Custom UI not supported in RPC mode"), which this loop would read
		// as Esc == Discard -- silently throwing the gate away before the user ever sees it. omp's own
		// ExtensionContext docs say to guard custom components with `mode === "tui"`. `mode` is
		// optional here only for older omp builds that don't expose it (those were TUI-only anyway).
		const hasSidebar = typeof ctx.ui.custom === "function" && (ctx.mode === undefined || ctx.mode === "tui");
		let choice: ReviewOverlayResult;
		if (hasSidebar) {
			try {
				choice = await openSidebarOverlay(ctx, chosen, snapshot, taskSummary);
			} catch (err) {
				ctx.ui.notify(`Sidebar view failed to open: ${err instanceof Error ? err.message : String(err)}. Falling back to the classic menu.`, "warning");
				choice = await classicGateSelect(ctx, chosen, snapshot, taskSummary, snapshot.openDecisions.length);
			}
		} else {
			choice = await classicGateSelect(ctx, chosen, snapshot, taskSummary, snapshot.openDecisions.length);
		}

		if (!choice || choice === "discard") {
			await recordPhase(chosen.changeId, "gate", "end", { outcome: "discard", outsideRepo: outsideRepoCount(), outsideRepoTmp: outsideRepoTmpCount() });
			return;
		}

		// "Resolve open decisions" is a Refine pre-filled with the still-open decision list, so
		// the user picks (or confirms) the recommended option for each. It routes through the
		// ordinary Refine branch below — no `ctx.ui.input` prompt, the list IS the feedback.
		let refineFeedback: string | undefined;
		if (choice === "resolve-decisions") {
			refineFeedback =
				"Resolve these open decisions by picking (or confirming) the recommended option for each, then" +
				" update proposal.md's `## Open Decisions` (move each resolved one into `## Assumptions` with the" +
				" chosen behavior) and the affected scenarios:\n" +
				snapshot.openDecisions.map((d, i) => `${i + 1}. ${d.question} — recommended: ${d.recommended ?? "(none stated)"}`).join("\n");
			choice = "refine";
		}

		// "Approve & Execute" compacts first when the context clears the threshold (see
		// compactForPhase for why this is safe for a Readyset change specifically: everything
		// Explore/Propose produced is already persisted under readyset/changes/<id>/, and Apply
		// re-reads those files from disk). "Approve & Execute, keep context" skips the compact
		// entirely — the escape hatch for when discussion nuance didn't make it into the
		// artifacts. `--compact never` suppresses this default too. A missing ctx.compact (older
		// omp build) or a failed compaction degrades to plain Approve & Execute rather than
		// blocking the user from proceeding at all. A scope mismatch (out-of-contract files
		// already changed in the tree) likewise warns, never blocks: it is shown in the gate panel
		// so approval happens with eyes open, not stopped for work the user can see. "compact"
		// is kept as an accepted result for older sidebar builds that still return it (defensive;
		// the current overlay no longer offers it).
		if (choice === "keep-context") {
			// Apply without compacting: the compact boundary is still recorded, marked as skipped,
			// so every gate path leaves a balanced pair of phase events (gate start/end, and a
			// compact boundary for the Apply boundary either way).
			await recordPhase(chosen.changeId, "compact", "end", {
				model: phaseModels.get("apply")?.model,
				outcome: "skipped-keep-context",
				boundary: "apply",
			});
			await recordPhase(chosen.changeId, "gate", "end", { outcome: "approve-keep-context", openDecisions: snapshot.openDecisions.length, outsideRepo: outsideRepoCount(), outsideRepoTmp: outsideRepoTmpCount() });
			choice = "approve"; // fall through to Apply, skipping compaction
		} else if (choice === "approve" || choice === "compact") {
			const compactResult = await compactForPhase(
				pi,
				ctx,
				phaseModels,
				"apply",
				chosen.changeId,
				"executing",
				compactBeforeExecuteGuidance(chosen.changeId),
				compactMode,
				minContextPercent,
			);
			await recordPhase(chosen.changeId, "compact", "end", {
				model: phaseModels.get("apply")?.model,
				outcome: compactResult.outcome,
				boundary: "apply",
				context: { beforePercent: compactResult.beforePercent, afterPercent: compactResult.afterPercent },
			});
			choice = "approve";
			// The recorded outcome names the action the user took. The legacy `"compact"` result
			// (from older sidebar builds) means "approve, keep context" in 0.12.0's note, but the
			// gate treats it as a plain approve here, so both record `approve`.
			await recordPhase(chosen.changeId, "gate", "end", { outcome: "approve", openDecisions: snapshot.openDecisions.length, outsideRepo: outsideRepoCount(), outsideRepoTmp: outsideRepoTmpCount() });
		}

		if (choice === "refine") {
			await recordPhase(chosen.changeId, "gate", "end", { outcome: "refine", openDecisions: snapshot.openDecisions.length, outsideRepo: outsideRepoCount(), outsideRepoTmp: outsideRepoTmpCount() });
			const feedback = refineFeedback ?? (ctx.ui.input ? await ctx.ui.input("What should change?") : undefined);
			if (!feedback) {
				ctx.ui.notify("No feedback given — nothing changed.", "info");
				continue;
			}
			ctx.ui.notify(`Revising "${chosen.changeId}"...`, "info");
			// Refine rides the propose override -- same as withPhaseModel(..., "propose", ...).
			let refineOutcome = "aborted";
			await recordPhase(chosen.changeId, "refine", "start", { model: phaseModels.get("propose")?.model });
			try {
				const refineFired = await withPhaseModel(pi, ctx, "propose", phaseModels, () =>
					spendTurn(
						pi,
						ctx,
						budget,
						"Refine",
						refineTurnPrompt(chosen.changeId, feedback, snapshot.validated.issues.map((i) => `${i.file}: ${i.problem}`), reviewLane, artifactBudgets),
					),
				);
				if (!refineFired) return;
				refineOutcome = "refined";
				await appendContext(ctx.cwd, chosen.changeId, "Refine", `User feedback: ${feedback}`);
				await runContractRepair(pi, ctx, budget, chosen.changeId, phaseModels, recordRepair, chosen.raw);
				await runTrim(pi, ctx, budget, chosen.changeId, phaseModels, artifactBudgets, reviewLane, recordRepair);
			} finally {
				await recordPhase(chosen.changeId, "refine", "end", { model: phaseModels.get("propose")?.model, outcome: refineOutcome });
			}
			continue; // loop back: re-validate and show the panel/gate again
		}

		// "approve". Readyset scopes strictly up to the Review Gate. Once approved, the change
		// is marked approved, recorded in CONTEXT.md and phase events, UI is cleared, and execution
		// is handed off directly to core omp via pi.sendUserMessage(applyTurnPrompt(...)).
		await markApproved(chosen);
		await appendContext(
			ctx.cwd,
			chosen.changeId,
			"Apply",
			"Change approved at the Review Gate. Handing off execution to core omp.",
		);

		// The approve-base commit: everything scope/review-trigger/diff-stat accounting measures
		// against from here on. Captured now (before execution ever runs) and only once per change
		// (writeApproveBase is idempotent) — a re-approve after Refine must not move the base.
		{
			const run = promisify(execFile);
			const approveBaseSha = await run("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 30000 })
				.then((r) => r.stdout.trim())
				.catch(() => undefined);
			await writeApproveBase(ctx.cwd, chosen.changeId, approveBaseSha).catch(() => {});
		}

		// Precedence mirrors withPhaseModel: the apply phase override wins, else the run's pin, else
		// the session model untouched. This deliberately does NOT call withPhaseModel — that would
		// restore in its own `finally`, which is the bug this whole path exists to avoid.
		const applyOverride = phaseModels.get("apply");
		const executionSpec = applyOverride?.model ?? pinnedModel;
		const executionSource = applyOverride ? applyOverride.source : pinnedModelSource;

		await recordPhase(chosen.changeId, "apply", "start", {
			model: executionSpec,
			outcome: "handoff-omp",
		});

		// The execution handoff is fire-and-forget: `pi.sendUserMessage` starts the turn and this
		// branch returns immediately, so withPinnedModel's `finally` would restore the pre-run model
		// exactly as execution begins. Apply the execution model here and record the handoff so
		// withPinnedModel leaves the pin alone (see its `finally`) until the execution settles.
		// The restore target for this handoff: the pin's captured pre-pin model when there was a pin
		// (withPinnedModel stored it in `state.handoffRestoreTarget`), else the session model captured at the
		// capture site below just before the execution model is applied. Stays undefined when no
		// execution model was ever applied, so the settle has nothing to restore and short-circuits.
		let restoreTarget: unknown = state.handoffRestoreTarget;
		const setModel = resolveHostSetModel(pi);
		const models = ctx.models;
		let executionModelApplied = false;
		if (!executionSpec) {
			// Nothing pinned or overridden: leave the session model alone.
		} else if (!setModel || !models?.current) {
			ctx.ui.notify(
				`Execution model "${executionSpec}" (from ${executionSource}) can't be applied — this omp build doesn't expose ` +
					"pi.setModel/ctx.models.current. Running on the current model.",
				"warning",
			);
		} else {
			const resolved = models.resolve ? models.resolve(executionSpec) : executionSpec;
			if (resolved === undefined || resolved === null) {
				ctx.ui.notify(
					`Execution model "${executionSpec}" (from ${executionSource}) didn't resolve to any available model — ` +
						"running on the current model.",
					"warning",
				);
			} else {
				// Capture the pre-apply session model only when nothing has captured one yet (no pin) and
				// we are genuinely about to apply: this instant's models.current() is still the pre-run
				// session model. On a failed apply the capture is skipped, leaving restoreTarget undefined
				// so the settle short-circuits the restore (nothing changed, nothing to restore).
				if (restoreTarget === undefined) restoreTarget = models.current();
				try {
					executionModelApplied = (await setModel(resolved)) !== false;
				} catch {
					executionModelApplied = false;
				}
				if (!executionModelApplied) {
					ctx.ui.notify(
						`Execution model "${executionSpec}" (from ${executionSource}) couldn't be applied (usually: no API key) — ` +
							"running on the current model.",
						"warning",
					);
				} else {
					ctx.ui.notify(`Execution runs on "${executionSpec}" (from ${executionSource}).`, "info");
				}
			}
		}
		if (!executionSpec) {
			ctx.ui.notify("Execution runs on this session's current model (no --model pin and no apply phase model).", "info");
		}

		// Armed before the send below, so withPinnedModel's `finally` (which runs during the
		// `return` right after) observes it and skips its restore. `restoreTarget` is the pin's
		// capture when there was a pin, else the session model captured above just before the
		// execution model was applied — so an apply override alone still restores. It stays
		// undefined when no execution model was applied, in which case handlePendingHandoff has
		// nothing to restore and short-circuits. `sessionId` is the arming session's own id (the
		// command ctx has sessionManager), so a subagent's settle in the same cwd cannot end it.
		// The pre-change test run: a test that already fails here is not this change's failure, so
		// readyset_done / settle / --review compare against it instead of refusing on it. Taken after
		// approve (the user's approval covers running the repo's own test command) and before any
		// code changes; recorded in state.json so a later --review can use it too.
		let verify = opts.verify;
		if (verify.command) {
			ctx.ui.notify(`Running \`${verify.command}\` once to record the pre-change test baseline...`, "info");
			const baselineRun = await runTestCommand(ctx.cwd, verify.command).catch(() => undefined);
			if (baselineRun) {
				const baseline = toBaseline(baselineRun);
				verify = { ...verify, baseline };
				await writeTestBaseline(ctx.cwd, chosen.changeId, baseline).catch(() => {});
				if (!baseline.passed) ctx.ui.notify(`${baselineFailureLine(baseline)}. Only new failures will hold up "done".`, "warning");
			}
		}
		const armingSessionId = ctx.sessionManager?.getSessionId?.();
		state.handoff = {
			changeId: chosen.changeId,
			restoreTo: restoreTarget,
			cwd: ctx.cwd,
			sessionId: armingSessionId,
			armedAt: new Date().toISOString(),
			reviewPolicy: { mode: reviewMode, fullLane: reviewFullLane, thresholds: reviewThresholds, protectedPaths, testPaths },
			verify,
		};
		await persistPendingHandoff(state.handoff);
		// readyset_verify is only meaningful while THIS change's Apply is live — armed here (the
		// handoff is about to fire), cleared by settleHandoff once it settles for real.
		state.verifyChangeId = chosen.changeId;

		if (typeof ctx.ui.setEditorText === "function") {
			ctx.ui.setEditorText("");
		}
		if (typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget("readyset", undefined);
		}

		ctx.ui.notify(`Approved "${chosen.changeId}". Handing off execution to core omp...`, "info");

		const applyOpenDecisions = await readOpenDecisions(ctx.cwd, chosen.changeId).catch(() => []);
		pi.sendUserMessage(applyTurnPrompt(chosen.changeId, applyOpenDecisions, reviewLane, verify));
		return;
	}
}

/**
 * The archive offer shared by the main path and `runOnDemandReview` — one implementation, so a
 * skipped review and an on-demand one cannot drift on wording, options, or the archive
 * start/end phase events. `skipReason` selects the leading sentence; the drift prefix and the
 * three options are identical either way.
 */
async function offerArchive(
	ctx: ReviewCtx,
	chosen: BrainstormMeta,
	reviewContent: string | undefined,
	archiveDriftPaths: string[],
	recordPhase: (
		changeId: string,
		phase: PhaseName,
		edge: "start" | "end",
		extra?: { outcome?: string },
	) => Promise<void>,
	skipReason: "skipped-flag" | "skipped-no-trigger" | "review-failed" | undefined,
	restoredPaths: string[],
	findings: { found: number; fixed: number } | undefined,
): Promise<void> {
	await flushOutsideRepoEntries(ctx.cwd, chosen.changeId);
	const outsideLine = outsideRepoCount() > 0 ? `⚠ outside-repo access: ${outsideRepoCount()} tool call(s) outside the repository (advisory). ` : "";
	const tmpLine = outsideRepoTmpCount() > 0 ? `/tmp access: ${outsideRepoTmpCount()} tool call(s) (advisory, not counted). ` : "";
	const restoredLine = restoredPaths.length > 0
		? `⚠ ${restoredPaths.length} file(s) the reconciliation turn reverted out of list were RESTORED (${restoredPaths.join(", ")}). `
		: "";
	const findingsLine = findings ? `blocking: ${findings.found} found, ${findings.fixed} fixed. ` : "";
	const driftLine = archiveDriftPaths.length > 0
		? `Apply touched ${archiveDriftPaths.length} file(s) outside the contract (${archiveDriftPaths.join(", ")}). `
		: "";
	const reviewLine = reviewContent
		? `Code review done for "${chosen.changeId}" — see ${changePaths(ctx.cwd, chosen.changeId).review}.`
		: skipReason === "skipped-flag"
			? `Code review skipped (never): readyset.review.mode = never.`
			: skipReason === "review-failed"
				? `Code review ran but wrote no REVIEW.md — nothing was checked.`
				: `Code review skipped (auto): no risk trigger — see the stub in ${changePaths(ctx.cwd, chosen.changeId).review}.`;
	// A "Re-run review" option is deliberately not added: the extension cannot fire a second
	// review turn from inside offerArchive without another turn budget and a fresh change-state
	// read, so a "Re-run review" label would be a dead option. "Address findings first" already
	// tells the user they can re-run /readyset.
	const addressFirst = { label: "Address findings first", description: "leave it in readyset/changes/ so you can fix review findings, then re-run /readyset" };
	const archiveNow = { label: "Archive now", description: "moves the change to changes/archive/ and merges deltas into specs/ (append-only, best-effort — review after)" };
	const notYet = { label: "Not yet", description: "leave it in readyset/changes/ for now" };
	// After a review that failed to write REVIEW.md, archiving is not the sensible default: lead
	// with the option that says "go look at it" instead of "move on".
	const options = skipReason === "review-failed"
		? [addressFirst, archiveNow, notYet]
		: [archiveNow, addressFirst, notYet];
	// The archive window opens with the offer itself, so every path below -- archived, declined,
	// dismissed, or failed -- closes a window that was actually opened: one `start`, one `end`.
	// (It used to open only on "Archive now", leaving every other choice an orphan `end`.)
	await recordPhase(chosen.changeId, "archive", "start");
	const archiveChoice = await ctx.ui.select(
		`${outsideLine}${tmpLine}${restoredLine}${findingsLine}${driftLine}${reviewLine} Archive now?`,
		options,
	);

	if (archiveChoice !== "Archive now") {
		// Every non-archive path still closes the boundary, so the compile step sees a single
		// `end` per archive window. `archiveChoice` is falsy on Esc/dismissed.
		await recordPhase(chosen.changeId, "archive", "end", { outcome: archiveChoice || "dismissed" });
		return;
	}

	try {
		// The fast lane carries no spec delta. Record that in CONTEXT.md *before*
		// archiveChange runs — the rename moves the change dir, so the append must land
		// while the live path still exists (same ordering as the pre-archive phase events).
		const archiveLane = await readChangeLane(ctx.cwd, chosen.changeId);
		if (archiveLane === "fast") {
			await appendContext(ctx.cwd, chosen.changeId, "Archive", "Fast lane: no spec delta to merge (skipped by design).");
		}
		const result = await archiveChange(ctx.cwd, chosen.changeId);
		if (result.specsMergeSkipped) {
			// Fast lane: nothing was merged *by design*, not because something failed. The
			// usual baseNotice warning path reads as if a merge went wrong, so it is skipped.
			ctx.ui.notify(
				`Archived to ${result.archivedDir}. Fast lane: this change carried no spec delta, so nothing was merged into readyset/specs/.`,
				"info",
			);
		} else {
			const baseNotice =
				`Archived to ${result.archivedDir}. Merged into: ${result.mergedSpecFiles.join(", ") || "(no spec files found to merge)"} ` +
				"— this was an append-only merge, not a real ADDED/MODIFIED/REMOVED diff; review the merged spec.";
			if (result.unappliedModifications.length === 0) {
				ctx.ui.notify(baseNotice, "info");
			} else {
				// MODIFIED/REMOVED specifically: the append-only merge did NOT actually change or remove these --
				// the old requirement text is still sitting in the canonical spec, untouched, right next to the
				// appended delta that claims it changed/disappeared. Worth a sharper, itemized warning rather
				// than the same generic notice an ADDED-only archive gets.
				const items = result.unappliedModifications
					.map((u) => `  - ${u.verb}: "${u.requirement}" (in ${u.specFile})`)
					.join("\n");
				ctx.ui.notify(
					`${baseNotice}\n\n⚠ ${result.unappliedModifications.length} requirement(s) below were declared MODIFIED/REMOVED ` +
						"in this change but were only appended, NOT actually changed or removed in the canonical spec -- the " +
						"old text is still there. Manual cleanup needed:\n" +
						items,
					"warning",
				);
			}
		}
		// archiveChange renamed the change dir to changes/archive/<date>-<id>/, so the
		// archive `end` event must target that location — writing to the live id would
		// find no CONTEXT.md (the move already happened). READYSET_ROOT is "readyset".
		const archivedChangeId = result.archivedDir.slice(join(ctx.cwd, "readyset", "changes").length + 1);
		await recordPhase(archivedChangeId, "archive", "end", { outcome: "archived" });
	} catch (err) {
		// Close the archive boundary before rethrowing: the caller must still see the
		// original error, but the phase log should record that archive did not complete.
		await recordPhase(chosen.changeId, "archive", "end", { outcome: "error" });
		throw err;
	}
}


/**
 * `/readyset --review <change-id>`: fire exactly one code-review turn for an existing,
 * not-yet-archived change and then offer archive as usual. Used when `auto` skipped review but
 * the user wants it before opening a PR. Overwrites any REVIEW.md stub.
 *
 * Uses `fireTurnAndWait` rather than `spendTurn`: on-demand review has no run budget of its own,
 * and it must always fire exactly one turn — a budget check here could silently fire none.
 */
async function runOnDemandReview(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	changeId: string,
	phaseModels: Map<string, { model: string; source: string }>,
	mode: ReviewMode,
	thresholds: ParsedReviewThresholds,
	protectedPaths: string[],
	testPaths: string[],
	verifyConfig: VerifyConfig = { command: undefined, disabled: false, requireNotes: false, warning: undefined },
): Promise<void> {
	const changeStatus = await changeState(ctx.cwd, changeId);
	if (changeStatus === "archived") {
		ctx.ui.notify(
			`Change "${changeId}" is already archived — review runs only on a not-yet-archived change. ` +
				"Run /readyset on a new brainstorm for follow-up work.",
			"error",
		);
		return;
	}
	if (changeStatus === "none") {
		ctx.ui.notify(
			`No active change "${changeId}" found under readyset/changes/ — check the id (it is the change directory name, not the brainstorm title).`,
			"error",
		);
		return;
	}

	// A handoff for this change that never settled and is not armed in this process -- another
	// session's, or one armed before an omp restart that no session has re-attached. Asking to
	// review the change is the user saying execution is over, so close the `apply` window first
	// (`handoff-orphaned`: no diff, no review policy -- this review IS the review) rather than
	// leaving it open forever. The one handoff armed in this process was already superseded by
	// the command handler before this ran.
	const orphan = await readHandoffState(ctx.cwd, changeId);
	if (orphan && state.handoff?.changeId !== changeId) {
		await settleHandoff(pi, ctx, { changeId, restoreTo: undefined }, "handoff-orphaned");
		ctx.ui.notify(
			`Closed the handed-off execution of "${changeId}" that never settled (approved ${orphan.armedAt}` +
				`${orphan.sessionId ? `, session ${orphan.sessionId}` : ""}) as handoff-orphaned before reviewing.`,
			"warning",
		);
	}

	const lane = (await readChangeLane(ctx.cwd, changeId)) ?? "full";
	const recordPhase = async (
		id: string,
		phase: PhaseName,
		edge: "start" | "end",
		extra: { model?: string; outcome?: string; review?: PhaseEvent["review"]; tests?: PhaseEvent["tests"] } = {},
	): Promise<void> => {
		await appendPhaseEvent(ctx.cwd, id, { phase, edge, at: new Date().toISOString(), lane, laneSource: "brainstorm", ...extra }).catch(() => {});
	};

	const changedPaths = await pathsChangedThisRun(ctx.cwd, changeId);
	const scope = await checkScope(ctx.cwd, changeId, changedPaths);
	const justified = new Set((await readScopeDeviations(ctx.cwd, changeId)).map((d) => d.path));
	const driftPaths = (scope.noContract ? [] : scope.outside).filter((p) => !justified.has(p));
	const brainstorm = await loadBrainstorms(ctx.cwd).then((all) => all.find((b) => b.changeId === changeId));
	// The review starts from a deterministic fact: the project's own test command, run now.
	const testCommand = resolveTestCommand(ctx.cwd, verifyConfig);
	if (testCommand) ctx.ui.notify(`Running \`${testCommand}\` before the review...`, "info");
	const tests = testCommand ? await runTestCommand(ctx.cwd, testCommand) : undefined;
	// Failures that were already there at approve are not this change's: the trigger and the review
	// prompt see them as such (same rule as readyset_done).
	const testBaseline = tests ? await readTestBaseline(ctx.cwd, changeId).catch(() => undefined) : undefined;
	const testVerdict = tests ? judgeTestRun(tests, testBaseline?.command === tests.command ? testBaseline : undefined) : undefined;
	const triggerResult = evaluateReviewTriggers({
		...(await buildReviewTriggerInput(ctx.cwd, changeId, driftPaths, changedPaths, brainstorm?.clarity, thresholds, (await readOpenDecisions(ctx.cwd, changeId)).length, protectedPaths, testPaths)),
		...(tests ? { tests: { ...testRunSummary(tests), passed: !testVerdict?.blocking } } : {}),
	});

	let reviewContent: string | undefined;
	let reviewOutcome = "aborted";
	await recordPhase(changeId, "review", "start", { model: phaseModels.get("review")?.model });
	ctx.ui.notify(`Running code review for "${changeId}"...`, "info");
	try {
		const deviationsForReview = await readScopeDeviations(ctx.cwd, changeId);
		await withPhaseModel(pi, ctx, "review", phaseModels, () =>
			fireTurnAndWait(pi, ctx, codeReviewTurnPrompt(changeId, lane, deviationsForReview, triggerResult, changedPaths, tests, testVerdict)),
		);
		reviewContent = await readReview(ctx.cwd, changeId);
		reviewOutcome = reviewContent ? "review-written" : "no-review";
		await appendContext(
			ctx.cwd,
			changeId,
			"Code review",
			reviewContent ? "On-demand review — REVIEW.md written." : "On-demand review turn ran but REVIEW.md is empty or missing.",
		);
	} finally {
		await recordPhase(changeId, "review", "end", {
			model: phaseModels.get("review")?.model,
			outcome: reviewOutcome,
			review: {
				mode,
				triggersEvaluated: triggerResult.evaluated,
				triggersFired: triggerResult.fired,
				outcome: "on-demand",
			},
			...(tests ? { tests: testRunSummary(tests) } : {}),
		});
	}

	if (reviewContent) {
		ctx.ui.setWidget?.("readyset", [`Change: ${changeId}`, "REVIEW.md:", ...reviewContent.split("\n").slice(0, 8)]);
	}
	ctx.ui.notify(`Code review for "${changeId}" done — see ${changePaths(ctx.cwd, changeId).review}.`, "info");

	// offerArchive needs a BrainstormMeta; an on-demand target may have no matching brainstorm
	// (a change recorded outside the brainstorm flow), so fall back to a minimal shape carrying
	// only what the archive path actually reads: the change id.
	await offerArchive(
		ctx,
		brainstorm ?? ({ changeId } as BrainstormMeta),
		reviewContent,
		driftPaths,
		recordPhase,
		// The truthiness mirrors the reviewOutcome line above: a falsey reviewContent is what that
		// line calls "no-review", whether the file is missing or empty.
		!(reviewContent) ? "review-failed" : undefined,
		[],
		undefined,
	);
}


export async function executeBrainstorm(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	chosen: BrainstormMeta,
	options: BrainstormExecutionOptions,
): Promise<void> {
	const {
		laneOverride,
		laneDefault,
		parsedArgs,
		compactMode,
		effectiveReviewMode,
		reviewFullLane,
		reviewThresholds,
		scopeProtected,
		testPathsResult,
	} = options;

	// resolveLane() in readyset-brainstorm.ts answers "what did the file say"; the run's
	// lane additionally honors --lane (set above) and readyset.lane.default (a configured
	// `fast`/`full` forces it; `auto` accepts code's clarity→lane recommendation recomputed
	// fresh from the file's frontmatter). From here on, effectiveLane is the only lane
	// value this run may act on — read b.lane directly and you silently drop the operator's
	// override or the config default.
	const claritySignal = readClaritySignal(parseFrontmatter(chosen.raw).meta);
	const recommendation = recommendLane(claritySignal);
	const configLane: Lane | undefined =
		laneDefault === "fast" || laneDefault === "full"
			? laneDefault
			: laneDefault === "auto"
				? recommendation.lane
				: undefined;
	const effectiveLane = laneOverride ?? configLane ?? chosen.lane;
	if (laneOverride && laneOverride !== chosen.lane) {
		ctx.ui.notify(
			`Running "${chosen.changeId}" on the ${effectiveLane} lane (--lane override; the brainstorm records ${chosen.lane}). ` +
				(effectiveLane === "fast"
					? "Fast lane: lighter Explore folded into Propose, at most ~8 tasks, no mutation-testing review. Behavior questions are still asked."
					: "Full lane: the complete Grill → Explore → Propose → Review → Execute pipeline."),
			"info",
		);
	} else if (laneDefault === "auto" && recommendation.lane !== chosen.lane) {
		ctx.ui.notify(
			`Auto lane: clarity ${recommendation.clarity}` +
				`${recommendation.escalatedBy ? ` (risk flag: ${recommendation.escalatedBy})` : ""} recommends the ` +
				`${recommendation.lane} lane; the brainstorm records ${chosen.lane}. Running ${effectiveLane}.`,
			"warning",
		);
	}

	// Lane context every `recordPhase` below reads. `--lane` is the operator's explicit,
	// per-run answer to the lane question, so its source is "flag"; a configured
	// readyset.lane.default decides the lane, so its source is "config-auto"; under `ask`,
	// a brainstorm that carries the new clarity signal came from grilling just asking the
	// user, so its source is "user-pick"; an older/pre-existing file with no clarity signal
	// falls back to "brainstorm" (today's meaning, unchanged).
	const phaseLane: "fast" | "full" = effectiveLane;
	const phaseLaneSource: PhaseEvent["laneSource"] = laneOverride
		? "flag"
		: laneDefault === "auto" || laneDefault === "fast" || laneDefault === "full"
			? "config-auto"
			: chosen.clarity !== undefined
				? "user-pick"
				: "brainstorm";

	if (chosen.status === "archived") {
		ctx.ui.notify(`Change "${chosen.changeId}" is already archived. Start a new brainstorm for follow-up work.`, "warning");
		return;
	}

	const reviewCtx = ctx;
	const budget = createTurnBudget();

	// --model <spec> (or, if no flag is given, a configured default from
	// ~/.omp/agent/config.yml: readyset.model if set, else omp's own modelRoles.default) pins
	// a specific model for every turn this run fires (Explore through Code-review), so a run
	// is reproducible regardless of whatever model happened to be active in the chat session
	// that invoked it. The original model is restored once this run finishes, whether it
	// completes, stops early (Discard, budget exhausted), or throws. Flag wins over config.
	//
	// --phase-model <phase>=<spec> (repeatable) or readyset.model.phases.<phase> in config
	// overrides the pinned model for one phase only (grill|explore|propose|apply|review).
	// The run's pinned model is restored between phases. An override that fails to pin
	// warns and falls back to the run default — a phase model is a cost optimization, not
	// a correctness requirement, so it must never stop the run.
	//
	// --fallback-model <spec> (a single spec, not a chain) or readyset.model.fallbackChains
	// (an ordered list, tried in turn until one pins — legacy readyset.fallbackModel still
	// works too, as a one-element chain) is tried if pinning the resolved model above fails
	// outright (a bad/retired spec) — see withPinnedModel's doc comment for why this is
	// narrower than, and doesn't replace, omp's own retry.fallbackChains.
	const modelFromFlag = parsedArgs.model;
	const resolvedConfigModel = modelFromFlag ? undefined : await readPinnedModel();
	const pinnedModel = modelFromFlag ?? resolvedConfigModel?.model;
	const pinnedModelSource = modelFromFlag ? "--model flag" : (resolvedConfigModel?.source ?? "");

	const resolvedConfigPhases = await readPhaseModels();
	const phaseModelOverrides = new Map<string, { model: string; source: string }>();
	for (const e of resolvedConfigPhases.entries) {
		if (!phaseModelOverrides.has(e.phase)) phaseModelOverrides.set(e.phase, { model: e.model, source: e.source });
	}
	for (const e of parsedArgs.phaseModels ?? []) {
		phaseModelOverrides.set(e.phase, { model: e.model, source: "--phase-model flag" });
	}

	// A phase's effective model, mirroring withPhaseModel's own precedence
	// (phaseModelOverrides wins, else the run's pinned model). withPhaseModel cannot report
	// back whether the override actually pinned, so the phase log records the spec that
	// *would* have been used: the override when one exists, else pinnedModel.
	const phaseModelFor = (phase: string): string | undefined =>
		phaseModelOverrides.get(phase)?.model ?? pinnedModel;

	// The `auto` threshold: a boundary compacts only when the host reports context usage
	// at or above this share of the window (see compactForPhase). A warning about an
	// invalid stored value is surfaced once, here, rather than per boundary.
	const resolvedCompactMin = await readCompactMinContextPercent();
	if (resolvedCompactMin.warning) ctx.ui.notify(resolvedCompactMin.warning, "warning");
	const minContextPercent = resolvedCompactMin.percent;

	// Wall-clock ceiling per Explore/Propose turn (PhaseBudget): enforced by aborting the turn;
	// `readyset.phaseBudget.minutes: 0` measures and reports only.
	const resolvedPhaseBudget = await readPhaseBudgetMinutes();
	if (resolvedPhaseBudget.warning) ctx.ui.notify(resolvedPhaseBudget.warning, "warning");
	const phaseBudgetMs = Math.round(resolvedPhaseBudget.minutes * 60_000);

	// Per-artifact character budgets, resolved once for the run. The lane's own set is
	// picked once `effectiveLane` is known (it is by this point): the fast lane only
	// budgets proposal.md and tasks.md.
	const artifactBudgetsByLane = await readArtifactBudgets();
	const artifactBudgets = artifactBudgetsByLane[effectiveLane];

	// Writes one phase boundary event. Never throws: a phase log is diagnostics, not control
	// flow -- a write failure must not abort the run (mirrors appendContext's callers, which
	// also never guard). Notably the archive `end` event lands *after* archiveChange moved
	// the change directory away, so its write legitimately fails; that must not fail the run.
	const recordPhase = async (
		changeId: string,
		phase: PhaseName,
		edge: "start" | "end",
		lane: "fast" | "full",
		laneSource: PhaseEvent["laneSource"],
		extra: { model?: string; outcome?: string; diff?: PhaseEvent["diff"]; boundary?: PhaseEvent["boundary"]; context?: PhaseEvent["context"]; grill?: PhaseEvent["grill"]; artifactChars?: PhaseEvent["artifactChars"]; review?: PhaseEvent["review"] } = {},
	): Promise<void> => {
		await appendPhaseEvent(ctx.cwd, changeId, { phase, edge, at: new Date().toISOString(), lane, laneSource, ...extra }).catch(() => {});
	};

	const recordPhaseFor = async (phase: PhaseName, edge: "start" | "end", extra: { model?: string; outcome?: string; artifactChars?: PhaseEvent["artifactChars"] } = {}) =>
		recordPhase(chosen.changeId, phase, edge, phaseLane, phaseLaneSource, extra);

	const fallbackFromFlag = parsedArgs.fallbackModel;
	const resolvedConfigFallback = fallbackFromFlag ? undefined : await readFallbackChain();
	const fallbackChain = fallbackFromFlag ? [fallbackFromFlag] : (resolvedConfigFallback?.chain ?? []);
	const fallbackChainSource = fallbackFromFlag ? "--fallback-model flag" : (resolvedConfigFallback?.source ?? "");

	// readyset.verify: the test command Readyset runs itself at readyset_done / settle / --review,
	// and whether `_Verified:` notes are still required on top of it.
	const verifyConfig = await readVerifyConfig();
	if (verifyConfig.warning) ctx.ui.notify(verifyConfig.warning, "warning");

	const gateRunOptions: GateRunOptions = {
		phaseModels: phaseModelOverrides,
		lane: effectiveLane,
		laneSource: phaseLaneSource,
		compactMode,
		minContextPercent,
		artifactBudgets,
		reviewMode: effectiveReviewMode,
		reviewFullLane,
		reviewThresholds,
		protectedPaths: scopeProtected.paths,
		testPaths: testPathsResult.paths,
		pinnedModel,
		pinnedModelSource,
		verify: resolveVerifySettings(ctx.cwd, verifyConfig),
	};
	if (!gateRunOptions.verify.command && !verifyConfig.disabled && !verifyConfig.requireNotes) {
		ctx.ui.notify(
			"No test command found in this repo (package.json test script, go.mod, Cargo.toml, pytest config or a Makefile test target), " +
				"so Readyset cannot verify the execution itself — checked tasks need `_Verified:` notes instead. Set readyset.verify.command to change that.",
			"info",
		);
	}

	await withPinnedModel(pi, reviewCtx, pinnedModel, pinnedModelSource, fallbackChain, fallbackChainSource, async () => {
		if (isProposed(chosen.status)) {
			// Defensive: a change that predates the baseline mechanism has no capture
			// yet. This never overwrites an existing baseline (first capture wins).
			await ensureDirtyBaseline(ctx.cwd, chosen.changeId, await currentDirtyPaths(ctx.cwd).catch(() => []));
			await reviewAndMaybeExecute(pi, reviewCtx, chosen, budget, gateRunOptions);
			return;
		}

		// Structural gate on the brainstorm itself, before Explore/Propose spend any turns on
		// it — catches a brainstorm (from grilling or otherwise) whose Decision/Seam/Scope/
		// Acceptance Criteria were never actually resolved. See validateBrainstormContent's doc
		// comment for why this exists specifically for the grilling path: a fired turn working
		// from a prose instruction alone can accept a passive answer despite being told not to,
		// and there is no other structural check between grilling writing the file and Explore
		// spending real turns on it.
		const contentCheck = validateBrainstormContent(chosen.raw);

		// Consumed here, one-shot -- see state.grillRounds's doc comment for exactly what this
		// does and doesn't attest to.
		const grillingSkippedAsking = state.grillRounds.active && state.grillRounds.rounds === 0;
		state.grillRounds.active = false;

		if (!contentCheck.ok || grillingSkippedAsking) {
			const issues: string[] = [];
			if (!contentCheck.ok) {
				// contentCheck.summary carries the "(structural check)" label deliberately -- same
				// wording validateChange uses below in the review gate, so neither reads as a
				// stronger guarantee than it actually is just because of how it's phrased here.
				const gapList = contentCheck.issues.map((i) => `${i.section} (${i.problem})`).join("; ");
				issues.push(`${contentCheck.summary}: ${gapList}`);
			}
			if (grillingSkippedAsking) {
				issues.push(
					"grilling was started this session but readyset_ask was never called before the brainstorm " +
						"was written -- the model may have answered every question itself instead of asking you",
				);
			}
			const proceed = await reviewCtx.ui.select(
				`${issues.join(". ")}.`,
				[
					{ label: "Continue anyway", description: "proceed to Explore/Propose despite the gaps above" },
					{ label: "Go back", description: "cancel -- fill in (or keep grilling) the brainstorm first, then run /readyset again" },
				],
			);
			if (proceed !== "Continue anyway") {
				ctx.ui.notify(`Stopped before Explore -- resolve the gaps in "${chosen.title}" and run /readyset again.`, "info");
				return;
			}
		}

		await scaffoldChange(ctx.cwd, chosen.changeId);
		// Capture what was already dirty before this change's own planning turns ever
		// run, so the gate invariant and scope check subtract it rather than blaming
		// this change for unrelated repo state. First capture wins; later, dirtier
		// trees must not widen it.
		await ensureDirtyBaseline(ctx.cwd, chosen.changeId, await currentDirtyPaths(ctx.cwd).catch(() => []));

		// Grill boundary, recorded at the first opportunity: the change directory does not
		// exist during grilling (scaffoldChange above just created it), so a grill `start`
		// timestamp is not recoverable from CONTEXT.md. Only the boundary at which grilling
		// completed is written -- never synthesized from the brainstorm's date-only `created`
		// frontmatter, which would be a fabricated time.
		await recordPhase(chosen.changeId, "grill", "end", phaseLane, phaseLaneSource, {
			// The model grilling ACTUALLY ran on (applyGrillModel), never phaseModelFor("grill"):
			// the grill turn is not fired from here, so a phase override was never applied to it
			// by this function -- recording it would put a fabricated model in the bench log.
			model: options.grillModel,
			outcome: "grilled",
			grill: {
				clarity: recommendation.clarity,
				openDecisions: claritySignal.openDecisions,
				questionsAsked: chosen.questionsAsked,
				recommendedLane: recommendation.lane,
				laneReason: chosen.laneReason,
				riskFlag: claritySignal.riskFlag,
			},
		});

		// Fast lane folds Explore into Propose: no separate turn, no EXPLORATION.md turn.
		// The full-lane path (separate grounding turn that must produce EXPLORATION.md)
		// is unchanged below.
		const isFastLane = effectiveLane === "fast";
		let explored = false;
		if (isFastLane) {
			await recordPhase(chosen.changeId, "explore", "start", phaseLane, phaseLaneSource, { model: phaseModelFor("explore") });
			await appendContext(
				ctx.cwd,
				chosen.changeId,
				"Explore",
				"Skipped as a separate turn — fast lane folds grounding into Propose (a few targeted reads, noted inline).",
			);
			await recordPhase(chosen.changeId, "explore", "end", phaseLane, phaseLaneSource, { model: phaseModelFor("explore"), outcome: "skipped-fast-lane" });
		} else {
			const submodules = await listSubmodules(ctx.cwd);
			ctx.ui.notify(`Exploring ground truth for "${chosen.changeId}" — this can take a while...`, "info");
			const exploreCompact = await compactForPhase(
				pi,
				reviewCtx,
				phaseModelOverrides,
				"explore",
				chosen.changeId,
				"Explore",
				compactBeforeExploreGuidance(chosen.changeId, chosen.file),
				compactMode,
				minContextPercent,
			);
			await recordPhase(chosen.changeId, "compact", "end", phaseLane, phaseLaneSource, {
				model: phaseModelFor("explore"),
				outcome: exploreCompact.outcome,
				boundary: "explore",
				context: { beforePercent: exploreCompact.beforePercent, afterPercent: exploreCompact.afterPercent },
			});
			let exploreOutcome = "aborted";
			await recordPhase(chosen.changeId, "explore", "start", phaseLane, phaseLaneSource, { model: phaseModelFor("explore") });
			const exploreBudget = startPhaseBudget(phaseBudgetMs);
			try {
				const exploreFired = await withPhaseModel(pi, reviewCtx, "explore", phaseModelOverrides, () =>
					spendTurn(pi, reviewCtx, budget, "Explore", exploreTurnPrompt(chosen, submodules), exploreBudget),
				);
				if (!exploreFired) return;

				explored = await hasExploration(ctx.cwd, chosen.changeId);
				exploreOutcome = exploreBudget.aborted
					? explored ? "budget-aborted-partial" : "budget-aborted"
					: explored ? "exploration-written" : "no-exploration";
				await appendContext(
					ctx.cwd,
					chosen.changeId,
					"Explore",
					(explored
						? `EXPLORATION.md written. ${submodules.length} submodule(s) known from .gitmodules: ${submodules.map((s) => s.name).join(", ") || "(none)"}.`
						: "Explore turn ran but EXPLORATION.md is empty or missing — Propose will still run, but without grounded findings to lean on.") +
						` (phase wall time: ${phaseBudgetLine(exploreBudget)}.)`,
				);
				if (exploreBudget.aborted || phaseBudgetExceeded(exploreBudget)) {
					ctx.ui.notify(
						`Explore for "${chosen.changeId}" hit its phase budget without finishing — continuing anyway since ` +
							`${explored ? "EXPLORATION.md exists (possibly partial)" : "Propose can still run ungrounded"}. Raise readyset.phaseBudget.minutes if this repo legitimately needs longer.`,
						"warning",
					);
				}
				if (!explored) {
					ctx.ui.notify(
						`Exploration for "${chosen.changeId}" didn't produce EXPLORATION.md — continuing to Propose anyway, but its ` +
							"grounding will be weaker than usual. Check the transcript above.",
						"warning",
					);
				}
			} finally {
				await recordPhase(chosen.changeId, "explore", "end", phaseLane, phaseLaneSource, { model: phaseModelFor("explore"), outcome: exploreOutcome });
			}
		}

		ctx.ui.notify(`Proposing change "${chosen.changeId}"${isFastLane ? " (fast lane — grounding folded in)" : ""} — this can take a while...`, "info");
		const proposeCompact = await compactForPhase(
			pi,
			reviewCtx,
			phaseModelOverrides,
			"propose",
			chosen.changeId,
			"Propose",
			compactBeforeProposeGuidance(chosen.changeId, chosen.file, !isFastLane),
			compactMode,
			minContextPercent,
		);
		await recordPhase(chosen.changeId, "compact", "end", phaseLane, phaseLaneSource, {
			model: phaseModelFor("propose"),
			outcome: proposeCompact.outcome,
			boundary: "propose",
			context: { beforePercent: proposeCompact.beforePercent, afterPercent: proposeCompact.afterPercent },
		});
		let proposeOutcome = "aborted";
		let proposeSizes: ArtifactSizes | undefined;
		await recordPhase(chosen.changeId, "propose", "start", phaseLane, phaseLaneSource, { model: phaseModelFor("propose") });
		const proposeBudget = startPhaseBudget(phaseBudgetMs);
		try {
			const proposeFired = await withPhaseModel(pi, reviewCtx, "propose", phaseModelOverrides, () =>
				spendTurn(pi, reviewCtx, budget, "Propose", proposeTurnPrompt(chosen, effectiveLane, artifactBudgets), proposeBudget),
			);
			if (!proposeFired) return;
			proposeSizes = await readArtifactSizes(ctx.cwd, chosen.changeId);
			const violations = await checkPhaseViolations(
				ctx.cwd,
				chosen.changeId,
				await pathsChangedThisRun(ctx.cwd, chosen.changeId),
			);
			if (violations.length > 0) {
				proposeOutcome = "stopped-violation";
				await appendContext(
					ctx.cwd,
					chosen.changeId,
					"Propose",
					`STOPPED — planning turn wrote outside its boundary: ${violations
						.map((v) => `${v.path} (${v.detail})`)
						.join("; ")}. No review gate is offered for this state.`,
				);
				ctx.ui.notify(
					`Stopped: the Propose turn for "${chosen.changeId}" changed files outside the change ` +
						`directory (${violations.map((v) => v.path).join(", ")}). Readyset never implements without approval, ` +
						"so no review gate is offered — revert those files (or move them into the change dir) and run /readyset again.",
					"error",
				);
				return;
			}
			proposeOutcome = proposeBudget.aborted ? "budget-aborted" : "proposed";
			await appendContext(
				ctx.cwd,
				chosen.changeId,
				"Propose",
				`Propose turn ran; see proposal.md/design.md/specs/tasks.md.` +
					(proposeSizes ? ` Planning size: proposal ${proposeSizes.proposal ?? 0}, design ${proposeSizes.design ?? 0}, specs ${proposeSizes.specs}, tasks ${proposeSizes.tasks ?? 0} chars (lane ${phaseLane}).` : "") +
					` (phase wall time: ${phaseBudgetLine(proposeBudget)}.)`,
			);
		} finally {
			await recordPhase(chosen.changeId, "propose", "end", phaseLane, phaseLaneSource, {
				model: phaseModelFor("propose"),
				outcome: proposeOutcome,
				artifactChars: proposeSizes ? { before: proposeSizes, after: proposeSizes } : undefined,
			});
		}
		if (proposeBudget.aborted || phaseBudgetExceeded(proposeBudget)) {
			ctx.ui.notify(
				`Propose for "${chosen.changeId}" hit its phase budget (${phaseBudgetLine(proposeBudget)}) — the turn was stopped, so the artifacts may be partial. ` +
					"The gate's validation shows what is missing; Refine or re-run /readyset to finish them.",
				"warning",
			);
		}

		await runContractRepair(pi, reviewCtx, budget, chosen.changeId, phaseModelOverrides, recordPhaseFor, chosen.raw);
		await runTrim(pi, reviewCtx, budget, chosen.changeId, phaseModelOverrides, artifactBudgets, effectiveLane, recordPhaseFor);

		const reloaded = await loadBrainstorms(ctx.cwd);
		await reconcileStatuses(ctx.cwd, reloaded);
		const after = reloaded.find((b) => b.changeId === chosen.changeId);

		const wroteProposal = after ? (await validateChange(ctx.cwd, after.changeId)).issues.every((i) => !(i.file === "proposal.md" && i.problem === "missing")) : false;

		if (!after || !isProposed(after.status) || !wroteProposal) {
			const why = !after
				? `no brainstorm matches the change id "${chosen.changeId}"`
				: !isProposed(after.status)
					? `its brainstorm status is "${after.status}", not proposed`
					: "proposal.md is missing or empty";
			ctx.ui.notify(
				`Propose for "${chosen.changeId}" doesn't look finished (${why}) — check the transcript above for errors, then run /readyset again.`,
				"warning",
			);
			return;
		}

		await reviewAndMaybeExecute(pi, reviewCtx, after, budget, gateRunOptions);
	});
}

export default function (pi: ExtensionAPI) {
	// Outside-repo tripwire (advisory). omp fires `tool_call` before every tool executes; older
	// builds and the test fakes have no `on`, so registration is feature-detected and no-ops.
	// The host surface is read through a named const on purpose (see the OverlayKeybindings note
	// above): this file takes zero type dependency on host internals, so the hook shape is cast
	// rather than imported.
	const toolCallHost = asHostEvents(pi);
	if (typeof toolCallHost.on === "function") {
		toolCallHost.on("tool_call", (event, ctx) => {
			if (state.outsideRepo.cwd !== undefined && ctx?.cwd === state.outsideRepo.cwd) {
				const call = event as { toolName?: string; input?: Record<string, unknown> };
				const kind = classifyOutsideRepoAccess(call.toolName ?? "", call.input ?? {}, state.outsideRepo.cwd);
				if (kind) noteOutsideRepoCall(call.toolName ?? "", call.input ?? {}, kind);
			}
			if (state.grill?.active) {
				const call = event as { toolName?: string; input?: Record<string, unknown> };
				if ((call.toolName === "write" || call.toolName === "write_file") && typeof call.input?.path === "string") {
					const p = call.input.path;
					if (p.includes(".ai/brainstorms") && p.endsWith(".md")) {
						state.grill.writtenBrainstormFile = p;
					}
				}
			}
		});
		toolCallHost.on("agent_end", async (event, ctx) => {
			const endEv = event as { willContinue?: boolean } | undefined;
			// Terminal settles only. omp fires `agent_end` with `willContinue: true` whenever it has
			// already scheduled an automatic continuation (auto-retry, empty/unexpected-stop retry),
			// and documents that subscribers "must not treat this as a user-visible terminal settle"
			// (`AgentEndEvent.willContinue`, shared-events.ts). `session_stop` is deliberately NOT used
			// here: it is a *control* hook whose return value can schedule a hidden continuation turn,
			// so "settled" would be ambiguous, whereas a handler returning nothing is only consulted
			// when the session is already settling. `agent_end` fires once per genuinely settled run.
			if (endEv?.willContinue) return;
			// A settled execution handoff is handled first, before the grill block, so it still runs
			// when state.grill is unset (the usual case: approve fires long after grilling).
			// We await it so *our own* restore and `apply` `end` write complete before this handler
			// returns — nothing externally waits on this handler: omp dispatches the extension
			// `agent_end` notification detached (`void this.#emitAgentEndNotification(...)` in
			// agent-session.ts, whose `.catch(logger.error)` only logs), so a throw here would be
			// invisible. The try/catch below exists for exactly that reason, and keeps a failure from
			// taking down the grill-transition block.
			try {
				await rehydratePendingHandoff(ctx);
				await handlePendingHandoff(pi, asReviewCtx(ctx));
			} catch (err) {
				(ctx.ui as { notify?: (m: string, l?: string) => void } | undefined)?.notify?.(
					`Readyset: restoring the model after the handed-off execution failed: ${err instanceof Error ? err.message : String(err)}. ` +
						"Check /model if it looks off.",
					"warning",
				);
			}
			if (state.grill?.active && sessionMatches(asReviewCtx(ctx), state.grill.sessionId, ctx.cwd)) {
				// Guarded here (not inside runGrillEndTransition) because this is where the session
				// identity is available on the hook ctx: a subagent's own terminal agent_end shares
				// the parent's cwd, so without this guard its settle would drive the parent's
				// grill→propose transition.
				// Belt and braces: omp dispatches this handler detached (`void ...catch(logger.error)`
				// in agent-session.ts), so a throw here would be invisible to the user. The inner
				// notify in handleGrillEndTransition handles the common case; this outer one covers a
				// failure in the notify path itself or in the guard above.
				try {
					await handleGrillEndTransition(pi, asReviewCtx(ctx));
				} catch (err) {
					(ctx.ui as { notify?: (m: string, l?: string) => void } | undefined)?.notify?.(
						`Readyset: the grill→propose transition failed: ${err instanceof Error ? err.message : String(err)}. ` +
							"Run /readyset and pick the brainstorm to resume.",
						"error",
					);
				}
			}
		});
		// Verification gate: blocks the session from settling (Claude/Codex-compatible
		// `decision: "block"`) when a checked task in the change readyset_verify is currently
		// attached to (state.verifyChangeId -- armed for the same handoff this file tracks) lacks a
		// `_Verified:` note. omp itself does not cap how many times a hook may return `block` --
		// left unbounded, a model that never adds the note would loop forever, so this file enforces
		// its own cap (MAX_VERIFICATION_SENDBACKS) per handoff. Only the session that armed the
		// handoff is ever gated -- a subagent's own session_stop (same process, same cwd, different
		// session id) is let through untouched; see sessionStopVerificationCheck.
		toolCallHost.on("session_stop", async (event, ctx) => {
			const cwd = ctx?.cwd;
			if (!cwd) return undefined;
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? (event as { session_id?: string } | undefined)?.session_id;
			await rehydratePendingHandoff({ ...ctx, sessionManager: sessionId === undefined ? undefined : { getSessionId: () => sessionId } }).catch(() => {});
			const check = await sessionStopVerificationCheck(cwd, sessionId).catch(() => undefined);
			if (!check) return undefined;
			const counterKey = `${sessionId ?? "unknown-session"}:${check.changeId}`;
			const blocked = state.sessionStopBlocks.get(counterKey) ?? 0;
			if (blocked >= MAX_VERIFICATION_SENDBACKS) return undefined; // cap reached: let the session stop
			state.sessionStopBlocks.set(counterKey, blocked + 1);
			const armed = state.handoff;
			if (armed?.changeId === check.changeId) {
				state.handoff = { ...armed, verificationBlocks: (armed.verificationBlocks ?? 0) + 1 };
				await persistPendingHandoff(state.handoff);
			}
			return {
				decision: "block" as const,
				reason:
					`Readyset: ${check.missing} checked task(s) in "${check.changeId}"/tasks.md lack a _Verified: note. ` +
					"Add one (what you ran or checked, and the actual result), or explain why verification doesn't apply, " +
					`before stopping. (${blocked + 1}/${MAX_VERIFICATION_SENDBACKS})`,
			};
		});
	}
	registerAskTool(pi);
	registerVerifyTool(pi);
	registerDoneTool(pi);
	pi.registerCommand("readyset", {
		description:
			"Readyset: propose + review + execute a brainstorm against real repo state, standalone — no /plan or external CLI required " +
			"(flags: --all, --fast, --idea <raw idea text> to grill a new brainstorm from scratch, --lang <language> to open " +
			"grilling's discussion in that language from round 1 (must come before --idea), --model <spec> to pin a model " +
			"for this run's turns, --fallback-model <spec> if the pin fails to apply, " +
			"--lane <fast|full> to force the lane for the run and list fast-lane brainstorms in the picker (--fast only filters the picker; neither flag alone forces a lane), " +
			"--review auto|always|never|<change-id> to control (or re-run) the code-review turn)",
		handler: async (args, ctx) => {
			// `args` is the raw string omp hands a registered command (see parseReadysetArgs).
			const parsedArgs = parseReadysetArgs(args);
			const showAll = parsedArgs.all;

			// Standalone: bootstrap readyset/{changes,specs} ourselves if missing — there is no
			// separate init step or CLI to run first.
			await ensureReadysetRoot(ctx.cwd);
			resetOutsideRepoWatch(ctx.cwd);
			// A handoff whose execution turn never settled (user aborted the process, or a different
			// session's settle was never observed) must not linger. Settle it instead of dropping it:
			// settling restores the model this session had before the run and closes the `apply`
			// boundary (handoff-superseded), where the old resetPendingHandoff cleared the state with
			// no restore and left the session stuck on the execution model. A handoff this session
			// armed in an earlier omp process is re-attached first, so it is superseded the same way.
			await rehydratePendingHandoff(asReviewCtx(ctx)).catch(() => {});
			await supersedePendingHandoff(pi, asReviewCtx(ctx));
			// Same idea for a grill pin whose brainstorm was never written (grilling abandoned):
			// give the session its model back before this command pins anything of its own --
			// otherwise a new applyGrillModel/withPinnedModel would capture the stale grill pin as
			// "the model to restore". The grill session itself is left alone (a brainstorm it
			// wrote may still be picked below; see state.grillRounds). The cwd fallback is trivially true:
			// a /readyset command is user-driven, so only a known, different session id opts out.
			if (state.grill && sessionMatches(asReviewCtx(ctx), state.grill.sessionId, ctx.cwd)) {
				await restoreGrillModel(pi, asReviewCtx(ctx), state.grill);
			}

			// Risk-based code-review policy, resolved once for the run. `--review
			// auto|always|never` (flag) wins over readyset.review.mode (config); the trigger
			// thresholds and the full-lane exemption come from config only. Read here, before
			// the picker, so the on-demand `--review <change-id>` path below can use them too.
			const resolvedReviewMode = await readReviewMode();
			if (resolvedReviewMode.warning) ctx.ui.notify(resolvedReviewMode.warning, "warning");
			const resolvedReviewFullLane = await readReviewFullLane();
			if (resolvedReviewFullLane.warning) ctx.ui.notify(resolvedReviewFullLane.warning, "warning");
			const reviewThresholds = await readReviewThresholds();
			if (reviewThresholds.warning) ctx.ui.notify(reviewThresholds.warning, "warning");
			const scopeProtected = await readScopeProtectedPaths();
			if (scopeProtected.warning) ctx.ui.notify(scopeProtected.warning, "warning");
			const testPathsResult = await readTestPaths();
			if (testPathsResult.warning) ctx.ui.notify(testPathsResult.warning, "warning");
			const effectiveReviewMode: ReviewMode = parsedArgs.review ?? resolvedReviewMode.mode;
			const reviewFullLane: ReviewFullLane = resolvedReviewFullLane.fullLane;
			if (parsedArgs.review === undefined && /(^|\s)--review(\s|$)/.test(args)) {
				ctx.ui.notify(
					"Ignoring --review with no mode or change id — expected auto, always, never, or a change id.",
					"warning",
				);
			}

			// `--review <change-id>`: on-demand, exactly one code-review turn for an existing
			// change, then the usual archive offer. Used when `auto` skipped review but the user
			// wants it before opening a PR. Handled before the brainstorm picker so it never
			// needs one.
			if (parsedArgs.reviewTarget !== undefined) {
				const reviewCtxForTarget = asReviewCtx(ctx);
				const resolvedPhaseModels = new Map<string, { model: string; source: string }>();
				for (const e of (await readPhaseModels()).entries) {
					if (!resolvedPhaseModels.has(e.phase)) resolvedPhaseModels.set(e.phase, { model: e.model, source: e.source });
				}
				await runOnDemandReview(
					pi,
					reviewCtxForTarget,
					parsedArgs.reviewTarget,
					resolvedPhaseModels,
					effectiveReviewMode,
					reviewThresholds,
					scopeProtected.paths,
					testPathsResult.paths,
					await readVerifyConfig(),
				);
				return;
			}

			// --lane fast|full forces the lane for this run, bypassing the brainstorm's recorded
			// lane. It is the operator's explicit answer to the same question grilling asks at
			// close-out; a flag wins over the file for the same reason --model wins over config.
			// Anything else is ignored (never a silent default: an unknown --lane value must not
			// quietly run the wrong lane).
			const laneOverride = parsedArgs.lane === "fast" || parsedArgs.lane === "full" ? parsedArgs.lane : undefined;
			if (parsedArgs.lane !== undefined && laneOverride === undefined) {
				ctx.ui.notify(`Ignoring --lane "${parsedArgs.lane}" — expected fast or full. Running on the brainstorm's recorded lane.`, "warning");
			}

			// The picker filter must agree with the lane the run is about to use. An explicit
			// --lane (fast or full) IS the operator's lane answer, so a fast-lane brainstorm is
			// exactly what a `--lane fast` run asked for and `--lane full` must still let it be
			// listed — the operator picks it and the override decides the lane that actually runs.
			// Only the bare `/readyset` (no --fast, no --lane) hides fast-lane brainstorms.
			// Declared here, after laneOverride: reading `laneOverride` before its `const` would be
			// a temporal-dead-zone ReferenceError.
			const includeFast = parsedArgs.fast || laneOverride !== undefined;

			// --compact auto|always|never controls when a phase boundary actually compacts.
			// Anything else (or a bare --compact with no value) warns and uses "auto". The raw
			// `--compact` text test covers both "no value" and "bad value", since the parser only
			// sets `parsed.compact` on a valid mode.
			const compactMode: "auto" | "always" | "never" = parsedArgs.compact ?? "auto";
			if (parsedArgs.compact === undefined && /(^|\s)--compact(\s|$)/.test(args)) {
				ctx.ui.notify(`Ignoring --compact with no valid mode — expected auto, always, or never. Using "auto".`, "warning");
			}

			// readyset.lane.default decides whether the lane is asked by hand during grilling
			// (ask, today's behavior), auto-accepted from code's clarity→lane recommendation, or
			// forced. Resolved once here and threaded into both grilling and the effective lane.
			const resolvedLaneDefault = await readLaneDefault();
			if (resolvedLaneDefault.warning) ctx.ui.notify(resolvedLaneDefault.warning, "warning");
			const laneDefault = resolvedLaneDefault.laneDefault;

			const execOptions: BrainstormExecutionOptions = {
				laneOverride,
				laneDefault,
				parsedArgs,
				compactMode,
				effectiveReviewMode,
				reviewFullLane,
				reviewThresholds,
				scopeProtected,
				testPathsResult,
			};

			// --lang <language> (or, if no flag, readyset.language in ~/.omp/agent/config.yml) sets
			// the language grilling's discussion (questions and replies) opens in from round 1,
			// rather than grillTurnPrompt's reactive default of matching whatever language the
			// user's own replies happen to be in -- for a dev who isn't fluent in English, waiting
			// for them to switch first means round 1 always arrives in English regardless. The
			// brainstorm FILE itself stays English either way (see grillTurnPrompt). Must come
			// before --idea on the command line: --idea joins everything after it into the idea
			// text, so a --lang placed after --idea would be swallowed into that text instead of
			// parsed as a flag.
			const langFromFlag = parsedArgs.lang;
			const resolvedConfigLanguage = langFromFlag ? undefined : await readPreferredLanguage();
			const preferredLanguage = langFromFlag ?? resolvedConfigLanguage?.language;

			// --idea skips the picker entirely: everything after it is joined back into the raw idea
			// text (so it need not be quoted as a single arg), and grilling starts immediately. Must
			// come last among flags on the command line.
			const ideaFromFlag = parsedArgs.idea ?? "";
			if (ideaFromFlag) {
				const grillModel = await applyGrillModel(pi, asReviewCtx(ctx), parsedArgs);
				startGrilling(pi, asReviewCtx(ctx), ideaFromFlag, laneDefault, preferredLanguage, execOptions, grillModel);
				return;
			}

			const all = await loadBrainstorms(ctx.cwd);
			const updated = await reconcileStatuses(ctx.cwd, all);
			if (updated > 0) ctx.ui.notify(`Synced status of ${updated} brainstorm(s) with readyset/changes`, "info");

			const items = all
				.filter((b) => showAll || b.status !== "archived")
				.filter((b) => includeFast || b.lane === "full");

			// Offering "type a new idea" needs ctx.ui.input to actually collect it -- feature-detected
			// the same way ctx.ui.custom is for the Sidebar view, so this degrades gracefully (falls
			// back to --idea only) on an omp build that doesn't expose input() on this ctx shape.
			const canGrillFromScratch = typeof asReviewCtx(ctx).ui.input === "function";
			const NEW_IDEA_LABEL = "✎ Type a new idea (grill it here)";

			if (items.length === 0) {
				ctx.ui.notify(
					`No full-lane brainstorms found in ${BRAINSTORM_DIR}/ (--fast or --lane includes fast-lane, --all includes archived)` +
						(canGrillFromScratch ? ` -- or run /readyset --idea "<your raw idea>" to grill a new one into existence.` : ""),
					"warning",
				);
				return;
			}

			const byLabel = new Map<string, BrainstormMeta>();
			const options: ExtensionUISelectOption[] = items.map((b) => {
				const label = `${b.created ?? "?"} · ${b.title}`;
				const effectiveLane = laneOverride ?? b.lane;
				const lane = laneOverride
					? `${effectiveLane} lane (--lane override)`
					: b.laneSource === "default"
						? "full lane (assumed)"
						: `${b.lane} lane`;
				const next = b.status === "archived" ? "done" : isProposed(b.status) ? "→ review" : "→ propose + review";
				const clarityTag = b.clarity
					? `clarity ${b.clarity}${b.recommendedLane && b.recommendedLane !== b.lane ? ` → ${b.recommendedLane}` : ""}`
					: undefined;
				byLabel.set(label, b);
				return { label, description: [next, lane, b.namespace, clarityTag].filter(Boolean).join(" · ") };
			});
			if (canGrillFromScratch) {
				options.unshift({
					label: NEW_IDEA_LABEL,
					description: "type a raw idea; Readyset grills it mattpocock-style into a brainstorm, then hands off to Explore",
				});
			}

			const picked = await ctx.ui.select("Pick a brainstorm to take through Readyset (fused review)", options, {
				helpText: "enter to continue · esc to cancel",
			});
			if (!picked) return;

			if (picked === NEW_IDEA_LABEL) {
				const reviewCtxForInput = asReviewCtx(ctx);
				const idea = (await reviewCtxForInput.ui.input!("What's the idea? A sentence or two is enough -- Readyset will grill for the rest."))?.trim();
				if (!idea) {
					ctx.ui.notify("No idea given -- nothing started.", "info");
					return;
				}
				const grillModel = await applyGrillModel(pi, reviewCtxForInput, parsedArgs);
				startGrilling(pi, reviewCtxForInput, idea, laneDefault, preferredLanguage, execOptions, grillModel);
				return;
			}

			const chosen = byLabel.get(picked);
			if (!chosen) return;

			await executeBrainstorm(pi, asReviewCtx(ctx), chosen, execOptions);
		},
	});
}
