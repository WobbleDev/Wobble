import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { normalizeForMatch } from '#lib/shared/text.ts';
import { compareNames } from '#lib/i18n/format.ts';
import { heldIds } from '#lib/shared/select-mode.ts';

/** The most candidates the add list renders; a worksite can hold thousands. */
export const RELATIONSHIP_CANDIDATE_LIMIT = 50;

export type RelationshipCandidate = {
	worker: Worker;
	/** The first Category answer the candidate has, to tell similar names apart. */
	detail: string;
};

/** The text of the first Category answer the Worker has, or an empty string. */
function firstCategoryAnswer(worker: Worker, attributes: readonly WorkerAttributeDefinition[]) {
	for (const attribute of attributes) {
		if (attribute.kind !== 'category') continue;
		const answerId = heldIds(worker.attributes[attribute.id])[0];
		if (answerId === undefined) continue;
		const label = attribute.answers.find((answer) => answer.id === answerId)?.value;
		if (label) return label;
	}
	return '';
}

/**
 * The Workers a Relationship can be added to: everyone but the Worker themselves and
 * the Workers already related, filtered by name, in name order, and cut to the first
 * {@link RELATIONSHIP_CANDIDATE_LIMIT}. `more` says a longer list was cut.
 */
export function relationshipCandidates(
	worker: Worker,
	workers: readonly Worker[],
	attributes: readonly WorkerAttributeDefinition[],
	query: string
): { matches: RelationshipCandidate[]; more: boolean } {
	const needle = normalizeForMatch(query);
	const related = new Set(worker.relationships);
	const matches: RelationshipCandidate[] = [];
	let more = false;

	const eligible = workers.filter(
		(candidate) =>
			candidate.id !== worker.id &&
			!related.has(candidate.id) &&
			(needle === '' || candidate.name.toLowerCase().includes(needle))
	);
	// Name order as the Workers table reads it: the system regional locale at call
	// time, case-blind, digits by value. Names themselves are never rewritten.
	eligible.sort((a, b) => compareNames(a.name, b.name));

	for (const candidate of eligible) {
		if (matches.length === RELATIONSHIP_CANDIDATE_LIMIT) {
			more = true;
			break;
		}
		matches.push({ worker: candidate, detail: firstCategoryAnswer(candidate, attributes) });
	}

	return { matches, more };
}
