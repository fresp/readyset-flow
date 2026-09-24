import type { ExtensionAPI, ExtensionAskDialogQuestion, ExtensionAskDialogResult } from "@oh-my-pi/pi-coding-agent";
import { existsSync, readdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { ReadysetArgs } from "./readyset-args.ts";
import { BRAINSTORM_DIR, type BrainstormMeta, loadBrainstorms, reconcileStatuses } from "./readyset-brainstorm.ts";
import { EVIDENCE_MAX_OUTPUT_BYTES, EVIDENCE_TIMEOUT_MS, checkTaskEvidence, describeEvidenceConflict, findEvidenceConflicts, persistEvidence, runCommand, truncateForCapture } from "./readyset-evidence.ts";
import { applyDiffStats, executionComplete, isPlanningPath, pathsChangedThisRun } from "./readyset-git.ts";
import { asReviewCtx, resolveHostSetModel, sessionMatches } from "./readyset-host.ts";
import { type LaneDefault, readPhaseModels, readPinnedModel } from "./readyset-omp-config.ts";
import { GRILL_ROUND_CAP, grillTurnPrompt } from "./readyset-prompts.ts";
import { writeReviewSkipStub } from "./readyset-review-policy.ts";
import { type TestRun, type VerifySettings, runTestCommand, testRunSummary } from "./readyset-verify.ts";
import { evaluateReviewTriggers } from "./readyset-review-trigger.ts";
import { type PhaseEvent, appendContext, appendPhaseEvent, checkScope, checkTaskVerification, clearHandoffState, getProgress, listHandoffStates, readChangeLane, readOpenDecisions, readPhaseEvents, readScopeDeviations, writeHandoffState } from "./readyset-spec.ts";
import type { ActiveGrillSession, ArmedReviewPolicy, BrainstormExecutionOptions, GrillModelPin, HandoffSignal, OutsideRepoKind, PendingHandoff, ReadysetState, ReviewCtx } from "./readyset-types.ts";

/**
 * Shape of `readyset_ask`'s params. Declared explicitly and cast to inside `execute()` because
 * omp's `registerTool` generic infers `Static<TSchema>` as `unknown` for a `pi.zod` schema — a
 * Zod object doesn't map through TypeBox's `TSchema`, so inference falls back to the constraint
 * default even though the runtime value is exactly this shape.
 */
interface ReadysetAskParams {
	questions: {
		id: string;
		question: string;
		header?: string;
		options: { label: string; description?: string }[];
		recommendedIndex?: number;
		multi?: boolean;
		decision: string;
	}[];
}

/** Shape of `readyset_verify`'s params — see `ReadysetAskParams` for why this is declared and
 *  cast to rather than inferred from the `pi.zod` schema passed to `registerTool`. */
interface ReadysetVerifyParams {
	taskId: string;
	command: string;
}

/** Shape of `readyset_done`'s params — see `ReadysetAskParams` for why this is declared and cast
 *  to rather than inferred from the `pi.zod` schema passed to `registerTool`. */
interface ReadysetDoneParams {
	status: "done" | "blocked";
	summary?: string;
}


/** What the extension entry supplies that would otherwise be a circular import. */
export interface RuntimeDeps {
	executeBrainstorm: (pi: ExtensionAPI, ctx: ReviewCtx, chosen: BrainstormMeta, options: BrainstormExecutionOptions) => Promise<void>;
}

/**
 * Everything in /readyset that reads or writes ReadysetState: the outside-repo tally, the model
 * pin, grilling, the execution handoff (arm, pause, settle, persist, rehydrate), the session_stop
 * gate's check, and the three tools. A factory rather than module-level functions so the state is
 * per extension instance (see ReadysetState).
 */
export function createRuntime(state: ReadysetState, deps: RuntimeDeps) {
	function outsideRepoCount(): number {
		return state.outsideRepo.entries.filter((e) => e.kind === "outside").length;
	}
	function outsideRepoTmpCount(): number {
		return state.outsideRepo.entries.filter((e) => e.kind === "tmp").length;
	}

	function resetOutsideRepoWatch(cwd: string): void {
		state.outsideRepo.cwd = cwd;
		state.outsideRepo.entries = [];
		state.outsideRepo.written = 0;
	}

	function noteOutsideRepoCall(toolName: string, input: Record<string, unknown>, kind: OutsideRepoKind): void {
		if (state.outsideRepo.entries.length >= 200) return; // bound memory; the counts below keep growing
		const text = toolName === "bash" ? String(input.command ?? "")
			: (typeof input.path === "string" ? input.path : ""); // grep: never the pattern
		state.outsideRepo.entries.push({ kind, text: `${toolName}: ${text.slice(0, 140)}` });
	}

	/** Advisory CONTEXT.md flush: one entry per gate/archive pass, carrying only the calls observed
	 *  since the previous flush. Never throws — a phase log is diagnostics, not control flow. */
	async function flushOutsideRepoEntries(cwd: string, changeId: string): Promise<void> {
		const unwritten = state.outsideRepo.entries.slice(state.outsideRepo.written);
		if (unwritten.length === 0) return;
		state.outsideRepo.written = state.outsideRepo.entries.length;
		const outside = unwritten.filter((e) => e.kind === "outside").map((e) => e.text);
		const tmp = unwritten.filter((e) => e.kind === "tmp").map((e) => e.text);
		if (outside.length > 0) {
			await appendContext(
				cwd, changeId, "Outside-repo access",
				`⚠ outside-repo access: ${outside.length} tool call(s) reached outside the repository — advisory, never blocking` +
					(outside.length <= 10 ? `: ${outside.join("; ")}` : `; first 10: ${outside.slice(0, 10).join("; ")}`),
			).catch(() => {});
		}
		if (tmp.length > 0) {
			await appendContext(
				cwd, changeId, "Outside-repo access",
				`tmp-directory access: ${tmp.length} tool call(s) used a scratch directory under /tmp — reported separately, not counted in the outside-repo headline` +
					(tmp.length <= 10 ? `: ${tmp.join("; ")}` : `; first 10: ${tmp.slice(0, 10).join("; ")}`),
			).catch(() => {});
		}
	}

	async function withPinnedModel<T>(
		pi: ExtensionAPI,
		ctx: ReviewCtx,
		modelSpec: string | undefined,
		source: string,
		fallbackChain: string[],
		fallbackSource: string,
		fn: () => Promise<T>,
	): Promise<T> {
		if (!modelSpec) return fn();

		const setModel = resolveHostSetModel(pi);
		const models = ctx.models;
		if (!setModel || !models?.current) {
			ctx.ui.notify(
				`Model "${modelSpec}" (from ${source}) was given, but this omp build doesn't expose pi.setModel/ctx.models.current — ` +
					"running with whatever model this session already has.",
				"warning",
			);
			return fn();
		}

		/**
		 * Resolves a spec and applies it, throwing when it did NOT actually take effect.
		 *
		 * `pi.setModel` is `(model: Model) => Promise<boolean>`, and its real implementation returns
		 * `false` — without throwing — when there's no API key for that model (`runExtensionSetModel`
		 * in omp source: `const key = await session.modelRegistry.getApiKey(model); if (!key) return
		 * false;`). Treating only rejections as failure, as this used to, made a failed pin look
		 * successful: it reported "Pinned model ..." for a session model that never changed, and the
		 * configured fallback chain was never tried. `ctx.models.resolve` returning `undefined` for an
		 * unmatched spec is the same class of failure and is handled the same way.
		 */
		const applyModel = async (spec: string): Promise<void> => {
			const resolved = models.resolve ? models.resolve(spec) : spec;
			if (resolved === undefined || resolved === null) {
				throw new Error(`"${spec}" didn't resolve to any available model`);
			}
			const applied = await setModel(resolved);
			if (applied === false) {
				throw new Error(`"${spec}" resolved, but couldn't be applied (usually: no API key available for it)`);
			}
		};

		const original = models.current();
		state.handoffRestoreTarget = original;
		let activeSpec = modelSpec;
		let activeSource = source;

		try {
			await applyModel(modelSpec);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (fallbackChain.length === 0) {
				ctx.ui.notify(
					`Couldn't pin model "${modelSpec}" (from ${source}): ${reason}. No fallback configured (readyset.model.fallbackChains) — ` +
						"running with whatever model this session already has.",
					"warning",
				);
				return fn();
			}

			let pinned = false;
			for (const [i, fallbackSpec] of fallbackChain.entries()) {
				ctx.ui.notify(
					i === 0
						? `Couldn't pin model "${modelSpec}" (from ${source}): ${reason}. Trying fallback "${fallbackSpec}" (from ${fallbackSource})...`
						: `Fallback "${fallbackChain[i - 1]}" also failed to pin. Trying next fallback "${fallbackSpec}" (from ${fallbackSource})...`,
					"warning",
				);
				try {
					await applyModel(fallbackSpec);
					activeSpec = fallbackSpec;
					activeSource = fallbackSource;
					pinned = true;
					break;
				} catch {
					// try the next entry in the chain
				}
			}

			if (!pinned) {
				ctx.ui.notify(
					`Every fallback in the chain (${fallbackChain.join(", ")}, from ${fallbackSource}) failed to pin. ` +
						"Running with whatever model this session already has.",
					"warning",
				);
				return fn();
			}
		}

		ctx.ui.notify(`Pinned model "${activeSpec}" (from ${activeSource}) for this /readyset run.`, "info");

		try {
			return await fn();
		} finally {
			// The approve branch of the gate sets `state.handoff` before it fires the execution turn
			// and returns. Execution is handed to core omp fire-and-forget, so restoring here would
			// land exactly as the execution turn starts, making it run on the pre-run model instead of
			// the pinned/apply-phase one. The restore moves to the settle of this session's handoff
			// (the agent_end hook -> handlePendingHandoff).
			// Session identity, like every other handoff check (sessionMatches; cwd fallback only when
			// either side has no session id).
			const handedOff = state.handoff !== undefined && sessionMatches(ctx, state.handoff.sessionId, state.handoff.cwd);
			if (!handedOff) {
				try {
					await setModel(original);
				} catch {
					ctx.ui.notify(
						`Couldn't restore the model this session had before pinning "${activeSpec}" — check /model if it looks off.`,
						"warning",
					);
				}
			}
		}
	}

	function resetActiveGrillSession(): void {
		state.grill = undefined;
	}

	function resetPendingHandoff(): void {
		state.handoff = undefined;
		state.handoffRestoreTarget = undefined;
	}

	/**
	 * Mirrors `state.handoff` to `readyset/changes/<id>/handoff.json` (readyset-spec.ts
	 * `HANDOFF_STATE_FILE`). Module state dies with the omp process; without this, a restart, crash
	 * or session resume mid-execution left the `apply` window open forever, readyset_verify detached,
	 * the session_stop gate silent and the review policy never applied. `restoreTo` is NOT persisted:
	 * it is an opaque host model object, and a fresh process has no pin of this run's to undo anyway.
	 * Never throws -- persistence is best-effort, the in-memory handoff still works without it.
	 */
	async function persistPendingHandoff(handoff: PendingHandoff): Promise<void> {
		await writeHandoffState(handoff.cwd, {
			changeId: handoff.changeId,
			...(handoff.sessionId !== undefined ? { sessionId: handoff.sessionId } : {}),
			armedAt: handoff.armedAt ?? new Date().toISOString(),
			...(handoff.reviewPolicy !== undefined ? { reviewPolicy: handoff.reviewPolicy } : {}),
			...(handoff.pauses ? { pauses: handoff.pauses } : {}),
			...(handoff.blocks ? { blocks: handoff.blocks } : {}),
			...(handoff.verificationBlocks ? { verificationBlocks: handoff.verificationBlocks } : {}),
			...(handoff.signal ? { signal: handoff.signal } : {}),
			...(handoff.verify ? { verify: handoff.verify } : {}),
			...(handoff.tests ? { tests: handoff.tests } : {}),
		}).catch(() => {});
	}

	/** `${cwd}\0${sessionId}` pairs already scanned for a persisted handoff this process, so the scan
	 *  (a readdir of readyset/changes/) runs once per session per repo, not on every agent_end. Keyed by
	 *  session too: a subagent's own first agent_end must not use up the parent's one scan. */

	/**
	 * Re-attaches a handed-off execution armed by THIS session in an earlier process (see
	 * `persistPendingHandoff`), once per session per cwd. Called at every entry point that consults
	 * `state.handoff`: the agent_end settle, the session_stop gate, readyset_verify and the
	 * /readyset command. A no-op while a handoff is already armed in memory. Matching uses
	 * `sessionMatches`, so a different session's handoff is never adopted (it is closed explicitly by
	 * `/readyset --review <id>` instead); with no session id on either side it falls back to cwd.
	 */
	async function rehydratePendingHandoff(ctx: { cwd?: string; ui?: unknown; sessionManager?: { getSessionId?: () => string } }): Promise<void> {
		if (state.handoff !== undefined || !ctx.cwd) return;
		const cwd = ctx.cwd;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		const key = `${cwd}\u0000${sessionId ?? ""}`;
		if (state.rehydrationChecked.has(key)) return;
		state.rehydrationChecked.add(key);
		const mine = (await listHandoffStates(cwd).catch(() => [])).find((h) => sessionMatches(ctx, h.sessionId, cwd));
		if (!mine || state.handoff !== undefined) return;
		state.handoff = {
			changeId: mine.changeId,
			restoreTo: undefined,
			cwd,
			sessionId: mine.sessionId,
			armedAt: mine.armedAt,
			reviewPolicy: mine.reviewPolicy as ArmedReviewPolicy | undefined,
			pauses: mine.pauses,
			blocks: mine.blocks,
			verificationBlocks: mine.verificationBlocks,
			rehydrated: true,
			signal: mine.signal,
			verify: mine.verify as VerifySettings | undefined,
			tests: mine.tests as TestRun | undefined,
		};
		state.verifyChangeId = mine.changeId;
		(ctx.ui as { notify?: (m: string, l?: string) => void } | undefined)?.notify?.(
			`Readyset re-attached to the handed-off execution of "${mine.changeId}" (approved ${mine.armedAt}, before this omp process started).`,
			"info",
		);
	}

	/**
	 * Kicks off grilling for a raw, directly-typed idea and returns immediately — deliberately not
	 * awaited against `ctx.waitForIdle()` the way `spendTurn`/`fireTurnAndWait` are, because the
	 * turns that follow are ordinary chat turns the user answers directly (see `grillTurnPrompt`'s
	 * doc comment). Handler call sites `return` right after this.
	 */
	function startGrilling(
		pi: ExtensionAPI,
		ctx: ReviewCtx,
		ideaText: string,
		laneDefault: LaneDefault,
		preferredLanguage?: string,
		execOptions?: BrainstormExecutionOptions,
		grillModel?: GrillModelPin,
	): void {
		const today = new Date().toISOString().slice(0, 10);
		const preview = ideaText.length > 60 ? `${ideaText.slice(0, 57)}...` : ideaText;
		state.grillRounds.rounds = 0;
		state.grillRounds.active = true; // consumed by the command handler's zero-rounds check -- see state.grillRounds's doc comment

		const files = new Set<string>();
		const brainstormDir = join(ctx.cwd, BRAINSTORM_DIR);
		if (existsSync(brainstormDir)) {
			try {
				for (const entry of readdirSync(brainstormDir)) {
					if (entry.endsWith(".md")) {
						files.add(join(brainstormDir, entry));
					}
				}
			} catch {}
		}

		if (execOptions) {
			state.grill = {
				active: true,
				startedAt: Date.now(),
				ideaText,
				laneDefault,
				preferredLanguage,
				existingFiles: files,
				execOptions,
				waitForIdle: ctx.waitForIdle,
				sessionId: ctx.sessionManager?.getSessionId?.(),
				grillModel,
			};
		}

		ctx.ui.notify(
			`Grilling started for: "${preview}"${preferredLanguage ? ` in ${preferredLanguage}` : ""} — Readyset will ask questions ` +
				"right here in the chat (a structured picker where available); answer them, and it'll write the " +
				"brainstorm file once the design is genuinely resolved.",
			"info",
		);
		pi.sendUserMessage(grillTurnPrompt(ideaText, today, laneDefault, preferredLanguage));
	}

	/**
	 * Pins the model the grill turn runs on, BEFORE `startGrilling` fires it. Grilling is a plain chat
	 * turn fired with `pi.sendUserMessage` and returned from immediately, so neither
	 * `withPinnedModel` nor `withPhaseModel` (both scoped to an awaited `fn`) can cover it -- which is
	 * why `--phase-model grill=…` used to be accepted, advertised as a cost lever, and silently
	 * ignored, while the `grill` phase event still recorded it as the model used.
	 *
	 * Precedence mirrors every other phase (`phaseModelFor` in executeBrainstorm): the grill phase
	 * override (`--phase-model grill=` flag, else `readyset.model.phases.grill`) wins, else the run's
	 * pin (`--model`, else `readyset.model`/`modelRoles.default`). Like `withPhaseModel`, a spec that
	 * fails to resolve or apply warns and leaves the session model alone -- a cost optimization is
	 * never a reason to stop grilling. Returns the pin (with the pre-pin model to restore), or
	 * `undefined` when nothing was applied.
	 */
	async function applyGrillModel(pi: ExtensionAPI, ctx: ReviewCtx, parsedArgs: ReadysetArgs): Promise<GrillModelPin | undefined> {
		let spec: string | undefined;
		let source = "";
		const fromFlag = (parsedArgs.phaseModels ?? []).filter((e) => e.phase === "grill").at(-1);
		if (fromFlag) {
			spec = fromFlag.model;
			source = "--phase-model flag";
		} else {
			const fromConfig = (await readPhaseModels()).entries.find((e) => e.phase === "grill");
			if (fromConfig) {
				spec = fromConfig.model;
				source = fromConfig.source;
			} else if (parsedArgs.model) {
				spec = parsedArgs.model;
				source = "--model flag";
			} else {
				const pinned = await readPinnedModel();
				if (pinned.model) {
					spec = pinned.model;
					source = pinned.source ?? "";
				}
			}
		}
		if (!spec) return undefined;

		const setModel = resolveHostSetModel(pi);
		const models = ctx.models;
		if (!setModel || !models?.current) {
			ctx.ui.notify(
				`Grill model "${spec}" (from ${source}) was given, but this omp build doesn't expose pi.setModel/ctx.models.current — grilling runs on the session model.`,
				"warning",
			);
			return undefined;
		}
		const resolved = models.resolve ? models.resolve(spec) : spec;
		if (resolved === undefined || resolved === null) {
			ctx.ui.notify(`Grill model "${spec}" (from ${source}) didn't resolve to any available model — grilling runs on the session model.`, "warning");
			return undefined;
		}
		const restoreTo = models.current();
		let applied = false;
		try {
			applied = (await setModel(resolved)) !== false;
		} catch {
			applied = false;
		}
		if (!applied) {
			ctx.ui.notify(`Grill model "${spec}" (from ${source}) couldn't be applied (usually: no API key) — grilling runs on the session model.`, "warning");
			return undefined;
		}
		ctx.ui.notify(
			`Grilling runs on "${spec}" (from ${source}). The previous model is restored once the brainstorm is written, or on the next /readyset command.`,
			"info",
		);
		return { spec, source, restoreTo };
	}

	/** Restores the model a grill pin replaced. One-shot (marks the pin `restored`), never throws. */
	async function restoreGrillModel(pi: ExtensionAPI, ctx: ReviewCtx, session: ActiveGrillSession | undefined): Promise<void> {
		const pin = session?.grillModel;
		if (!pin || pin.restored) return;
		pin.restored = true;
		const setModel = resolveHostSetModel(pi);
		try {
			if (!setModel) throw new Error("no setModel");
			await setModel(pin.restoreTo);
		} catch {
			ctx.ui.notify(`Couldn't restore the model this session had before grilling on "${pin.spec}" — check /model if it looks off.`, "warning");
		}
	}

	async function findNewlyWrittenBrainstorm(cwd: string, session: ActiveGrillSession): Promise<string | undefined> {
		if (session.writtenBrainstormFile && existsSync(session.writtenBrainstormFile)) {
			return session.writtenBrainstormFile;
		}
		const brainstormDir = join(cwd, BRAINSTORM_DIR);
		if (!existsSync(brainstormDir)) return undefined;
		try {
			const entries = await readdir(brainstormDir);
			let latestFile: string | undefined;
			let latestMtime = session.startedAt;
			for (const entry of entries) {
				if (!entry.endsWith(".md")) continue;
				const fullPath = join(brainstormDir, entry);
				if (!session.existingFiles.has(fullPath)) {
					return fullPath;
				}
				try {
					const st = await stat(fullPath);
					if (st.mtimeMs >= latestMtime) {
						latestMtime = st.mtimeMs;
						latestFile = fullPath;
					}
				} catch {}
			}
			return latestFile;
		} catch {
			return undefined;
		}
	}

	async function handleGrillEndTransition(pi: ExtensionAPI, ctx: ReviewCtx): Promise<void> {
		try {
			await runGrillEndTransition(pi, ctx);
		} catch (err) {
			ctx.ui.notify(
				`Readyset couldn't continue from grilling: ${err instanceof Error ? err.message : String(err)}. ` +
					"Run /readyset and pick the brainstorm to resume.",
				"error",
			);
			return;
		}
	}

	async function runGrillEndTransition(pi: ExtensionAPI, ctx: ReviewCtx): Promise<void> {
		if (!state.grill?.active) return;
		const session = state.grill;
		// The ctx this run is driven with from here on. This function fires from two places: the
		// /readyset command handler (command ctx: has waitForIdle) and omp's agent_end hook (general
		// ExtensionContext: no waitForIdle). `session` was captured from the command ctx at
		// startGrilling time and carries that ctx's own waitForIdle, so spread it in when the hook
		// ctx lacks one. The spread also keeps cwd/ui/models/mode/isIdle/hasPendingMessages from the
		// hook ctx and replaces only the missing member; `session.waitForIdle` may itself be
		// undefined (a direct call with a non-command ctx), in which case fireTurnAndWait's polling
		// fallback takes over.
		const runCtx: ReviewCtx = ctx.waitForIdle ? ctx : { ...ctx, waitForIdle: session.waitForIdle };
		const newlyWritten = await findNewlyWrittenBrainstorm(ctx.cwd, session);
		if (!newlyWritten) {
			// Grilling still in progress (intermediate question round)
			return;
		}

		// Brainstorm file is written! Mark grilling complete.
		state.grill = undefined;
		state.grillRounds.active = false;
		// Grilling is over: give the session its own model back before anything else runs, so
		// executeBrainstorm's withPinnedModel captures (and later restores to) the real pre-run model,
		// not the grill pin. Also the right moment for "Finish here" -- nothing else will restore it.
		await restoreGrillModel(pi, ctx, session);

		const relativePath = relative(ctx.cwd, newlyWritten);
		ctx.ui.notify(`Brainstorm file created: ${relativePath}`, "info");

		const isIndonesian =
			session.preferredLanguage === "id" ||
			session.preferredLanguage === "indonesian" ||
			/indonesia/i.test(session.preferredLanguage ?? "");

		const promptText = isIndonesian
			? `Brainstorm selesai (${basename(newlyWritten)}). Lanjut ke tahap berikutnya?`
			: `Brainstorm complete (${basename(newlyWritten)}). Continue to next phase?`;

		const continueLabel = isIndonesian
			? "Lanjut ke Propose (Explore & Propose)"
			: "Continue to Explore & Propose (Recommended)";
		const finishLabel = isIndonesian
			? "Selesai di sini (Review file dulu)"
			: "Finish here (review brainstorm first)";

		const choice = await ctx.ui.select(promptText, [
			{
				label: continueLabel,
				description: isIndonesian
					? "Lanjutkan eksplorasi repo dan pembuatan proposal/spesifikasi secara otomatis"
					: "Grounded repo checks + proposal, design, specs, and tasks",
			},
			{
				label: finishLabel,
				description: isIndonesian
					? "Berhenti di sini untuk membaca atau mengedit file brainstorm sebelum propose"
					: "Stop here to inspect or edit the brainstorm file before proposing",
			},
		]);

		if (choice === continueLabel) {
			const all = await loadBrainstorms(ctx.cwd);
			await reconcileStatuses(ctx.cwd, all);
			const chosen = all.find((b) => b.file === newlyWritten || b.slug === basename(newlyWritten, ".md"));
			if (!chosen) {
				ctx.ui.notify(`Could not load brainstorm metadata for ${relativePath}`, "warning");
				return;
			}
			await deps.executeBrainstorm(pi, runCtx, chosen, { ...session.execOptions, grillModel: session.grillModel?.spec });
		} else {
			ctx.ui.notify(`Brainstorm saved at ${relativePath}. Run /readyset when you're ready to proceed.`, "info");
		}
	}

	/**
	 * Reads this change's `apply` `start` phase event and returns the model it recorded, or
	 * `undefined` when there is none (an unpinned run, or events that predate the field). That is the
	 * honest value to carry onto the balancing `apply` `end` event — never a fabricated one.
	 */
	async function executionModelOf(cwd: string, changeId: string): Promise<string | undefined> {
		const events = await readPhaseEvents(cwd, changeId);
		return events.find((e) => e.phase === "apply" && e.edge === "start")?.model;
	}

	/**
	 * Settles a pending execution handoff: records the balancing `apply` `end` phase event and
	 * restores the model the session had before the run pinned anything. Shared by the terminal
	 * `agent_end` path (handlePendingHandoff) and the command-start supersede path so the two cannot
	 * drift on the event shape, the restore, or the notify.
	 *
	 * `handoff` is already detached from the module state by the caller, so a throw here cannot leave
	 * a stale handoff armed. Never throws: the event write and the restore each degrade to a warning.
	 */
	async function settleHandoff(
		pi: ExtensionAPI,
		ctx: ReviewCtx,
		handoff: {
			changeId: string;
			restoreTo: unknown;
			reviewPolicy?: ArmedReviewPolicy;
			pauses?: number;
			blocks?: number;
			verificationBlocks?: number;
			rehydrated?: boolean;
			signal?: HandoffSignal;
			verify?: VerifySettings;
			tests?: TestRun;
		},
		outcome: string,
	): Promise<void> {
		// A real settle (the execution signalled done, or ran every task to completion) gets its diff measured NOW, live, against the approve base — not read
		// back from a stale event later — and the review policy applied. `handoff-superseded` and
		// `handoff-orphaned` skip both: the execution was abandoned mid-run, nothing is conclusive.
		const isRealSettle = outcome === "handoff-done" || outcome === "handoff-settled";
		const changedPaths = isRealSettle
			? await pathsChangedThisRun(ctx.cwd, handoff.changeId).catch(() => [] as string[])
			: undefined;
		const diff = changedPaths ? await applyDiffStats(ctx.cwd, handoff.changeId, changedPaths).catch(() => undefined) : undefined;

		// Deterministic verification: the test run readyset_done just performed is reused (the turn
		// that sent `done` ended right after it); otherwise a real settle runs the command now.
		const tests = isRealSettle && handoff.verify?.command
			? (handoff.tests ?? (await runTestCommand(ctx.cwd, handoff.verify.command).catch(() => undefined)))
			: undefined;

		// The review decision is taken BEFORE the apply `end` event is written, so the event can carry
		// it (the bench reads the settle's decision from there rather than from notify text).
		const reviewDecision = isRealSettle && changedPaths && handoff.reviewPolicy
			? await applyReviewPolicyAtSettle(ctx, handoff.changeId, handoff.reviewPolicy, changedPaths, diff ?? { files: 0, added: 0, deleted: 0 }, tests).catch(() => undefined)
			: undefined;

		await appendPhaseEvent(ctx.cwd, handoff.changeId, {
			phase: "apply",
			edge: "end",
			at: new Date().toISOString(),
			lane: (await readChangeLane(ctx.cwd, handoff.changeId)) ?? "full",
			laneSource: "brainstorm",
			model: await executionModelOf(ctx.cwd, handoff.changeId).catch(() => undefined),
			outcome,
			...(diff ? { diff } : {}),
			handoff: {
				pauses: handoff.pauses ?? 0,
				blocks: handoff.blocks ?? 0,
				verificationBlocks: handoff.verificationBlocks ?? 0,
				rehydrated: handoff.rehydrated === true,
				...(handoff.signal ? { signal: handoff.signal.status } : {}),
			},
			...(reviewDecision ? { reviewPolicy: reviewDecision } : {}),
			...(tests ? { tests: testRunSummary(tests) } : {}),
		}).catch(() => {});
		if (tests && !tests.passed) {
			ctx.ui.notify(`Tests are failing after the execution of "${handoff.changeId}": \`${tests.command}\` exited ${tests.exitCode ?? "without an exit code"}.`, "warning");
		}
		// The window is closed: the persisted copy must not be re-attached by a later process.
		await clearHandoffState(ctx.cwd, handoff.changeId).catch(() => {});

		// readyset_verify is only meaningful while THIS handoff's execution is live.
		if (state.verifyChangeId === handoff.changeId) state.verifyChangeId = undefined;

		if (outcome === "handoff-done") {
			ctx.ui.notify(`Execution of "${handoff.changeId}" signalled done: ${handoff.signal?.summary ?? "(no summary)"}`, "info");
		}

		if (handoff.restoreTo === undefined) return; // nothing was ever pinned; nothing to restore

		const setModel = resolveHostSetModel(pi);
		if (!setModel) {
			ctx.ui.notify("Couldn't restore the model this session had before the /readyset run — check /model if it looks off.", "warning");
			return;
		}
		try {
			await setModel(handoff.restoreTo);
		} catch {
			ctx.ui.notify("Couldn't restore the model this session had before the /readyset run — check /model if it looks off.", "warning");
			return;
		}
		if (outcome === "handoff-superseded") {
			ctx.ui.notify(
				"A new /readyset command superseded the handed-off execution — the model this session had before the run is restored (handoff-superseded).",
				"warning",
			);
		} else {
			ctx.ui.notify("Execution settled — restored the model this session had before the run.", "info");
		}
	}

	/**
	 * Applies the run's risk-based review policy once a handoff has genuinely settled (not paused,
	 * not superseded) — the automatic post-Apply review turn that used to fire this decision no
	 * longer exists now that Apply is a fire-and-forget handoff to core omp (nothing in this
	 * extension's control flow runs after the handoff returns), so this is the only place left that
	 * ever applies `readyset.review.mode`. Two outcomes, never a review turn fired here (settleHandoff
	 * runs from the `agent_end` hook, with no turn budget of its own):
	 *   - review is skipped (mode `never`, or `auto` with no trigger fired) -> `writeReviewSkipStub`
	 *     records why, so REVIEW.md distinguishes "nothing was checked" from "checked and clean".
	 *   - review is recommended (mode `always`, `auto` on the full lane when the `readyset.review.
	 *     fullLane` exemption is `always`, or `auto` with a trigger fired) -> a notify tells the user
	 *     to run `/readyset --review <id>`, naming which trigger(s) fired when there are any.
	 * `changedPaths`/`diff` are the caller's own live measurement (settleHandoff) — reused rather
	 * than re-measured, so this can never disagree with what the apply `end` event just recorded.
	 */
	async function applyReviewPolicyAtSettle(
		ctx: ReviewCtx,
		changeId: string,
		policy: ArmedReviewPolicy,
		changedPaths: string[],
		diff: { files: number; added: number; deleted: number },
		tests?: TestRun,
	): Promise<NonNullable<PhaseEvent["reviewPolicy"]>> {
		const productPaths = changedPaths.filter((p) => !isPlanningPath(p));
		const lane = (await readChangeLane(ctx.cwd, changeId)) ?? "full";

		if (policy.mode === "never") {
			await writeReviewSkipStub(ctx.cwd, changeId, { evaluated: [], fired: [], firedSensitivePaths: [] }, "never");
			return { mode: policy.mode, decision: "skipped", triggersFired: [] };
		}

		// "always", or "auto" on the full lane when the fullLane exemption says full-lane changes
		// always get reviewed regardless of trigger: no trigger evaluation needed either way.
		if (policy.mode === "always" || (policy.mode === "auto" && lane === "full" && policy.fullLane === "always")) {
			// Triggers are not evaluated on this path, but a failing test run is a fact worth
			// recording and naming, whatever the policy.
			const testsFailing = tests !== undefined && !tests.passed;
			ctx.ui.notify(
				`Review recommended for "${changeId}" (readyset.review.mode = ${policy.mode}` +
					(policy.mode === "auto" ? ", full lane" : "") +
					(testsFailing ? ", tests-failing" : "") +
					`) — run /readyset --review ${changeId}.`,
				testsFailing ? "warning" : "info",
			);
			return { mode: policy.mode, decision: "recommended", triggersFired: testsFailing ? ["tests-failing"] : [] };
		}

		// "auto": evaluate the same triggers evaluateReviewTriggers always has, against this run's
		// own live diff and scope — never a stale value from an earlier phase event.
		const scope = await checkScope(ctx.cwd, changeId, productPaths).catch(() => ({ noContract: true as const, outside: [] as string[] }));
		const justified = new Set((await readScopeDeviations(ctx.cwd, changeId).catch(() => [])).map((d) => d.path));
		const driftPaths = (scope.noContract ? [] : scope.outside).filter((p) => !justified.has(p));
		const brainstorm = await loadBrainstorms(ctx.cwd).then((all) => all.find((b) => b.changeId === changeId)).catch(() => undefined);
		const [conflicts, evidence, verification, progress] = await Promise.all([
			findEvidenceConflicts(ctx.cwd, changeId),
			checkTaskEvidence(ctx.cwd, changeId),
			checkTaskVerification(ctx.cwd, changeId),
			getProgress(ctx.cwd, changeId),
		]);
		const openDecisions = await readOpenDecisions(ctx.cwd, changeId).catch(() => []);
		const triggerResult = evaluateReviewTriggers({
			unjustifiedDriftPaths: driftPaths,
			evidenceConflicts: conflicts,
			evidenceTotal: evidence.totalRecords,
			verification,
			checkedTasks: progress?.done ?? 0,
			diff,
			changedPaths: productPaths,
			clarity: brainstorm?.clarity,
			openDecisions: openDecisions.length,
			protectedPatterns: policy.protectedPaths,
			testPaths: policy.testPaths,
			verifiedCommandNotes: verification?.withCommandNote ?? 0,
			...(tests ? { tests: testRunSummary(tests) } : {}),
			thresholds: policy.thresholds,
		});

		if (triggerResult.fired.length === 0) {
			await writeReviewSkipStub(ctx.cwd, changeId, triggerResult, "auto");
			return { mode: policy.mode, decision: "skipped", triggersFired: [] };
		}
		ctx.ui.notify(
			`Review recommended for "${changeId}": ${triggerResult.fired.join(", ")} — run /readyset --review ${changeId}.`,
			"warning",
		);
		return { mode: policy.mode, decision: "recommended", triggersFired: triggerResult.fired };
	}

	/**
	 * Settles a pending execution handoff: records the balancing `apply` `end` phase event and
	 * restores the model the session had before the run pinned anything.
	 *
	 * Runs from the `agent_end` hook, and only on a terminal settle — see the handler's comment for
	 * why `agent_end` (`willContinue !== true`) and not `session_stop`. The hook ctx is the general
	 * `ExtensionContext`, which is all this needs: cwd, ui, and (for the restore) `pi.setModel`.
	 *
	 * Pause-aware: a terminal `agent_end` with tasks still unfinished means execution paused to ask a
	 * question or report a blocker (applyTurnPrompt tells the model to pause rather than guess), NOT
	 * that it finished. In that case the handoff stays armed, the execution model stays active, and a
	 * pause record is written; the model is restored when the tasks finish or on the next /readyset
	 * command (supersede).
	 *
	 * The handoff state is cleared first, so a throw later cannot leave a stale handoff armed forever
	 * and re-firing on every subsequent agent_end.
	 */
	async function handlePendingHandoff(pi: ExtensionAPI, ctx: ReviewCtx): Promise<void> {
		const handoff = state.handoff;
		if (!handoff) return;
		if (!sessionMatches(ctx, handoff.sessionId, handoff.cwd)) return; // another session's settle: leave it
		// The executing model's own completion signal wins over every heuristic below: readyset_done
		// only records `done` once every task is checked and verified (see registerDoneTool), so the
		// turn that sent it is the end of the execution — no inference from checkboxes or git needed.
		if (handoff.signal?.status === "done") {
			state.handoff = undefined;
			state.handoffRestoreTarget = undefined;
			await settleHandoff(pi, ctx, handoff, "handoff-done");
			return;
		}
		if (!(await executionComplete(ctx.cwd, handoff.changeId))) {
			if (handoff.signal?.status === "blocked") {
				const blockedProgress = await getProgress(ctx.cwd, handoff.changeId).catch(() => undefined);
				// An explicit block (readyset_done status "blocked"): the model stopped to ask the user
				// something it cannot resolve alone — surface the question; the handoff stays armed.
				const summary = handoff.signal.summary;
				state.handoff = { ...handoff, signal: undefined, blocks: (handoff.blocks ?? 0) + 1 };
				await persistPendingHandoff(state.handoff);
				const where = `${blockedProgress?.done ?? 0}/${blockedProgress?.total ?? 0} tasks`;
				await appendContext(ctx.cwd, handoff.changeId, "Apply", `Execution blocked at ${where}: ${summary}`).catch(() => {});
				ctx.ui.notify(
					`Execution of "${handoff.changeId}" is blocked at ${where}: ${summary} — answer in chat to let it continue (the execution model stays active), or run /readyset to supersede it.`,
					"warning",
				);
				return;
			}
			// Unfinished, no signal: the execution paused (a question, a blocker, or simply a turn that
			// ended mid-work). It stays armed — execution model active — until readyset_done, all tasks
			// checked, or the next /readyset command supersedes it. No stall inference: the old
			// progress+tree fingerprint (two identical pauses => "handoff-stalled") was a guess about a
			// turn this extension no longer runs, and the source of most handoff bugs.
			const progress = await getProgress(ctx.cwd, handoff.changeId).catch(() => undefined);
			state.handoff = { ...handoff, pauses: (handoff.pauses ?? 0) + 1 };
			await persistPendingHandoff(state.handoff);
			ctx.ui.notify(
				`Execution paused at ${progress?.done ?? 0}/${progress?.total ?? 0} tasks — the execution model stays active until it signals readyset_done, all tasks are checked, or the next /readyset command.`,
				"info",
			);
			return; // handoff stays armed; state.handoffRestoreTarget stays set
		}
		state.handoff = undefined;
		state.handoffRestoreTarget = undefined;
		await settleHandoff(pi, ctx, handoff, "handoff-settled");
	}

	/**
	 * Settles a pending handoff that a new /readyset command is superseding, instead of dropping it.
	 * The previous behavior (resetPendingHandoff) cleared the state with no model restore and no
	 * balancing `apply` `end` event, so an abandoned or interleaved handoff left the session stuck on
	 * the execution model forever and the phase log with an unclosed `apply`.
	 *
	 * Shares settleHandoff with the terminal-settle path. No-ops when nothing is pending.
	 */
	async function supersedePendingHandoff(pi: ExtensionAPI, ctx: ReviewCtx): Promise<void> {
		const handoff = state.handoff;
		if (!handoff) return;
		state.handoff = undefined;
		state.handoffRestoreTarget = undefined;
		await settleHandoff(pi, ctx, handoff, "handoff-superseded");
	}

	/** How many times the `session_stop` verification gate below may return `decision: "block"` for
	 *  ONE session. omp itself does not cap `block`, so this file enforces its own ceiling: a model
	 *  that never adds a `_Verified:` note must not loop forever. */
	const MAX_VERIFICATION_SENDBACKS = 2;

	/** How many times the `session_stop` verification gate has blocked, keyed by
	 *  `<session id>:<change id>`. The session half: only the arming session is ever gated (see
	 *  `sessionStopVerificationCheck`), but keying by it keeps one session's budget from being spent
	 *  by another. The change half: the cap is per handoff, not per session lifetime -- keyed by
	 *  session alone, a session that exhausted the cap on change A would never be gated again on
	 *  change B. Never pruned: each entry is a few bytes and handoffs are not created at a rate where
	 *  this matters in practice. */

	/**
	 * Whether `session_stop`'s verification gate should block: true only while a handoff is armed
	 * (`state.handoff`, with readyset_verify attached to the same change -- `state.verifyChangeId`,
	 * armed at approve, cleared at settle), the stopping session IS the session that armed it, AND
	 * that change's tasks.md has at least one checked task with no `_Verified:` note.
	 *
	 * Session identity matters here for the same reason `sessionMatches` exists: omp rebinds a
	 * parent-imported extension factory into subagent runtimes in the same process, so every subagent
	 * core omp spawns during the handed-off execution shares this module's state and the parent's
	 * cwd. Without the check, each of them would be blocked (up to the cap) for a tasks.md it may not
	 * even own -- N parallel subagents, up to 2N wasted turns. Falls back to cwd matching when either
	 * side has no session id (older host builds). Scoped to the active handoff, not "every change
	 * under readyset/changes/", so an unrelated chat session with old changes lying around is never
	 * blocked by this gate.
	 */
	async function sessionStopVerificationCheck(cwd: string, sessionId: string | undefined): Promise<{ changeId: string; missing: number } | undefined> {
		const handoff = state.handoff;
		const changeId = state.verifyChangeId;
		if (!handoff || !changeId || handoff.changeId !== changeId) return undefined;
		const stopping = { cwd, sessionManager: sessionId === undefined ? undefined : { getSessionId: () => sessionId } };
		if (!sessionMatches(stopping, handoff.sessionId, handoff.cwd)) return undefined;
		// `_Verified:` notes are only enforced when readyset.verify.requireNotes asks for them (older
		// handoffs without verify settings keep the old, notes-required behavior).
		if (handoff.verify && !handoff.verify.requireNotes) return undefined;
		const verification = await checkTaskVerification(cwd, changeId).catch(() => undefined);
		if (!verification || verification.missing <= 0) return undefined;
		return { changeId, missing: verification.missing };
	}

	/**
	 * Registers `readyset_ask` — the tool `grillTurnPrompt` tells the model to call for every round
	 * of grilling questions, instead of writing "❓ Q1 ..." as plain chat text. Presents
	 * `ctx.ui.askDialog()`, omp's own native multi-question picker dialog (Interactive mode only —
	 * see `grillTurnPrompt`'s doc comment for the plain-chat-text fallback when it's unavailable),
	 * and returns the user's picks (or their own typed answer, or "let's discuss instead") back to
	 * the model as the tool result so it can decide whether the design tree is settled yet.
	 *
	 * Enforces `GRILL_ROUND_CAP` in code (see `state.grillRounds`'s doc comment) — once the cap is
	 * hit, this refuses to open another dialog and tells the model to check in via plain text
	 * instead, a real ceiling rather than the prompt-level-only convention grilling used before this
	 * tool existed.
	 */
	function registerAskTool(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "readyset_ask",
			label: "Readyset: Ask",
			description:
				"Ask the user one round of grilling questions as a real structured picker instead of plain chat text -- " +
				"use this for EVERY round while grilling a Readyset brainstorm. 1-4 questions per call, each with 2+ " +
				"real options (mark your own recommended one via recommendedIndex) plus room for the user to type " +
				"their own answer or ask to discuss instead of picking. Only meaningful during a /readyset grilling " +
				"conversation.",
			parameters: pi.zod.object({
				questions: pi.zod
					.array(
						pi.zod.object({
							id: pi.zod.string().describe("short stable id for this question within the round, e.g. 'q1'"),
							question: pi.zod.string().describe("the question text"),
							header: pi.zod.string().optional().describe("short label shown as a chip, e.g. 'Approach'"),
							options: pi.zod
								.array(
									pi.zod.object({
										label: pi.zod.string(),
										description: pi.zod.string().optional().describe("brief trade-off/context for this option"),
									}),
								)
								.min(2)
								.describe("2 or more real options"),
							recommendedIndex: pi.zod.number().int().min(0).optional().describe("index of your recommended option, if any"),
							multi: pi.zod.boolean().optional().describe("true if more than one option can be selected"),
							decision: pi.zod
								.string()
								.describe(
									"the plan decision this question changes, and how the plan differs per answer — one short " +
										"sentence; a question whose answers all lead to the same plan must not be asked",
								),
						}),
					)
					.min(1)
					.max(4)
					.describe("1-4 questions for this round"),
			}),
			approval: "read",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { questions: askedQuestions } = params as ReadysetAskParams;
				if (state.grillRounds.rounds >= GRILL_ROUND_CAP) {
					return {
						content: [
							{
								type: "text",
								text:
									`Round cap (${GRILL_ROUND_CAP}) reached for this grilling session -- not opening another dialog. ` +
									"Check in with the user in plain chat text instead: summarize what's decided, name what's still " +
									"open, and ask whether to keep grilling or write the brainstorm now with the rest under Open " +
									"Questions.",
							},
						],
					};
				}
				// Value-of-information gate: every question must name the plan decision it changes.
				// A question whose answers all lead to the same plan must not be asked at all — the
				// model decides it and records it under the brainstorm's "Assumed" list instead. This
				// is checked BEFORE rounds++ so a rejected round neither opens the dialog nor consumes
				// the round budget (a malformed round can be corrected without burning the ceiling).
				const missingDecision = askedQuestions.filter((q) => !q.decision || q.decision.trim() === "");
				if (missingDecision.length > 0) {
					return {
						content: [
							{
								type: "text",
								text:
									`Rejected: ${missingDecision.length} question(s) had no \`decision\` field (${missingDecision.map((q) => q.id).join(", ")}). ` +
									"Every question must name the plan decision it changes and how the plan differs per answer, in the " +
									"question's `decision` field. If a question's answers would all lead to the same plan, do not ask it — " +
									"decide it yourself and record it under an \"Assumed\" list in the brainstorm instead. Re-send this round " +
									"with a `decision` on every question.",
							},
						],
					};
				}
				state.grillRounds.rounds++;

				if (!ctx.ui.askDialog) {
					return {
						content: [
							{
								type: "text",
								text:
									"The structured picker isn't available in this session (non-interactive mode) -- ask this " +
									"round's questions as plain chat text instead, same content and same rules (real options, your " +
									"own recommendation, never accept a passive answer), then wait for the user's next message.",
							},
						],
					};
				}

				const questions: ExtensionAskDialogQuestion[] = askedQuestions.map((q) => ({
					id: q.id,
					question: q.question,
					header: q.header,
					options: q.options,
					multi: q.multi,
					recommended: q.recommendedIndex,
				}));

				let result: ExtensionAskDialogResult | undefined;
				try {
					result = await ctx.ui.askDialog(questions);
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					return {
						content: [
							{
								type: "text",
								text: `The structured picker failed to open (${reason}) -- ask this round's questions as plain chat text instead.`,
							},
						],
					};
				}

				if (!result) {
					return {
						content: [
							{
								type: "text",
								text:
									"The user closed the picker without answering. Ask them directly in plain chat what they'd " +
									"like to do -- keep grilling, or stop here.",
							},
						],
					};
				}

				if (result.kind === "chat") {
					return {
						content: [
							{
								type: "text",
								text:
									"The user chose to discuss this round in plain chat instead of picking from the options -- " +
									"continue the conversation normally and wait for their next message before calling " +
									"readyset_ask again.",
							},
						],
					};
				}

				const lines = result.results.map((r) => {
					const picked = r.customInput
						? `their own answer: "${r.customInput}"`
						: r.selectedOptions.length > 0
							? r.selectedOptions.join(", ")
							: "(no option picked)";
					return `- ${r.question} -> ${picked}${r.note ? ` (note: ${r.note})` : ""}${r.timedOut ? " [timed out]" : ""}`;
				});
				return { content: [{ type: "text", text: `User's answers this round:\n${lines.join("\n")}` }] };
			},
		});
	}

	/**
	 * Which Readyset change `readyset_verify` should attach evidence to. Module-level, same
	 * trade-off `state.grillRounds` documents above: `registerTool`'s `execute()` has no per-run
	 * channel for extension-local state, only `ctx`, and evidence needs to know which
	 * `readyset/changes/<id>/` to write into — a concept Readyset owns, not omp. Armed at approve,
	 * right before the execution is handed off to core omp (`reviewAndMaybeExecute`), and cleared by
	 * `settleHandoff` once that handoff settles, so a `readyset_verify` call outside a live handoff
	 * gets a clear "not currently applicable" result instead of silently writing evidence to a
	 * stale change. Not
	 * designed for two concurrent Apply turns in the same process — an accepted limitation, not a
	 * real scenario this single-session tool needs to guard against.
	 */

	/**
	 * Registers `readyset_verify` — a runtime evidence *collector*, not a correctness judge.
	 *
	 * What it does, and only this: runs a command (real `node:child_process`, see
	 * `readyset-evidence.ts`'s `runCommand` doc comment for why `shell: true` and why there's no
	 * OMP execution mechanism to reuse instead), captures the REAL exit code/stdout/stderr/
	 * duration, and persists it as an immutable evidence record tied to a `taskId`
	 * (`readyset/changes/<id>/evidence/E<NNN>.md`).
	 *
	 * What it deliberately does NOT do, on purpose, per the locked v1 scope: mark a task `[x]`,
	 * modify `_Verified:`, decide correctness, infer requirement satisfaction, perform semantic
	 * review, or become a general verification engine. `_Verified:` (the model's own prose note,
	 * checked structurally by `checkTaskVerification` in readyset-spec.ts) is UNCHANGED and stays
	 * exactly as load-bearing as before — this tool runs alongside it, not instead of it. The
	 * shape is:
	 *
	 *   readyset_verify() -> EvidenceRecord -> task references evidence -> Review interprets evidence
	 *
	 * never:
	 *
	 *   readyset_verify() -> "task is correct"
	 *
	 * `npm test` exiting 0 means "npm test executed successfully" — it does NOT mean "the
	 * implementation satisfies the requirement." A command that runs clean but tests the wrong
	 * thing is exactly as "verified" by this tool as one that actually covers the requirement;
	 * judging that distinction stays the separate Code-review turn's job, same as before this
	 * tool existed.
	 *
	 * Approval tier is `"exec"` (command execution) — confirmed against real omp source
	 * (`ToolDefinition.approval`'s doc comment: `"exec": code execution`; this is also the
	 * default when the field is omitted, set explicitly here to self-document rather than rely on
	 * the default silently). This goes through the SAME approval gate as any other write/exec
	 * tool call — `tools.approvalMode` in the user's own config governs it exactly like it
	 * governs the model's ordinary bash tool, per the same reasoning `state.grillRounds`'s doc
	 * comment above lays out for `ctx.ui` dialogs (except this genuinely is a permission-gated
	 * tool call, not a UI dialog, so approval mode DOES apply here — this is real command
	 * execution, deliberately not exempted from it).
	 *
	 * Self-reported `_Verified:` and runtime-captured evidence are two independent signals and
	 * this tool never reconciles them — see the "Evidence" review section and the
	 * `findEvidenceConflicts` call in `takeReviewSnapshot` for where a mismatch (task marked done,
	 * latest evidence shows failure) is surfaced. v1 keeps that passive/observational only (a line
	 * in the review panel), not a blocking gate — see the package README/doc comments for why.
	 *
	 * `applyTurnPrompt` recommends this tool and asks the model to cite the record it returns as
	 * `evidence E00N` in the task's `_Verified:` note (0.18; v1 deliberately left it unmentioned to
	 * observe whether the model reached for it unprompted -- it mostly did not). A citation is a
	 * checkable claim: `findEvidenceConflicts` flags one that names a missing record, another task's
	 * record, or a failed run, and readyset_done refuses "done" while any conflict remains.
	 */
	function registerVerifyTool(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "readyset_verify",
			label: "Readyset: Verify",
			description:
				"Run a command and capture its REAL execution result (exit code, stdout, stderr, duration) as an " +
				"immutable evidence record tied to a task -- for use during Apply, when you want a machine-captured " +
				"record instead of just writing a `_Verified:` note yourself. This does NOT mark the task done, does " +
				"NOT modify tasks.md or `_Verified:`, and does NOT judge correctness -- a captured exitCode 0 means " +
				"the command ran and exited cleanly, not that the requirement is satisfied. You still update " +
				"tasks.md and write your own `_Verified:` note (referencing the evidence id this returns is a good " +
				"idea, but not required). Only meaningful during Apply, against the task currently being implemented.",
			parameters: pi.zod.object({
				taskId: pi.zod.string().describe("the task's id exactly as it appears in tasks.md (e.g. '2.1')"),
				command: pi.zod.string().describe("the command to run, exactly as you'd type it in a shell -- pipes/&&/redirects are fine"),
			}),
			approval: "exec",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { taskId, command } = params as ReadysetVerifyParams;
				await rehydratePendingHandoff(asReviewCtx(ctx)).catch(() => {});
				const changeId = state.verifyChangeId;
				if (!changeId) {
					return {
						content: [
							{
								type: "text",
								text:
									"readyset_verify isn't attached to an active Apply turn right now, so there's nowhere to record " +
									"this evidence. If you're implementing a task this turn, that's unexpected -- otherwise just run " +
									"the command directly instead of through this tool.",
							},
						],
					};
				}

				const cwd = asReviewCtx(ctx).cwd;
				const startedAt = new Date().toISOString();
				const result = await runCommand(command, cwd, EVIDENCE_TIMEOUT_MS);
				const stdoutCap = truncateForCapture(result.stdout, EVIDENCE_MAX_OUTPUT_BYTES);
				const stderrCap = truncateForCapture(result.stderr, EVIDENCE_MAX_OUTPUT_BYTES);

				const record = await persistEvidence(cwd, changeId, {
					taskId,
					command,
					cwd,
					startedAt,
					durationMs: result.durationMs,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					signal: result.signal,
					stdout: stdoutCap.text,
					stderr: stderrCap.text,
					stdoutTruncated: stdoutCap.truncated,
					stderrTruncated: stderrCap.truncated,
				});

				const outcome = result.timedOut
					? `timed out after ${Math.round(EVIDENCE_TIMEOUT_MS / 1000)}s`
					: result.exitCode === null
						? "did not produce an exit code (process error -- see stderr in the evidence record)"
						: `exited ${result.exitCode}`;

				return {
					content: [
						{
							type: "text",
							text:
								`Evidence ${record.id} recorded for task ${taskId}: \`${command}\` ${outcome} in ` +
								`${result.durationMs}ms. This is a runtime-captured EXECUTION RESULT ONLY -- it does not by itself ` +
								"mean the task is done or the requirement is satisfied. You still need to update tasks.md and " +
								`write your own _Verified: note yourself (mentioning ${record.id} there is a good idea, but this ` +
								"tool never touches tasks.md itself).",
						},
					],
				};
			},
		});
	}

	/**
	 * Registers `readyset_done` — the executing model's explicit end-of-execution signal.
	 *
	 * Before it existed, "is the handed-off execution over?" was inferred at every terminal
	 * `agent_end`: all boxes ticked meant settled, anything else a pause. The checkbox read is the
	 * fallback now, not the rule:
	 *   - `done` is recorded only when every task in tasks.md is checked AND carries a `_Verified:`
	 *     note (the same check the session_stop gate applies) — otherwise the call is refused with the
	 *     reason, so a premature "done" costs one tool call, not a wrong settle. The next terminal
	 *     settle then closes the handoff as `handoff-done` (diff, review policy, model restore).
	 *   - `blocked` needs the question/blocker as its summary; the next terminal settle records an
	 *     explicit pause and surfaces the question to the user.
	 * Only the session that armed the handoff may signal it: a subagent reports to its parent, which
	 * decides. Approval tier `read`: it runs nothing, it only records Readyset's own state.
	 */
	function registerDoneTool(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "readyset_done",
			label: "Readyset: Done",
			description:
				"Signal that the handed-off execution of an approved Readyset change is over. status \"done\": every task " +
				"in tasks.md is checked and has its _Verified: note (refused otherwise, with the reason). status \"blocked\": " +
				"you cannot continue without the user — put the exact question in summary, then ask it. Call it once, as your " +
				"last action; only meaningful while executing an approved Readyset change.",
			parameters: pi.zod.object({
				status: pi.zod.enum(["done", "blocked"]).describe("done = all tasks checked and verified; blocked = need the user"),
				summary: pi.zod.string().optional().describe("done: one line on what was delivered; blocked: the exact question or blocker"),
			}),
			approval: "read",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
				const { status, summary } = params as ReadysetDoneParams;
				const c = asReviewCtx(ctx);
				await rehydratePendingHandoff(c).catch(() => {});
				const handoff = state.handoff;
				if (!handoff) {
					return reply(
						"readyset_done isn't attached to a handed-off Readyset execution right now, so there is nothing to signal. " +
							"If you are not executing an approved Readyset change, just finish your reply normally.",
					);
				}
				if (!sessionMatches(c, handoff.sessionId, handoff.cwd)) {
					return reply(
						"Only the session that approved this Readyset change can signal its execution. Report your result back to " +
							"the session that started you instead; it decides when the change is done.",
					);
				}
				const cwd = c.cwd ?? handoff.cwd;
				const text = (summary ?? "").trim();
				const at = new Date().toISOString();
				if (status === "blocked") {
					if (!text) return reply('Not recorded: status "blocked" needs a summary — the exact question or blocker for the user.');
					state.handoff = { ...handoff, signal: { status: "blocked", summary: text, at } };
					await persistPendingHandoff(state.handoff);
					return reply(
						"Recorded as blocked. Now ask the user that question in plain chat and end your turn — the execution stays " +
							"armed, and when they answer you continue from where you stopped.",
					);
				}
				if (status !== "done") return reply('Not recorded: status must be "done" or "blocked".');
				const progress = await getProgress(cwd, handoff.changeId).catch(() => undefined);
				if (progress && progress.done < progress.total) {
					return reply(
						`Not recorded: tasks.md still has ${progress.total - progress.done} unchecked task(s) (${progress.done}/${progress.total} done). ` +
							'Finish and verify them, or call readyset_done with status "blocked" and the question that stops you.',
					);
				}
				// `_Verified:` notes only when readyset.verify.requireNotes asks (older handoffs: always).
				const verification = !handoff.verify || handoff.verify.requireNotes
					? await checkTaskVerification(cwd, handoff.changeId).catch(() => undefined)
					: undefined;
				if (verification && verification.missing > 0) {
					return reply(
						`Not recorded: ${verification.missing} checked task(s) in tasks.md have no _Verified: note. Add one under each ` +
							"(what you ran or checked, and the actual result), then call readyset_done again.",
					);
				}
				const conflicts = await findEvidenceConflicts(cwd, handoff.changeId).catch(() => []);
				if (conflicts.length > 0) {
					return reply(
						`Not recorded: the notes disagree with the runtime evidence — ${conflicts.map(describeEvidenceConflict).join("; ")}. ` +
							"Fix the task (and re-run readyset_verify) or correct the citation, then call readyset_done again.",
					);
				}
				// The deterministic check: Readyset runs the project's test command itself. A failing run
				// refuses "done" with the output tail — the one verification signal that cannot be a
				// claim. The passing run is kept for the settle that follows (no second run).
				let tests: TestRun | undefined;
				if (handoff.verify?.command) {
					tests = await runTestCommand(cwd, handoff.verify.command);
					if (!tests.passed) {
						state.handoff = { ...handoff, tests: undefined };
						return reply(
							`Not recorded: Readyset ran \`${tests.command}\` and it ${tests.timedOut ? "timed out" : `exited ${tests.exitCode ?? "without an exit code"}`}. ` +
								`Fix the failure, then call readyset_done again. Last output:\n${tests.tail}`,
						);
					}
				}
				state.handoff = { ...handoff, signal: { status: "done", summary: text || "(no summary)", at }, ...(tests ? { tests } : {}) };
				await persistPendingHandoff(state.handoff);
				await appendContext(cwd, handoff.changeId, "Apply", `Execution signalled done: ${text || "(no summary)"}`).catch(() => {});
				return reply(
					(tests ? `\`${tests.command}\` passed (${Math.round(tests.durationMs / 1000)}s). ` : "") +
						"Recorded as done. End your turn now with a short report for the user; Readyset closes the execution, restores " +
						"the model and applies the review policy when the turn ends.",
				);
			},
		});
	}

	return {
		outsideRepoCount,
		outsideRepoTmpCount,
		resetOutsideRepoWatch,
		noteOutsideRepoCall,
		flushOutsideRepoEntries,
		withPinnedModel,
		resetActiveGrillSession,
		resetPendingHandoff,
		persistPendingHandoff,
		rehydratePendingHandoff,
		startGrilling,
		applyGrillModel,
		restoreGrillModel,
		findNewlyWrittenBrainstorm,
		handleGrillEndTransition,
		runGrillEndTransition,
		executionModelOf,
		settleHandoff,
		applyReviewPolicyAtSettle,
		handlePendingHandoff,
		supersedePendingHandoff,
		MAX_VERIFICATION_SENDBACKS,
		sessionStopVerificationCheck,
		registerAskTool,
		registerVerifyTool,
		registerDoneTool,
	};
}

export type ReadysetRuntime = ReturnType<typeof createRuntime>;
