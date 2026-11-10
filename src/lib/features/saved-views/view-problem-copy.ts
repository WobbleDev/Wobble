/** The words for what Needs review says about one reference. */
import { m } from '#lib/paraglide/messages.js';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import type { ProblemPlace, ViewProblem } from './saved-view-references.ts';

const placeLabels: Record<ProblemPlace, () => string> = {
	filters: () => m.views_place_filters(),
	sort: () => m.views_place_sort(),
	columns: () => m.views_place_columns(),
	order: () => m.views_place_order(),
	grouping: () => m.views_place_grouping(),
	detail: () => m.views_place_detail(),
	visibility: () => m.views_place_visibility(),
	highlight: () => m.views_place_highlight()
};

/** The control a reference sat in. */
export function problemPlace(problem: ViewProblem): string {
	return placeLabels[problem.place]();
}

/** What is wrong with the reference, naming the live Attribute where one is known. */
export function problemReading(
	problem: ViewProblem,
	attributes: readonly WorkerAttributeDefinition[]
): string {
	switch (problem.kind) {
		case 'attribute':
			return m.views_problem_attribute();
		case 'answer': {
			const attribute = attributes.find(({ id }) => id === problem.attributeId);
			return attribute
				? m.views_problem_answer({ attribute: attribute.name })
				: m.views_problem_attribute();
		}
		case 'language':
			return m.views_problem_language();
		case 'agitation':
			return m.views_problem_agitation();
		case 'assessment':
			return m.views_problem_assessment();
		case 'column':
			return m.views_problem_column();
		case 'highlight':
			return m.views_problem_highlight();
		case 'subGroupSameAsGroup':
			return m.views_problem_sub_same();
		case 'subGroupWithoutGroup':
			return m.views_problem_sub_alone();
	}
}
