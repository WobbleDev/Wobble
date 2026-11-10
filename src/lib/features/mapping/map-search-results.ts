import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
import { heldIds } from '#lib/shared/select-mode.ts';
import { normalizeForMatch } from '#lib/shared/text.ts';

/** The most results the list names; a longer match narrows by typing more. */
export const searchResultLimit = 12;

export type SearchResult = {
	id: string;
	name: string;
	assessment: Worker['assessment'];
	/** The first answer the Worker holds to the first Attribute that has one; '' when none. */
	detail: string;
	/** True when the current view does not draw this Worker. */
	hidden: boolean;
};

/** The Workers whose name holds the search text, in the Worker order, with whether each is drawn. */
export function searchResults(input: {
	query: string;
	workers: readonly Worker[];
	attributes: readonly WorkerAttributeDefinition[];
	drawnIds: ReadonlySet<string>;
}): { results: SearchResult[]; total: number } {
	const query = normalizeForMatch(input.query);
	if (!query) return { results: [], total: 0 };

	const matches = input.workers.filter((worker) => worker.name.toLowerCase().includes(query));
	const results = matches.slice(0, searchResultLimit).map((worker) => ({
		id: worker.id,
		name: worker.name,
		assessment: worker.assessment,
		detail: distinguishingAnswer(worker, input.attributes),
		hidden: !input.drawnIds.has(worker.id)
	}));
	return { results, total: matches.length };
}

function distinguishingAnswer(
	worker: Worker,
	attributes: readonly WorkerAttributeDefinition[]
): string {
	for (const attribute of attributes) {
		const [first] = heldIds(worker.attributes[attribute.id]);
		if (first) return answerDisplayLabel(attribute.answers, first);
	}
	return '';
}
