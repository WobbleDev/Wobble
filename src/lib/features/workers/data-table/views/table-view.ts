/**
 * The Workers table's question as a saved view holds it. `workers-view-state.ts` is the pure
 * translation between a view and the table's filters, sort, columns and order; this is the
 * table port it runs against, so the grid only names what the table can read and set.
 */
import type { SavedViewSnapshot } from '#lib/domain-vocabulary.ts';
import {
	captureWorkersView,
	workersViewToTable,
	type WorkersTableState,
	type WorkersTableTarget
} from '#lib/features/saved-views/workers-view-state.ts';
import type { ViewVocabulary } from '#lib/features/saved-views/saved-view-references.ts';

/** What a saved view reads from the table and writes back to it. */
export type WorkersTableViewPort = WorkersTableState & {
	setColumnFilters: (filters: WorkersTableTarget['columnFilters']) => void;
	setSorting: (sorting: WorkersTableTarget['sorting']) => void;
	setColumnVisibility: (visibility: WorkersTableTarget['columnVisibility']) => void;
	setColumnOrder: (order: string[]) => void;
};

/** The table's current question as a snapshot, with no Name search in it. */
export function captureTableView(
	port: WorkersTableViewPort,
	vocabulary: ViewVocabulary
): SavedViewSnapshot {
	return {
		version: 1,
		kind: 'workers',
		workers: captureWorkersView(port, vocabulary)
	};
}

/**
 * Puts a saved view back on the table. The Name search is the organizer's own and stays: a view
 * never carries it, and applying one must not clear what is typed in the search field.
 */
export function applyTableView(
	port: WorkersTableViewPort,
	snapshot: SavedViewSnapshot,
	vocabulary: ViewVocabulary
): void {
	if (!snapshot.workers) return;
	const target = workersViewToTable(snapshot.workers, vocabulary);
	const search = port.filterValue('name');
	port.setColumnFilters([
		...target.columnFilters,
		...(typeof search === 'string' && search ? [{ id: 'name', value: search }] : [])
	]);
	port.setSorting(target.sorting);
	port.setColumnVisibility(target.columnVisibility);
	port.setColumnOrder(target.columnOrder);
}
