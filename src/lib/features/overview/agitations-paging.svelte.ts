import { createGroupPaging } from './group-paging.svelte.ts';

/**
 * The Agitations card's page behaviour: which whole-group page shows, how many
 * whole group columns fit the card, and when the card has measured them. The
 * route mounts this beside its matrix derivation and keeps only the element
 * bindings and the render; pure slicing stays in agitations-paging.ts.
 *
 * Paging slices the presentation, never the matrix arithmetic: the page resets
 * to the first one only when the grouping identity changes, and the per-page
 * count is measured from whole rendered columns so no column is ever half-cut.
 */

/**
 * The horizontal gap each matrix column adds beside its measured width. It
 * matches the table's border-spacing-x-1 cell spacing (0.25rem), so the fit
 * count agrees with the rendered grid instead of drifting from it.
 */
export const GROUP_GAP_PX = 4;

/** What the page behaviour reads from the route that mounts it. */
export type AgitationsPagingHost = {
	/** How many whole-group pages the current matrix slices into. */
	pageCount: () => number;
	/** The grouping identity the pages slice: attribute id plus row answer ids. */
	groupingKey: () => string;
};

/**
 * The card's page behaviour, specced through its factory with a literal host.
 * The route wires observe() from a single measure effect and handleKeydown
 * from the card section element; syncGrouping() from a single reset effect.
 */
export function createAgitationsPaging(host: AgitationsPagingHost) {
	const navigation = createGroupPaging(host);
	// The pre-measure default: a plausible run of whole columns before the first
	// measurement settles it. The page controls stay hidden until ready, so no
	// reader ever sees this transient split.
	let groupsPerPage = $state(4);
	let ready = $state(false);

	/**
	 * How many whole group columns fit beside the pinned All column, measured
	 * from the rendered header: the scroller's width less the row-name and All
	 * columns, divided by one rendered group column plus its gap. Unmeasurable
	 * input reads back the current count instead of collapsing the matrix.
	 */
	function measure(scroller: HTMLElement): number {
		const headers = [...scroller.querySelectorAll(':scope > table thead th')];
		const [, all, ...groupCells] = headers;
		const rowName = scroller.querySelector('tbody th');
		const groupWidth =
			groupCells.length > 0
				? Math.max(
						...groupCells.map(
							(cell) =>
								parseFloat(
									typeof getComputedStyle === 'function' ? getComputedStyle(cell).minWidth : ''
								) || cell.getBoundingClientRect().width
						)
					)
				: 0;
		if (groupWidth <= 0) return groupsPerPage;
		const chrome =
			(rowName?.getBoundingClientRect().width ?? 0) +
			(all?.getBoundingClientRect().width ?? 0) +
			GROUP_GAP_PX * 2;
		return Math.max(
			1,
			Math.floor((scroller.clientWidth - chrome + GROUP_GAP_PX) / (groupWidth + GROUP_GAP_PX))
		);
	}

	/** Settle the per-page count from the rendered columns; marks ready. */
	function refresh(scroller: HTMLElement | undefined): void {
		if (!scroller) return;
		const next = measure(scroller);
		if (next !== groupsPerPage) groupsPerPage = next;
		if (!ready) ready = true;
	}

	/**
	 * Measure at once, then re-measure whenever the card resizes. Only the
	 * scroller is watched, never the table: the table is the content the fit
	 * sizes, so watching it feeds each rendered page back into another fit
	 * write until the framework trips its update-depth guard. The scroller is
	 * layout-fixed (flex fill under a rem max-height), so scroller-only
	 * observation cannot loop. Data-driven width changes re-settle through the
	 * grouping-key effect and through route remounts instead.
	 */
	function observe(scroller: HTMLElement | undefined): () => void {
		refresh(scroller);
		if (!scroller || typeof ResizeObserver === 'undefined') return () => {};
		const update = () => refresh(scroller);
		const observer = new ResizeObserver(update);
		observer.observe(scroller);
		return () => observer.disconnect();
	}

	return {
		get page() {
			return navigation.page;
		},
		get groupsPerPage() {
			return groupsPerPage;
		},
		get ready() {
			return ready;
		},
		goTo: navigation.goTo,
		syncGrouping: navigation.syncGrouping,
		handleKeydown: navigation.handleKeydown,
		measure,
		refresh,
		observe
	};
}
