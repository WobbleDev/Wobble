// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { fitFloor, fitScale, fitScaleWithHeadings } from './graph-composition-layout.ts';

describe('fitScale', () => {
	const free = { width: 1000, height: 600 };
	const padding = 28 * 2;

	it('fits an extent that needs a scale below the old 0.15 floor', () => {
		const extent = { left: 0, top: 0, right: (free.width - padding) / 0.07, bottom: 100 };
		const scale = fitScale(extent, free);
		expect(scale).toBeCloseTo(0.07, 6);
		expect((extent.right - extent.left) * scale).toBeLessThanOrEqual(free.width - padding + 1e-6);
	});

	it('guards only degenerate extents with the floor', () => {
		const huge = { left: 0, top: 0, right: 1e9, bottom: 1e9 };
		expect(fitScale(huge, free)).toBe(fitFloor);
		expect(fitFloor).toBeLessThan(0.05);
	});
});

describe('fitScaleWithHeadings', () => {
	const free = { width: 1000, height: 600 };
	const hull = { left: 0, top: 0, right: 8000, bottom: 4000 };
	const scale = fitScale(hull, free);

	it('keeps a scale whose headings already fit', () => {
		const inside = [{ left: 100, top: 100, right: 400, bottom: 300 }];
		expect(fitScaleWithHeadings(hull, inside, scale, free)).toBe(scale);
		const slack = [{ left: 0, top: -20, right: 400, bottom: 0 }];
		expect(fitScaleWithHeadings({ ...hull, bottom: 3000 }, slack, scale, free)).toBe(scale);
		expect(fitScaleWithHeadings(hull, [], scale, free)).toBe(scale);
	});

	it('takes the headings overhang out of the free canvas once', () => {
		const below = [{ left: 100, top: 4000, right: 900, bottom: 4000 + 150 / scale }];
		const next = fitScaleWithHeadings(hull, below, scale, free);
		expect(next).toBeLessThan(scale);
		expect(4000 * next + 150).toBeCloseTo(free.height - 56, 6);
	});
});
