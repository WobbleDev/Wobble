/**
 * The Workers table's keyboard movement: the active cell moves with the
 * arrows, Shift extends a checked range, and focus follows the cell into the DOM.
 * It sits beside data-table-selection.svelte.ts, which owns what is checked; the table
 * component renders the rows and wires these moves into them.
 */
import { tick } from 'svelte';
import type { WorkersSelection } from './data-table-selection.svelte.ts';

/**
 * Focus can only land on a row the virtualizer has mounted. After `scrollToIndex` the
 * row arrives a tick or a frame later, so one lookup would miss it; the focus loop
 * retries this many frames before it gives up.
 */
export const MAX_FOCUS_ATTEMPTS = 10;

/**
 * The visible row a keyboard move lands on, as an index, or null when it runs off
 * either end. A boundary move (⌘↑ / ⌘↓) goes to the first or last row whatever the start.
 */
export function moveTargetIndex(
	index: number,
	delta: -1 | 1,
	rowCount: number,
	boundary: boolean
): number | null {
	if (index < 0) return null;
	const target = boundary ? (delta === 1 ? rowCount - 1 : 0) : index + delta;
	return target >= 0 && target < rowCount ? target : null;
}

/**
 * The row ids a Shift-extended range covers, in display order, from the anchor row to
 * the end row. With no anchor (`anchorIndex` below 0) the range starts at the row being left.
 */
export function rangeRowIds(
	rowIds: readonly string[],
	anchorIndex: number,
	fromIndex: number,
	endIndex: number
): string[] {
	const start = anchorIndex < 0 ? fromIndex : anchorIndex;
	return rowIds.slice(Math.min(start, endIndex), Math.max(start, endIndex) + 1);
}

/** What the keyboard module reads from the table and writes back to it. */
export type WorkersKeyboardHost = {
	/** The visible row ids, in display order. */
	rowIds: () => readonly string[];
	/** The scroll viewport the rendered rows live in. */
	viewport: () => HTMLElement | null;
	/** Scrolls the virtualizer to a row index so that row mounts. */
	scrollToRow: (index: number) => void;
	/** Saves open drafts first; answers false when one refused, and the move stops. */
	flushDrafts: () => Promise<boolean>;
	selection: WorkersSelection;
	/** True while the New Worker placeholder is open: moves are ignored meanwhile. */
	creating: () => boolean;
	/** True on the grid (desktop). The phone list has no cells, so a move focuses the row. */
	isGrid: () => boolean;
	/** The column a move keeps when it names none: the active cell's, else the Name column. */
	currentColumnId: () => string;
	/** Makes a Worker the open record. */
	select: (workerId: string) => void;
	/** Makes a cell the active cell. */
	activate: (workerId: string, columnId: string) => void;
};

export function createWorkersKeyboard(host: WorkersKeyboardHost) {
	/**
	 * Set by arrowing, cleared by the pointer: while set, rows ignore hover so only the
	 * focused one looks active.
	 */
	let navigating = $state(false);
	/** The row a Shift range started from, kept until a plain move or a toggle ends it. */
	let rangeAnchor: string | null = null;
	/** The ids checked before the range began, so the range extends them rather than replacing them. */
	let rangeBefore: readonly string[] = [];

	/**
	 * Focuses a row's cell (or the row itself when no column is given), scrolling the
	 * virtualizer to it first. Retries while the row mounts; see MAX_FOCUS_ATTEMPTS.
	 */
	async function focusCell(workerId: string, columnId: string | null) {
		const targetIndex = host.rowIds().indexOf(workerId);
		if (targetIndex < 0) return;
		host.scrollToRow(targetIndex);
		for (let attempt = 0; attempt < MAX_FOCUS_ATTEMPTS; attempt++) {
			await tick();
			const row = host
				.viewport()
				?.querySelector<HTMLElement>(`tr[data-worker-id="${CSS.escape(workerId)}"]`);
			const element = columnId
				? row?.querySelector<HTMLElement>(`td[data-column-id="${CSS.escape(columnId)}"]`)
				: row;
			if (element) {
				element.focus();
				element.scrollIntoView({ block: 'nearest' });
				return;
			}
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
	}

	/**
	 * Up/Down (delta -1/+1) and ⌘↑/⌘↓ (boundary), with Shift to extend the range. Moves
	 * the selected row and focuses its cell, keeping the column unless one is named.
	 */
	async function move(
		workerId: string,
		delta: -1 | 1,
		columnId?: string,
		extend = false,
		boundary = false
	) {
		if (host.creating()) return;
		navigating = true;
		const ids = host.rowIds();
		const index = ids.indexOf(workerId);
		const targetIndex = moveTargetIndex(index, delta, ids.length, boundary);
		if (targetIndex === null) return;
		const targetId = ids[targetIndex];
		if (targetId === undefined) return;
		if (!(await host.flushDrafts())) return;
		if (extend) {
			if (rangeAnchor === null) {
				rangeAnchor = workerId;
				rangeBefore = [...host.selection.liveSelection];
			}
			// Read the rows again: the flush may have changed them.
			const current = host.rowIds();
			const range = rangeRowIds(
				current,
				current.indexOf(rangeAnchor),
				index,
				current.indexOf(targetId)
			);
			if (!(await host.selection.setKeyboardRange(range, rangeBefore))) return;
		} else rangeAnchor = null;
		host.select(targetId);
		const cellColumn = host.isGrid() ? (columnId ?? host.currentColumnId()) : null;
		if (cellColumn) host.activate(targetId, cellColumn);
		await focusCell(targetId, cellColumn);
	}

	/** Ends a Shift range, so the next checkbox toggle is a single-row toggle. Answers whether one was open. */
	function endRange(): boolean {
		const open = rangeAnchor !== null;
		rangeAnchor = null;
		return open;
	}

	return {
		/** True while the keyboard is driving the table; see `setNavigating`. */
		get navigating() {
			return navigating;
		},
		setNavigating(value: boolean) {
			navigating = value;
		},
		endRange,
		focusCell,
		move
	};
}

export type WorkersKeyboard = ReturnType<typeof createWorkersKeyboard>;
