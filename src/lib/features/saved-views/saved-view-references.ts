/**
 * Reading a saved view's references against the configuration as it stands. A view names
 * Attributes, answers, Languages, Agitations and columns by stable id, so a rename never
 * breaks it; a reference the Worksite no longer holds, or holds in an incompatible way, is a
 * problem. Each problem carries the one edit that drops it. Applying a view with problems
 * needs the organizer's explicit choice per problem: nothing is dropped, and so nothing is
 * broadened, silently.
 */
import {
	assessmentOptions,
	type Agitation,
	type Language,
	type SavedViewMapping,
	type SavedViewPopulation,
	type SavedViewSnapshot,
	type SavedViewWorkers,
	type WorkerAttributeDefinition
} from '#lib/domain-vocabulary.ts';
import {
	decodeHighlightQuery,
	encodeHighlightQuery
} from '#lib/features/mapping/map-highlight-query-codec.ts';

/** What the Worksite configures now. */
export type ViewVocabulary = {
	attributes: readonly WorkerAttributeDefinition[];
	languages: readonly Language[];
	agitations: readonly Agitation[];
};

/** The control a problem sits in. */
export type ProblemPlace =
	'filters' | 'sort' | 'columns' | 'order' | 'grouping' | 'detail' | 'visibility' | 'highlight';

export type ProblemKind =
	| 'attribute'
	| 'answer'
	| 'language'
	| 'agitation'
	| 'assessment'
	| 'column'
	| 'highlight'
	| 'subGroupSameAsGroup'
	| 'subGroupWithoutGroup';

/** One reference the view cannot keep, and the edit that lets the rest of the view open. */
export type ViewProblem = {
	/** Identifies the problem within one view's review. */
	key: string;
	place: ProblemPlace;
	kind: ProblemKind;
	/** The Attribute an answer problem belongs to, so its live name can be shown. */
	attributeId?: string;
	/** Removes this reference from a snapshot of the same kind. */
	drop: (snapshot: SavedViewSnapshot) => SavedViewSnapshot;
};

/** The columns a Workers view may sort, hide or order, by id. */
export function workersColumnIds(vocabulary: ViewVocabulary): {
	sortable: ReadonlySet<string>;
	optional: ReadonlySet<string>;
	ordered: ReadonlySet<string>;
} {
	const attributeIds = vocabulary.attributes.map(({ id }) => id);
	return {
		sortable: new Set(['name', 'assessment', 'languages', ...attributeIds]),
		optional: new Set(['assessment', 'languages', ...attributeIds]),
		ordered: new Set([
			'selection',
			'name',
			'assessment',
			'languages',
			'agitations',
			...attributeIds
		])
	};
}

type Edit<V> = (view: V) => V;

function editWorkers(snapshot: SavedViewSnapshot, edit: Edit<SavedViewWorkers>): SavedViewSnapshot {
	return snapshot.workers ? { ...snapshot, workers: edit(snapshot.workers) } : snapshot;
}

function editMapping(snapshot: SavedViewSnapshot, edit: Edit<SavedViewMapping>): SavedViewSnapshot {
	return snapshot.mapping ? { ...snapshot, mapping: edit(snapshot.mapping) } : snapshot;
}

type Group = Record<string, string[]>;

function withoutEntry(group: Group, attributeId: string, answerId: string | null): Group {
	const next: Group = { ...group };
	if (answerId === null) {
		delete next[attributeId];
		return next;
	}
	const kept = (next[attributeId] ?? []).filter((id) => id !== answerId);
	if (kept.length > 0) next[attributeId] = kept;
	else delete next[attributeId];
	return next;
}

function answerIdsOf(
	vocabulary: ViewVocabulary
): ReadonlyMap<string, { attribute: WorkerAttributeDefinition; answers: ReadonlySet<string> }> {
	return new Map(
		vocabulary.attributes.map((attribute) => [
			attribute.id,
			{ attribute, answers: new Set(attribute.answers.map(({ id }) => id)) }
		])
	);
}

/** Problems of one answer group: an Attribute that is gone, or an answer it no longer holds. */
function answerGroupProblems(
	group: Group,
	place: ProblemPlace,
	path: string,
	vocabulary: ViewVocabulary,
	dropEntry: (
		snapshot: SavedViewSnapshot,
		attributeId: string,
		answerId: string | null
	) => SavedViewSnapshot
): ViewProblem[] {
	const known = answerIdsOf(vocabulary);
	const problems: ViewProblem[] = [];
	for (const [attributeId, answerIds] of Object.entries(group)) {
		const attribute = known.get(attributeId);
		if (!attribute) {
			problems.push({
				key: `${path}:${attributeId}`,
				place,
				kind: 'attribute',
				drop: (snapshot) => dropEntry(snapshot, attributeId, null)
			});
			continue;
		}
		for (const answerId of answerIds) {
			if (attribute.answers.has(answerId)) continue;
			problems.push({
				key: `${path}:${attributeId}:${answerId}`,
				place,
				kind: 'answer',
				attributeId,
				drop: (snapshot) => dropEntry(snapshot, attributeId, answerId)
			});
		}
	}
	return problems;
}

function missingProblems(
	ids: readonly string[],
	place: ProblemPlace,
	path: string,
	vocabulary: ViewVocabulary,
	dropId: (snapshot: SavedViewSnapshot, attributeId: string) => SavedViewSnapshot
): ViewProblem[] {
	const known = new Set(vocabulary.attributes.map(({ id }) => id));
	return ids
		.filter((id) => !known.has(id))
		.map((id) => ({
			key: `${path}:${id}`,
			place,
			kind: 'attribute' as const,
			drop: (snapshot: SavedViewSnapshot) => dropId(snapshot, id)
		}));
}

type PopulationEditor = (
	snapshot: SavedViewSnapshot,
	edit: Edit<SavedViewPopulation>
) => SavedViewSnapshot;

function populationProblems(
	population: SavedViewPopulation,
	place: ProblemPlace,
	path: string,
	vocabulary: ViewVocabulary,
	editPopulation: PopulationEditor
): ViewProblem[] {
	return [
		...answerGroupProblems(
			population.answers,
			place,
			`${path}.answers`,
			vocabulary,
			(snapshot, attributeId, answerId) =>
				editPopulation(snapshot, (value) => ({
					...value,
					answers: withoutEntry(value.answers, attributeId, answerId)
				}))
		),
		...answerGroupProblems(
			population.exactAnswers,
			place,
			`${path}.exact`,
			vocabulary,
			(snapshot, attributeId, answerId) =>
				editPopulation(snapshot, (value) => ({
					...value,
					exactAnswers: withoutEntry(value.exactAnswers, attributeId, answerId)
				}))
		),
		...missingProblems(
			population.missing,
			place,
			`${path}.missing`,
			vocabulary,
			(snapshot, attributeId) =>
				editPopulation(snapshot, (value) => ({
					...value,
					missing: value.missing.filter((id) => id !== attributeId)
				}))
		)
	];
}

function languageProblems(
	ids: readonly string[],
	place: ProblemPlace,
	path: string,
	vocabulary: ViewVocabulary,
	dropId: (snapshot: SavedViewSnapshot, languageId: string) => SavedViewSnapshot
): ViewProblem[] {
	const known = new Set(vocabulary.languages.map(({ id }) => id));
	return ids
		.filter((id) => !known.has(id))
		.map((id) => ({
			key: `${path}:${id}`,
			place,
			kind: 'language' as const,
			drop: (snapshot: SavedViewSnapshot) => dropId(snapshot, id)
		}));
}

function assessmentProblems(
	values: readonly string[],
	place: ProblemPlace,
	path: string,
	dropValue: (snapshot: SavedViewSnapshot, value: string) => SavedViewSnapshot
): ViewProblem[] {
	const known: readonly string[] = assessmentOptions;
	return values
		.filter((value) => !known.includes(value))
		.map((value) => ({
			key: `${path}:${value}`,
			place,
			kind: 'assessment' as const,
			drop: (snapshot: SavedViewSnapshot) => dropValue(snapshot, value)
		}));
}

function columnProblems(
	ids: readonly string[],
	valid: ReadonlySet<string>,
	place: ProblemPlace,
	path: string,
	dropId: (snapshot: SavedViewSnapshot, columnId: string) => SavedViewSnapshot
): ViewProblem[] {
	return ids
		.filter((id) => !valid.has(id))
		.map((id) => ({
			key: `${path}:${id}`,
			place,
			kind: 'column' as const,
			drop: (snapshot: SavedViewSnapshot) => dropId(snapshot, id)
		}));
}

function workersProblems(view: SavedViewWorkers, vocabulary: ViewVocabulary): ViewProblem[] {
	const columns = workersColumnIds(vocabulary);
	const agitations = new Set(vocabulary.agitations.map(({ id }) => id));
	const dropFrom =
		(edit: (view: SavedViewWorkers) => SavedViewWorkers) => (snapshot: SavedViewSnapshot) =>
			editWorkers(snapshot, edit);
	return [
		...populationProblems(
			view.filters.population,
			'filters',
			'filters',
			vocabulary,
			(snapshot, edit) =>
				editWorkers(snapshot, (workers) => ({
					...workers,
					filters: { ...workers.filters, population: edit(workers.filters.population) }
				}))
		),
		...view.filters.agitations
			.filter((id) => !agitations.has(id))
			.map((id) => ({
				key: `filters.agitations:${id}`,
				place: 'filters' as const,
				kind: 'agitation' as const,
				drop: dropFrom((workers) => ({
					...workers,
					filters: {
						...workers.filters,
						agitations: workers.filters.agitations.filter((entry) => entry !== id)
					}
				}))
			})),
		...languageProblems(
			view.filters.languages,
			'filters',
			'filters.languages',
			vocabulary,
			(snapshot, languageId) =>
				editWorkers(snapshot, (workers) => ({
					...workers,
					filters: {
						...workers.filters,
						languages: workers.filters.languages.filter((id) => id !== languageId)
					}
				}))
		),
		...assessmentProblems(
			view.filters.assessments,
			'filters',
			'filters.assessments',
			(snapshot, value) =>
				editWorkers(snapshot, (workers) => ({
					...workers,
					filters: {
						...workers.filters,
						assessments: workers.filters.assessments.filter((entry) => entry !== value)
					}
				}))
		),
		...columnProblems(
			view.sort.map(({ column }) => column),
			columns.sortable,
			'sort',
			'sort',
			(snapshot, columnId) =>
				editWorkers(snapshot, (workers) => ({
					...workers,
					sort: workers.sort.filter(({ column }) => column !== columnId)
				}))
		),
		...columnProblems(
			view.hiddenColumns,
			columns.optional,
			'columns',
			'columns',
			(snapshot, columnId) =>
				editWorkers(snapshot, (workers) => ({
					...workers,
					hiddenColumns: workers.hiddenColumns.filter((id) => id !== columnId)
				}))
		),
		...columnProblems(view.order, columns.ordered, 'order', 'order', (snapshot, columnId) =>
			editWorkers(snapshot, (workers) => ({
				...workers,
				order: workers.order.filter((id) => id !== columnId)
			}))
		)
	];
}

function mappingProblems(view: SavedViewMapping, vocabulary: ViewVocabulary): ViewProblem[] {
	const known = answerIdsOf(vocabulary);
	const { group, subGroup } = view.grouping;
	const problems: ViewProblem[] = [];
	const editGrouping =
		(edit: (view: SavedViewMapping) => SavedViewMapping) => (snapshot: SavedViewSnapshot) =>
			editMapping(snapshot, edit);

	if (group !== '' && !known.has(group)) {
		problems.push({
			key: 'grouping.group',
			place: 'grouping',
			kind: 'attribute',
			drop: editGrouping((mapping) => ({
				...mapping,
				grouping: { group: '', subGroup: '' },
				detail: { expanded: [], expandedSub: [] }
			}))
		});
	}
	if (subGroup !== '') {
		const dropSub = editGrouping((mapping) => ({
			...mapping,
			grouping: { ...mapping.grouping, subGroup: '' },
			detail: { ...mapping.detail, expandedSub: [] }
		}));
		if (!known.has(subGroup)) {
			problems.push({ key: 'grouping.sub', place: 'grouping', kind: 'attribute', drop: dropSub });
		} else if (group === '') {
			problems.push({
				key: 'grouping.sub',
				place: 'grouping',
				kind: 'subGroupWithoutGroup',
				drop: dropSub
			});
		} else if (subGroup === group) {
			problems.push({
				key: 'grouping.sub',
				place: 'grouping',
				kind: 'subGroupSameAsGroup',
				drop: dropSub
			});
		}
	}

	const detail = (
		ids: readonly string[],
		attributeId: string,
		field: 'expanded' | 'expandedSub'
	) => {
		const holder = known.get(attributeId);
		if (!holder) return;
		for (const id of ids) {
			if (holder.answers.has(id)) continue;
			problems.push({
				key: `detail.${field}:${id}`,
				place: 'detail',
				kind: 'answer',
				attributeId,
				drop: editGrouping((mapping) => ({
					...mapping,
					detail: {
						...mapping.detail,
						[field]: mapping.detail[field].filter((entry) => entry !== id)
					}
				}))
			});
		}
	};
	detail(view.detail.expanded, group, 'expanded');
	detail(view.detail.expandedSub, subGroup, 'expandedSub');

	problems.push(
		...populationProblems(view.population, 'filters', 'population', vocabulary, (snapshot, edit) =>
			editMapping(snapshot, (mapping) => ({ ...mapping, population: edit(mapping.population) }))
		),
		...assessmentProblems(
			view.visibility.assessments,
			'visibility',
			'visibility.assessments',
			(snapshot, value) =>
				editMapping(snapshot, (mapping) => ({
					...mapping,
					visibility: {
						...mapping.visibility,
						assessments: mapping.visibility.assessments.filter((entry) => entry !== value)
					}
				}))
		),
		...answerGroupProblems(
			view.visibility.values,
			'visibility',
			'visibility.values',
			vocabulary,
			(snapshot, attributeId, answerId) =>
				editMapping(snapshot, (mapping) => ({
					...mapping,
					visibility: {
						...mapping.visibility,
						values: withoutEntry(mapping.visibility.values, attributeId, answerId)
					}
				}))
		),
		...languageProblems(
			view.visibility.languages,
			'visibility',
			'visibility.languages',
			vocabulary,
			(snapshot, languageId) =>
				editMapping(snapshot, (mapping) => ({
					...mapping,
					visibility: {
						...mapping.visibility,
						languages: mapping.visibility.languages.filter((id) => id !== languageId)
					}
				}))
		)
	);

	// The highlight query round-trips unchanged while every rule still reads; one that
	// pruning or decoding would change names something the Worksite no longer holds.
	const query = view.highlight.query;
	const pruned = encodeHighlightQuery(decodeHighlightQuery(query, vocabulary));
	if (query !== pruned) {
		problems.push({
			key: 'highlight',
			place: 'highlight',
			kind: 'highlight',
			drop: editGrouping((mapping) => ({
				...mapping,
				highlight: {
					query: encodeHighlightQuery(decodeHighlightQuery(mapping.highlight.query, vocabulary))
				}
			}))
		});
	}
	return problems;
}

/** Every reference of the snapshot the configuration cannot honour; empty when it all reads. */
export function findViewProblems(
	snapshot: SavedViewSnapshot,
	vocabulary: ViewVocabulary
): ViewProblem[] {
	if (snapshot.kind === 'workers' && snapshot.workers) {
		return workersProblems(snapshot.workers, vocabulary);
	}
	if (snapshot.kind === 'mapping' && snapshot.mapping) {
		return mappingProblems(snapshot.mapping, vocabulary);
	}
	return [];
}
