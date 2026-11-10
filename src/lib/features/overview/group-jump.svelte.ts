import { clampPageIndex } from './agitations-paging.ts';

/** One pager the jump aligns: its own page contents by key, and how to turn to a page. */
export type JumpPager = {
	/** The keys each page shows, in this pager's row order. */
	pages: () => readonly (readonly string[])[];
	goTo: (page: number) => void;
};

/**
 * Jump to group: resolves a group's stable key to a page in each pager
 * (identity, then index in that pager's row order, then goTo). It only turns
 * pages; the grouping, and so every pager's reset-on-grouping-change, is untouched.
 */
export function createGroupJump(host: { pagers: () => JumpPager[] }) {
	let key = $state<string | undefined>();
	/** Returns true when at least one pager holds the group. */
	function jump(next: string): boolean {
		let found = false;
		for (const pager of host.pagers()) {
			const pages = pager.pages();
			const page = pages.findIndex((keys) => keys.includes(next));
			if (page === -1) continue;
			pager.goTo(clampPageIndex(page, pages.length));
			found = true;
		}
		if (found) key = next;
		return found;
	}
	return {
		get key() {
			return key;
		},
		jump
	};
}
