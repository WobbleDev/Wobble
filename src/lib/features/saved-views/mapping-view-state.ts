/**
 * Moving the map's question between the map and a saved view. A view keeps the grouping,
 * its detail, the layout, the population filter, what is hidden and the Highlight query;
 * the toolbar search, the selected Worker, Isolate, the camera and manual positions are the
 * organizer's own and never enter it.
 */
import type { SavedViewMapping } from '#lib/domain-vocabulary.ts';
import { copyContextualFilters } from '#lib/shared/contextual-filters.ts';
import {
	readExpansionIds,
	writeExpansionEntries,
	type MapViewSnapshot
} from '#lib/features/mapping/map-view-snapshot.ts';

/** The map's question as a view, from the snapshot the map state already captures. */
export function captureMappingView(snapshot: MapViewSnapshot): SavedViewMapping {
	const filters = copyContextualFilters(snapshot.contextFilters);
	return {
		grouping: { group: snapshot.group, subGroup: snapshot.subGroup },
		detail: {
			expanded: readExpansionIds(snapshot.expanded, snapshot.group),
			expandedSub: readExpansionIds(snapshot.expandedSub, snapshot.subGroup)
		},
		layout: snapshot.layout,
		population: {
			answers: filters.answers,
			exactAnswers: filters.exactAnswers ?? {},
			missing: filters.missing
		},
		visibility: {
			assessments: [...snapshot.hiddenAssessments],
			values: Object.fromEntries(
				Object.entries(snapshot.hiddenValues).map(([id, ids]) => [id, [...ids]])
			),
			languages: [...snapshot.hiddenLanguages]
		},
		highlight: { query: snapshot.highlightQuery }
	};
}

/**
 * The snapshot a view sets on the map. Isolate is the organizer's own, so the one in effect
 * is kept; the rest comes from the view.
 */
export function mappingViewToSnapshot(view: SavedViewMapping, isolated: boolean): MapViewSnapshot {
	const { population } = view;
	return {
		group: view.grouping.group,
		subGroup: view.grouping.subGroup,
		layout: view.layout,
		isolated,
		hiddenAssessments: [...view.visibility.assessments],
		hiddenValues: Object.fromEntries(
			Object.entries(view.visibility.values).map(([id, ids]) => [id, [...ids]])
		),
		hiddenLanguages: [...view.visibility.languages],
		highlightLanguage: '',
		highlightQuery: view.highlight.query,
		contextFilters: {
			answers: Object.fromEntries(
				Object.entries(population.answers).map(([id, ids]) => [id, [...ids]])
			),
			missing: [...population.missing],
			...(Object.keys(population.exactAnswers).length > 0
				? {
						exactAnswers: Object.fromEntries(
							Object.entries(population.exactAnswers).map(([id, ids]) => [id, [...ids]])
						)
					}
				: {})
		},
		expanded: writeExpansionEntries(view.grouping.group, view.detail.expanded),
		expandedSub: writeExpansionEntries(view.grouping.subGroup, view.detail.expandedSub)
	};
}
