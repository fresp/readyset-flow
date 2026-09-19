/**
 * One shared piece of wording for every structural (not semantic) check in this package --
 * `validateChange` (readyset-spec.ts) and `validateBrainstormContent` (readyset-brainstorm.ts).
 *
 * Both checks make the same honest, narrower claim: the required pieces are present and not
 * left as unfilled template text, not that the content is actually correct or well thought
 * through. That claim was previously spelled out as a hand-written literal string in each of
 * the two files independently ("... (structural check)") -- harmless while there were two, but
 * exactly the kind of duplication that silently drifts: someone tightens the wording in one
 * check after a UX review and forgets the other one exists. Centralizing it here means there is
 * now exactly one place that decides what "(structural check)" means and how it reads, and
 * both checks are guaranteed to say the same thing by construction, not by two people
 * remembering to keep them in sync.
 *
 * Deliberately just this one function -- not a shared `Issue`/`Result` type. The two checks'
 * issue shapes name their locator field differently on purpose (`file` for validateChange,
 * `section` for validateBrainstormContent, since a spec issue points at a file and a brainstorm
 * issue points at a section of one file) and unifying that would mean renaming a field real code
 * and tests already depend on for no behavioral benefit -- churn, not a fix. This function only
 * touches the one thing that was actually duplicated and risked drifting: the summary sentence.
 */
export function structuralCheckSummary(opts: {
	/** What's being checked, e.g. "validate" or "brainstorm" -- becomes the sentence's prefix. */
	kind: string;
	issueCount: number;
	/** Describes a clean result, e.g. "pass" or "Decision/Seam/Scope/Acceptance Criteria filled in". */
	okDetail: string;
	/** Noun phrase for what's being counted when issues exist, e.g. "issue(s)" or "section(s) look unresolved". */
	issueNoun: string;
	/** Optional trailing clause appended after issueNoun when issues exist, e.g. "may not have been fully grilled". */
	notOkDetail?: string;
}): string {
	const { kind, issueCount, okDetail, issueNoun, notOkDetail } = opts;
	if (issueCount === 0) return `${kind}: ${okDetail} (structural check)`;
	const suffix = notOkDetail ? ` -- ${notOkDetail}` : "";
	return `${kind}: ${issueCount} ${issueNoun} (structural check)${suffix}`;
}
