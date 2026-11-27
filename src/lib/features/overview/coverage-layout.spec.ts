import { describe, expect, it } from 'vitest';
import {
	coverageLayout,
	GAP_RATIO,
	MAX_DIAMETER,
	MIN_DIAMETER,
	UNIT_MIN_DIAMETER,
	UNIT_SIZES
} from './coverage-layout.ts';

// The Committee card's dot zone at the 1024x640 floor: the third dashboard column,
// under the two fixed header lines (measured in the browser while building this).
const WIDTH = 234;
const HEIGHT = 22;
const zone = (total: number, leaders = total) =>
	coverageLayout({ total, leaders, width: WIDTH, height: HEIGHT });

describe('coverageLayout', () => {
	it('draws a small Committee at 16px in one compact row', () => {
		const layout = zone(3);
		expect(layout.unit).toBe(1);
		expect(layout.diameter).toBe(MAX_DIAMETER);
		expect(layout.rows).toBe(1);
		expect(layout.marks).toHaveLength(3);
		expect(layout.gap).toBeCloseTo(MAX_DIAMETER * GAP_RATIO, 2);
		expect(3 * layout.diameter + 2 * layout.gap).toBeLessThan(WIDTH);
	});

	it('keeps 28 Leaders at 1:1, sweeping down, and fills each full row to the margin', () => {
		const layout = zone(28);
		expect(layout.unit).toBe(1);
		expect(layout.diameter).toBeGreaterThanOrEqual(MIN_DIAMETER);
		expect(layout.diameter).toBeLessThanOrEqual(MAX_DIAMETER);
		expect(layout.rows).toBeGreaterThan(1);
		expect(layout.marks).toHaveLength(28);
		const fullRow = layout.perRow * layout.diameter + (layout.perRow - 1) * layout.gap;
		expect(fullRow).toBeCloseTo(WIDTH, 1);
	});

	it('switches to clean units when 1:1 would fall under the floor, with a partial mark', () => {
		// 275 Leaders against a target of 300 keeps a remainder inside the last unit.
		const layout = zone(300, 275);
		expect(UNIT_SIZES).toContain(layout.unit);
		expect(layout.unit).toBeGreaterThan(1);
		expect(layout.diameter).toBeGreaterThanOrEqual(UNIT_MIN_DIAMETER);
		expect(layout.marks).toHaveLength(Math.ceil(300 / layout.unit));
		expect(layout.marks.filter((mark) => mark.filled >= 1).length).toBeGreaterThan(0);
		expect(layout.marks.filter((mark) => mark.filled > 0 && mark.filled < 1)).toHaveLength(1);
	});

	it('never grows a 1:1 mark as the Committee grows', () => {
		let previous = Infinity;
		for (let total = 1; total <= 46; total += 1) {
			const layout = zone(total);
			if (layout.unit !== 1) continue;
			expect(layout.diameter).toBeLessThanOrEqual(previous);
			previous = layout.diameter;
		}
	});
});
