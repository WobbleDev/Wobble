import { describe, expect, it } from 'vitest';
import { clampPageIndex, paginateGroups } from './agitations-paging.ts';

/**
 * The Agitations card pages whole group columns instead of scrolling them:
 * the helper below slices the matrix's ordered groups into pages. Each
 * expectation below pins an exact page boundary from a worked example,
 * not a recomputation of the implementation.
 */
describe('paginateGroups', () => {
	it('slices exact pages in input order', () => {
		expect(paginateGroups(['a', 'b', 'c', 'd'], 2)).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
	});

	it('keeps a short last page left-aligned with its leftover groups', () => {
		expect(paginateGroups(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
	});

	it('yields one page when every group fits', () => {
		expect(paginateGroups(['a', 'b'], 5)).toEqual([['a', 'b']]);
		expect(paginateGroups(['a'], 1)).toEqual([['a']]);
	});

	it('yields no pages for empty input', () => {
		expect(paginateGroups([], 3)).toEqual([]);
	});

	it('keeps group objects in order without copying them', () => {
		const first = { id: 'cashier' };
		const second = { id: 'stocker' };
		const third = { id: 'no-job' };
		const pages = paginateGroups([first, second, third], 2);
		expect(pages).toEqual([[{ id: 'cashier' }, { id: 'stocker' }], [{ id: 'no-job' }]]);
		expect(pages[0]?.[0]).toBe(first);
		expect(pages[0]?.[1]).toBe(second);
		expect(pages[1]?.[0]).toBe(third);
	});
});

describe('clampPageIndex', () => {
	it('holds an in-range index', () => {
		expect(clampPageIndex(0, 3)).toBe(0);
		expect(clampPageIndex(1, 3)).toBe(1);
		expect(clampPageIndex(2, 3)).toBe(2);
	});

	it('clamps an out-of-range index to the nearest page', () => {
		expect(clampPageIndex(-1, 3)).toBe(0);
		expect(clampPageIndex(-99, 3)).toBe(0);
		expect(clampPageIndex(3, 3)).toBe(2);
		expect(clampPageIndex(99, 3)).toBe(2);
	});

	it('reads back the first position when there are no pages', () => {
		expect(clampPageIndex(0, 0)).toBe(0);
		expect(clampPageIndex(5, 0)).toBe(0);
		expect(clampPageIndex(-2, 0)).toBe(0);
	});
});
