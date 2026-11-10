import { describe, expect, it } from 'vitest';
import { captureWorkersView, workersViewToTable } from './workers-view-state.ts';
import { stewardId, vocabulary, workersView } from './saved-view-fixtures.ts';

describe('capturing the Workers table as a view', () => {
	it('keeps filters by id, sort, hidden columns and order, and leaves the Name search out', () => {
		const filters: Record<string, unknown> = {
			name: 'Worker 07',
			role: { answers: [stewardId], missing: true },
			languages: ['Language B'],
			assessment: ['Leader'],
			agitations: ['agitation-a']
		};
		const view = captureWorkersView(
			{
				filterValue: (id) => filters[id],
				sorting: [{ id: 'role', desc: true }],
				columnVisibility: { agitations: false, shift: false, languages: true },
				columnOrder: ['selection', 'name', 'shift', 'role']
			},
			vocabulary
		);
		expect(view).toEqual({
			filters: {
				population: { answers: { role: [stewardId] }, exactAnswers: {}, missing: ['role'] },
				agitations: ['agitation-a'],
				languages: ['lang-b'],
				assessments: ['Leader']
			},
			sort: [{ column: 'role', descending: true }],
			hiddenColumns: ['shift'],
			order: ['selection', 'name', 'shift', 'role']
		});
		expect(JSON.stringify(view)).not.toContain('Worker 07');
	});
});

describe('applying a view to the Workers table', () => {
	it('sets filters (Languages by current name), sort, visibility and order', () => {
		const target = workersViewToTable(
			workersView({
				filters: {
					population: { answers: { role: [stewardId] }, exactAnswers: {}, missing: ['shift'] },
					agitations: ['agitation-a'],
					languages: ['lang-b'],
					assessments: ['Leader']
				},
				sort: [{ column: 'shift', descending: true }],
				hiddenColumns: ['languages'],
				order: ['selection', 'name', 'assessment']
			}),
			vocabulary
		);
		expect(target.columnFilters).toEqual([
			{ id: 'role', value: { answers: [stewardId], missing: false } },
			{ id: 'shift', value: { answers: [], missing: true } },
			{ id: 'languages', value: ['Language B'] },
			{ id: 'assessment', value: ['Leader'] },
			{ id: 'agitations', value: ['agitation-a'] }
		]);
		expect(target.sorting).toEqual([{ id: 'shift', desc: true }]);
		expect(target.columnVisibility).toEqual({
			agitations: false,
			assessment: true,
			languages: false,
			role: true,
			shift: true
		});
		expect(target.columnOrder).toEqual(['selection', 'name', 'assessment']);
	});

	it('round-trips through capture', () => {
		const view = workersView({
			filters: {
				population: { answers: { role: [stewardId] }, exactAnswers: {}, missing: [] },
				agitations: [],
				languages: ['lang-a'],
				assessments: []
			},
			sort: [{ column: 'name', descending: true }],
			hiddenColumns: ['assessment'],
			order: ['selection', 'name']
		});
		const target = workersViewToTable(view, vocabulary);
		const filters = new Map(target.columnFilters.map((entry) => [entry.id, entry.value]));
		expect(
			captureWorkersView(
				{
					filterValue: (id) => filters.get(id),
					sorting: target.sorting,
					columnVisibility: target.columnVisibility,
					columnOrder: target.columnOrder
				},
				vocabulary
			)
		).toEqual(view);
	});
});
