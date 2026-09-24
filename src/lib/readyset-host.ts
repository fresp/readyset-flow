import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type PhaseBudget, type TurnBudget, phaseBudgetElapsedMs } from "./readyset-budget.ts";
import type { ReviewCtx } from "./readyset-types.ts";

/** The seam to omp's host API: model switching, firing a turn and waiting for it, session
 *  identity, compaction. Feature-detected throughout -- older omp builds lack some members. */
export interface CompactBoundaryResult {
	/** `skipped-keep-context` is never returned by `compactForPhase`; the gate's keep-context
	 *  branch records it directly as the Apply boundary's compact outcome (it skipped compaction
	 *  by the user's own choice, not by mode/threshold). */
	outcome: "compacted" | "skipped-below-threshold" | "skipped-flag" | "skipped-keep-context" | "unavailable" | "failed";
	beforePercent?: number;
	afterPercent?: number;
}

/**
 * Compaction for one phase boundary. Whether it runs is governed by `mode`:
 * - "never":  always skip (the user asked for no compaction).
 * - "always": always compact (0.13.0 behavior).
 * - "auto":   compact only when the host reports context usage at or above `minContextPercent`;
 *             when `getContextUsage` is missing or returns undefined, compact anyway (today's
 *             behavior — we cannot measure, so we do not skip).
 * The summarization runs inside `withPhaseModel(..., phase, ...)` so it uses the phase's own
 * (usually cheaper) model. omp exposes NO compaction-model parameter (verified: CompactOptions
 * has no model field, the session.compacting/session_before_compact results have none, and
 * `compaction.*`/`modelRoles` settings have no model key), so this wrapper is the only supported
 * way to influence the model the summary is produced on. A missing `ctx.compact` or a throw
 * degrades to a plain continue — a cost optimization must never block the run.
 *
 * One outcome in the union, `skipped-keep-context`, is never produced here: the gate's
 * keep-context branch records it directly as the Apply boundary's compact event.
 */
export async function compactForPhase(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	phaseModels: Map<string, { model: string; source: string }>,
	phase: "explore" | "propose" | "apply",
	changeId: string,
	phaseLabel: string,
	guidance: string,
	mode: "auto" | "always" | "never",
	minContextPercent: number,
): Promise<CompactBoundaryResult> {
	if (mode === "never") return { outcome: "skipped-flag" };
	if (typeof ctx.compact !== "function") {
		ctx.ui.notify(`Compact isn't available in this context — continuing ${phaseLabel} without it.`, "warning");
		return { outcome: "unavailable" };
	}
	const before = ctx.getContextUsage?.();
	const beforePercent = before?.percent;
	if (mode === "auto" && beforePercent !== undefined && beforePercent < minContextPercent) {
		ctx.ui.notify(
			`Context is at ${beforePercent.toFixed(0)}% (below the ${minContextPercent}% threshold) — skipping the compaction before ${phaseLabel}.`,
			"info",
		);
		return { outcome: "skipped-below-threshold", beforePercent };
	}
	ctx.ui.notify(`Compacting context before ${phaseLabel} for "${changeId}"...`, "info");
	try {
		await withPhaseModel(pi, ctx, phase, phaseModels, () =>
			ctx.compact!({ internalGuidance: guidance, suppressContinuation: true }).then(() => undefined),
		);
	} catch (err) {
		ctx.ui.notify(`Compact failed (${err instanceof Error ? err.message : String(err)}) — continuing without it.`, "warning");
		return { outcome: "failed", beforePercent };
	}
	const after = ctx.getContextUsage?.();
	return { outcome: "compacted", beforePercent, afterPercent: after?.percent };
}

/**
 * Pins a specific model for the turns fired inside `fn`, then restores whatever model the
 * session had before, even if `fn` throws. This exists so a Readyset run is reproducible
 * independent of whatever model happened to be active in the chat session that invoked it —
 * without it, re-running the same change could silently use a different (possibly weaker or
 * more expensive) model each time.
 *
 * `pi.setModel(modelSpec)` and `ctx.models.current()`/`.resolve()` are confirmed to exist on
 * the extension API (extensions.md), but the exact accepted/returned shape for setModel isn't
 * documented in detail — this resolves a raw model spec string via `ctx.models.resolve()`
 * first (the same path `--model` itself uses) rather than assuming setModel takes a bare
 * string, and treats whatever `ctx.models.current()` returns as an opaque value to hand back
 * to `setModel()` unchanged for restoration. If either API is missing on a given omp build,
 * this degrades to running with whatever model the session already has, with a warning.
 *
 * `modelSpec` can come from the `--model` flag or from `readyset.model` (its `.default`, in the
 * current nested shape, or the bare legacy value) in `~/.omp/agent/config.yml` (flag wins if
 * both are set) — `source` is just for the notification text, so it's clear which one actually
 * took effect.
 *
 * `fallbackChain` (optional, possibly empty) covers only the pin itself failing to apply — i.e.
 * `setModel()` throwing while switching to `modelSpec`, which usually means the configured
 * spec is wrong (typo, retired model), not that the model is transiently unavailable. Each
 * entry is tried in order, stopping at the first that pins successfully; only once every entry
 * has failed does this give up and run unpinned. A runtime provider outage mid-turn is a
 * different problem, and omp already has its own answer for it (`retry.fallbackChains` in
 * `~/.omp/agent/config.yml`, applied automatically to whatever model is active) — this does not
 * attempt to duplicate that. `fallbackSource` labels the whole chain (it's read from one place
 * in config, or is a single `--fallback-model` flag value), not each entry individually.
 */
/**
 * The host's `pi.setModel`, bound to `pi`, or `undefined` when this omp build doesn't expose it.
 *
 * Bound, not merely extracted: a bare `pi.setModel` reference loses its `this` when called
 * detached (`const f = obj.method; f()`), which a real terminal run (2026-09-18) hit as
 * "undefined is not an object (evaluating 'this.runtime')" on every call — the real
 * implementation reads state off `this` internally. `.bind(pi)` keeps the existence check
 * working (bind on undefined would throw, so the optional chain still yields `undefined`) while
 * fixing every call site at once. The cast is read once here instead of at each call site.
 */
export function resolveHostSetModel(pi: ExtensionAPI): ((spec: unknown) => unknown) | undefined {
	// pi is the public ExtensionAPI; setModel exists on it per extensions.md but is not in this
	// build's published type surface, so the shape is asserted once, here, at the boundary.
	const host = pi as unknown as { setModel?: (spec: unknown) => unknown };
	return host.setModel?.bind(pi);
}

/**
 * Runs `fn` with a phase-specific model override for one labeled phase. The run's pinned model
 * is captured from ctx.models.current() and restored afterward, so an override only affects the
 * turns fired inside `fn`. An override that fails to pin warns and runs the phase on the pinned
 * model instead — it is a cost optimization, never a reason to stop the run.
 *
 * Unknown phase labels are a caller bug, not a user typo: `phase` here is always one of the
 * extension's own labels (grill|explore|propose|apply|review), so an unrecognized one throws
 * rather than silently running the phase on the wrong model.
 */
export async function withPhaseModel<T>(
	pi: ExtensionAPI,
	ctx: ReviewCtx,
	phase: string,
	overrides: Map<string, { model: string; source: string }>,
	fn: () => Promise<T>,
): Promise<T> {
	const knownPhases = ["grill", "explore", "propose", "apply", "review"];
	if (!knownPhases.includes(phase)) {
		throw new Error(`unknown phase "${phase}" — expected one of ${knownPhases.join("|")}`);
	}
	const override = overrides.get(phase);
	if (!override) return fn();

	const setModel = resolveHostSetModel(pi);
	const models = ctx.models;
	if (!setModel || !models?.current) {
		ctx.ui.notify(
			`Phase model "${override.model}" for ${phase} (from ${override.source}) was given, but this omp build doesn't expose pi.setModel/ctx.models.current — running ${phase} on the run's model.`,
			"warning",
		);
		return fn();
	}
	const resolved = models.resolve ? models.resolve(override.model) : override.model;
	if (resolved === undefined || resolved === null) {
		ctx.ui.notify(
			`Phase model "${override.model}" for ${phase} (from ${override.source}) didn't resolve to any available model — running ${phase} on the run's model.`,
			"warning",
		);
		return fn();
	}
	const pinned = models.current();
	let applied: unknown;
	try {
		applied = await setModel(resolved);
	} catch {
		applied = false;
	}
	if (applied === false) {
		ctx.ui.notify(
			`Phase model "${override.model}" for ${phase} (from ${override.source}) couldn't be applied (usually: no API key) — running ${phase} on the run's model.`,
			"warning",
		);
		return fn();
	}
	ctx.ui.notify(`Phase model for ${phase}: "${override.model}" (from ${override.source}).`, "info");
	try {
		return await fn();
	} finally {
		try {
			await setModel(pinned);
		} catch {
			ctx.ui.notify(`Couldn't restore the run model after the ${phase} phase — check /model if it looks off.`, "warning");
		}
	}
}

/**
 * Fires a triggered agent turn and waits for it to actually finish — not just for
 * `waitForIdle()` to resolve.
 *
 * `pi.sendUserMessage(prompt)` with no `deliverAs` is the wanted behavior: the host starts a
 * turn when the session is idle, and queues as a steer while streaming. It is also the only
 * shape the user-message API accepts — `SendUserMessageOptions.deliverAs` is `"steer" |
 * "followUp" | "aside"`. An earlier version of this file passed `{ deliverAs: "nextTurn",
 * triggerTurn: true }`, which belongs to `pi.sendMessage` and is silently ignored here (the
 * turn still started, by falling through to the host's plain prompt path, so the net effect
 * looked right for the wrong reason).
 *
 * The send is still fire-and-forget from the extension's side — the host does not await it —
 * so the turn is not guaranteed to have flipped the session out of idle by the time this
 * returns. Calling `ctx.waitForIdle()` immediately can race it: if the session still reads as
 * idle in that instant, `waitForIdle()` resolves at once, before the turn has produced
 * anything. That is exactly what happened live (2026-09-18): the "doesn't look finished"
 * warning fired, and only afterward did the turn's own prompt/output actually appear.
 *
 * Fix: poll briefly for the session to leave idle (or show a pending message) before
 * calling waitForIdle() for real. If `isIdle`/`hasPendingMessages` aren't available on this
 * build's ctx, this falls back to the original (racy) immediate wait rather than hanging
 * forever on an unknown API.
 *
 * The wait itself is feature-detected, because `waitForIdle` only exists on the command ctx
 * (`ExtensionCommandContext`) and NOT on the `agent_end` hook ctx (`ExtensionContext`) this also
 * runs under during the grill->propose transition. Preference order: (1) `waitForIdle` when
 * present -- the command path, unchanged; (2) `isIdle`/`hasPendingMessages` polled until the
 * session is idle with nothing pending on two *consecutive* checks -- the agent_end safety net.
 * The fallback deliberately has no deadline: a planning turn legitimately runs for minutes, and
 * requiring two consecutive clean reads is what makes "idle" trustworthy (a single read can land
 * in the same instant a turn has not started yet, which is the race this whole function exists to
 * avoid). The loop exits the moment the session is genuinely settled, so it costs nothing on a
 * fast turn. (3) Neither API: fail loudly via `ctx.ui.notify` and return -- do NOT throw, because
 * omp dispatches the agent_end notification detached and would swallow it.
 */
export async function fireTurnAndWait(pi: ExtensionAPI, ctx: ReviewCtx, prompt: string, phaseBudget?: PhaseBudget, label = "this phase"): Promise<void> {
	pi.sendUserMessage(prompt);

	// Phase budget watchdog (see PhaseBudget): abort the turn once the phase's wall-clock ceiling
	// passes. Armed only when there is a ceiling and the host can abort; always disarmed on return.
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	if (phaseBudget && phaseBudget.maxMs > 0 && typeof ctx.abort === "function") {
		const abort = ctx.abort;
		const remaining = Math.max(0, phaseBudget.maxMs - phaseBudgetElapsedMs(phaseBudget));
		watchdog = setTimeout(() => {
			phaseBudget.aborted = true;
			ctx.ui.notify(
				`${label} ran past its ${Math.round(phaseBudget.maxMs / 60000) || "<1"}-minute phase budget — aborting the turn and continuing with what it wrote (readyset.phaseBudget.minutes).`,
				"warning",
			);
			try {
				abort();
			} catch {
				/* an abort that throws still leaves the turn to finish on its own */
			}
		}, remaining);
	}
	try {
		await waitForTurn(ctx);
	} finally {
		if (watchdog !== undefined) clearTimeout(watchdog);
	}
}

/** The waiting half of fireTurnAndWait -- see its doc comment. */
export async function waitForTurn(ctx: ReviewCtx): Promise<void> {

	const sleep = (ms: number): Promise<void> =>
		// `new Promise` rather than `Promise.withResolvers`: tsconfig targets ES2022, where
		// `withResolvers` is not in `lib` (same reason readyset-evidence.ts uses this form).
		new Promise((resolve) => setTimeout(resolve, ms));

	const pollStarted = ctx.isIdle || ctx.hasPendingMessages;
	if (pollStarted) {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const idle = ctx.isIdle ? ctx.isIdle() : true;
			const pending = ctx.hasPendingMessages ? ctx.hasPendingMessages() : false;
			if (!idle || pending) break;
			await sleep(100);
		}
	}

	if (typeof ctx.waitForIdle === "function") {
		await ctx.waitForIdle();
		return;
	}

	if (typeof ctx.isIdle === "function" && typeof ctx.hasPendingMessages === "function") {
		const isIdle = ctx.isIdle;
		const hasPendingMessages = ctx.hasPendingMessages;
		let consecutive = 0;
		while (consecutive < 2) {
			await sleep(200);
			consecutive = isIdle() && !hasPendingMessages() ? consecutive + 1 : 0;
		}
		return;
	}

	ctx.ui.notify(
		"Can't tell when this turn finished: this omp build's ctx exposes neither waitForIdle() nor isIdle()/hasPendingMessages(). " +
			"Re-run /readyset and pick the brainstorm to resume.",
		"error",
	);
	return;
}

/**
 * Whether an `agent_end` hook ctx belongs to the session that armed `handoff`/the grill session.
 * Session identity, not cwd: omp rebinds a parent-imported extension factory into subagent
 * runtimes in the same process (sdk.ts bindPreparedExtensions), so module-level state here is
 * shared and a subagent's terminal agent_end shares the parent's cwd. Requiring the same session
 * id stops a child's settle from restoring the parent's model or firing its grill transition.
 * Falls back to cwd matching when either side cannot report a session id (older host builds).
 */
export function sessionMatches(
	ctx: { cwd?: string; sessionManager?: { getSessionId?: () => string } },
	expectedSessionId: string | undefined,
	armedCwd: string | undefined,
): boolean {
	const ctxId = ctx.sessionManager?.getSessionId?.();
	if (expectedSessionId === undefined || ctxId === undefined) return ctx.cwd === armedCwd;
	return ctxId === expectedSessionId;
}

/** Fires a turn against the budget. Returns false (and notifies) without firing anything if
 *  the budget is already spent — callers must stop, not retry, when this returns false. */
export async function spendTurn(pi: ExtensionAPI, ctx: ReviewCtx, budget: TurnBudget, label: string, prompt: string, phaseBudget?: PhaseBudget): Promise<boolean> {
	if (budget.spent >= budget.max) {
		ctx.ui.notify(
			`Turn budget (${budget.max} agent turns) reached for this /readyset run — stopping before ${label} to avoid an ` +
				"unbounded loop. Check readyset/changes/<id>/CONTEXT.md for what ran, then re-run /readyset to continue with a fresh budget.",
			"warning",
		);
		return false;
	}
	budget.spent++;
	await fireTurnAndWait(pi, ctx, prompt, phaseBudget, label);
	return true;
}

/** The context shape omp hands an event hook (`tool_call`, `agent_end`, `session_stop`), as far as
 *  Readyset reads it. Every member is optional: builds and hook kinds differ, and each use
 *  feature-detects. */
export type HostHookCtx = {
	cwd?: string;
	ui?: unknown;
	mode?: string;
	waitForIdle?: () => Promise<void>;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	models?: { current?: () => unknown; resolve?: (spec: string) => unknown };
	sessionManager?: { getSessionId?: () => string };
};

/** The event-subscription surface of `pi`, as far as Readyset uses it. */
export type HostEvents = {
	on?: (event: string, handler: (event: unknown, ctx: HostHookCtx) => unknown) => void;
};

/**
 * The host boundary, in one place. omp's own context and API types are richer than what Readyset
 * calls and vary across builds, so this extension takes no type dependency on host internals:
 * `ReviewCtx`/`HostEvents` declare only the members used, every build-dependent one optional and
 * feature-detected at its call site. These two functions are the only casts from a host object to
 * those shapes -- everything else goes through them rather than scattering `as unknown as`.
 */
export function asReviewCtx(ctx: unknown): ReviewCtx {
	return ctx as ReviewCtx;
}

export function asHostEvents(pi: ExtensionAPI): HostEvents {
	return pi as unknown as HostEvents;
}
