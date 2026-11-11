// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type { Point } from './graph-layout.ts';
import { isolateDotGap, separateOverlappingDots } from './isolate-separation.ts';

const gapBetween = (points: Map<string, Point>, radii: Map<string, number>, a: string, b: string) =>
	Math.hypot(points.get(a)!.x - points.get(b)!.x, points.get(a)!.y - points.get(b)!.y) -
	(radii.get(a)! + radii.get(b)!);

const closestGap = (points: Map<string, Point>, radii: Map<string, number>) => {
	const ids = [...points.keys()];
	let closest = Infinity;
	for (const [index, a] of ids.entries()) {
		for (const b of ids.slice(index + 1)) {
			closest = Math.min(closest, gapBetween(points, radii, a, b));
		}
	}
	return closest;
};

describe('separateOverlappingDots', () => {
	it('leaves a set that is already clear exactly as it was', () => {
		const points = new Map<string, Point>([
			['a', { x: 0, y: 0 }],
			['b', { x: 100, y: 0 }]
		]);
		const radii = new Map([
			['a', 4],
			['b', 4]
		]);

		expect(separateOverlappingDots(points, radii)).toEqual(points);
	});

	it('pushes overlapping pairs apart until every edge gap reaches the clearance', () => {
		const points = new Map<string, Point>([
			['a', { x: 0, y: 0 }],
			['b', { x: 5, y: 0 }],
			['c', { x: 0, y: 6 }]
		]);
		const radii = new Map([
			['a', 10],
			['b', 10],
			['c', 10]
		]);

		const separated = separateOverlappingDots(points, radii);

		expect(closestGap(separated, radii)).toBeGreaterThanOrEqual(isolateDotGap);
	});

	it('is deterministic: the same input always separates to the same positions', () => {
		const points = new Map<string, Point>([
			['a', { x: 0, y: 0 }],
			['b', { x: 3, y: 1 }],
			['c', { x: 1, y: 2 }]
		]);
		const radii = new Map([
			['a', 8],
			['b', 8],
			['c', 8]
		]);

		expect(separateOverlappingDots(points, radii)).toEqual(separateOverlappingDots(points, radii));
	});

	it('separates coincident dots along a fixed direction', () => {
		const points = new Map<string, Point>([
			['a', { x: 50, y: 50 }],
			['b', { x: 50, y: 50 }]
		]);
		const radii = new Map([
			['a', 4],
			['b', 4]
		]);

		const separated = separateOverlappingDots(points, radii);

		expect(closestGap(separated, radii)).toBeGreaterThanOrEqual(isolateDotGap);
		expect(separated.get('a')!.y).toBe(separated.get('b')!.y);
	});

	it('takes an omitted radius as zero, so only the clearance separates dots', () => {
		const points = new Map<string, Point>([
			['a', { x: 0, y: 0 }],
			['b', { x: 1, y: 0 }]
		]);

		const separated = separateOverlappingDots(points, new Map());

		expect(separated.get('b')!.x - separated.get('a')!.x).toBeGreaterThanOrEqual(isolateDotGap);
	});
});
