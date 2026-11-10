import { describe, expect, it } from 'vitest';
import { encodeHighlightQuery } from '#lib/features/mapping/map-highlight-query-codec.ts';
import { findViewProblems } from './saved-view-references.ts';
import {
	mappingSnapshot,
	mappingView,
	stewardId,
	vocabulary,
	workersSnapshot,
	workersView
} from './saved-view-fixtures.ts';
import type { HighlightGroup } from '#lib/features/mapping/map-highlight-query.ts';

const keys = (problems: ReturnType<typeof findViewProblems>) => problems.map((p) => p.key);

describe('a view whose references all read', () => {
	it('has no problems', () => {
		const snapshot = workersSnapshot(
			workersView({
				filters: {
					population: { answers: { role: [stewardId] }, exactAnswers: {}, missing: ['shift'] },
					agitations: ['agitation-a'],
					languages: ['lang-a'],
					assessments: ['Leader']
				},
				sort: [{ column: 'role', descending: true }],
				hiddenColumns: ['shift'],
				order: ['selection', 'name', 'role']
			})
		);
		expect(findViewProblems(snapshot, vocabulary)).toEqual([]);
		expect(
			findViewProblems(
				mappingSnapshot(mappingView({ grouping: { group: 'role', subGroup: 'shift' } })),
				vocabulary
			)
		).toEqual([]);
	});
});

describe('Workers views with a missing or incompatible reference', () => {
	it('names each, and dropping one removes only that reference', () => {
		const snapshot = workersSnapshot(
			workersView({
				filters: {
					population: {
						answers: { role: [stewardId, 'role~Gone'], removed: ['x'] },
						exactAnswers: { role: ['role~Gone'] },
						missing: ['removed']
					},
					agitations: ['agitation-gone'],
					languages: ['lang-a', 'lang-gone'],
					assessments: ['Nonsense']
				},
				sort: [{ column: 'removed', descending: false }],
				hiddenColumns: ['removed'],
				order: ['name', 'removed']
			})
		);
		const problems = findViewProblems(snapshot, vocabulary);
		expect(problems.map((p) => [p.place, p.kind])).toEqual([
			['filters', 'answer'],
			['filters', 'attribute'],
			['filters', 'answer'],
			['filters', 'attribute'],
			['filters', 'agitation'],
			['filters', 'language'],
			['filters', 'assessment'],
			['sort', 'column'],
			['columns', 'column'],
			['order', 'column']
		]);

		const dropped = problems.reduce((current, problem) => problem.drop(current), snapshot);
		expect(findViewProblems(dropped, vocabulary)).toEqual([]);
		// What still reads is kept: a drop never reaches past its own reference.
		expect(dropped.workers?.filters.population.answers).toEqual({ role: [stewardId] });
		expect(dropped.workers?.filters.languages).toEqual(['lang-a']);
		expect(dropped.workers?.order).toEqual(['name']);

		const first = problems[0]!.drop(snapshot);
		expect(findViewProblems(first, vocabulary)).toHaveLength(problems.length - 1);
		expect(first.workers?.filters.population.answers.removed).toEqual(['x']);
	});
});

describe('Mapping views with a missing or incompatible reference', () => {
	it('flags a gone grouping, an incompatible sub-grouping and stale detail', () => {
		const gone = mappingSnapshot(
			mappingView({
				grouping: { group: 'removed', subGroup: '' },
				detail: { expanded: ['x'], expandedSub: [] }
			})
		);
		expect(findViewProblems(gone, vocabulary).map((p) => [p.place, p.kind])).toEqual([
			['grouping', 'attribute']
		]);
		const droppedGone = findViewProblems(gone, vocabulary)[0]!.drop(gone);
		expect(droppedGone.mapping?.grouping).toEqual({ group: '', subGroup: '' });
		expect(droppedGone.mapping?.detail.expanded).toEqual([]);

		const same = mappingSnapshot(mappingView({ grouping: { group: 'role', subGroup: 'role' } }));
		expect(findViewProblems(same, vocabulary)[0]?.kind).toBe('subGroupSameAsGroup');
		const alone = mappingSnapshot(mappingView({ grouping: { group: '', subGroup: 'shift' } }));
		expect(findViewProblems(alone, vocabulary)[0]?.kind).toBe('subGroupWithoutGroup');

		const staleDetail = mappingSnapshot(
			mappingView({
				grouping: { group: 'role', subGroup: '' },
				detail: { expanded: ['role~Gone'], expandedSub: [] }
			})
		);
		expect(keys(findViewProblems(staleDetail, vocabulary))).toEqual(['detail.expanded:role~Gone']);
	});

	it('flags hidden answers, languages and Assessments that no longer read', () => {
		const snapshot = mappingSnapshot(
			mappingView({
				population: { answers: { role: ['role~Gone'] }, exactAnswers: {}, missing: ['removed'] },
				visibility: {
					assessments: ['Nonsense'],
					values: { shift: ['shift~Gone'], removed: ['x'] },
					languages: ['lang-gone']
				}
			})
		);
		const problems = findViewProblems(snapshot, vocabulary);
		expect(problems).toHaveLength(6);
		const dropped = problems.reduce((current, problem) => problem.drop(current), snapshot);
		expect(findViewProblems(dropped, vocabulary)).toEqual([]);
	});

	it('flags a Highlight that names something gone, and drops only that rule', () => {
		const group: HighlightGroup = {
			type: 'group',
			id: 'g',
			match: 'all',
			rules: [
				{
					type: 'clause',
					id: 'a',
					field: { kind: 'attribute', attributeId: 'role' },
					operator: 'any',
					values: [stewardId, 'role~Gone']
				},
				{
					type: 'clause',
					id: 'b',
					field: { kind: 'languages' },
					operator: 'any',
					values: ['lang-a']
				}
			]
		};
		const snapshot = mappingSnapshot(
			mappingView({ highlight: { query: encodeHighlightQuery(group) } })
		);
		const [problem] = findViewProblems(snapshot, vocabulary);
		expect(problem?.kind).toBe('highlight');
		const dropped = problem!.drop(snapshot);
		expect(findViewProblems(dropped, vocabulary)).toEqual([]);
		expect(dropped.mapping?.highlight.query).toContain(stewardId);
		expect(dropped.mapping?.highlight.query).not.toContain('role~Gone');
		expect(dropped.mapping?.highlight.query).toContain('lang-a');

		const malformed = mappingSnapshot(mappingView({ highlight: { query: '{nope' } }));
		expect(findViewProblems(malformed, vocabulary)[0]?.kind).toBe('highlight');
		expect(
			findViewProblems(malformed, vocabulary)[0]!.drop(malformed).mapping?.highlight.query
		).toBe('');
	});
});
