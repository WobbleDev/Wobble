import { describe, expect, it } from 'vitest';
import { mapEmptyKind, mapScope } from './map-scope.ts';

const base = { total: 5, layoutCount: 5, visibleCount: 5, isolatedInEffect: false };

describe('mapEmptyKind', () => {
	it('names an empty Worksite first, whatever else holds', () => {
		expect(
			mapEmptyKind({ total: 0, layoutCount: 0, visibleCount: 0, isolatedInEffect: true })
		).toBe('worksite');
	});

	it('names filter exclusion when the filters leave nobody, even under Isolate', () => {
		expect(mapEmptyKind({ ...base, layoutCount: 0, visibleCount: 0 })).toBe('filters');
		expect(mapEmptyKind({ ...base, layoutCount: 0, visibleCount: 0, isolatedInEffect: true })).toBe(
			'filters'
		);
	});

	it('names an empty Isolate only for Isolate with a non-empty layout and nobody drawn', () => {
		expect(mapEmptyKind({ ...base, visibleCount: 0, isolatedInEffect: true })).toBe('isolate');
		expect(mapEmptyKind({ ...base, visibleCount: 1, isolatedInEffect: true })).toBeUndefined();
		expect(mapEmptyKind({ ...base, visibleCount: 0 })).toBeUndefined();
	});

	it('is not empty for a single isolated dot with no Relationships', () => {
		expect(mapEmptyKind({ ...base, visibleCount: 1, isolatedInEffect: true })).toBeUndefined();
	});
});

describe('mapScope', () => {
	it('counts hidden and isolated-away separately', () => {
		expect(
			mapScope({ total: 10, layoutCount: 7, visibleCount: 3, isolatedInEffect: true })
		).toEqual({
			total: 10,
			drawn: 7,
			listed: 3,
			hidden: 3,
			isolatedAway: 4
		});
	});

	it('has one count when nothing narrows', () => {
		expect(mapScope(base)).toMatchObject({ hidden: 0, isolatedAway: 0, drawn: 5, listed: 5 });
	});
});
