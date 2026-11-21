import { groupPageRange } from './paging/page-math.ts';
import { createBreakdownPaging } from './paging/breakdown-card.svelte.ts';

/**
 * The By Attribute card's page behaviour: the paging factory plus what the card reads
 * from it (the visible range, the visible rows, whether the footer shows). The grouping
 * identity is the Attribute choice plus the ids of its unexpanded groups, so a data
 * change that keeps the same groups leaves the page where the reader left it, and
 * opening or closing a branch in place does not send the reader back to the first page.
 * The rows themselves are what the pager measures, so it re-measures when they change.
 */
export interface OverviewBreakdownCardHost {
	attributeId(): string | undefined;
	/** The unexpanded groups' ids: the identity of the reading, whatever is open. */
	groupIds(): readonly string[];
	/** The displayed rows' keys, branches open or not. */
	rowKeys(): readonly string[];
}

export function createOverviewBreakdownCard(host: OverviewBreakdownCardHost) {
	const groupingKey = $derived((host.attributeId() ?? '') + '|' + host.groupIds().join(','));
	const rowsKey = $derived(host.rowKeys().join(','));
	const paging = createBreakdownPaging({ groupingKey: () => groupingKey });
	const range = $derived(groupPageRange(paging.pages, paging.page));
	const visibleRows = $derived(paging.pages[paging.page] ?? []);
	/* The footer stays once measured while groups remain: a single page reads its
	   own range with both turns disabled, so the note always matches what is shown. */
	const showFooter = $derived(paging.ready && range.total > 0);

	return {
		paging,
		get groupingKey() {
			return groupingKey;
		},
		get range() {
			return range;
		},
		get visibleRows() {
			return visibleRows;
		},
		get showFooter() {
			return showFooter;
		},
		syncGrouping: () => paging.syncGrouping(),
		observe: (body: HTMLElement | undefined, footer: HTMLElement | undefined) => {
			void groupingKey;
			void rowsKey;
			return paging.observe(body, footer);
		}
	};
}
