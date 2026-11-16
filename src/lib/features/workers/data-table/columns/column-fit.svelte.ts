/**
 * How the Workers table fits its frame: whether it overflows (and is scrolled to the end),
 * and the shrink factor `--workers-table-t` that squeezes the columns between their
 * minimum and preferred sums. The table component renders the style this builds.
 */
import { tick } from 'svelte';
import {
	NO_GROW_SHARE_REM,
	shrinkFactor,
	workersPreferredWidth,
	workersTableWidth,
	workersVisibleRem
} from './workers-table-width.ts';

/** One visible column, as far as its width is concerned. */
export type FitColumn = {
	id: string;
	width?: string;
	minWidth?: string;
	grow?: boolean;
};

/** What the fit reads from the table. */
export type WorkersColumnFitHost = {
	/** The scroll viewport the table lives in. */
	viewport: () => HTMLElement | null;
	/** The visible leaf columns, left to right. */
	columns: () => readonly FitColumn[];
	/** The Name column's width, in rem, when the viewport names none. */
	nameRem: () => number;
};

/**
 * The preferred and minimum widths of the visible columns, in px. Name is sized by
 * `namePx`; other columns count only when they state a `rem` width.
 */
export function columnWidthsPx(
	columns: readonly FitColumn[],
	namePx: number,
	rootFont: number
): { minPx: number; prefPx: number } {
	let prefRem = 0;
	let minRem = 0;
	let hasName = false;
	for (const column of columns) {
		if (column.id === 'name') {
			hasName = true;
			continue;
		}
		const width = column.width;
		if (!width?.endsWith('rem')) continue;
		const pref = parseFloat(width);
		const min = column.minWidth?.endsWith('rem') ? parseFloat(column.minWidth) : pref;
		prefRem += pref;
		minRem += min;
	}
	return {
		minPx: minRem * rootFont + (hasName ? namePx : 0),
		prefPx: prefRem * rootFont + (hasName ? namePx : 0)
	};
}

/** The Name column's width in px: the viewport's custom property, else the measured fallback. */
export function namePxFrom(rawName: string, fallbackRem: number, rootFont: number): number {
	let namePx = fallbackRem * rootFont;
	if (rawName.endsWith('rem')) namePx = parseFloat(rawName) * rootFont;
	else if (rawName.endsWith('px')) namePx = parseFloat(rawName);
	return namePx;
}

/** The table's inline style: its width, the slack above the preferred sum, and the shrink factor. */
export function workersTableStyleFor(columns: readonly FitColumn[], frameFit: number): string {
	const { contentRem, growRem } = workersVisibleRem(
		columns.map((column) => ({ id: column.id, width: column.width, grow: column.grow }))
	);
	const ids = columns.map((column) => column.id);
	// Spare width is what the frame has beyond the columns' preferred sum;
	// it is shared out by the growing columns, in proportion to their own widths.
	return `width: ${workersTableWidth(ids, contentRem)}; --workers-table-slack: max(0px, calc(100% - ${workersPreferredWidth(ids, contentRem)})); --workers-table-grow-rem: ${growRem || NO_GROW_SHARE_REM}; --workers-table-t: ${frameFit};`;
}

/** Call during component init: it registers effects. */
export function createWorkersColumnFit(host: WorkersColumnFitHost) {
	/**
	 * The table floors at its columns' minimum sum and rests at the preferred
	 * sum; between them the columns shrink with `--workers-table-t` (0..1). Above the
	 * preferred sum the growing columns share the spare width as before.
	 */
	let frameFit = $state(1);
	/** Overflow cues: the table is wider than its frame, and whether it is scrolled to the end. */
	let overflowing = $state(false);
	let scrolledToEnd = $state(true);

	const style = $derived(workersTableStyleFor(host.columns(), frameFit));

	function measureOverflow() {
		const viewport = host.viewport();
		if (!viewport) return;
		const viewportStyle = getComputedStyle(viewport);
		// `scrollWidth` covers the whole padding box, so the scrollbar's gutter counts
		// towards reaching the end even though `clientWidth` leaves it out. Without it a
		// classic scrollbar (macOS "Always", Linux) keeps the fade up at the far right.
		const border =
			(parseFloat(viewportStyle.borderLeftWidth) || 0) +
			(parseFloat(viewportStyle.borderRightWidth) || 0);
		const gutter = Math.max(0, viewport.offsetWidth - viewport.clientWidth - border);
		overflowing = viewport.scrollWidth > viewport.clientWidth + 1;
		scrolledToEnd = viewport.scrollLeft + viewport.clientWidth + gutter >= viewport.scrollWidth - 1;
		const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize);
		if (!(rootFont > 0)) return;
		const rawName = viewportStyle.getPropertyValue('--workers-table-name-w').trim();
		const namePx = namePxFrom(rawName, host.nameRem(), rootFont);
		const { minPx, prefPx } = columnWidthsPx(host.columns(), namePx, rootFont);
		const next = shrinkFactor(viewport.clientWidth, minPx, prefPx);
		if (next !== frameFit) frameFit = next;
	}

	$effect(() => {
		const viewport = host.viewport();
		if (!viewport) return;
		const observer = new ResizeObserver(measureOverflow);
		observer.observe(viewport);
		const tableElement = viewport.querySelector('table');
		if (tableElement) observer.observe(tableElement);
		// Vertical scrolling cannot change either cue, and reading scrollWidth forces layout.
		let lastScrollLeft = viewport.scrollLeft;
		const onScroll = () => {
			if (viewport.scrollLeft === lastScrollLeft) return;
			lastScrollLeft = viewport.scrollLeft;
			measureOverflow();
		};
		viewport.addEventListener('scroll', onScroll, { passive: true });
		measureOverflow();
		return () => {
			observer.disconnect();
			viewport.removeEventListener('scroll', onScroll);
		};
	});

	// A wider preferred sum with the same frame and table width still moves `t`:
	// re-measure when the columns behind it change, not only on resize.
	$effect(() => {
		const widths = host
			.columns()
			.map((column) => column.width)
			.join();
		void widths;
		void host.nameRem();
		void tick().then(measureOverflow);
	});

	return {
		get style() {
			return style;
		},
		get overflowing() {
			return overflowing;
		},
		get scrolledToEnd() {
			return scrolledToEnd;
		}
	};
}
