import { describe, expect, it } from 'vitest';
import {
	columnWidthsPx,
	namePxFrom,
	workersTableStyleFor
} from './data-table-column-fit.svelte.ts';

describe('columnWidthsPx', () => {
	it('sums rem widths and counts Name by its own pixel width', () => {
		const columns = [
			{ id: 'name' },
			{ id: 'a', width: '10rem', minWidth: '6rem' },
			{ id: 'b', width: '4rem' }
		];
		expect(columnWidthsPx(columns, 200, 16)).toEqual({
			prefPx: 14 * 16 + 200,
			minPx: 10 * 16 + 200
		});
	});

	it('skips columns without a rem width and leaves Name out when it is hidden', () => {
		const columns = [{ id: 'a', width: '5rem' }, { id: 'b', width: '30px' }, { id: 'c' }];
		expect(columnWidthsPx(columns, 200, 10)).toEqual({ prefPx: 50, minPx: 50 });
	});
});

describe('namePxFrom', () => {
	it('prefers the custom property in rem or px, else the fallback', () => {
		expect(namePxFrom('12rem', 5, 16)).toBe(192);
		expect(namePxFrom('180px', 5, 16)).toBe(180);
		expect(namePxFrom('', 5, 16)).toBe(80);
	});
});

describe('workersTableStyleFor', () => {
	it('carries the shrink factor into the style', () => {
		const style = workersTableStyleFor([{ id: 'name' }, { id: 'a', width: '8rem' }], 0.5);
		expect(style).toContain('--workers-table-t: 0.5;');
		expect(style.startsWith('width: ')).toBe(true);
	});
});
