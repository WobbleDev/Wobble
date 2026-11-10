import { paginateReadingRows } from './breakdown-paging.ts';
import { createGroupPaging } from './group-paging.svelte.ts';

/** Measures every retained row, including inert off-page rows, at its real width. */
export function createBreakdownPaging(host: { groupingKey: () => string }) {
	let pages = $state<number[][]>([]);
	let ready = $state(false);
	const navigation = createGroupPaging({
		pageCount: () => pages.length,
		groupingKey: host.groupingKey
	});
	function observe(body: HTMLElement | undefined, footer: HTMLElement | undefined) {
		if (!body || !footer) return () => {};
		const rows = [...body.querySelectorAll<HTMLElement>('[data-group-row]')];
		const refresh = () => {
			const next = paginateReadingRows(
				rows.map((row) => row.getBoundingClientRect().height),
				body.clientHeight,
				footer.getBoundingClientRect().height
			);
			if (JSON.stringify(next) !== JSON.stringify(pages)) pages = next;
			ready = true;
		};
		refresh();
		const observer = new ResizeObserver(refresh);
		// The body has a fixed layout budget. Rows and footer retain their natural
		// sizes on every page, so observing them cannot feed paging back into fit.
		for (const element of [body, footer, ...rows]) observer.observe(element);
		return () => observer.disconnect();
	}
	return {
		get pages() {
			return pages;
		},
		get page() {
			return navigation.page;
		},
		get ready() {
			return ready;
		},
		goTo: navigation.goTo,
		syncGrouping: navigation.syncGrouping,
		handleKeydown: navigation.handleKeydown,
		observe
	};
}
