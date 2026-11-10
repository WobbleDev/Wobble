import { describe, expect, it } from 'vitest';
import { paginateReadingRows } from './breakdown-paging.ts';
import { groupPageRange } from './agitations-paging.ts';

describe('whole-row reading pages', () => {
	it('always reserves the permanent footer, even when every row fits', () => {
		expect(paginateReadingRows([88, 88, 88], 264 + 72, 72)).toEqual([[0, 1, 2]]);
		expect(paginateReadingRows([88, 88, 88], 264, 72)).toEqual([[0, 1], [2]]);
		expect(paginateReadingRows([], 264, 72)).toEqual([]);
	});
	it('reserves the measured footer and keeps a short final page', () => {
		const pages = paginateReadingRows([88, 88, 88, 88, 88], 250, 72);
		expect(pages).toEqual([[0, 1], [2, 3], [4]]);
		expect(groupPageRange(pages, 0)).toEqual({ start: 1, end: 2, total: 5 });
		expect(groupPageRange(pages, 2)).toEqual({ start: 5, end: 5, total: 5 });
	});
	it('accounts for wrapped or enlarged rows, rather than a fixed row count', () => {
		expect(paginateReadingRows([88, 120, 88, 88], 280, 72)).toEqual([
			[0, 1],
			[2, 3]
		]);
		expect(paginateReadingRows([88, 120, 88, 88], 240, 72)).toEqual([[0], [1], [2], [3]]);
	});
	it('keeps every group reachable even with an undersized layout budget', () => {
		expect(paginateReadingRows([120, 120], 100, 72)).toEqual([[0], [1]]);
	});
});

describe('shared group ranges', () => {
	it('counts columns across pages and clamps a stale index after resizing', () => {
		expect(groupPageRange([['a', 'b', 'c'], ['d']], 1)).toEqual({ start: 4, end: 4, total: 4 });
		expect(groupPageRange([['a', 'b', 'c', 'd']], 3)).toEqual({ start: 1, end: 4, total: 4 });
		expect(groupPageRange([], 2)).toEqual({ start: 0, end: 0, total: 0 });
	});
});
