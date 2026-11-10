import { describe, expect, it } from 'vitest';
import { createWorkersColumnOrder, isMovableColumn } from './data-table-column-order.svelte.ts';

function harness(order: string[], hidden: string[] = []) {
	let current = order;
	const column = createWorkersColumnOrder({
		allColumnIds: () => current,
		visibleColumnIds: () => current.filter((id) => !hidden.includes(id)),
		setColumnOrder: (next) => (current = next),
		columnLabel: (id) => id.toUpperCase(),
		viewport: () => null
	});
	return { column, order: () => current };
}

function dragEvent() {
	const log = { prevented: false };
	const event = {
		preventDefault: () => (log.prevented = true),
		dataTransfer: { effectAllowed: '', dropEffect: '', setData: () => {} }
	} as unknown as DragEvent;
	return { event, log };
}

function altArrow(key: string) {
	const log = { prevented: false };
	const event = {
		altKey: true,
		key,
		preventDefault: () => (log.prevented = true),
		currentTarget: { querySelectorAll: () => [] },
		target: null
	} as unknown as KeyboardEvent;
	return { event, log };
}

describe('the column order', () => {
	it('pins the selection checkbox and Name', () => {
		expect(isMovableColumn('selection')).toBe(false);
		expect(isMovableColumn('name')).toBe(false);
		expect(isMovableColumn('languages')).toBe(true);
	});

	it('moves a column one step right on Alt+ArrowRight', () => {
		const { column, order } = harness(['selection', 'name', 'a', 'b', 'c']);
		const { event, log } = altArrow('ArrowRight');
		column.onHeaderKeydown(event, 'a');
		expect(order()).toEqual(['selection', 'name', 'b', 'a', 'c']);
		expect(log.prevented).toBe(true);
	});

	it('steps over hidden columns', () => {
		const { column, order } = harness(['selection', 'name', 'a', 'h', 'b'], ['h']);
		column.onHeaderKeydown(altArrow('ArrowRight').event, 'a');
		expect(order()).toEqual(['selection', 'name', 'h', 'b', 'a']);
	});

	it('does not move a pinned column, nor the first column left past Name', () => {
		const { column, order } = harness(['selection', 'name', 'a', 'b']);
		column.onHeaderKeydown(altArrow('ArrowRight').event, 'name');
		column.onHeaderKeydown(altArrow('ArrowLeft').event, 'a');
		expect(order()).toEqual(['selection', 'name', 'a', 'b']);
	});

	it('ignores arrows without Alt', () => {
		const { column, order } = harness(['selection', 'name', 'a', 'b']);
		const { event } = altArrow('ArrowRight');
		(event as { altKey: boolean }).altKey = false;
		column.onHeaderKeydown(event, 'a');
		expect(order()).toEqual(['selection', 'name', 'a', 'b']);
	});

	it('drops a dragged column where the target sits', () => {
		const { column, order } = harness(['selection', 'name', 'a', 'b', 'c']);
		column.onHeaderDragStart(dragEvent().event, 'c');
		expect(column.draggingColumnId).toBe('c');
		column.onHeaderDragOver(dragEvent().event, 'a');
		expect(column.dropTargetColumnId).toBe('a');
		column.onHeaderDrop(dragEvent().event, 'a');
		expect(order()).toEqual(['selection', 'name', 'c', 'a', 'b']);
		expect(column.draggingColumnId).toBeNull();
		expect(column.dropTargetColumnId).toBeNull();
	});

	it('refuses to start a drag from a pinned column', () => {
		const { column } = harness(['selection', 'name', 'a']);
		const { event, log } = dragEvent();
		column.onHeaderDragStart(event, 'name');
		expect(log.prevented).toBe(true);
		expect(column.draggingColumnId).toBeNull();
	});
});
