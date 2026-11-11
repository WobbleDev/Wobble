/**
 * Pins what `columns.ts` does today, ahead of the data-table refactors: the inline width and
 * pin style a column carries, the Workers table's column order and per-column filter and sort
 * behaviour, and the guard that a cell edit needs its table handlers. Read through the module's
 * public exports with literal rows; no table engine and no DOM.
 */
import { describe, expect, it } from 'vitest';
import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { columnStyle, createColumns, pinClass } from './columns.ts';

const attributes: WorkerAttributeDefinition[] = [
	{
		id: 'department',
		name: 'Department',
		kind: 'category',
		answers: [
			{ id: 'front', value: 'Front' },
			{ id: 'back', value: 'Back' }
		]
	},
	{
		id: 'shifts',
		name: 'Shifts',
		kind: 'tag',
		answers: [
			{ id: 'day', value: 'Day' },
			{ id: 'night', value: 'Night' }
		]
	}
];
const agitations = [{ id: 'pay', text: 'Pay' }];
const languages = [
	{ id: 'greek', name: 'Greek' },
	{ id: 'latin', name: 'Latin' }
];

function worker(overrides: Partial<Worker> = {}): Worker {
	return {
		id: 'w-1',
		name: 'Ada Lovelace',
		email: 'ada@example.com',
		phone: '',
		assessment: 'Supporter',
		attributes: {},
		agitations: [],
		languages: [],
		relationships: [],
		notes: [],
		...overrides
	} as Worker;
}

/** A row stub carrying the worker, and the sort direction the engine would report. */
function row(
	w: Worker,
	sorted: false | 'asc' | 'desc' = 'asc',
	values: Record<string, unknown> = {}
) {
	return {
		original: w,
		getValue: (id: string) => values[id],
		table: { getColumn: () => ({ getIsSorted: () => sorted }) }
	} as never;
}

function column(id: string) {
	const found = createColumns(attributes, agitations, languages).find(
		(c) => (c as { id?: string }).id === id || (c as { accessorKey?: string }).accessorKey === id
	);
	if (!found) throw new Error(`no column ${id}`);
	return found as unknown as {
		filterFn?: (row: never, id: string, value: unknown) => boolean;
		sortFn?: (a: never, b: never, id: string) => number;
		meta?: Record<string, unknown>;
		enableSorting?: boolean;
		sortDescFirst?: boolean;
	};
}

describe('columnStyle', () => {
	it('is empty when a column declares no width', () => {
		expect(columnStyle(undefined)).toBeUndefined();
		expect(columnStyle({ label: 'Agitations' })).toBeUndefined();
	});

	it('pins the checkbox at offset 0 and Name after the checkbox width', () => {
		expect(columnStyle({ width: '2.75rem', pin: 'select' })).toBe('width:2.75rem;left:0;');
		expect(columnStyle({ width: 'var(--workers-table-name-w)', pin: 'name' })).toBe(
			'width:var(--workers-table-name-w);left:2.75rem;'
		);
	});

	it('gives a column without a minimum its fixed width, plus slack when it grows', () => {
		expect(columnStyle({ width: '8rem' })).toBe('width:8rem;');
		expect(columnStyle({ width: '8rem', grow: true })).toBe(
			'width:calc(8rem + var(--workers-table-slack, 0px) * 8 / var(--workers-table-grow-rem, 1));'
		);
	});

	it('lets a shrinkable column rest between its minimum and preferred width', () => {
		const shrunk = 'calc(5rem + (9rem - 5rem) * var(--workers-table-t, 1))';
		expect(columnStyle({ width: '9rem', minWidth: '5rem' })).toBe(`width:${shrunk};`);
		expect(columnStyle({ width: '9rem', minWidth: '5rem', grow: true })).toBe(
			`width:calc(${shrunk} + var(--workers-table-slack, 0px) * 9 / var(--workers-table-grow-rem, 1));`
		);
	});
});

describe('pinClass', () => {
	it('makes a pinned cell sticky and opaque, and leaves others alone', () => {
		expect(pinClass({ pin: 'select' })).toBe('sticky z-10 bg-panel');
		expect(pinClass({ pin: 'name' })).toBe('sticky z-10 bg-panel');
		expect(pinClass({ width: '8rem' })).toBeUndefined();
		expect(pinClass(undefined)).toBeUndefined();
	});
});

describe('createColumns layout', () => {
	it('lists selection, name, assessment, languages, the hidden agitations facet, then each attribute', () => {
		const ids = createColumns(attributes, agitations, languages).map(
			(c) =>
				(c as { id?: string; accessorKey?: string }).id ??
				(c as { accessorKey?: string }).accessorKey
		);
		expect(ids).toEqual([
			'selection',
			'name',
			'assessment',
			'languages',
			'agitations',
			'department',
			'shifts'
		]);
	});

	it('builds only the fixed columns when the worksite configures nothing', () => {
		expect(createColumns([], [], [])).toHaveLength(5);
	});

	it('pins selection and name, and lets assessment, languages and attributes grow', () => {
		expect(column('selection').meta).toMatchObject({ pin: 'select', width: '2.75rem' });
		expect(column('name').meta).toMatchObject({
			pin: 'name',
			width: 'var(--workers-table-name-w)'
		});
		for (const id of ['assessment', 'languages', 'department', 'shifts']) {
			expect(column(id).meta).toMatchObject({ grow: true, widthClass: expect.any(String) });
			expect(column(id).meta?.minWidth).toMatch(/rem$/);
		}
	});

	it('keeps the agitations facet out of sorting and out of the layout', () => {
		expect(column('agitations').enableSorting).toBe(false);
		expect(column('agitations').meta).toEqual({ label: 'Agitations' });
	});

	it('starts list-valued columns ascending on the first press', () => {
		expect(column('languages').sortDescFirst).toBe(false);
		expect(column('department').sortDescFirst).toBe(false);
	});
});

describe('createColumns filters', () => {
	it('matches an assessment or language column against the selected option values', () => {
		const assessment = column('assessment').filterFn!;
		expect(assessment(row(worker(), 'asc', { assessment: 'Supporter' }), 'assessment', [])).toBe(
			true
		);
		expect(
			assessment(row(worker(), 'asc', { assessment: 'Supporter' }), 'assessment', ['Supporter'])
		).toBe(true);
		expect(
			assessment(row(worker(), 'asc', { assessment: 'Supporter' }), 'assessment', ['Hostile'])
		).toBe(false);
		expect(
			assessment(row(worker(), 'asc', { assessment: 'Supporter' }), 'assessment', 'Supporter')
		).toBe(false);
		expect(assessment(row(worker(), 'asc', { assessment: 'Supporter' }), 'assessment', [1])).toBe(
			false
		);

		const languagesFilter = column('languages').filterFn!;
		const held = row(worker(), 'asc', { languages: ['Greek'] });
		expect(languagesFilter(held, 'languages', ['Latin', 'Greek'])).toBe(true);
		expect(languagesFilter(held, 'languages', ['Latin'])).toBe(false);
		expect(languagesFilter(row(worker(), 'asc', { languages: [] }), 'languages', ['Greek'])).toBe(
			false
		);
	});

	it('matches the agitations facet by assigned agitation id', () => {
		const facet = column('agitations').filterFn!;
		expect(facet(row(worker({ agitations: ['pay'] })), 'agitations', ['pay'])).toBe(true);
		expect(facet(row(worker({ agitations: [] })), 'agitations', ['pay'])).toBe(false);
	});

	it('matches an attribute column by held answer id', () => {
		const department = column('department').filterFn!;
		const front = worker({ attributes: { department: 'front' } });
		expect(department(row(front), 'department', { answers: ['front'] })).toBe(true);
		expect(department(row(front), 'department', { answers: ['back'] })).toBe(false);
	});
});

describe('createColumns sorting', () => {
	it('orders assessments along the scale and puts Unassessed last in both directions', () => {
		const sort = column('assessment').sortFn!;
		const leader = worker({ assessment: 'Leader' });
		const hostile = worker({ assessment: 'Hostile' });
		const unassessed = worker({ assessment: 'Unassessed' });
		expect(sort(row(leader), row(hostile), 'assessment')).toBeLessThan(0);
		expect(sort(row(hostile), row(leader), 'assessment')).toBeGreaterThan(0);
		expect(sort(row(unassessed, 'asc'), row(leader, 'asc'), 'assessment')).toBeGreaterThan(0);
		expect(sort(row(unassessed, 'desc'), row(leader, 'desc'), 'assessment')).toBeLessThan(0);
	});

	it('sorts languages by their names, empties last', () => {
		const sort = column('languages').sortFn!;
		const greek = worker({ languages: ['greek'] });
		const latin = worker({ languages: ['latin'] });
		const none = worker({ languages: [] });
		expect(sort(row(greek), row(latin), 'languages')).toBeLessThan(0);
		expect(sort(row(latin), row(greek), 'languages')).toBeGreaterThan(0);
		expect(sort(row(none, 'asc'), row(greek, 'asc'), 'languages')).toBeGreaterThan(0);
		// Descending: the engine negates the result, so an empty still reads as the later one.
		expect(sort(row(none, 'desc'), row(greek, 'desc'), 'languages')).toBeLessThan(0);
	});

	it('sorts an attribute column by its held answer labels', () => {
		const sort = column('department').sortFn!;
		const front = worker({ attributes: { department: 'front' } });
		const back = worker({ attributes: { department: 'back' } });
		expect(sort(row(back), row(front), 'department')).toBeLessThan(0);
	});

	it('sorts Name by the regional name order', () => {
		const sort = column('name').sortFn!;
		expect(sort(row(worker({ name: 'ada' })), row(worker({ name: 'Bob' })), 'name')).toBeLessThan(
			0
		);
	});
});
