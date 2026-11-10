import { tick } from 'svelte';
import { clampPageIndex } from './agitations-paging.ts';

/**
 * A page turn that disables the button it was made with would drop focus to the page body
 * (the browser clears focus from a disabled control on the next frame). Focus moves to the
 * pager's other button, which the turn has just made the way back: Previous after the last
 * turn forward, Next after the first turn back.
 */
export function refocusDisabledTurn(turned: Element | null | undefined): void {
	if (!turned?.isConnected || !turned.matches(':disabled')) return;
	turned
		.closest('[data-group-pager]')
		?.querySelector<HTMLElement>('button:not(:disabled)')
		?.focus();
}

/** Local, independent navigation shared by the two group readings. */
export function createGroupPaging(host: { pageCount: () => number; groupingKey: () => string }) {
	let page = $state(0);
	let lastGroupingKey: string | undefined;
	/** `turned` is the pager button that made the turn, when a button did. */
	function goTo(next: number, turned?: Element | null) {
		page = clampPageIndex(next, host.pageCount());
		if (turned) void tick().then(() => refocusDisabledTurn(turned));
	}
	function syncGrouping() {
		const key = host.groupingKey();
		if (lastGroupingKey !== undefined && key !== lastGroupingKey) page = 0;
		lastGroupingKey = key;
	}
	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		if (event.defaultPrevented || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
			return;
		const element = event.target as Element | null;
		if (element?.closest?.('input,textarea,select,[contenteditable=true],[role=combobox]')) return;
		if (host.pageCount() <= 1) return;
		event.preventDefault();
		const card = element?.closest?.('section');
		goTo(clampPageIndex(page, host.pageCount()) + (event.key === 'ArrowRight' ? 1 : -1));
		void tick().then(() => {
			// A page turn can remove a cell or make a retained row inert.
			if (card && element && (!element.isConnected || element.closest('[inert]')))
				card.querySelector<HTMLElement>('[data-group-pager] button:not(:disabled)')?.focus();
		});
	}
	return {
		get page() {
			return clampPageIndex(page, host.pageCount());
		},
		goTo,
		syncGrouping,
		handleKeydown
	};
}
