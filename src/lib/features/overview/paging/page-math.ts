/**
 * The Agitations card's paging arithmetic: how the matrix's ordered group
 * columns become whole-column pages. Pure and DOM-free so the panel reads it
 * instead of recomputing it; asserted in the spec beside this module.
 *
 * Paging slices the presentation, never the matrix arithmetic: order is
 * preserved exactly, a short last page keeps its leftover groups, and empty
 * input yields no pages.
 */

/**
 * Whole group-column pages in input order: each page holds up to `perPage`
 * groups, the last page holding the leftover. Empty input yields no pages;
 * a non-positive count reads as one group per page so every group stays
 * whole and visible.
 */
export function paginateGroups<T>(groups: readonly T[], perPage: number): T[][] {
	const size = Math.floor(perPage) >= 1 ? Math.floor(perPage) : 1;
	const pages: T[][] = [];
	for (let start = 0; start < groups.length; start += size) {
		pages.push(groups.slice(start, start + size));
	}
	return pages;
}

/**
 * The nearest page for a requested index: the first page for anything below
 * it, the last page for anything above it. With no pages there is nowhere
 * to go, so the first position reads back.
 */
export function clampPageIndex(index: number, pageCount: number): number {
	if (!Number.isFinite(pageCount) || pageCount <= 0) return 0;
	if (!Number.isFinite(index)) return 0;
	const last = Math.floor(pageCount) - 1;
	if (index <= 0) return 0;
	if (index >= last) return last;
	return Math.floor(index);
}

/** The visible one-based group range, including a short last page. */
export function groupPageRange(pages: readonly (readonly unknown[])[], page: number) {
	const index = clampPageIndex(page, pages.length);
	const total = pages.reduce((count, groups) => count + groups.length, 0);
	const before = pages.slice(0, index).reduce((count, groups) => count + groups.length, 0);
	return { start: total === 0 ? 0 : before + 1, end: before + (pages[index]?.length ?? 0), total };
}
