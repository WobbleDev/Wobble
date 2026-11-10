/**
 * Pure column-order helpers for the Workers table. An order is the list of column ids
 * as they run left to right, hidden columns included, so a column hidden and shown
 * again returns to its place. The selection checkbox and Name lead the order and
 * never move; every other column moves within the range after them.
 */

/** The columns that stay at the left of the table, in this order. */
export const PINNED_COLUMN_IDS: readonly string[] = ['selection', 'name'];

function isPinned(columnId: string): boolean {
	return PINNED_COLUMN_IDS.includes(columnId);
}

/** The index of the first column that may move: the first one after the pinned run. */
function firstMovableIndex(order: readonly string[]): number {
	const index = order.findIndex((columnId) => !isPinned(columnId));
	return index === -1 ? order.length : index;
}

/**
 * Moves one column so it sits at `index` in the resulting order. The index is clamped
 * to the movable range, so nothing lands ahead of Name. A pinned column or an id the
 * order does not hold leaves the order as it was.
 */
export function moveColumn(order: readonly string[], columnId: string, index: number): string[] {
	if (isPinned(columnId) || !order.includes(columnId)) return [...order];
	const to = Math.min(Math.max(index, firstMovableIndex(order)), order.length - 1);
	const next = order.filter((id) => id !== columnId);
	next.splice(to, 0, columnId);
	return next;
}

/**
 * The index a column moves to for one step across the visible columns, in the
 * order given, for `moveColumn`. Hidden columns are skipped. Null when the step
 * runs off either end, lands next to a pinned column, or the column is pinned.
 */
export function stepTargetIndex(
	order: readonly string[],
	visibleIds: readonly string[],
	columnId: string,
	step: 1 | -1
): number | null {
	if (isPinned(columnId)) return null;
	const at = visibleIds.indexOf(columnId);
	if (at === -1) return null;
	const neighbour = visibleIds[at + step];
	if (neighbour === undefined || isPinned(neighbour)) return null;
	const index = order.indexOf(neighbour);
	return index === -1 ? null : index;
}
