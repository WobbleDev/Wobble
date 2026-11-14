/**
 * The Configuration outline's tree behaviour: roving focus, arrow, Home and End
 * navigation, fold and unfold, Alt+Arrow and pointer reorder of Attributes, and the
 * Enter, F2 and Delete activations. This module holds no DOM queries. The host reports
 * the visible rows and performs the focus, click and hit-test the behaviour asks for;
 * events arrive as arguments, as they do in map-drag.svelte.ts.
 */
import { m } from '#lib/paraglide/messages.js';

/** One visible row of the outline, as the DOM shows it. */
export type OutlineRow = {
	id: string;
	level: number;
	parentId: string | null;
	expandable: boolean;
	expanded: boolean;
};

/** What the tree reads from the editor and asks the editor to do. */
export type OutlineTreeHost = {
	/** Visible rows in document order. */
	rows: () => OutlineRow[];
	/** Moves browser focus to a row's own element. */
	focus: (id: string) => void;
	toggleExpanded: (id: string) => void;
	/** Moves an Attribute one place; true when it moved. */
	moveAttribute: (id: string, direction: -1 | 1) => boolean;
	/** The Attribute's trimmed name; empty when it has none. */
	attributeName: (id: string) => string;
	/** Clicks the row's own edit or remove control; true when that control was present and enabled. */
	activate: (id: string, action: 'edit' | 'remove' | 'abbreviation') => boolean;
	/** The top-level row under a point, with its box, for dropping an Attribute. */
	rowAtPoint: (x: number, y: number) => { id: string; top: number; height: number } | null;
	/** The id of the row whose own element is the target; null for a control inside a row or any other target. */
	rowOwnedBy: (target: EventTarget | null) => string | null;
	disabled: () => boolean;
	/** Resolves once the editor has rendered the latest state. */
	afterUpdate: () => Promise<void>;
};

/** The keyboard fields the tree reads; a KeyboardEvent satisfies it. */
export type OutlineKey = Pick<
	KeyboardEvent,
	'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'preventDefault' | 'target'
>;

/** The pointer fields a reorder grip reads; a PointerEvent satisfies it. */
export type OutlinePress = Pick<PointerEvent, 'button' | 'clientX' | 'clientY' | 'preventDefault'>;

/** The Attribute being dragged by its handle: where it would land, and the pointer for the ghost. */
export type OutlineReorder = {
	id: string;
	targetId: string | null;
	after: boolean;
	x: number;
	y: number;
};

export function createOutlineTree(host: OutlineTreeHost) {
	/** The row the column's tab stop sits on; null means the first visible row. */
	let focusedRowId = $state<string | null>(null);
	/** The last Attribute reordering, announced so a keyboard move is not silent. */
	let announcement = $state('');
	let reorder = $state<OutlineReorder | null>(null);

	function focusRow(id: string): void {
		if (!host.rows().some((row) => row.id === id)) return;
		focusedRowId = id;
		host.focus(id);
	}

	/** Reorders one Attribute and keeps the row's focus; announces the result. */
	function moveAttribute(id: string, direction: -1 | 1): boolean {
		if (host.disabled() || !host.moveAttribute(id, direction)) return false;
		const name = host.attributeName(id) || m.configuration_attribute_fallback();
		announcement =
			direction < 0
				? m.configuration_attribute_moved_up({ name })
				: m.configuration_attribute_moved_down({ name });
		void host.afterUpdate().then(() => focusRow(id));
		return true;
	}

	/** Moves one Attribute to the drop point, one place at a time so every step is announced. */
	function dropAttribute(id: string, targetId: string, after: boolean): void {
		const ids = host
			.rows()
			.filter((row) => row.level === 1)
			.map((row) => row.id);
		const from = ids.indexOf(id);
		const rest = ids.filter((candidate) => candidate !== id);
		const destination = rest.indexOf(targetId) + (after ? 1 : 0);
		for (let step = destination - from; step !== 0; step -= Math.sign(step)) {
			moveAttribute(id, step > 0 ? 1 : -1);
		}
	}

	/** A press on an Attribute's handle arms a drop; the release commits it, Escape or a cancel drops it. */
	function startReorder(event: OutlinePress, id: string): void {
		if (host.disabled() || event.button !== 0) return;
		event.preventDefault();
		reorder = { id, targetId: null, after: false, x: event.clientX, y: event.clientY };
		const move = (next: PointerEvent) => {
			const row = host.rowAtPoint(next.clientX, next.clientY);
			const targetId = row?.id;
			reorder = {
				id,
				targetId: targetId && targetId !== id ? targetId : null,
				after: row ? next.clientY > row.top + row.height / 2 : false,
				x: next.clientX,
				y: next.clientY
			};
		};
		const finish = (commit: boolean) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', cancel);
			window.removeEventListener('keydown', escape);
			const drop = reorder;
			reorder = null;
			if (commit && drop?.targetId) dropAttribute(id, drop.targetId, drop.after);
		};
		const up = () => finish(true);
		const cancel = () => finish(false);
		const escape = (key: KeyboardEvent) => {
			if (key.key === 'Escape') finish(false);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', cancel);
		window.addEventListener('keydown', escape);
	}

	/** Folds or unfolds a row and then takes focus to the row it leads to. */
	async function toggleThenFocus(row: OutlineRow, focusId: string): Promise<void> {
		host.toggleExpanded(row.id);
		await host.afterUpdate();
		focusRow(focusId);
	}

	/** Keys on a row itself: the row's own controls keep their keys, and Alt+Arrow reorders Attributes. */
	async function keydown(event: OutlineKey): Promise<void> {
		if (host.disabled()) return;
		const rowId = host.rowOwnedBy(event.target);
		if (!rowId) return;
		const rows = host.rows();
		const index = rows.findIndex((row) => row.id === rowId);
		const row = rows[index];
		if (!row) return;
		// Alt+Arrow reorders the Attribute rows themselves; an answer row keeps its keys.
		if (event.altKey && row.level === 1) {
			if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
			event.preventDefault();
			moveAttribute(rowId, event.key === 'ArrowUp' ? -1 : 1);
			return;
		}
		if (event.altKey || event.ctrlKey || event.metaKey) return;

		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				focusRow(rows[Math.min(index + 1, rows.length - 1)].id);
				return;
			case 'ArrowUp':
				event.preventDefault();
				focusRow(rows[Math.max(index - 1, 0)].id);
				return;
			case 'ArrowRight': {
				event.preventDefault();
				if (!row.expandable) return;
				if (!row.expanded) {
					await toggleThenFocus(row, rowId);
					return;
				}
				const child = host.rows().find((candidate) => candidate.parentId === rowId);
				if (child) focusRow(child.id);
				return;
			}
			case 'ArrowLeft': {
				event.preventDefault();
				if (row.expandable && row.expanded) {
					await toggleThenFocus(row, rowId);
					return;
				}
				if (row.parentId) focusRow(row.parentId);
				return;
			}
			case 'Home':
				event.preventDefault();
				focusRow(rows[0].id);
				return;
			case 'End':
				event.preventDefault();
				focusRow(rows[rows.length - 1].id);
				return;
			case 'Enter':
			case 'F2':
				// Shift+F2 goes to the row's Abbreviation field; Enter and F2 edit its name.
				if (event.key === 'F2' && event.shiftKey) {
					if (host.activate(rowId, 'abbreviation')) event.preventDefault();
					return;
				}
				if (host.activate(rowId, 'edit')) event.preventDefault();
				return;
			case 'Delete': {
				if (!host.activate(rowId, 'remove')) return;
				event.preventDefault();
				await host.afterUpdate();
				// A removed row takes its focus with it; land on the row that took its place.
				if (host.rows().some((candidate) => candidate.id === rowId)) return;
				const remaining = host.rows();
				if (remaining.length) focusRow(remaining[Math.min(index, remaining.length - 1)].id);
				return;
			}
			default:
				return;
		}
	}

	return {
		/** The row that holds the tab stop, or null when the first row does. */
		get focusedRowId() {
			return focusedRowId;
		},
		/** The last Attribute move, as it is announced. */
		get announcement() {
			return announcement;
		},
		/** The Attribute drag in progress, for the drop line and the ghost. */
		get reorder() {
			return reorder;
		},
		keydown,
		startReorder,
		moveAttribute,
		/** A row took browser focus: it becomes the tab stop. */
		focusIn(id: string): void {
			focusedRowId = id;
		},
		/** Clears the tab stop when its row is no longer visible; the editor calls this after a change. */
		reconcile(): void {
			if (focusedRowId && !host.rows().some((row) => row.id === focusedRowId)) focusedRowId = null;
		}
	};
}

export type OutlineTree = ReturnType<typeof createOutlineTree>;
