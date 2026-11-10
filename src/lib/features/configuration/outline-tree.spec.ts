import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { createOutlineTree, type OutlineRow, type OutlineTreeHost } from './outline-tree.svelte.ts';

// Two Attributes: "a" is unfolded with answer "a1" (which has an unfolded child "a1x"), "b" is a leaf "c" is a folded Attribute with an answer.
function baseRows(): OutlineRow[] {
	return [
		{ id: 'a', level: 1, parentId: null, expandable: true, expanded: true },
		{ id: 'a1', level: 2, parentId: 'a', expandable: true, expanded: true },
		{ id: 'a1x', level: 3, parentId: 'a1', expandable: false, expanded: false },
		{ id: 'b', level: 1, parentId: null, expandable: false, expanded: false },
		{ id: 'c', level: 1, parentId: null, expandable: true, expanded: false }
	];
}

const names: Record<string, string> = { a: 'Department', b: 'Role', c: 'Shift' };

/** A row element as a keyboard event sees it: the row itself, or a control inside it. */
const onRow = (id: string) => ({ rowId: id });
const onControl = { control: true };

type Overrides = {
	rows?: OutlineRow[];
	disabled?: boolean;
	moved?: boolean;
	rowAtPoint?: (x: number, y: number) => { id: string; top: number; height: number } | null;
	activate?: boolean;
};

function setup(overrides: Overrides = {}) {
	const rows = overrides.rows ?? baseRows();
	const host = {
		rows: () => rows,
		focus: vi.fn(),
		toggleExpanded: vi.fn(),
		moveAttribute: vi.fn<OutlineTreeHost['moveAttribute']>(() => overrides.moved ?? true),
		attributeName: (id: string) => names[id] ?? '',
		activate: vi.fn<OutlineTreeHost['activate']>(() => overrides.activate ?? true),
		rowAtPoint: vi.fn(overrides.rowAtPoint ?? (() => null)),
		rowOwnedBy: (target: EventTarget | null) =>
			(target as { rowId?: string } | null)?.rowId ?? null,
		disabled: () => overrides.disabled ?? false,
		afterUpdate: () => Promise.resolve()
	};
	return { outline: createOutlineTree(host), host, rows };
}

function key(name: string, target: unknown, extra: Partial<KeyboardEvent> = {}) {
	return {
		key: name,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		target,
		preventDefault: vi.fn(),
		...extra
	} as unknown as KeyboardEvent;
}

function press(x: number, y: number, extra: Partial<PointerEvent> = {}) {
	return {
		button: 0,
		clientX: x,
		clientY: y,
		preventDefault: vi.fn(),
		...extra
	} as unknown as PointerEvent;
}

/** Dispatches a window-level event whose fields the module reads. */
function dispatch(type: string, fields: Record<string, unknown> = {}) {
	const event = Object.assign(new Event(type), fields);
	window.dispatchEvent(event);
}

/** Lets the focus that follows a move or fold land. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => vi.stubGlobal('window', new EventTarget()));
afterEach(() => vi.unstubAllGlobals());

describe('navigation', () => {
	it('ArrowDown and ArrowUp step to the neighbouring row and stop at both ends', async () => {
		const { outline, host } = setup();
		const down = key('ArrowDown', onRow('a'));
		await outline.keydown(down);
		expect(down.preventDefault).toHaveBeenCalledOnce();
		expect(host.focus).toHaveBeenLastCalledWith('a1');

		await outline.keydown(key('ArrowUp', onRow('a1')));
		expect(host.focus).toHaveBeenLastCalledWith('a');

		await outline.keydown(key('ArrowUp', onRow('a')));
		expect(host.focus).toHaveBeenLastCalledWith('a');

		await outline.keydown(key('ArrowDown', onRow('c')));
		expect(host.focus).toHaveBeenLastCalledWith('c');
	});

	it('Home and End go to the first and last visible row', async () => {
		const { outline, host } = setup();
		await outline.keydown(key('End', onRow('a1')));
		expect(host.focus).toHaveBeenLastCalledWith('c');
		await outline.keydown(key('Home', onRow('c')));
		expect(host.focus).toHaveBeenLastCalledWith('a');
	});

	it('ArrowRight unfolds a folded row and records focus on it', async () => {
		const { outline, host } = setup();
		await outline.keydown(key('ArrowRight', onRow('c')));
		expect(host.toggleExpanded).toHaveBeenCalledWith('c');
		expect(host.toggleExpanded).toHaveBeenCalledOnce();
		expect(host.focus).toHaveBeenLastCalledWith('c');
	});

	it('ArrowRight on an unfolded row moves to its first child', async () => {
		const { outline, host } = setup();
		await outline.keydown(key('ArrowRight', onRow('a')));
		expect(host.toggleExpanded).not.toHaveBeenCalled();
		expect(host.focus).toHaveBeenLastCalledWith('a1');
	});

	it('ArrowRight on a row with no children does nothing but keep its key', async () => {
		const { outline, host } = setup();
		const event = key('ArrowRight', onRow('b'));
		await outline.keydown(event);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(host.toggleExpanded).not.toHaveBeenCalled();
		expect(host.focus).not.toHaveBeenCalled();
	});

	it('ArrowLeft folds an unfolded row and keeps focus on it', async () => {
		const { outline, host } = setup();
		await outline.keydown(key('ArrowLeft', onRow('a')));
		expect(host.toggleExpanded).toHaveBeenCalledWith('a');
		expect(host.focus).toHaveBeenLastCalledWith('a');
	});

	it('ArrowLeft on a folded or leaf row moves to its parent', async () => {
		const { outline, host } = setup();
		await outline.keydown(key('ArrowLeft', onRow('a1x')));
		expect(host.toggleExpanded).not.toHaveBeenCalled();
		expect(host.focus).toHaveBeenLastCalledWith('a1');
		await outline.keydown(key('ArrowLeft', onRow('a1')));
		expect(host.toggleExpanded).toHaveBeenCalledWith('a1');
	});

	it('an Attribute with no parent has nowhere to move on ArrowLeft', async () => {
		const { outline, host } = setup();
		await outline.keydown(key('ArrowLeft', onRow('b')));
		expect(host.toggleExpanded).not.toHaveBeenCalled();
		expect(host.focus).not.toHaveBeenCalled();
	});

	it.each([
		['Control', { ctrlKey: true }],
		['Meta', { metaKey: true }]
	])('ignores the arrow keys with %s held', async (_name, extra) => {
		const { outline, host } = setup();
		const event = key('ArrowDown', onRow('a'), extra as Partial<KeyboardEvent>);
		await outline.keydown(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(host.focus).not.toHaveBeenCalled();
	});
});

describe('Attribute reorder by keyboard', () => {
	it('Alt+ArrowDown moves the Attribute, announces it, and keeps focus on it', async () => {
		const { outline, host } = setup();
		await outline.keydown(key('ArrowDown', onRow('b'), { altKey: true }));
		expect(host.moveAttribute).toHaveBeenCalledWith('b', 1);
		expect(outline.announcement).toBe(m.configuration_attribute_moved_down({ name: 'Role' }));
		await settle();
		expect(host.focus).toHaveBeenLastCalledWith('b');
	});

	it('Alt+ArrowUp moves the Attribute up and announces it', async () => {
		const { outline, host } = setup();
		await outline.keydown(key('ArrowUp', onRow('b'), { altKey: true }));
		expect(host.moveAttribute).toHaveBeenCalledWith('b', -1);
		expect(outline.announcement).toBe(m.configuration_attribute_moved_up({ name: 'Role' }));
	});

	it('announces a fallback name for an Attribute that has none', async () => {
		const { outline, host } = setup();
		host.attributeName = () => '';
		await outline.keydown(key('ArrowDown', onRow('b'), { altKey: true }));
		expect(outline.announcement).toBe(
			m.configuration_attribute_moved_down({ name: m.configuration_attribute_fallback() })
		);
	});

	it('does nothing at either end: no move, no announcement, no focus', async () => {
		const { outline, host } = setup({ moved: false });
		const event = key('ArrowUp', onRow('a'), { altKey: true });
		await outline.keydown(event);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(host.moveAttribute).toHaveBeenCalledWith('a', -1);
		expect(outline.announcement).toBe('');
		await settle();
		expect(host.focus).not.toHaveBeenCalled();
	});

	it('Alt+Arrow on an answer row keeps its key and moves nothing', async () => {
		const { outline, host } = setup();
		const event = key('ArrowDown', onRow('a1'), { altKey: true });
		await outline.keydown(event);
		expect(host.moveAttribute).not.toHaveBeenCalled();
		expect(event.preventDefault).not.toHaveBeenCalled();
	});
});

describe('activation', () => {
	it.each([['Enter'], ['F2']])('%s activates the edit control of the row', async (name) => {
		const { outline, host } = setup();
		const event = key(name, onRow('a1'));
		await outline.keydown(event);
		expect(host.activate).toHaveBeenCalledWith('a1', 'edit');
		expect(event.preventDefault).toHaveBeenCalledOnce();
	});

	it('Shift+F2 moves into the Short form field of the row', async () => {
		const { outline, host } = setup();
		const event = key('F2', onRow('a1'), { shiftKey: true });
		await outline.keydown(event);
		expect(host.activate).toHaveBeenCalledWith('a1', 'short-form');
		expect(host.activate).not.toHaveBeenCalledWith('a1', 'edit');
		expect(event.preventDefault).toHaveBeenCalledOnce();
	});

	it('Enter keeps its key when the row has no edit control', async () => {
		const { outline, host } = setup({ activate: false });
		const event = key('Enter', onRow('b'));
		await outline.keydown(event);
		expect(host.activate).toHaveBeenCalledWith('b', 'edit');
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it('Delete activates remove, then focuses the row that took its place', async () => {
		const { outline, host, rows } = setup();
		host.activate = vi.fn((id: string) => {
			rows.splice(
				rows.findIndex((row) => row.id === id),
				1
			);
			return true;
		});
		const event = key('Delete', onRow('b'));
		await outline.keydown(event);
		expect(host.activate).toHaveBeenCalledWith('b', 'remove');
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(host.focus).toHaveBeenLastCalledWith('c');
	});

	it('Delete on the last row focuses the new last row', async () => {
		const { outline, host, rows } = setup();
		host.activate = vi.fn((id: string) => {
			rows.splice(
				rows.findIndex((row) => row.id === id),
				1
			);
			return true;
		});
		await outline.keydown(key('Delete', onRow('c')));
		expect(host.focus).toHaveBeenLastCalledWith('b');
	});

	it('Delete without a remove control leaves the row and its key alone', async () => {
		const { outline, host } = setup({ activate: false });
		const event = key('Delete', onRow('a'));
		await outline.keydown(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(host.focus).not.toHaveBeenCalled();
	});

	it('keys from inside a row control are ignored', async () => {
		const { outline, host } = setup();
		for (const name of ['ArrowDown', 'Enter', 'Delete', 'Home']) {
			const event = key(name, onControl);
			await outline.keydown(event);
			expect(event.preventDefault).not.toHaveBeenCalled();
		}
		expect(host.focus).not.toHaveBeenCalled();
		expect(host.activate).not.toHaveBeenCalled();
	});
});

describe('focused row', () => {
	it('focusIn makes the row the tab stop', () => {
		const { outline } = setup();
		outline.focusIn('a1');
		expect(outline.focusedRowId).toBe('a1');
	});

	it('clears the tab stop when its row is no longer visible', () => {
		const { outline, rows } = setup();
		outline.focusIn('a1x');
		outline.reconcile();
		expect(outline.focusedRowId).toBe('a1x');
		rows.splice(2, 1);
		outline.reconcile();
		expect(outline.focusedRowId).toBeNull();
	});
});

describe('pointer reorder', () => {
	const row = (id: string) => ({ id, top: 0, height: 40 });

	it('moves the Attribute to the row under the pointer on release', async () => {
		const { outline, host } = setup({ rowAtPoint: () => row('b') });
		const grip = press(10, 10);
		outline.startReorder(grip, 'a');
		expect(grip.preventDefault).toHaveBeenCalledOnce();

		dispatch('pointermove', { clientX: 10, clientY: 30 });
		expect(outline.reorder).toEqual({ id: 'a', targetId: 'b', after: true, x: 10, y: 30 });

		dispatch('pointerup');
		expect(outline.reorder).toBeNull();
		// Dropped after b: one step down, from a's place past b.
		expect(host.moveAttribute).toHaveBeenCalledOnce();
		expect(host.moveAttribute).toHaveBeenCalledWith('a', 1);
		expect(outline.announcement).toBe(m.configuration_attribute_moved_down({ name: 'Department' }));
	});

	it('the drop line sits above the target while the pointer is in its upper half', () => {
		const { outline } = setup({ rowAtPoint: () => row('b') });
		outline.startReorder(press(10, 10), 'a');
		dispatch('pointermove', { clientX: 10, clientY: 5 });
		expect(outline.reorder?.after).toBe(false);
		expect(outline.reorder?.targetId).toBe('b');
	});

	it('a release over no row, or over the dragged row itself, moves nothing', () => {
		const { outline, host } = setup({ rowAtPoint: () => row('a') });
		outline.startReorder(press(10, 10), 'a');
		dispatch('pointermove', { clientX: 10, clientY: 30 });
		expect(outline.reorder?.targetId).toBeNull();
		dispatch('pointerup');
		expect(host.moveAttribute).not.toHaveBeenCalled();
	});

	it('a drop across several rows moves one place per step', () => {
		const { outline, host } = setup({ rowAtPoint: () => ({ id: 'c', top: 0, height: 40 }) });
		outline.startReorder(press(10, 10), 'a');
		dispatch('pointermove', { clientX: 10, clientY: 39 });
		dispatch('pointerup');
		expect(host.moveAttribute.mock.calls).toEqual([
			['a', 1],
			['a', 1]
		]);
	});

	it('pointer cancel drops the Attribute without moving it', () => {
		const { outline, host } = setup({ rowAtPoint: () => row('b') });
		outline.startReorder(press(10, 10), 'a');
		dispatch('pointermove', { clientX: 10, clientY: 30 });
		dispatch('pointercancel');
		expect(outline.reorder).toBeNull();
		expect(host.moveAttribute).not.toHaveBeenCalled();
	});

	it('Escape cancels the drag and stops listening', () => {
		const { outline, host } = setup({ rowAtPoint: () => row('b') });
		outline.startReorder(press(10, 10), 'a');
		dispatch('pointermove', { clientX: 10, clientY: 30 });
		dispatch('keydown', { key: 'Escape' });
		expect(outline.reorder).toBeNull();
		dispatch('pointerup');
		expect(host.moveAttribute).not.toHaveBeenCalled();
	});

	it('an Escape that is not the Escape key does not cancel', () => {
		const { outline } = setup({ rowAtPoint: () => row('b') });
		outline.startReorder(press(10, 10), 'a');
		dispatch('pointermove', { clientX: 10, clientY: 30 });
		dispatch('keydown', { key: 'Enter' });
		expect(outline.reorder?.targetId).toBe('b');
	});

	it('only the primary button starts a drag', () => {
		const { outline } = setup();
		const grip = press(10, 10, { button: 2 } as Partial<PointerEvent>);
		outline.startReorder(grip, 'a');
		expect(grip.preventDefault).not.toHaveBeenCalled();
		expect(outline.reorder).toBeNull();
	});
});

describe('disabled host', () => {
	it('ignores keys, moves, and drags', async () => {
		const { outline, host } = setup({
			disabled: true,
			rowAtPoint: () => ({ id: 'b', top: 0, height: 40 })
		});
		const arrow = key('ArrowDown', onRow('a'));
		await outline.keydown(arrow);
		expect(arrow.preventDefault).not.toHaveBeenCalled();

		await outline.keydown(key('ArrowDown', onRow('b'), { altKey: true }));
		expect(outline.moveAttribute('b', 1)).toBe(false);
		expect(host.moveAttribute).not.toHaveBeenCalled();
		expect(host.focus).not.toHaveBeenCalled();

		outline.startReorder(press(10, 10), 'a');
		expect(outline.reorder).toBeNull();
	});
});
