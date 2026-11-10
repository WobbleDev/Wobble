<script lang="ts">
	import { FlexRender, type Row } from '@tanstack/svelte-table';
	import { SvelteMap } from 'svelte/reactivity';
	import * as Table from '#lib/components/ui/table/index.ts';
	import { cn } from '#lib/utils.ts';
	import { columnStyle, pinClass, workersRowClass } from './columns.ts';
	import type { Worker } from '#lib/domain-vocabulary.ts';
	import type { DataTableFeatures } from './data-table-features.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { formatList } from '#lib/i18n/format.ts';

	type Props = {
		row: Row<DataTableFeatures, Worker>;
		virtualIndex: number;
		rowIndex: number;
		/** Selection: a click on the row itself (not a control in it). */
		onSelect: (workerId: string) => void;
		/** A click on the name of the Worker whose record is open closes the panel. */
		onClose: () => void;
		/** Desktop keyboard: Up/Down (-1/+1) move selection and focus to a neighbour. */
		onMove: (
			workerId: string,
			delta: -1 | 1,
			columnId?: string,
			extend?: boolean,
			boundary?: boolean
		) => void;
		/** Space: flip this row's checkbox (gated like a click). */
		onToggle: (workerId: string, checked: boolean) => void;
		/** Checked for a bulk edit: the only selected state. */
		checked: boolean;
		/** The Worker open in the record panel: current, never selected. */
		open: boolean;
		/**
		 * Shell tier and above: the row is part of the keyboard grid and its
		 * cells, not the row, take focus. Below it the row keeps its own Tab stop.
		 */
		grid: boolean;
		/** The column of this row's active cell, or null when another row holds it. */
		activeColumnId: string | null;
		/** A click or focus on a cell makes it the active cell. */
		onActivate: (workerId: string, columnId: string) => void;
		rowRef?: HTMLTableRowElement | null;
	};

	let {
		row,
		virtualIndex,
		rowIndex,
		onSelect,
		onClose,
		onMove,
		onToggle,
		checked,
		open,
		grid,
		activeColumnId,
		onActivate,
		rowRef = $bindable()
	}: Props = $props();

	/** Clicks on the controls inside a row (checkbox, dropdowns, menus) never select it. */
	const CONTROL_SELECTOR =
		'button, a, input, label, [role="checkbox"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="combobox"]';

	/** The grid cell an event happened in. */
	function cellOf(target: EventTarget | null): HTMLElement | null {
		return target instanceof Element ? target.closest<HTMLElement>('td[data-column-id]') : null;
	}

	function onRowClick(event: MouseEvent) {
		const target = event.target;
		const cell = grid ? cellOf(target) : null;
		if (cell) onActivate(row.original.id, cell.dataset.columnId ?? '');
		if (target instanceof Element && target.closest(CONTROL_SELECTOR)) return;
		if (open && target instanceof Element && target.closest('[data-name-cell]')) return onClose();
		onSelect(row.original.id);
	}

	/**
	 * In the grid the controls inside cells are not Tab stops: the cell is the one stop.
	 * They stay clickable. Cells render their controls late and re-render them, so the
	 * rule is re-applied as the row's content changes.
	 */
	const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex="0"]:not(td)';
	function gridControls(enabled: boolean) {
		return (node: HTMLElement) => {
			if (!enabled) return;
			const originalTabindex = new SvelteMap<HTMLElement, string | null>();
			const apply = () => {
				for (const control of node.querySelectorAll<HTMLElement>(FOCUSABLE)) {
					if (!originalTabindex.has(control)) {
						originalTabindex.set(control, control.getAttribute('tabindex'));
					}
					if (control.getAttribute('tabindex') !== '-1') control.setAttribute('tabindex', '-1');
				}
			};
			apply();
			const observer = new MutationObserver(apply);
			observer.observe(node, { childList: true, subtree: true });
			return () => {
				observer.disconnect();
				for (const [control, tabindex] of originalTabindex) {
					if (tabindex === null) control.removeAttribute('tabindex');
					else control.setAttribute('tabindex', tabindex);
				}
			};
		};
	}

	/** Moves the active cell within this row (Left/Right/Home/End). */
	function moveAcross(cell: HTMLElement, key: string) {
		const cells = [
			...(cell.parentElement?.querySelectorAll<HTMLElement>('td[data-column-id]') ?? [])
		];
		const at = cells.indexOf(cell);
		const next =
			key === 'Home'
				? 0
				: key === 'End'
					? cells.length - 1
					: Math.min(Math.max(at + (key === 'ArrowRight' ? 1 : -1), 0), cells.length - 1);
		const target = cells[next];
		if (!target) return;
		onActivate(row.original.id, target.dataset.columnId ?? '');
		target.focus();
		target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	/**
	 * Opens the cell's editor (or the row menu) from the keyboard. The controls are
	 * out of the Tab order, so the trigger is driven with the key a focused one takes.
	 */
	function openEditor(cell: HTMLElement): boolean {
		const trigger = cell.querySelector<HTMLElement>('[aria-haspopup="menu"]:not(:disabled)');
		if (!trigger) return false;
		trigger.focus();
		trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		return true;
	}

	function onRowKeydown(event: KeyboardEvent) {
		// Keys typed inside a control (dropdown, input) belong to that control. In the
		// grid the cell itself is the focus target; below it, the row is.
		if (event.target !== (grid ? cellOf(event.target) : event.currentTarget)) return;
		const cell = grid ? cellOf(event.target) : null;
		const typing =
			event.key.length === 1 &&
			event.key !== ' ' &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey;
		if (
			cell &&
			['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) &&
			!event.metaKey &&
			!event.ctrlKey
		) {
			event.preventDefault();
			moveAcross(cell, event.key);
		} else if (cell && (typing || event.key === 'Enter') && cell.dataset.columnId !== 'name') {
			// Assessment, Language and Attribute cells (and the row menu) open on Enter or
			// a typing key; anywhere else Enter keeps its row meaning below.
			const isEditor = cell.dataset.columnId !== 'selection';
			if (isEditor && openEditor(cell)) event.preventDefault();
			else if (event.key === 'Enter') {
				event.preventDefault();
				onSelect(row.original.id);
			}
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			onMove(
				row.original.id,
				event.key === 'ArrowDown' ? 1 : -1,
				cellOf(event.target)?.dataset.columnId,
				grid && event.shiftKey,
				grid && (event.metaKey || event.ctrlKey)
			);
		} else if (event.key === ' ') {
			event.preventDefault();
			onToggle(row.original.id, !checked);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			onSelect(row.original.id);
		}
	}
</script>

<Table.Row
	bind:ref={rowRef}
	data-index={virtualIndex}
	aria-rowindex={grid ? rowIndex : undefined}
	aria-selected={checked}
	aria-current={open ? 'true' : undefined}
	aria-expanded={grid ? (open ? 'true' : 'false') : undefined}
	aria-controls={grid && open ? `worker-${row.original.id}-details` : undefined}
	data-state={checked ? 'selected' : undefined}
	data-worker-id={row.original.id}
	tabindex={grid ? undefined : 0}
	{@attach gridControls(grid)}
	onclick={onRowClick}
	onkeydown={onRowKeydown}
	class={workersRowClass}
>
	{#each row.getVisibleCells() as cell, columnIndex (cell.id)}
		{@const meta = cell.column.columnDef.meta}
		<Table.Cell
			role={grid ? 'gridcell' : undefined}
			aria-colindex={grid ? columnIndex + 1 : undefined}
			aria-label={grid
				? m.workers_cell_aria({
						field: meta?.label ?? cell.column.id,
						worker: row.original.name,
						value:
							cell.column.id === 'selection'
								? checked
									? m.workers_checked()
									: m.workers_unchecked()
								: (meta?.describeValue?.(cell.getValue()) ??
									(Array.isArray(cell.getValue())
										? formatList(cell.getValue() as string[]) || m.common_none()
										: cell.getValue() || m.common_none()))
					})
				: undefined}
			onfocus={() => grid && onActivate(row.original.id, cell.column.id)}
			data-column-id={cell.column.id}
			tabindex={grid ? (cell.column.id === activeColumnId ? 0 : -1) : undefined}
			data-pin={meta?.pin}
			style={columnStyle(meta)}
			class={cn(
				grid &&
					'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
				meta?.widthClass,
				pinClass(meta),
				cell.column.id === 'selection' && 'py-1 lg:py-0.5',
				// The name is what an organizer scans by, so it carries the row:
				// one weight step over the Attribute values beside it, same size.
				// It truncates in its pinned width; the title carries the whole name.
				cell.column.id === 'name' && 'overflow-hidden py-0.5 font-medium',
				cell.column.id === 'assessment' && 'py-0.5 whitespace-normal'
			)}
		>
			{#if cell.column.id === 'name'}
				<!-- Below the desktop rail the name opens the Worker's sheet. -->
				<!-- Kept raw: the mobile name button truncates inside a table cell; the ui Button nowrap and padding would break that. -->
				<button
					type="button"
					class="block min-h-tap w-full cursor-pointer truncate p-0 text-left lg:hidden"
					aria-haspopup="dialog"
					aria-label={m.workers_show_details({ name: row.original.name })}
					title={row.original.name}
					onclick={() => onSelect(row.original.id)}
				>
					{row.original.name}
				</button>
				<span data-name-cell class="hidden truncate lg:block" title={row.original.name}
					>{row.original.name}</span
				>
			{:else}
				<FlexRender {cell} />
			{/if}
		</Table.Cell>
	{/each}
</Table.Row>
