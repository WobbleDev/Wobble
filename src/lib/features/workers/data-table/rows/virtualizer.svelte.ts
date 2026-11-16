/**
 * The Workers table's row virtualizer: which Worker rows are rendered for the current scroll.
 */
import { get } from 'svelte/store';
import { untrack } from 'svelte';
import { createVirtualizer } from '@tanstack/svelte-virtual';

export type DataTableRenderItem<TRow> = {
	key: string;
	row: TRow;
};

/**
 * Whether a row element needs `measureElement` for `index`. TanStack installs its
 * own ResizeObserver on an element the first time it is measured, so only a new
 * element, or one now rendering a different index, needs another call.
 */
export function shouldMeasure(
	measured: WeakMap<object, number>,
	element: object,
	index: number
): boolean {
	if (measured.get(element) === index) return false;
	measured.set(element, index);
	return true;
}

export function createDataTableVirtualizer<TRow>(
	getItems: () => DataTableRenderItem<TRow>[],
	getScrollElement: () => HTMLElement | null,
	initialCount: number
) {
	const rowElements = $state<Record<number, HTMLTableRowElement | null>>({});
	const measured = new WeakMap<object, number>();

	const rowVirtualizer = createVirtualizer<HTMLElement, HTMLTableRowElement>({
		count: initialCount,
		getScrollElement,
		estimateSize: () => 36,
		getItemKey: (index) => getItems()[index]?.key ?? index,
		overscan: 8
	});
	let virtualizerRevision = $state(0);

	$effect(() => {
		const unsubscribe = rowVirtualizer.subscribe(() => {
			untrack(() => {
				virtualizerRevision += 1;
			});
		});

		return unsubscribe;
	});

	$effect(() => {
		get(rowVirtualizer).setOptions({
			count: getItems().length,
			getScrollElement,
			getItemKey: (index) => getItems()[index]?.key ?? index
		});
	});

	const virtualItems = $derived.by(() => {
		// Touch the revision so the derived re-runs when the virtualizer notifies.
		void virtualizerRevision;
		return get(rowVirtualizer).getVirtualItems();
	});
	const paddingTop = $derived(virtualItems[0]?.start ?? 0);
	const paddingBottom = $derived(
		Math.max(
			0,
			get(rowVirtualizer).getTotalSize() - (virtualItems[virtualItems.length - 1]?.end ?? 0)
		)
	);

	$effect.pre(() => {
		for (const item of virtualItems) {
			if (!Object.hasOwn(rowElements, item.index)) {
				rowElements[item.index] = null;
			}
		}
	});

	$effect(() => {
		const virtualizer = get(rowVirtualizer);
		for (const item of virtualItems) {
			const element = rowElements[item.index];
			if (element && shouldMeasure(measured, element, item.index)) {
				virtualizer.measureElement(element);
			}
		}
	});

	return {
		rowElements,
		/** Brings a render item into the rendered window (and view). */
		scrollToIndex(index: number) {
			if (index >= 0) get(rowVirtualizer).scrollToIndex(index, { align: 'auto' });
		},
		get virtualItems() {
			return virtualItems;
		},
		get paddingTop() {
			return paddingTop;
		},
		get paddingBottom() {
			return paddingBottom;
		}
	};
}
