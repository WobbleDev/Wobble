import type { Agitation } from '#lib/domain-vocabulary.ts';

export type AgitationCandidates = {
	/** The worksite Agitations this Worker does not hold yet, filtered by the query, in worksite order. */
	matches: Agitation[];
	/** The worksite Agitation whose text equals the query, held or not. */
	exact: Agitation | undefined;
};

/**
 * The Agitations an Add Agitation list offers for one Worker. The query is trimmed and
 * compared case-insensitively, as the shared vocabulary has always matched text.
 */
export function agitationCandidates(
	worker: { agitations: readonly string[] },
	agitations: readonly Agitation[],
	query: string
): AgitationCandidates {
	const needle = query.trim().toLocaleLowerCase();
	const held = new Set(worker.agitations);
	const matches = agitations.filter(
		(agitation) => !held.has(agitation.id) && agitation.text.toLocaleLowerCase().includes(needle)
	);
	const exact = needle
		? agitations.find((agitation) => agitation.text.toLocaleLowerCase() === needle)
		: undefined;
	return { matches, exact };
}
