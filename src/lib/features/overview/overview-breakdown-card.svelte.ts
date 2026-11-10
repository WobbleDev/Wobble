import { groupPageRange } from './agitations-paging.ts';
import { createBreakdownPaging } from './breakdown-paging.svelte.ts';

/**
 * The By Attribute card's page behaviour: the paging factory plus what the card reads
 * from it (the visible range, the visible rows, whether the footer shows). The grouping
 * identity is the Attribute choice plus the group ids, so a data change that keeps the
 * same groups leaves the page where the reader left it.
 */
export interface OverviewBreakdownCardHost {
	attributeId(): string | undefined;
	groupIds(): readonly string[];
}

export function createOverviewBreakdownCard(host: OverviewBreakdownCardHost) {
	const groupingKey = $derived((host.attributeId() ?? '') + '|' + host.groupIds().join(','));
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
			return paging.observe(body, footer);
		}
	};
}
