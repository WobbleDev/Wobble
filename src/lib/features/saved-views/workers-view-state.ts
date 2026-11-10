/**
 * Moving the Workers table's question between the table and a saved view. The table keeps
 * filters, sort, column visibility and column order; a view keeps the same by stable id
 * (Languages by id, not name), and leaves out the Name search, which is the organizer's own.
 */
import type { SavedViewWorkers } from '#lib/domain-vocabulary.ts';
import {
	readAnswerFilter,
	toColumnFilters,
	type ColumnFilterEntry,
	type WorkerFilters
} from '#lib/shared/worker-filters.ts';
import { workersColumnIds, type ViewVocabulary } from './saved-view-references.ts';

/** The table's own state, as the column-filter reader and TanStack state hold it. */
export type WorkersTableState = {
	filterValue: (columnId: string) => unknown;
	sorting: readonly { id: string; desc: boolean }[];
	columnVisibility: Readonly<Record<string, boolean>>;
	columnOrder: readonly string[];
};

/** What applying a view sets on the table. */
export type WorkersTableTarget = {
	columnFilters: ColumnFilterEntry[];
	sorting: { id: string; desc: boolean }[];
	columnVisibility: Record<string, boolean>;
	columnOrder: string[];
};

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string')
		: [];
}

/** The table's current question as a view, with no Name search in it. */
export function captureWorkersView(
	state: WorkersTableState,
	vocabulary: ViewVocabulary
): SavedViewWorkers {
	const answers: Record<string, string[]> = {};
	const exactAnswers: Record<string, string[]> = {};
	const missing: string[] = [];
	for (const attribute of vocabulary.attributes) {
		const value = readAnswerFilter(state.filterValue(attribute.id));
		if (value.answers.length > 0) answers[attribute.id] = [...new Set(value.answers)];
		if (value.exact && value.exact.length > 0)
			exactAnswers[attribute.id] = [...new Set(value.exact)];
		if (value.missing) missing.push(attribute.id);
	}

	const languageIds = new Map(vocabulary.languages.map(({ id, name }) => [name, id]));
	const { optional } = workersColumnIds(vocabulary);

	return {
		filters: {
			population: { answers, exactAnswers, missing },
			agitations: [...new Set(strings(state.filterValue('agitations')))],
			languages: [...new Set(strings(state.filterValue('languages')))].flatMap((name) => {
				const id = languageIds.get(name);
				return id === undefined ? [] : [id];
			}),
			assessments: [...new Set(strings(state.filterValue('assessment')))]
		},
		sort: state.sorting.map(({ id, desc }) => ({ column: id, descending: desc })),
		hiddenColumns: [...optional].filter((id) => state.columnVisibility[id] === false),
		order: [...state.columnOrder]
	};
}

/** The table state a view sets; the Name search is left to the caller to keep. */
export function workersViewToTable(
	view: SavedViewWorkers,
	vocabulary: ViewVocabulary
): WorkersTableTarget {
	const names = new Map(vocabulary.languages.map(({ id, name }) => [id, name]));
	const { population } = view.filters;
	const columns = new Map<string, string[]>();
	const languages = view.filters.languages.flatMap((id) => {
		const name = names.get(id);
		return name === undefined ? [] : [name];
	});
	if (languages.length > 0) columns.set('languages', languages);
	if (view.filters.assessments.length > 0) columns.set('assessment', [...view.filters.assessments]);

	const filters: WorkerFilters = {
		answers: new Map(Object.entries(population.answers).map(([id, ids]) => [id, ids])),
		missing: new Set(population.missing),
		exactAnswers: new Map(Object.entries(population.exactAnswers).map(([id, ids]) => [id, ids])),
		columns,
		agitations: new Set(view.filters.agitations)
	};

	const { optional } = workersColumnIds(vocabulary);
	const hidden = new Set(view.hiddenColumns);
	return {
		columnFilters: toColumnFilters(filters),
		sorting: view.sort.map(({ column, descending }) => ({ id: column, desc: descending })),
		// The Agitation facet is a filter, never a column, so it stays hidden.
		columnVisibility: {
			agitations: false,
			...Object.fromEntries([...optional].map((id) => [id, !hidden.has(id)]))
		},
		columnOrder: [...view.order]
	};
}
