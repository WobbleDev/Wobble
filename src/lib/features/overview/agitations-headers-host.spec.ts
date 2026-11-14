import { describe, expect, it } from 'vitest';
import { createAgitationsHeaders } from './agitations-headers.svelte.ts';

const values = [
	{ id: 'front', value: 'Front of House', abbreviation: 'Front of …' },
	{ id: 'maintenance', value: 'Maintenance', abbreviation: 'Maintenan…' },
	{ id: 'customer', value: 'Customer Service North', abbreviation: 'Customer …' },
	{ id: 'kitchen', value: 'Kitchen', abbreviation: 'Kitchen' }
];

function headers(options: { columnsPerPage?: number; largest?: number } = {}) {
	return createAgitationsHeaders({
		values: () => values,
		locale: () => 'en',
		allLabel: () => 'All',
		largestGroup: () => options.largest ?? 9,
		columnsPerPage: () => options.columnsPerPage ?? 4
	});
}

describe('Agitations header host', () => {
	it('counts columns at the ten-digit minimum budget, before any spare width is shared', () => {
		const minimum = headers();
		expect([...minimum.labels.values()]).toEqual([
			'Front of …',
			'Maintenan…',
			'Customer …',
			'Kitchen'
		]);
		// The widest label, the reserved count and the cell chrome set the column minimum.
		expect(minimum.width).toBe(10 + '(9)'.length + 12);
		// The minimum never depends on how many columns a page holds.
		expect(headers({ columnsPerPage: 1 }).width).toBe(minimum.width);
	});

	it('shares the spare width of a page among its columns and chooses the labels again', () => {
		// The pre-measure width is 160: four columns leave 40 each, less the 4px gap, the
		// "(9)" count and the 12px chrome, so a 21-character label still fits and 22 does not.
		const narrow = headers({ columnsPerPage: 4 });
		expect(narrow.pageLabels.get('front')).toBe('Front of House');
		expect(narrow.pageLabels.get('customer')).toBe('Customer …');
		// One column per page gets the whole width, so every full name fits.
		const wide = headers({ columnsPerPage: 1 });
		expect([...wide.pageLabels.values()]).toEqual([
			'Front of House',
			'Maintenance',
			'Customer Service North',
			'Kitchen'
		]);
	});

	it('never lets a label narrower than the minimum budget replace the minimum choice', () => {
		const crowded = headers({ columnsPerPage: 40 });
		expect([...crowded.pageLabels.values()]).toEqual([...crowded.labels.values()]);
	});

	it('reserves the largest count before slicing pages', () => {
		expect(headers({ largest: 1200 }).width).toBe(10 + '(1200)'.length + 12);
		expect(headers().observe(undefined)).toBeTypeOf('function');
	});
});
