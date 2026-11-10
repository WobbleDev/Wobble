import { chooseShortFormLabels, type ShortFormLabelEntry } from '#lib/shared/short-form-label.ts';
import { GROUP_GAP_PX } from './agitations-paging.svelte.ts';

type HeaderHost = {
	/** Every value of the grouping, whether or not a Worker holds it, so counts never rename one. */
	values: () => readonly ShortFormLabelEntry[];
	locale: () => string;
	allLabel: () => string;
	largestGroup: () => number;
	/** How many columns share a page's width: a lone page's own columns, else a full page's. */
	columnsPerPage: () => number;
};

/** The ten-digit minimum a column's label may take: the width every page count is made at. */
const MINIMUM_BUDGET_SAMPLE = '0000000000';

/**
 * Font measurement and the complete value set stay independent of rendered pages. Columns
 * per page are counted at the ten-digit minimum budget; each page then shares its spare width
 * among its columns and the labels are chosen again against that larger budget, so a label
 * never adds a page.
 */
export function createAgitationsHeaders(host: HeaderHost) {
	let measure = $state<(label: string) => number>((label) => [...label].length);
	let availableWidth = $state(160);
	const minimumBudget = $derived(measure(MINIMUM_BUDGET_SAMPLE));
	const labels = $derived(
		chooseShortFormLabels(host.values(), {
			measure,
			budget: minimumBudget,
			reserved: [host.allLabel()]
		})
	);
	// The rendered header separates the label from its count with a flex gap,
	// not a space character: th px-1 adds 8px around the pair and the inline-flex
	// gap-1 adds 4px between them, hence the 12px chrome beside the measured text.
	const countWidth = $derived(measure(`(${host.largestGroup()})`));
	const width = $derived(Math.max(0, ...[...labels.values()].map(measure)) + countWidth + 12);
	// Every column of a page is as wide as the page's columns share out, whatever it holds.
	const pageBudget = $derived(
		Math.max(
			minimumBudget,
			availableWidth / Math.max(1, host.columnsPerPage()) - GROUP_GAP_PX - countWidth - 12
		)
	);
	const pageLabels = $derived(
		chooseShortFormLabels(host.values(), {
			measure,
			budget: pageBudget,
			reserved: [host.allLabel()]
		})
	);

	function observe(scroller: HTMLElement | undefined): () => void {
		if (!scroller) return () => {};
		const context = document.createElement('canvas').getContext('2d');
		let stopped = false;
		function refresh() {
			if (stopped || !scroller) return;
			const headers = scroller.querySelectorAll(':scope > table thead th');
			const sample = headers[2];
			if (!sample || !context) return;
			const style = getComputedStyle(sample);
			context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			const tracking = parseFloat(style.letterSpacing) || 0;
			const segmenter = new Intl.Segmenter(host.locale(), { granularity: 'grapheme' });
			measure = (label) => {
				const rendered = label.toLocaleUpperCase(host.locale());
				return (
					context.measureText(rendered).width + [...segmenter.segment(rendered)].length * tracking
				);
			};
			const chrome = [...headers]
				.slice(0, 2)
				.reduce((sum, cell) => sum + cell.getBoundingClientRect().width, 0);
			availableWidth = Math.max(1, scroller.clientWidth - chrome - 16);
		}
		refresh();
		void document.fonts.ready.then(refresh);
		const resize = new ResizeObserver(refresh);
		resize.observe(scroller);
		const settings = new MutationObserver(refresh);
		settings.observe(document.documentElement, { attributes: true });
		return () => {
			stopped = true;
			resize.disconnect();
			settings.disconnect();
		};
	}

	return {
		get labels() {
			return labels;
		},
		get pageLabels() {
			return pageLabels;
		},
		get width() {
			return width;
		},
		get availableWidth() {
			return availableWidth;
		},
		observe
	};
}
