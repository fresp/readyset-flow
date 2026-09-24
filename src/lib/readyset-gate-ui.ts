import type { ExtensionUISelectOption } from "@oh-my-pi/pi-coding-agent";
import { readFile } from "node:fs/promises";
import type { BrainstormMeta } from "./readyset-brainstorm.ts";
import type { TurnBudget } from "./readyset-budget.ts";
import { checkTaskEvidence, describeEvidenceConflict, findEvidenceConflicts } from "./readyset-evidence.ts";
import { pathsChangedThisRun } from "./readyset-git.ts";
import type { ArtifactBudgets } from "./readyset-omp-config.ts";
import { trimmableSizes } from "./readyset-repair.ts";
import { type OverlaySection, type ReviewOverlayResult, ReviewSidebarOverlay } from "./readyset-review-overlay.ts";
import { type ArtifactSizes, type ChangeLane, type OpenDecision, brainstormRequestText, changePaths, checkScope, checkScopeRefs, checkTaskVerification, findDocFileWarnings, findMissingRequestedDocs, findSpecFiles, getProgress, hasBeenApplied, hasExploration, readArtifactSizes, readAssumedScenarios, readAssumptions, readChangeLane, readContext, readOpenDecisions, readReview, readScopeContract, validateChange } from "./readyset-spec.ts";
import type { ReviewCtx } from "./readyset-types.ts";
import type { VerifySettings } from "./readyset-verify.ts";

/** The Review Gate's snapshot, panel, review document, sidebar overlay and classic menu. */
export interface ReviewSnapshot {
	counted: { done: number; total: number } | undefined;
	validated: Awaited<ReturnType<typeof validateChange>>;
	verification: Awaited<ReturnType<typeof checkTaskVerification>>;
	scope: Awaited<ReturnType<typeof checkScope>>;
	/** Dangling file references: contract paths (not marked `(new)`) that don't exist on disk.
	 *  Advisory, like `scope` — surfaced in the gate, never blocks. */
	scopeRefs: Awaited<ReturnType<typeof checkScopeRefs>>;
	explored: boolean;
	reviewed: boolean;
	/** Runtime evidence (readyset_verify) — independent of, and never reconciled with,
	 *  `verification` (the self-reported _Verified: note check) above. See
	 *  `findEvidenceConflicts`'s doc comment for exactly what "conflict" means here. */
	evidenceTotal: number;
	evidenceConflicts: Awaited<ReturnType<typeof findEvidenceConflicts>>;
	/** Per-artifact character counts, for the gate's budget line. */
	sizes: ArtifactSizes;
	/** proposal.md's `## Open Decisions` items still unresolved at the gate. */
	openDecisions: OpenDecision[];
	/** proposal.md's `## Assumptions` body, or undefined when absent. */
	assumptions: string | undefined;
	/** Full-lane `(assumed)` scenario names or fast-lane `(assumed)` acceptance bullets. */
	assumedScenarios: string[];
	/** Doc mentions (from `chosen.raw`) that the contract does not name. */
	missingDocs: string[];
	/** Advisory warnings for migration/release/deprecation docs with no contract or on-disk match. */
	missingDocWarnings: string[];
	/** Outside-repo tripwire count: tool calls this run observed reaching outside the repository.
	 *  Advisory — surfaced in the gate, never blocks. */
	outsideRepoAccess: number;
	/** Tool calls using a scratch directory under /tmp — reported alongside the headline, never
	 *  counted in `outsideRepoAccess` (stay-in-repo tripwire). Advisory. */
	outsideRepoTmpAccess: number;
}

/** One validate + progress + verification pass, shared by the widget and the gate prompt so
 *  they never disagree and none of it runs twice for the same decision. All pure fs work
 *  (readyset-spec.ts) — no LLM turn, no CLI process. */
export async function takeReviewSnapshot(
	ctx: ReviewCtx,
	chosen: BrainstormMeta,
	outsideRepo: { outside: number; tmp: number },
): Promise<ReviewSnapshot> {
	const progress = await getProgress(ctx.cwd, chosen.changeId);
	const validated = await validateChange(ctx.cwd, chosen.changeId);
	const verification = await checkTaskVerification(ctx.cwd, chosen.changeId);
	// Scope is checked against the working tree, not the plan: anything the repo already
	// shows as changed that the contract doesn't name is flagged here, in the gate.
	const scope = await checkScope(ctx.cwd, chosen.changeId, await pathsChangedThisRun(ctx.cwd, chosen.changeId));
	// Post-Apply the gate reopens with the change already implemented: a `(new)` file that Apply
	// created now exists and a `(delete)` file is gone, so the contract must be read with
	// post-Apply semantics or every one of them reads as a false NEW-BUT-EXISTS/DELETE-BUT-MISSING.
	const applied = await hasBeenApplied(ctx.cwd, chosen.changeId);
	const scopeRefsRaw = await checkScopeRefs(ctx.cwd, chosen.changeId, applied ? { afterApply: true } : {});
	const scopeRefs = applied ? { ...scopeRefsRaw, newButExists: [] } : scopeRefsRaw;
	const explored = await hasExploration(ctx.cwd, chosen.changeId);
	const review = await readReview(ctx.cwd, chosen.changeId);
	const { totalRecords: evidenceTotal } = await checkTaskEvidence(ctx.cwd, chosen.changeId);
	const evidenceConflicts = await findEvidenceConflicts(ctx.cwd, chosen.changeId);
	const sizes = await readArtifactSizes(ctx.cwd, chosen.changeId);
	const openDecisions = await readOpenDecisions(ctx.cwd, chosen.changeId);
	const assumptions = await readAssumptions(ctx.cwd, chosen.changeId);
	const assumedScenarios = await readAssumedScenarios(ctx.cwd, chosen.changeId);
	const missingDocs = await findMissingRequestedDocs(ctx.cwd, chosen.changeId, brainstormRequestText(chosen.raw), chosen.raw);
	const missingDocWarnings = await findDocFileWarnings(ctx.cwd, chosen.changeId, brainstormRequestText(chosen.raw), chosen.raw);
	return {
		counted: progress ? { done: progress.done, total: progress.total } : undefined,
		validated,
		verification,
		scope,
		scopeRefs,
		explored,
		reviewed: !!review,
		evidenceTotal,
		evidenceConflicts,
		sizes,
		openDecisions,
		assumptions,
		assumedScenarios,
		missingDocs,
		missingDocWarnings,
		outsideRepoAccess: outsideRepo.outside,
		outsideRepoTmpAccess: outsideRepo.tmp,
	};
}

export async function readOrPlaceholder(path: string, placeholder: string): Promise<string> {
	const raw = await readFile(path, "utf8").catch(() => undefined);
	const trimmed = raw?.trim();
	return trimmed ? trimmed : placeholder;
}

export const DOC_RULE = "═".repeat(78);
export const SECTION_RULE = "─".repeat(78);

export interface ReviewSection {
	/** Stable id, used as the select-menu label prefix so a pick can be matched back reliably
	 *  even if two sections' headings collide. */
	id: string;
	heading: string;
	/** Short status shown in the table of contents and the jump-to-section menu. */
	status: string;
	render: () => Promise<string>;
}

/**
 * Builds the list of review sections for `chosen` — the single source of truth for both the
 * full compiled document and the "Jump to section" single-section view, so they can never
 * drift out of sync with each other.
 */
export async function buildReviewSections(ctx: ReviewCtx, chosen: BrainstormMeta, snapshot: ReviewSnapshot): Promise<ReviewSection[]> {
	const paths = changePaths(ctx.cwd, chosen.changeId);
	const lane = await readChangeLane(ctx.cwd, chosen.changeId);
	const specFiles = lane === "fast" ? [] : await findSpecFiles(paths.specsDir).catch(() => [] as string[]);

	return [
		{
			id: "exploration",
			heading: "Exploration",
			status: snapshot.explored ? "done" : "not run",
			render: () => readOrPlaceholder(paths.exploration, "_(Explore did not run, or wrote nothing.)_"),
		},
		{
			id: "proposal",
			heading: "Proposal",
			status: "proposal.md",
			render: () => readOrPlaceholder(paths.proposal, "_(proposal.md not found.)_"),
		},
		{
			id: "open-decisions",
			heading: "Open decisions",
			status: snapshot.openDecisions.length > 0 ? `${snapshot.openDecisions.length} unresolved` : "none",
			render: async () => {
				const parts: string[] = [];
				if (snapshot.openDecisions.length === 0) {
					parts.push("_(none.)_");
				} else {
					for (const d of snapshot.openDecisions) {
						parts.push(`### ${d.question}`, "", d.raw || "_(no detail.)_", "");
					}
				}
				parts.push(`Assumptions: ${snapshot.assumptions ?? "_(none.)_"}`);
				parts.push("", "Assumed scenarios:", ...(snapshot.assumedScenarios.length > 0 ? snapshot.assumedScenarios.map((scenario) => `- ${scenario}`) : ["_(none.)_"]));
				return parts.join("\n");
			},
		},
		{
			id: "scope",
			heading: "Scope",
			status: snapshot.scope.noContract
				? "no contract"
				: snapshot.scope.outside.length +
							snapshot.scopeRefs.missing.length +
							snapshot.scopeRefs.newButExists.length +
							snapshot.scopeRefs.deleteButMissing.length >
						0
					? `${snapshot.scope.outside.length} out-of-scope, ${snapshot.scopeRefs.missing.length + snapshot.scopeRefs.newButExists.length + snapshot.scopeRefs.deleteButMissing.length} ref problem(s)`
					: "clean",
			render: async () => {
				const contract = await readScopeContract(ctx.cwd, chosen.changeId);
				if (contract.files === undefined) {
					return "_(no 'Files This Change Will Touch' contract in proposal.md — scope unknown.)_";
				}
				const contextRaw = await readContext(ctx.cwd, chosen.changeId).catch(() => undefined);
				// The last appendContext entry whose phase is "Contract repair" looks like
				// "## Contract repair — <ts>\n\n<N> issue(s) before, <M> after: ..."
				const repairMatches = [...(contextRaw ?? "").matchAll(/## Contract repair —[^\n]*\n\n(\d+) issue\(s\) before, (\d+) after/g)];
				const lastRepair = repairMatches[repairMatches.length - 1];
				const repairLine = lastRepair
					? `contract repair: fixed ${Number(lastRepair[1]) - Number(lastRepair[2])} of ${lastRepair[1]}`
					: "contract repair: not run";
				return [
					"Contract:",
					"",
					contract.raw || "(empty)",
					"",
					snapshot.scope.outside.length > 0
						? `Working-tree drift (changed but not in the contract): ${snapshot.scope.outside.join(", ")}`
						: "Working-tree drift (changed but not in the contract): none",
					snapshot.scopeRefs.missing.length > 0
						? `Dangling refs (named but don't exist, not marked (new)): ${snapshot.scopeRefs.missing.join(", ")}`
						: "Dangling refs (named but don't exist, not marked (new)): none",
					snapshot.scopeRefs.newButExists.length > 0
						? `New-but-exists (marked (new) but already on disk): ${snapshot.scopeRefs.newButExists.join(", ")}`
						: "New-but-exists (marked (new) but already on disk): none",
					snapshot.scopeRefs.deleteButMissing.length > 0
						? `Delete-but-missing (marked (delete) but not on disk): ${snapshot.scopeRefs.deleteButMissing.join(", ")}`
						: "Delete-but-missing (marked (delete) but not on disk): none",
					repairLine,
					...(snapshot.missingDocs.length > 0
						? snapshot.missingDocs.map((d) => `requested doc missing from contract: ${d}`)
						: []),
					...snapshot.missingDocWarnings,
					...(snapshot.outsideRepoAccess > 0 ? [`⚠ outside-repo access: ${snapshot.outsideRepoAccess} tool call(s) outside the repository (advisory)`] : []),
					...(snapshot.outsideRepoTmpAccess > 0 ? [`/tmp access: ${snapshot.outsideRepoTmpAccess} tool call(s) used a scratch directory (advisory, not counted in the outside-repo headline)`] : []),
				].join("\n");
			},
		},
		...(lane === "fast"
			? [
					{
						id: "artifacts",
						heading: "Artifact set",
						status: "fast lane: proposal + tasks",
						render: async () =>
							"Fast lane — this change carries proposal.md and tasks.md only; no design.md and no spec delta.",
					} satisfies ReviewSection,
				]
			: [
					{
						id: "design",
						heading: "Design",
						status: "design.md",
						render: () => readOrPlaceholder(paths.design, "_(design.md not found.)_"),
					} satisfies ReviewSection,
					{
						id: "specs",
						heading: `Specs (${specFiles.length})`,
						status: specFiles.length > 0 ? `${specFiles.length} file(s)` : "none found",
						render: async () => {
							if (specFiles.length === 0) return "_(no specs/**/spec.md found.)_";
							const parts: string[] = [];
							for (const specFile of specFiles) {
								const rel = specFile.slice(paths.specsDir.length + 1);
								parts.push(`### specs/${rel}`, "", await readOrPlaceholder(specFile, "_(empty)_"));
							}
							return parts.join("\n\n");
						},
					} satisfies ReviewSection,
				]),
		{
			id: "tasks",
			heading: snapshot.counted ? `Tasks (${snapshot.counted.done}/${snapshot.counted.total})` : "Tasks",
			status: snapshot.counted ? `${snapshot.counted.done}/${snapshot.counted.total} ticked` : "tasks.md not found",
			render: () => readOrPlaceholder(paths.tasks, "_(tasks.md not found.)_"),
		},
		{
			id: "verification",
			heading: "Verification summary",
			status: snapshot.verification ? (snapshot.verification.missing > 0 ? `${snapshot.verification.missing} missing` : "all verified") : "n/a",
			render: async () =>
				snapshot.verification
					? `${snapshot.verification.withVerificationNote}/${snapshot.verification.checkedTasks} checked tasks carry a _Verified: note (${snapshot.verification.missing} missing).`
					: "_(tasks.md unreadable — nothing to summarize.)_",
		},
		{
			id: "evidence",
			heading: "Runtime evidence",
			status:
				snapshot.evidenceTotal > 0
					? `${snapshot.evidenceTotal} record(s)${snapshot.evidenceConflicts.length > 0 ? `, ${snapshot.evidenceConflicts.length} conflict(s)` : ""}`
					: "none",
			render: async () => {
				const { byTask } = await checkTaskEvidence(ctx.cwd, chosen.changeId);
				if (byTask.size === 0) {
					return "_(No readyset_verify evidence recorded for this change. This is independent of the " +
						"_Verified: notes above -- their absence here doesn't mean verification wasn't done, only that " +
						"it wasn't runtime-captured.)_";
				}
				const conflictsByTask = new Map<string, string[]>();
				for (const c of snapshot.evidenceConflicts) conflictsByTask.set(c.taskId, [...(conflictsByTask.get(c.taskId) ?? []), describeEvidenceConflict(c)]);
				const parts: string[] = [];
				for (const [taskId, summary] of byTask) {
					const flag = conflictsByTask.has(taskId)
						? ` -- ⚠ CONFLICT: ${conflictsByTask.get(taskId)!.join("; ")}`
						: "";
					parts.push(`### Task ${taskId}${flag}`, "");
					for (const rec of summary.records) {
						const outcome = rec.timedOut ? "timed out" : rec.exitCode === null ? "no exit code" : `exit ${rec.exitCode}`;
						parts.push(`- ${rec.id}: \`${rec.command}\` -> ${outcome} (${rec.durationMs}ms)`);
					}
					parts.push("");
				}
				return parts.join("\n");
			},
		},
		{
			id: "code-review",
			heading: "Code review",
			status: snapshot.reviewed ? "done" : "not run yet",
			render: () => readOrPlaceholder(paths.review, "_(Code review has not run yet.)_"),
		},
		{
			id: "context-log",
			heading: "Context log",
			status: "audit trail",
			render: () => readOrPlaceholder(paths.context, "_(No phase transitions logged yet.)_"),
		},
	];
}

/**
 * Compiles every artifact for a change into one structured, scrollable document — a table of
 * contents up top (section name + at-a-glance status), then each section between `───` rules
 * — and pushes it to the editor pane via `ctx.ui.setEditorText`.
 *
 * A real persistent sidebar (native `/plan`'s clickable outline + content pane) turned out to
 * be possible after all via `ctx.ui.custom()` in Interactive mode — see `readyset-review-overlay.ts`
 * and `openSidebarOverlay` below. It opens automatically, as the review gate itself, whenever
 * `ctx.ui.custom` is present — not offered as a "Sidebar view" choice on a separate menu; Approve
 * & Execute / Refine / Discard are CTAs baked into the overlay (see
 * `readyset-review-overlay.ts`'s `ReviewOverlayResult`), so there's no menu step before it either.
 * This compiled document is pushed to the editor pane unconditionally at the top of every gate
 * loop iteration (see `reviewAndMaybeExecute`), so it's always current alongside the sidebar —
 * there is deliberately no separate "just show me the full doc" gate option, since one pushed
 * automatically on every loop turn would be a no-op by construction. `classicGateSelect` /
 * `browseReviewSections` below remain the fallback menu-driven gate for RPC/ACP/print contexts,
 * where `ctx.ui.custom` isn't available.
 */
export async function buildReviewDocument(ctx: ReviewCtx, chosen: BrainstormMeta, snapshot: ReviewSnapshot): Promise<string> {
	const sections = await buildReviewSections(ctx, chosen, snapshot);

	const lines: string[] = [DOC_RULE, ` ${chosen.title}  (${chosen.changeId})`, DOC_RULE, "", `Brainstorm: ${chosen.file}`, "", "Sections:"];
	sections.forEach((s, i) => lines.push(`  ${i + 1}. ${s.heading.padEnd(24)} [${s.status}]`));
	lines.push("", DOC_RULE);

	for (const [i, s] of sections.entries()) {
		lines.push("", SECTION_RULE, ` ${i + 1}. ${s.heading.toUpperCase()}`, SECTION_RULE, "", await s.render());
	}

	return lines.join("\n");
}

/** Renders just one section (by id) the same way `buildReviewDocument` would, for the
 *  "Jump to section" view — same content, without the noise of every other section. */
export async function buildSingleSectionDocument(ctx: ReviewCtx, chosen: BrainstormMeta, snapshot: ReviewSnapshot, sectionId: string): Promise<string | undefined> {
	const sections = await buildReviewSections(ctx, chosen, snapshot);
	const section = sections.find((s) => s.id === sectionId);
	if (!section) return undefined;
	return [DOC_RULE, ` ${section.heading.toUpperCase()}  —  ${chosen.changeId}`, DOC_RULE, "", await section.render()].join("\n");
}

/**
 * "Jump to section" — a menu-driven stand-in for a sidebar (see `buildReviewDocument`'s doc
 * comment for why a real one isn't possible). Loops until the user picks "Back to full
 * document", pushing just the picked section's content to the editor each time.
 */
/**
 * The review gate itself, whenever a real TUI is available — a persistent section list +
 * content pane via `ctx.ui.custom()` (Interactive mode only; see `readyset-review-overlay.ts`'s
 * module doc comment for how this was confirmed against `@oh-my-pi/pi-tui`'s own real source,
 * not assumed), with Approve & Execute / Approve & Compact / Refine / Discard as CTAs inside it
 * (the `[A]`/`[C]`/`[R]`/`[D]` keys `ReviewSidebarOverlay.handleInput` binds). Up/Down scroll the current section's content
 * and cross into the next/previous section once it's exhausted; Left/Right jump straight to a
 * section, bypassing its content; PgUp/PgDn take a bigger scroll step within the current
 * section. Esc cancels (treated the same as an explicit Discard by the caller). Errors
 * opening the overlay are NOT swallowed here — the caller (`reviewAndMaybeExecute`) catches them
 * and falls back to `classicGateSelect`'s menu, since a failed overlay open means there's no CTA
 * surface for the user to act on at all. `ctx.ui.custom` is feature-detected by the caller, not
 * here — this function assumes it exists.
 */
export async function openSidebarOverlay(
	ctx: ReviewCtx,
	chosen: BrainstormMeta,
	snapshot: ReviewSnapshot,
	taskSummary: string,
): Promise<ReviewOverlayResult> {
	const sections = await buildReviewSections(ctx, chosen, snapshot);
	const overlaySections: OverlaySection[] = [];
	for (const s of sections) {
		overlaySections.push({ id: s.id, heading: s.heading, status: s.status, bodyLines: (await s.render()).split("\n") });
	}

	type OverlayCtorArgs = ConstructorParameters<typeof ReviewSidebarOverlay>;
	return await ctx.ui.custom!<ReviewOverlayResult>((_tui, theme, keybindings, done) =>
		new ReviewSidebarOverlay(
			theme as unknown as OverlayCtorArgs[0],
			keybindings as unknown as OverlayCtorArgs[1],
			`Readyset review — ${chosen.title} (${chosen.changeId})`,
			overlaySections,
			taskSummary,
			done,
			snapshot.openDecisions.length > 0,
		),
	// `width: "90%"` is load-bearing, not decoration: `OverlayOptions.fullscreen` (confirmed
	// against pi-tui's real source -- see readyset-review-overlay.ts's module doc comment) only
	// controls the alt-screen buffer, not sizing. Without an explicit width the overlay defaults
	// to `min(80, terminalWidth)`, which is why an earlier version rendered as a narrow box even
	// on a wide terminal.
	{ overlay: true, overlayOptions: { fullscreen: true, width: "90%" } },
	);
}

export async function browseReviewSections(ctx: ReviewCtx, chosen: BrainstormMeta, snapshot: ReviewSnapshot): Promise<void> {
	const sections = await buildReviewSections(ctx, chosen, snapshot);
	const BACK = "◂ Back to full document";

	for (;;) {
		const options: ExtensionUISelectOption[] = sections.map((s, i) => ({
			label: `${i + 1}. ${s.heading}`,
			description: s.status,
		}));
		options.push({ label: BACK, description: "show every section again, with the table of contents" });

		const picked = await ctx.ui.select(`Jump to a section — "${chosen.changeId}"`, options, { helpText: "enter to view · esc to go back" });
		if (!picked || picked === BACK) {
			ctx.ui.setEditorText(await buildReviewDocument(ctx, chosen, snapshot));
			return;
		}

		const idx = sections.findIndex((s, i) => `${i + 1}. ${s.heading}` === picked);
		if (idx === -1) continue;
		const doc = await buildSingleSectionDocument(ctx, chosen, snapshot, sections[idx].id);
		if (doc) {
			ctx.ui.setEditorText(doc);
			ctx.ui.notify(`Showing "${sections[idx].heading}" in the editor pane.`, "info");
		}
	}
}

/** One gate line per artifact that has a real budget and a measured size, e.g.
 *  `artifacts: proposal 3,120 chars (budget 4,000)`; an overrun appends ` — OVER by N`.
 *  Artifacts whose budget is `Infinity` or whose size key is absent are skipped. */
export function artifactBudgetLines(sizes: ArtifactSizes, budgets: ArtifactBudgets, lane: ChangeLane): string[] {
	const lines: string[] = [];
	for (const { file, size } of trimmableSizes(sizes, lane)) {
		const budget = budgets[file];
		if (!Number.isFinite(budget) || size === undefined) continue;
		const over = size > budget ? ` — OVER by ${(size - budget).toLocaleString()}` : "";
		lines.push(`artifacts: ${file} ${size.toLocaleString()} chars (budget ${budget.toLocaleString()})${over}`);
	}
	return lines;
}

/** The gate line that says what Approve lets Readyset run: approving is the consent for it. */
export function verifyPanelLine(verify: VerifySettings | undefined): string | undefined {
	if (!verify) return undefined;
	if (verify.command) {
		return `tests: Approve lets Readyset run \`${verify.command}\` (${verify.source === "config" ? "readyset.verify.command" : "auto-detected"}) ` +
			"before execution (baseline), at readyset_done and at settle";
	}
	return verify.requireNotes
		? "tests: no test command — checked tasks need _Verified: notes (set readyset.verify.command)"
		: "tests: verification off (readyset.verify.command: none)";
}

export function showReviewPanel(ctx: ReviewCtx, chosen: BrainstormMeta, snapshot: ReviewSnapshot, budget: TurnBudget, lane: ChangeLane, budgets: ArtifactBudgets, verify?: VerifySettings): void {
	// Informational only -- doesn't gate which CTAs are offered (Approve & Compact is always
	// there; see reviewAndMaybeExecute). Lets the user judge for themselves whether it's worth
	// reaching for right now instead of Readyset guessing at a threshold.
	const usage = ctx.getContextUsage?.();
	const lines = [
		`Change: ${chosen.changeId}`,
		snapshot.validated.summary,
		snapshot.explored ? "exploration: done" : "exploration: skipped",
		snapshot.counted ? `tasks: ${snapshot.counted.done}/${snapshot.counted.total} ticked` : "tasks.md not found",
		snapshot.verification
			? snapshot.verification.missing > 0
				? `verification: ${snapshot.verification.missing}/${snapshot.verification.checkedTasks} checked tasks missing a _Verified: note`
				: `verification: ${snapshot.verification.withVerificationNote}/${snapshot.verification.checkedTasks} checked tasks verified`
			: "verification: n/a",
		snapshot.evidenceTotal > 0
			? `runtime evidence: ${snapshot.evidenceTotal} record(s)${snapshot.evidenceConflicts.length > 0 ? ` -- ${snapshot.evidenceConflicts.length} conflict(s): ${snapshot.evidenceConflicts.map(describeEvidenceConflict).join("; ")}` : ""}`
			: "runtime evidence: none",
		...(verifyPanelLine(verify) ? [verifyPanelLine(verify) as string] : []),
		snapshot.reviewed ? "code review: done — see REVIEW.md" : "code review: not run yet",
		snapshot.scope.noContract
			? "scope: no 'Files This Change Will Touch' contract in proposal.md — scope unknown"
			: snapshot.scope.outside.length > 0
				? `scope: OUT OF SCOPE already changed in the tree: ${snapshot.scope.outside.join(", ")}`
				: "scope: working tree matches the contract",
		// Only surface when there is a problem — a clean contract needs no line.
		...((snapshot.scopeRefs.missing.length > 0 || snapshot.scopeRefs.newButExists.length > 0 || snapshot.scopeRefs.deleteButMissing.length > 0)
			? [
					"scope refs: " +
						[
							snapshot.scopeRefs.missing.length > 0 ? `DANGLING ${snapshot.scopeRefs.missing.join(", ")}` : "",
							snapshot.scopeRefs.newButExists.length > 0 ? `NEW-BUT-EXISTS ${snapshot.scopeRefs.newButExists.join(", ")}` : "",
							snapshot.scopeRefs.deleteButMissing.length > 0 ? `DELETE-BUT-MISSING ${snapshot.scopeRefs.deleteButMissing.join(", ")}` : "",
						]
							.filter(Boolean)
							.join(" · "),
				]
			: []),
		...artifactBudgetLines(snapshot.sizes, budgets, lane),
		...((snapshot.openDecisions.length > 0 || snapshot.assumptions !== undefined)
			? [
					`open decisions: ${snapshot.openDecisions.length}`,
					...snapshot.openDecisions.map(
						(d) => `  - ${d.question}${d.recommended ? ` → ${d.recommended}` : " (no recommendation)"}`,
					),
					...(snapshot.assumptions !== undefined ? ["assumptions: see proposal.md `## Assumptions`"] : []),
					...snapshot.assumedScenarios.map((scenario) => `assumed scenario: ${scenario}`),
				]
			: snapshot.assumedScenarios.length > 0 ? snapshot.assumedScenarios.map((scenario) => `assumed scenario: ${scenario}`) : []),
		...snapshot.missingDocs.map((d) => `requested doc missing from contract: ${d}`),
		...snapshot.missingDocWarnings,
		...(snapshot.outsideRepoAccess > 0 ? [`⚠ outside-repo access: ${snapshot.outsideRepoAccess} tool call(s) outside the repository (advisory)`] : []),
		...(snapshot.outsideRepoTmpAccess > 0 ? [`/tmp access: ${snapshot.outsideRepoTmpAccess} tool call(s) used a scratch directory (advisory, not counted in the outside-repo headline)`] : []),
		`agent turns this run: ${budget.spent}/${budget.max}`,
		...(usage ? [`context: ${usage.percent}% (${usage.tokens.toLocaleString()}/${usage.contextWindow.toLocaleString()} tokens)`] : []),
		`proposal: readyset/changes/${chosen.changeId}/proposal.md`,
	];
	ctx.ui.setWidget?.("readyset", lines);
}

/**
 * The classic, menu-driven gate — used only when the sidebar overlay isn't available
 * (`ctx.ui.custom` missing: RPC/ACP/print-headless contexts, or the overlay threw on open).
 * Loops internally on "Jump to section" so the caller always gets back a real gate decision
 * (approve/refine/discard/cancel), never an intermediate browsing state.
 *
 * Fail-closed by construction: "Discard" is the first option, and any falsy/missing
 * selection (cancel, Esc, a host that resolves `undefined`) falls through to `undefined`,
 * which the caller treats as discard. No approval path can be reached by default, by
 * omission, or by a host-side stub resolving the first entry.
 */
export async function classicGateSelect(
	ctx: ReviewCtx,
	chosen: BrainstormMeta,
	snapshot: ReviewSnapshot,
	taskSummary: string,
	openDecisions: number,
): Promise<ReviewOverlayResult | "resolve-decisions"> {
	for (;;) {
		const options: ExtensionUISelectOption[] = [
			{ label: "Discard", description: "leave as proposed, do nothing (the safe default — nothing runs unless you pick an Approve option)" },
			{ label: "Approve & Execute", description: `compact context first, then implement per tasks.md — ${taskSummary}` },
			{ label: "Approve & Execute, keep context", description: "implement without compacting (keep the full Explore/Propose discussion in context)" },
			{ label: "Refine", description: "describe what to change; revises the artifacts and re-validates" },
		];
		if (openDecisions > 0) {
			options.push({
				label: "Resolve open decisions",
				description: `${openDecisions} decision(s) still open — refine with them listed so you can pick the recommended option for each`,
			});
		}
		options.push({ label: "Jump to section", description: "browse one section at a time (exploration/proposal/design/specs/tasks/…)" });

		const choice = await ctx.ui.select(`Review change "${chosen.changeId}" — ${snapshot.validated.summary}`, options, {
			helpText: "enter to choose · esc to cancel",
		});

		if (choice === "Jump to section") {
			await browseReviewSections(ctx, chosen, snapshot);
			continue; // stay in the loop; re-show this same menu after they're done browsing
		}
		if (choice === "Approve & Execute") return "approve";
		if (choice === "Approve & Execute, keep context") return "keep-context";
		if (choice === "Refine") return "refine";
		if (choice === "Resolve open decisions") return "resolve-decisions";
		if (choice === "Discard") return "discard";
		return undefined; // cancelled (no choice)
	}
}
