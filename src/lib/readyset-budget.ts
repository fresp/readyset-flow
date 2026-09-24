
/** Turn and wall-clock budgets for one /readyset run. */
export const MAX_TURNS_PER_RUN = 10;
/**
 * A phase budget caps how much wall-clock time one Explore or Propose turn may run. Distinct
 * from TurnBudget (which counts fired agent turns): a single turn can churn through an unbounded
 * number of tool calls without spending any more TurnBudget -- the benchmark runs showed
 * Explore/Propose consuming millions of tokens in one fired turn.
 *
 * Enforced, not advisory: `fireTurnAndWait` arms a timer for the remaining budget and calls
 * `ctx.abort()` when it fires, marking `aborted`. The caller then continues with whatever the
 * phase wrote so far (Explore: Propose may run less grounded; Propose: the "doesn't look
 * finished" check and the gate's validation catch a partial artifact). `maxMs === 0`
 * (`readyset.phaseBudget.minutes: 0`), or a host with no `ctx.abort`, measures and reports only.
 */
export interface PhaseBudget {
	/** Wall-clock ceiling for the phase, in milliseconds; 0 = never abort. */
	readonly maxMs: number;
	startedAt: number;
	/** Set when the ceiling was hit and the turn was aborted. */
	aborted?: boolean;
}

export function startPhaseBudget(maxMs: number): PhaseBudget {
	return { maxMs, startedAt: Date.now() };
}

export function phaseBudgetExceeded(budget: PhaseBudget): boolean {
	return budget.maxMs > 0 && Date.now() - budget.startedAt > budget.maxMs;
}

/** "12s of 1200s budget", or "12s (no budget)" when enforcement is off. */
export function phaseBudgetLine(budget: PhaseBudget): string {
	const elapsed = `${Math.round(phaseBudgetElapsedMs(budget) / 1000)}s`;
	return budget.maxMs > 0 ? `${elapsed} of ${Math.round(budget.maxMs / 1000)}s budget${budget.aborted ? ", ABORTED at the ceiling" : ""}` : `${elapsed} (no budget)`;
}

export function phaseBudgetElapsedMs(budget: PhaseBudget): number {
	return Date.now() - budget.startedAt;
}

/**
 * Every triggered turn (Explore/Propose/Refine/Apply/Code-review) costs real tokens, and
 * several of them sit inside loops a user could drive indefinitely (repeated Refine, repeated
 * "Send back for verification"). This is a hard per-invocation ceiling on total turns fired —
 * a guardrail against an unbounded loop burning cost with no natural stopping point, not a
 * precise cost estimate. It resets on every `/readyset` invocation; there is no
 * cross-session budget store yet, so a determined user can still re-run the command for a
 * fresh budget — this catches an accidental loop, not a deliberate one.
 */
export interface TurnBudget {
	readonly max: number;
	spent: number;
}

export function createTurnBudget(max: number = MAX_TURNS_PER_RUN): TurnBudget {
	return { max, spent: 0 };
}

/**
 * True when this run can fire one more turn AND still leave `reserve` turns unspent. Since 0.16
 * Apply and Review no longer draw on this budget (execution is handed off to core omp; review is
 * on demand), so the only turn worth protecting is a Refine the user asks for at the gate.
 * Automatic follow-up turns (contract repair, trim) therefore reserve exactly that one turn
 * (`AUTO_TURN_RESERVE`): they may run while a Refine would still fit, never with the last turn.
 */
export function turnsAvailableFor(budget: TurnBudget, reserve: number): boolean {
	return budget.max - budget.spent > reserve;
}

/** Turns an automatic follow-up (contract repair, trim) leaves unspent: one, for a user Refine. */
export const AUTO_TURN_RESERVE = 1;

