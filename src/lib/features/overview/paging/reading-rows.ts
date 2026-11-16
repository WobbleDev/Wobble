/** Whole-row pages, always reserving the permanent footer. */
export function paginateReadingRows(
	heights: readonly number[],
	available: number,
	footer: number
): number[][] {
	if (heights.length === 0) return [];
	const all = heights.map((_, index) => index);
	const budget = Math.max(0, available - footer);
	if (heights.reduce((sum, height) => sum + height, 0) <= budget) return [all];
	const pages: number[][] = [];
	let page: number[] = [];
	let used = 0;
	for (const [index, height] of heights.entries()) {
		if (page.length > 0 && used + height > budget) {
			pages.push(page);
			page = [];
			used = 0;
		}
		page.push(index);
		used += height;
	}
	pages.push(page);
	return pages;
}
