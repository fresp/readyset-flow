import type { ExtensionUISelectOption } from "@oh-my-pi/pi-coding-agent";
import type { ReadysetArgs } from "./readyset-args.ts";
import type { ArtifactBudgets, LaneDefault, ParsedReviewThresholds, ReviewFullLane, ReviewMode } from "./readyset-omp-config.ts";
import type { OverlayTheme } from "./readyset-review-overlay.ts";
import type { PhaseEvent } from "./readyset-spec.ts";

/** Shared types for the /readyset extension, plus its one mutable state store. Stateless: the
 *  store is created by the extension entry (src/extensions/readyset-review.ts), once per module
 *  instance, and passed to createRuntime(). */
/** Minimal structural shape this file actually calls — deliberately not importing the real
 *  `KeybindingsManager` type from `@oh-my-pi/pi-tui` even as a type, so this file has zero
 *  dependency (type or runtime) on that package resolving at all. This is the boundary where the
 *  wider extension hands those objects through without needing to know their full shape;
 *  `OverlayTheme` itself is imported from readyset-review-overlay.ts, which owns the one
 *  definition of what the sidebar calls. */
export interface OverlayKeybindings {
	matches: (data: string, name: string) => boolean;
}

/**
 * All of this extension's mutable runtime state, in one place. `createReadysetState()` is called
 * once per module instance (below), so a fresh import of this file (the tests' `?t=` imports, or
 * omp re-loading the extension) starts clean, while omp's rebinding of the same instance into
 * subagent runtimes shares it -- which is exactly why every consumer checks session identity
 * (`sessionMatches`) before acting on `handoff` or `grill`.
 */
export interface ReadysetState {
	/** The grilling session started by `startGrilling`, until its brainstorm is written. */
	grill: ActiveGrillSession | undefined;
	/** readyset_ask rounds this grilling session, plus whether a grilling session was started that
	 *  the command handler's zero-rounds check has not consumed yet (see GRILL_ROUND_CAP). */
	grillRounds: { rounds: number; active: boolean };
	/** The handed-off execution awaiting its settle (mirrored to handoff.json). */
	handoff: PendingHandoff | undefined;
	/** The pre-pin model `withPinnedModel` captured, read by the approve branch. */
	handoffRestoreTarget: unknown;
	/** Which change readyset_verify records evidence into; set only while a handoff is live. */
	verifyChangeId: string | undefined;
	/** `${cwd}\0${sessionId}` pairs already scanned for a persisted handoff. */
	rehydrationChecked: Set<string>;
	/** session_stop gate blocks, keyed `${sessionId}:${changeId}`. */
	sessionStopBlocks: Map<string, number>;
	/** Outside-repo tripwire observations for the current run. */
	outsideRepo: { cwd: string | undefined; entries: OutsideRepoEntry[]; written: number };
}

export function createReadysetState(): ReadysetState {
	return {
		grill: undefined,
		grillRounds: { rounds: 0, active: false },
		handoff: undefined,
		handoffRestoreTarget: undefined,
		verifyChangeId: undefined,
		rehydrationChecked: new Set(),
		sessionStopBlocks: new Map(),
		outsideRepo: { cwd: undefined, entries: [], written: 0 },
	};
}

/** `outside` counts toward the headline number; `tmp` is reported separately (scratch dirs are
 *  common and legitimate). */
export type OutsideRepoKind = "outside" | "tmp";

export interface OutsideRepoEntry { kind: OutsideRepoKind; text: string; }
export interface ReviewCtx {
	cwd: string;
	/** Host run mode ("tui" | "rpc" | "json" | "print"). Custom overlays are TUI-only -- see reviewAndMaybeExecute. */
	mode?: string;
	ui: {
		select: (prompt: string, options: ExtensionUISelectOption[], opts?: { helpText?: string }) => Promise<string | undefined>;
		input?: (prompt: string) => Promise<string | undefined>;
		setEditorText: (text: string) => void;
		// Real signature is `setWidget(key: string, content: ExtensionWidgetContent, options?)` —
		// the key is what a later call with the same key replaces. This used to be declared (and
		// called) as `(lines: string[])`, which the host received as key = the array and
		// content = undefined, so the summary panel never actually rendered. `content` is
		// `string[] | undefined` in the host type (`ExtensionWidgetContent`), so passing
		// `undefined` with the same key is how a widget is cleared.
		setWidget?: (key: string, content: string[] | undefined) => void;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		// Interactive-mode-only (docs/extensions.md): renders a real custom TUI component with
		// keyboard focus — the same mechanism native /plan's own review sidebar is built from.
		// Absent (or a no-op) in RPC/ACP/print modes, so every call site feature-detects it and
		// falls back to `browseReviewSections`'s menu-driven view rather than assuming it exists.
		custom?: <T>(
			factory: (tui: unknown, theme: OverlayTheme, keybindings: OverlayKeybindings, done: (result: T) => void) => unknown,
			options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
		) => Promise<T>;
	};
	waitForIdle?: () => Promise<void>;
	// Both documented on the general handler ctx (see extensions.md "Handler Context
	// Capabilities"). Optional here because real-world timing means we'd rather degrade to
	// the old (racy) behavior than throw if a given omp build doesn't expose them.
	//
	// `waitForIdle` is optional for a second, sharper reason: omp has two ctx shapes and only
	// one of them has it. The `agent_end` hook ctx is the general `ExtensionContext`
	// (`runner.ts` `createContext()`), which exposes `isIdle`/`hasPendingMessages`/`compact`/
	// `models` but NO `waitForIdle`; `waitForIdle` is added only by `createCommandContext()`,
	// which spreads `createContext()` and adds it and is what a registered command handler
	// receives. Declaring it required here is exactly what let `ctx as unknown as ReviewCtx` in
	// the `agent_end` registration hide the mismatch from `tsc` -- the grill->propose transition
	// then died with `TypeError: ctx.waitForIdle is not a function` inside `fireTurnAndWait`,
	// out of sight (omp dispatches that notification detached). See `fireTurnAndWait` for the
	// fallback and `ActiveGrillSession.waitForIdle` for why the command ctx's own function is
	// stashed at grill-start time.
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	// ctx.models.current() — confirmed in extensions.md ("the live session model, read lazily
	// so it reflects /model switches"). Used to save/restore the model around a pinned run.
	models?: {
		current?: () => unknown;
		resolve?: (spec: string) => unknown;
	};
	// Session identity of the ctx. omp's ExtensionContext exposes `sessionManager:
	// ReadonlySessionManager` (extensions/types.ts), whose `getSessionId(): string` names *this*
	// session — the child runner reports itself, never its parent. Optional so a host build
	// without it degrades to cwd matching rather than throwing.
	sessionManager?: { getSessionId?: () => string };
	// Confirmed against the real `ExtensionContext` type (extensibility/extensions/types.ts):
	// `compact(instructionsOrOptions)` is the same public API native /plan's own "Approve and
	// compact context" option calls internally. `internalGuidance` is piped only to the native
	// summarizer, never exposed as `customInstructions` on the `session_before_compact` hook, so
	// extensions that treat that field as user focus don't mistake this package's boilerplate
	// for the operator's own intent — same reasoning /plan's usage documents. `suppressContinuation`
	// is set by the caller (`reviewAndMaybeExecute`) because it dispatches the Apply turn itself
	// right after compacting, same as plan-mode does after its own "Approve and compact" — without
	// it, a manual compaction that interrupts something in flight would also fire an unwanted
	// auto-continue nudge. Optional because omp builds without it should still let Approve &
	// Compact degrade to a plain Approve (see `reviewAndMaybeExecute`'s "compact" branch) rather
	// than throw.
	compact?: (
		instructionsOrOptions?: string | { internalGuidance?: string; suppressContinuation?: boolean },
	) => Promise<void>;
	// Confirmed against the real type (`ContextUsage` in `@oh-my-pi/pi-tui/status-line/types`):
	// `{ tokens, contextWindow, percent }`. Informational only — shown in the review panel so the
	// user can judge for themselves whether Approve & Compact is worth reaching for; nothing here
	// gates which CTAs are offered.
	getContextUsage?: () => { tokens: number; contextWindow: number; percent: number } | undefined;
	/** Aborts the agent operation in flight (ExtensionContext.abort). Used by the phase budget to
	 *  stop an Explore/Propose turn that ran past its wall-clock ceiling. */
	abort?: () => void;
}

export interface BrainstormExecutionOptions {
	laneOverride?: "fast" | "full";
	laneDefault: LaneDefault;
	parsedArgs: ReadysetArgs;
	compactMode: "auto" | "always" | "never";
	effectiveReviewMode: ReviewMode;
	reviewFullLane: ReviewFullLane;
	reviewThresholds: ParsedReviewThresholds;
	scopeProtected: { paths: string[] };
	testPathsResult: { paths: string[] };
	/** The model spec the grill turn actually ran on, when THIS run pinned one before grilling
	 *  (see `applyGrillModel`). Recorded verbatim on the `grill` `end` phase event; `undefined`
	 *  when grilling ran on the session model or happened in an earlier run -- never a guess. */
	grillModel?: string;
}

/** A model pinned for the grill turn by `applyGrillModel`, and what to restore afterward. */
export interface GrillModelPin {
	spec: string;
	source: string;
	/** Opaque `ctx.models.current()` captured right before the pin was applied. */
	restoreTo: unknown;
	/** Set once `restoreGrillModel` has run, so the restore is one-shot. */
	restored?: boolean;
}

export interface ActiveGrillSession {
	active: boolean;
	startedAt: number;
	ideaText: string;
	laneDefault: LaneDefault;
	preferredLanguage?: string;
	writtenBrainstormFile?: string;
	existingFiles: Set<string>;
	execOptions: BrainstormExecutionOptions;
	/** The command ctx's own waitForIdle, captured because the runner closure stays valid after
	 *  the command handler returns, while the agent_end hook ctx (ExtensionContext) has none. */
	waitForIdle?: () => Promise<void>;
	/** The arming session's ctx.sessionManager.getSessionId(), or undefined when the host build
	 *  does not expose sessionManager. Used by the agent_end handler to reject a subagent's own
	 *  terminal settle (same cwd, different session) from driving the grill→propose transition. */
	sessionId?: string;
	/** The grill model this session pinned (`applyGrillModel`), restored when the brainstorm is
	 *  written (`runGrillEndTransition`) or when a new /readyset command supersedes it. */
	grillModel?: GrillModelPin;
}


/**
 * A pending execution handoff: the approve branch fires the apply turn fire-and-forget and
 * returns, so the run's model pin (withPinnedModel) must NOT be restored in its `finally` —
 * execution has to run on the pinned/apply model for its whole handed-off turn.
 * `restoreTo` is the model the session had before the run pinned anything (opaque, from
 * ctx.models.current(); `undefined` when nothing was ever pinned, in which case there is
 * nothing to restore).
 *
 * `sessionId` is the arming session's ctx.sessionManager.getSessionId(), or `undefined` when the
 * host build does not expose `sessionManager` (then matching falls back to cwd). Session identity,
 * not cwd, is what stops a subagent's settle from ending the parent's handoff: omp rebinds a
 * parent-imported extension factory into subagent runtimes in the same process, so module-level
 * state here is shared and a subagent's terminal agent_end shares the parent's cwd.
 */
/** What the executing model reported through `readyset_done` (see registerDoneTool). */
export interface HandoffSignal {
	status: "done" | "blocked";
	summary: string;
	at: string;
}

/** The risk-based review policy captured at arm time, so the settle path (which runs from the
 *  `agent_end` hook — no access to the command handler's local config reads) can apply it without
 *  re-resolving config. Mirrors the same fields `reviewAndMaybeExecute` already threads through. */
export interface ArmedReviewPolicy {
	mode: ReviewMode;
	fullLane: ReviewFullLane;
	thresholds: ParsedReviewThresholds;
	protectedPaths: string[];
	testPaths: string[];
}

/** A pending execution handoff (see `ReadysetState.handoff`). */
export interface PendingHandoff {
	changeId: string;
	restoreTo: unknown;
	cwd: string;
	sessionId?: string;
	/** ISO timestamp of the approve that armed this handoff (persisted; see
	 *  `persistPendingHandoff`). */
	armedAt?: string;
	/** The progress+tree fingerprint (`computePauseFingerprint`) recorded at the LAST pause,
	 *  so the next terminal settle can tell "still working" from "stopped making progress" —
	 *  see `handlePendingHandoff`'s pause branch. `undefined` before the first pause. */
	pauseFingerprint?: string;
	/** The review policy this run resolved, captured so a real settle (not a pause or a
	 *  supersede) can apply it — see `applyReviewPolicyAtSettle`. */
	reviewPolicy?: ArmedReviewPolicy;
	/** Running counts, recorded on the `apply` `end` event (PhaseEvent `handoff`). */
	pauses?: number;
	blocks?: number;
	verificationBlocks?: number;
	/** True when this handoff was re-attached from handoff.json after a restart. */
	rehydrated?: boolean;
	/** The executing model's latest readyset_done signal, consumed by the next terminal
	 *  settle (`done` settles as handoff-done; `blocked` is an explicit, non-stall pause). */
	signal?: HandoffSignal;
}

/**
 * The model the current run's `withPinnedModel` captured before it pinned anything. Only
 * `withPinnedModel` can observe this value, so the approve branch (which runs inside its `fn`)
 * reads it through here rather than calling `ctx.models.current()` again — that call would return
 * the already-pinned model, not the original. Left untouched (undefined) when no pin was
 * configured, which is exactly what `state.handoff.restoreTo` should be in that case.
 */

/**
 * The fused review+refine loop. Runs after propose-equivalent artifacts exist for `chosen`.
 * Loops on "Refine" until the user picks Approve or Discard, so refinement doesn't require
 * re-invoking the command either.
 *
 * Whenever `ctx.ui.custom` is available, the sidebar overlay opens automatically at the top of
 * every loop iteration — it IS the review gate, with Approve & Execute / Keep context /
 * Refine / Discard as CTAs baked into it, not a "Sidebar view" choice offered on a separate menu
 * the user had to pick first. `classicGateSelect` is the fallback for contexts without a real
 * TUI, and also covers the (rare) case where the overlay itself throws on open. Approve &
 * Execute runs `ctx.compact()` before falling through to the Apply flow — see the compact
 * branch below and `ReviewCtx.compact`'s doc comment.
 *
 * `phaseModels` carries the run's per-phase model overrides (grill|explore|propose|apply|
 * review); the Explore/Propose caller passes its own map, this loop passes the same map on
 * for Refine/Apply/Code-review so an override covers its phase wherever that phase fires.
 */
/** Everything `reviewAndMaybeExecute` needs beyond the change itself, resolved once by
 *  `executeBrainstorm`. One object instead of 13 positional parameters: every field is named at
 *  the call site, and a new one cannot silently shift the others. */
export interface GateRunOptions {
	phaseModels: Map<string, { model: string; source: string }>;
	lane: "full" | "fast";
	laneSource: PhaseEvent["laneSource"];
	compactMode: "auto" | "always" | "never";
	minContextPercent: number;
	artifactBudgets: ArtifactBudgets;
	reviewMode: ReviewMode;
	reviewFullLane: ReviewFullLane;
	reviewThresholds: ParsedReviewThresholds;
	protectedPaths: string[];
	testPaths: string[];
	/** The run's pinned model (--model / readyset.model.default) and its source label. Carried
	 *  explicitly because the pin lives in `executeBrainstorm`'s closure, not in `phaseModels`, and
	 *  the approve branch needs it to work out which model the handed-off execution runs on. */
	pinnedModel: string | undefined;
	pinnedModelSource: string;
}
