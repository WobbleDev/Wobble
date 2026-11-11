// @module-tag mapping
import { describe, expect, it } from 'vitest';
import {
	buildObstacleIndex,
	routeRelationships,
	type RouteObstacleSpec
} from './graph-relationship-routing.ts';
import { flattenPath, pointSegmentDistance, polygonRelation } from '../layout/graph-shapes.ts';
import { createWorkBudget, WorkExhausted } from '../layout/graph-work-budget.ts';
import type { Point } from '../layout/graph-layout.ts';

const unit = 1;
const positions = new Map<string, Point>([
	['a', { x: 0, y: 0 }],
	['b', { x: 200, y: 0 }]
]);
const request = [{ id: 'ab', source: 'a', target: 'b' }];

function route(obstacles: RouteObstacleSpec[], regions = new Map<string, string[]>()) {
	const budget = createWorkBudget();
	const index = buildObstacleIndex(obstacles, { unit }, budget);
	return routeRelationships({
		requests: request,
		positions,
		index,
		endpointRegions: regions,
		budget
	}).routes.get('ab')!;
}

const dot = (id: string, x: number, y: number, r = 10): RouteObstacleSpec => ({
	id,
	kind: 'dot',
	worker: id,
	x,
	y,
	r
});

describe('routeRelationships', () => {
	it('leaves a clear tie as the direct segment between its two dots', () => {
		const result = route([dot('far', 100, 90)]);
		expect(result.direct).toBe(true);
		expect(result.d).toBe('M 0 0 L 200 0');
		expect(result.blockers).toEqual([]);
	});

	it('detours around an unrelated dot with exact endpoints and a restrained length', () => {
		const result = route([dot('between', 100, 2)]);
		expect(result.direct).toBe(false);
		expect(result.waypoints[0]).toEqual({ x: 0, y: 0 });
		expect(result.waypoints.at(-1)).toEqual({ x: 200, y: 0 });
		expect(result.length).toBeLessThanOrEqual(1.5 * 200 + 16);
		const flat = flattenPath(result.d, 0.25, 64)!;
		expect(flat.certified).toBe(true);
		expect(flat.points[0]).toEqual({ x: 0, y: 0 });
		expect(flat.points.at(-1)).toEqual({ x: 200, y: 0 });
		for (let i = 1; i < flat.points.length; i += 1) {
			expect(
				pointSegmentDistance({ x: 100, y: 2 }, flat.points[i - 1], flat.points[i])
			).toBeGreaterThan(10);
		}
	});

	it('goes around a dot with one rounded corner, not a wobble along its outline', () => {
		const result = route([dot('between', 100, 2, 14)]);
		expect(result.direct).toBe(false);
		expect((result.d.match(/Q/g) ?? []).length).toBe(1);
		expect(result.waypoints).toHaveLength(3);
	});

	it('keeps the detour deterministic', () => {
		expect(route([dot('between', 100, 2)]).d).toBe(route([dot('between', 100, 2)]).d);
	});

	it('goes around an unrelated region but through its own', () => {
		const wall: RouteObstacleSpec = {
			id: 'wall',
			kind: 'region',
			region: 'W',
			polygon: [
				{ x: 80, y: -40 },
				{ x: 120, y: -40 },
				{ x: 120, y: 40 },
				{ x: 80, y: 40 }
			]
		};
		const around = route([wall]);
		expect(around.direct).toBe(false);
		const flat = flattenPath(around.d, 0.25, 64)!;
		for (let i = 1; i < flat.points.length; i += 1) {
			const a = flat.points[i - 1];
			const b = flat.points[i];
			const inside = (p: Point) => p.x > 80 && p.x < 120 && p.y > -40 && p.y < 40;
			expect(inside({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })).toBe(false);
		}
		const through = route([wall], new Map([['a', ['W']]]));
		expect(through.direct).toBe(true);
	});

	it('does not treat a name belonging to one of its own ends as an obstacle', () => {
		const box = { left: 90, top: -8, right: 110, bottom: 8 };
		expect(route([{ id: 'name:other', kind: 'name', worker: 'other', box }]).direct).toBe(false);
		expect(route([{ id: 'name:a', kind: 'name', worker: 'a', box }]).direct).toBe(true);
	});

	it('records the blocker and keeps the pair drawn when no restrained route exists', () => {
		const wall: RouteObstacleSpec = {
			id: 'wall',
			kind: 'region',
			region: 'W',
			polygon: [
				{ x: 90, y: -300 },
				{ x: 110, y: -300 },
				{ x: 110, y: 300 },
				{ x: 90, y: 300 }
			]
		};
		const result = route([wall]);
		expect(result.direct).toBe(true);
		expect(result.blockers).toEqual(['wall']);
		expect(result.waypoints).toEqual([
			{ x: 0, y: 0 },
			{ x: 200, y: 0 }
		]);
	});

	it('refuses a rounded corner that would enter the obstacle, rounding more gently or not at all', () => {
		// A dot just off a waypoint corner: the corner arc must stay out of it.
		const result = route([dot('between', 100, 0, 20), dot('under', 128, 34, 12)]);
		const flat = flattenPath(result.d, 0.25, 64)!;
		for (const [x, y, r] of [
			[100, 0, 20],
			[128, 34, 12]
		]) {
			for (let i = 1; i < flat.points.length; i += 1) {
				expect(
					pointSegmentDistance({ x, y }, flat.points[i - 1], flat.points[i])
				).toBeGreaterThanOrEqual(r - 0.01);
			}
		}
	});

	it('stops before exceeding its work allowance', () => {
		const budget = createWorkBudget({ placement: 10, routing: 5, evaluation: 10 });
		expect(() => buildObstacleIndex([dot('between', 100, 0)], { unit }, budget)).toThrow(
			WorkExhausted
		);
	});
});

describe('shapes', () => {
	it('reports signed overlap and containment between non-convex polygons', () => {
		const square = (x: number, y: number, size: number) => [
			{ x, y },
			{ x: x + size, y },
			{ x: x + size, y: y + size },
			{ x, y: y + size }
		];
		expect(polygonRelation(square(0, 0, 10), square(20, 0, 10)).overlap).toBe(false);
		expect(polygonRelation(square(0, 0, 10), square(20, 0, 10)).distance).toBeCloseTo(10);
		expect(polygonRelation(square(0, 0, 10), square(5, 5, 10)).overlap).toBe(true);
		expect(polygonRelation(square(0, 0, 40), square(10, 10, 5)).overlap).toBe(true);
	});
});
