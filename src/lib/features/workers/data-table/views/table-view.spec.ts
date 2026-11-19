import { describe, expect, it, vi } from 'vitest';
import type { ViewVocabulary } from '#lib/features/saved-views/saved-view-references.ts';
import { applyTableView, captureTableView, type WorkersTableViewPort } from './table-view.ts';

const vocabulary: ViewVocabulary = { attributes: [], languages: [], agitations: [] };

type State = {
	filters: Record<string, unknown>;
	sorting: { id: string; desc: boolean }[];
	visibility: Record<string, boolean>;
	order: string[];
};

function setup(initial: Partial<State> = {}) {
	const state: State = {
		filters: {},
		sorting: [],
		visibility: {},
		order: [],
		...initial
	};
	const port = {
		filterValue: (columnId: string) => state.filters[columnId],
		sorting: state.sorting,
		columnVisibility: state.visibility,
		columnOrder: state.order,
		setColumnFilters: vi.fn((filters: { id: string; value: unknown }[]) => ({ filters })),
		setSorting: vi.fn((sorting: State['sorting']) => ({ sorting })),
		setColumnVisibility: vi.fn((visibility: State['visibility']) => ({ visibility })),
		setColumnOrder: vi.fn((order: string[]) => ({ order }))
	} satisfies WorkersTableViewPort;
	return { port, state };
}

describe('a saved Workers view on the table', () => {
	it('captures the sort, columns and order the table holds', () => {
		const { port } = setup({
			sorting: [{ id: 'name', desc: true }],
			visibility: { assessment: false },
			order: ['name', 'assessment']
		});
		const snapshot = captureTableView(port, vocabulary);
		expect(snapshot).toMatchObject({ version: 1, kind: 'workers' });
		expect(snapshot.workers).toMatchObject({
			sort: [{ column: 'name', descending: true }],
			hiddenColumns: ['assessment'],
			order: ['name', 'assessment']
		});
	});

	it('leaves the Name search out of the view', () => {
		const { port } = setup({ filters: { name: 'ada' } });
		const snapshot = captureTableView(port, vocabulary);
		expect(JSON.stringify(snapshot.workers?.filters)).not.toContain('ada');
	});

	it('puts a captured view back on another table', () => {
		const source = setup({
			sorting: [{ id: 'assessment', desc: false }],
			visibility: { languages: false },
			order: ['assessment', 'name']
		});
		const snapshot = captureTableView(source.port, vocabulary);

		const target = setup();
		applyTableView(target.port, snapshot, vocabulary);
		expect(target.port.setSorting).toHaveBeenCalledWith([{ id: 'assessment', desc: false }]);
		expect(target.port.setColumnVisibility).toHaveBeenCalledWith(
			expect.objectContaining({ languages: false })
		);
		expect(target.port.setColumnOrder).toHaveBeenCalledWith(['assessment', 'name']);
	});

	it('keeps what is typed in the Name search when a view is applied', () => {
		const source = setup({ sorting: [{ id: 'name', desc: true }] });
		const snapshot = captureTableView(source.port, vocabulary);

		const target = setup({ filters: { name: 'ada' } });
		applyTableView(target.port, snapshot, vocabulary);
		const applied = target.port.setColumnFilters.mock.calls[0]![0];
		expect(applied).toContainEqual({ id: 'name', value: 'ada' });
	});

	it('ignores a snapshot that carries no Workers view', () => {
		const { port } = setup();
		applyTableView(port, { version: 1, kind: 'mapping' }, vocabulary);
		expect(port.setSorting).not.toHaveBeenCalled();
		expect(port.setColumnFilters).not.toHaveBeenCalled();
	});
});
