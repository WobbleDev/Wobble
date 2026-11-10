import { describe, expect, it } from 'vitest';
import { MAX_FOCUS_ATTEMPTS, moveTargetIndex, rangeRowIds } from './data-table-keyboard.svelte.ts';

describe('moveTargetIndex', () => {
	it('steps one row up or down', () => {
		expect(moveTargetIndex(2, 1, 5, false)).toBe(3);
		expect(moveTargetIndex(2, -1, 5, false)).toBe(1);
	});

	it('runs off either end as no move', () => {
		expect(moveTargetIndex(0, -1, 5, false)).toBeNull();
		expect(moveTargetIndex(4, 1, 5, false)).toBeNull();
	});

	it('jumps to the first or last row on a boundary move', () => {
		expect(moveTargetIndex(2, 1, 5, true)).toBe(4);
		expect(moveTargetIndex(2, -1, 5, true)).toBe(0);
		expect(moveTargetIndex(4, 1, 5, true)).toBe(4);
	});

	it('finds nothing when the row is not visible or there are no rows', () => {
		expect(moveTargetIndex(-1, 1, 5, false)).toBeNull();
		expect(moveTargetIndex(-1, 1, 5, true)).toBeNull();
		expect(moveTargetIndex(0, 1, 0, true)).toBeNull();
	});
});

describe('rangeRowIds', () => {
	const ids = ['a', 'b', 'c', 'd', 'e'];

	it('covers the anchor through the end, in either direction', () => {
		expect(rangeRowIds(ids, 1, 1, 3)).toEqual(['b', 'c', 'd']);
		expect(rangeRowIds(ids, 3, 3, 1)).toEqual(['b', 'c', 'd']);
	});

	it('starts at the row being left when there is no anchor', () => {
		expect(rangeRowIds(ids, -1, 2, 4)).toEqual(['c', 'd', 'e']);
	});
});

describe('focus retry limit', () => {
	it('gives the virtualised row several frames to mount before giving up', () => {
		expect(MAX_FOCUS_ATTEMPTS).toBe(10);
	});
});
