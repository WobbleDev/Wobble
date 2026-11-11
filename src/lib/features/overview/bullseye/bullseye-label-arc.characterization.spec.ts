/**
 * Pins the half-circle a bullseye ring's name is set on, ahead of splitting bullseye-geometry:
 * where it starts and ends for a given radius and anchor, and that it always bows the same way.
 */
import { describe, expect, it } from 'vitest';
import { CHART_CENTER, labelArcPath } from './bullseye-geometry.ts';

describe('labelArcPath', () => {
	it('runs clockwise as a half circle of the ring radius, ending opposite its start', () => {
		const path = labelArcPath(50, 0);
		// Anchored at 12 o'clock: from 9 o'clock round the top to 3 o'clock.
		expect(path).toBe(
			`M ${CHART_CENTER - 50}.00 ${CHART_CENTER}.00 A 50 50 0 0 1 ${CHART_CENTER + 50}.00 ${CHART_CENTER}.00`
		);
	});

	it('moves with the anchor and keeps the arc flags, so the text reads the right way up', () => {
		const path = labelArcPath(40, 90);
		expect(path).toMatch(/^M [\d.]+ [\d.]+ A 40 40 0 0 1 [\d.]+ [\d.]+$/);
		const [start, end] = [...path.matchAll(/(-?\d+\.\d+) (-?\d+\.\d+)/g)].map((match) => [
			Number(match[1]),
			Number(match[2])
		]);
		// Anchored at 3 o'clock the arc spans 12 to 6 o'clock.
		expect(start).toEqual([CHART_CENTER, CHART_CENTER - 40]);
		expect(end).toEqual([CHART_CENTER, CHART_CENTER + 40]);
	});

	it('uses the standing default anchor when none is given, and grows with the radius', () => {
		expect(labelArcPath(60)).toBe(labelArcPath(60, -44));
		expect(labelArcPath(60)).not.toBe(labelArcPath(70));
	});
});
