/**
 * Column order for the Workers table, changed by dragging a header or Alt+Arrow on a
 * focused one. The order holds every column, hidden ones too, so a column shown again
 * keeps its place. Name and the selection checkbox lead and never move.
 */
import { tick } from 'svelte';
import { m } from '#lib/paraglide/messages.js';
import { moveColumn, PINNED_COLUMN_IDS, stepTargetIndex } from './column-order.ts';

/** What the column order reads from the table and writes back to it. */
export type WorkersColumnOrderHost = {
	/** Every leaf column id in order, hidden ones included. */
	allColumnIds: () => string[];
	/** The visible leaf column ids in order. */
	visibleColumnIds: () => string[];
	setColumnOrder: (order: string[]) => void;
	/** The column's human label, if it has one. */
	columnLabel: (columnId: string) => string | undefined;
	/** The scroll viewport the headers live in. */
	viewport: () => HTMLElement | null;
};

export const isMovableColumn = (columnId: string) => !PINNED_COLUMN_IDS.includes(columnId);

export function createWorkersColumnOrder(host: WorkersColumnOrderHost) {
	/** Visible data columns in order, the selection checkbox left out: Name is position 1. */
	const visibleDataColumnIds = () =>
		host.visibleColumnIds().filter((columnId) => columnId !== 'selection');

	let draggingColumnId = $state<string | null>(null);
	let dropTargetColumnId = $state<string | null>(null);
	/** The polite announcement of a keyboard move, read by screen readers. */
	let columnMoveNotice = $state('');

	function moveColumnTo(columnId: string, index: number) {
		host.setColumnOrder(moveColumn(host.allColumnIds(), columnId, index));
	}

	function clearColumnDrag() {
		draggingColumnId = null;
		dropTargetColumnId = null;
	}

	function onHeaderDragStart(event: DragEvent, columnId: string) {
		if (!isMovableColumn(columnId)) {
			event.preventDefault();
			return;
		}
		draggingColumnId = columnId;
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			// Some browsers start no drag at all unless the transfer carries data.
			event.dataTransfer.setData('text/plain', columnId);
		}
	}

	/** A header is a drop target only for a movable column other than the one dragged. */
	function onHeaderDragOver(event: DragEvent, columnId: string) {
		if (!draggingColumnId || draggingColumnId === columnId || !isMovableColumn(columnId)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		dropTargetColumnId = columnId;
	}

	function onHeaderDragLeave(columnId: string) {
		if (dropTargetColumnId === columnId) dropTargetColumnId = null;
	}

	/** The dragged column lands where the drop target sits. */
	function onHeaderDrop(event: DragEvent, columnId: string) {
		const dragged = draggingColumnId;
		clearColumnDrag();
		if (!dragged || dragged === columnId || !isMovableColumn(columnId)) return;
		event.preventDefault();
		moveColumnTo(dragged, host.allColumnIds().indexOf(columnId));
	}

	/**
	 * Alt+Left and Alt+Right move the focused header's column one visible place. The
	 * focus stays on the same control of that header, and the move is announced.
	 */
	function onHeaderKeydown(event: KeyboardEvent, columnId: string) {
		if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
		if (!isMovableColumn(columnId)) return;
		event.preventDefault();
		const index = stepTargetIndex(
			host.allColumnIds(),
			host.visibleColumnIds(),
			columnId,
			event.key === 'ArrowRight' ? 1 : -1
		);
		if (index === null) return;

		const header = event.currentTarget as HTMLElement;
		const focused = Array.from(header.querySelectorAll('button')).indexOf(
			event.target as HTMLButtonElement
		);
		moveColumnTo(columnId, index);
		columnMoveNotice = m.workers_column_moved({
			label: host.columnLabel(columnId) ?? columnId,
			position: visibleDataColumnIds().indexOf(columnId) + 1
		});
		void tick().then(() => {
			const moved = host
				.viewport()
				?.querySelector<HTMLElement>(`th[data-column-id="${CSS.escape(columnId)}"]`);
			const buttons = Array.from(moved?.querySelectorAll('button') ?? []);
			(buttons[Math.max(focused, 0)] ?? buttons[0])?.focus();
		});
	}

	return {
		get draggingColumnId() {
			return draggingColumnId;
		},
		get dropTargetColumnId() {
			return dropTargetColumnId;
		},
		get columnMoveNotice() {
			return columnMoveNotice;
		},
		isMovableColumn,
		clearColumnDrag,
		onHeaderDragStart,
		onHeaderDragOver,
		onHeaderDragLeave,
		onHeaderDrop,
		onHeaderKeydown
	};
}
