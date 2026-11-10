// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { buildBundlePaths } from './graph-track-paths.ts';
import type { TrackRoute } from './graph-track-corridors.ts';
import type { Point } from './graph-layout.ts';
import { flattenPath } from './graph-shapes.ts';
import { createWorkBudget, WorkExhausted } from './graph-work-budget.ts';

function route(id: string, waypoints: [number, number][]): TrackRoute {
	return {
		id,
		source: `${id}-from`,
		target: `${id}-to`,
		waypoints: waypoints.map(([x, y]) => ({ x, y }))
	};
}

function routesOf(...routes: TrackRoute[]): Map<string, TrackRoute> {
	return new Map(routes.map((r) => [r.id, r]));
}

describe('buildBundlePaths', () => {
	it('puts two ties 10 apart in two lanes 6 apart around their middle line', () => {
		const paths = buildBundlePaths(
			routesOf(
				route('a', [
					[0, 0],
					[300, 0]
				]),
				route('b', [
					[0, 10],
					[300, 10]
				])
			),
			['a', 'b'],
			1,
			createWorkBudget()
		);
		expect(paths?.map((p) => [p.id, p.lane])).toEqual([
			['a', 0],
			['b', 1]
		]);
		const [a, b] = paths!;
		expect(a.waypoints).toEqual([
			{ x: 0, y: 0 },
			{ x: 24, y: 2 },
			{ x: 276, y: 2 },
			{ x: 300, y: 0 }
		]);
		expect(b.waypoints).toEqual([
			{ x: 0, y: 10 },
			{ x: 24, y: 8 },
			{ x: 276, y: 8 },
			{ x: 300, y: 10 }
		]);
		expect(a.d.startsWith('M 0 0')).toBe(true);
		expect(b.d.startsWith('M 0 10')).toBe(true);
	});

	it('keeps the flattened curves 6 apart at mid-run and on their own dots', () => {
		const paths = buildBundlePaths(
			routesOf(
				route('a', [
					[0, 0],
					[300, 0]
				]),
				route('b', [
					[0, 10],
					[300, 10]
				])
			),
			['a', 'b'],
			1,
			createWorkBudget()
		)!;
		const [fa, fb] = paths.map((p) => flattenPath(p.d, 0.25, 64));
		expect(fa?.certified).toBe(true);
		expect(fb?.certified).toBe(true);
		expect(fa!.points[0]).toEqual({ x: 0, y: 0 });
		expect(fa!.points.at(-1)).toEqual({ x: 300, y: 0 });
		expect(fb!.points[0]).toEqual({ x: 0, y: 10 });
		expect(fb!.points.at(-1)).toEqual({ x: 300, y: 10 });
		expect(yAt(fb!.points, 150) - yAt(fa!.points, 150)).toBeCloseTo(6, 6);
	});

	it('lanes three ties converging on one dot in source order, 6 apart', () => {
		const paths = buildBundlePaths(
			routesOf(
				route('p', [
					[0, -12],
					[300, 0]
				]),
				route('q', [
					[0, 0],
					[300, 0]
				]),
				route('r', [
					[0, 12],
					[300, 0]
				])
			),
			['p', 'q', 'r'],
			1,
			createWorkBudget()
		)!;
		expect(paths.map((m) => [m.id, m.lane])).toEqual([
			['p', 0],
			['q', 1],
			['r', 2]
		]);
		for (const member of paths) {
			expect(member.waypoints.at(-1)).toEqual({ x: 300, y: 0 });
		}
		expect(paths.map((m) => m.waypoints[1])).toEqual([
			{ x: 24, y: -6 },
			{ x: 24, y: 0 },
			{ x: 24, y: 6 }
		]);
	});

	it('refuses a pair whose order flips inside the corridor', () => {
		expect(
			buildBundlePaths(
				routesOf(
					route('x', [
						[0, 0],
						[300, 20]
					]),
					route('y', [
						[0, 20],
						[300, 0]
					])
				),
				['x', 'y'],
				1,
				createWorkBudget()
			)
		).toBeUndefined();
	});

	it('drops the one tie that crosses both neighbours and keeps the other two', () => {
		const paths = buildBundlePaths(
			routesOf(
				route('a', [
					[0, 0],
					[300, 0]
				]),
				route('b', [
					[0, 10],
					[300, 10]
				]),
				route('c', [
					[0, -20],
					[300, 40]
				])
			),
			['a', 'b', 'c'],
			1,
			createWorkBudget()
		);
		expect(paths?.map((m) => [m.id, m.lane])).toEqual([
			['a', 0],
			['b', 1]
		]);
	});

	it('runs a route that goes against the corridor from its own dots in route order', () => {
		const paths = buildBundlePaths(
			routesOf(
				route('a', [
					[0, 0],
					[300, 0]
				]),
				route('b', [
					[300, 10],
					[0, 10]
				])
			),
			['a', 'b'],
			1,
			createWorkBudget()
		)!;
		const b = paths[1];
		expect(b.id).toBe('b');
		expect(b.waypoints[0]).toEqual({ x: 300, y: 10 });
		expect(b.waypoints.at(-1)).toEqual({ x: 0, y: 10 });
		expect(b.waypoints.slice(1, -1)).toEqual([
			{ x: 276, y: 8 },
			{ x: 24, y: 8 }
		]);
	});

	it("keeps a bent tie's own leading bends and splices the lane into its longest leg", () => {
		const paths = buildBundlePaths(
			routesOf(
				route('a', [
					[0, 0],
					[30, 0],
					[330, 0]
				]),
				route('b', [
					[0, 10],
					[330, 10]
				])
			),
			['a', 'b'],
			1,
			createWorkBudget()
		)!;
		expect(paths.map((m) => m.lane)).toEqual([0, 1]);
		expect(paths[0].waypoints).toEqual([
			{ x: 0, y: 0 },
			{ x: 30, y: 0 },
			{ x: 54, y: 2 },
			{ x: 306, y: 2 },
			{ x: 330, y: 0 }
		]);
		expect(paths[1].waypoints).toEqual([
			{ x: 0, y: 10 },
			{ x: 30, y: 10 },
			{ x: 54, y: 8 },
			{ x: 306, y: 8 },
			{ x: 330, y: 10 }
		]);
	});

	it('gives the same paths whatever order the members are listed in, and on every call', () => {
		const routes = routesOf(
			route('a', [
				[0, 0],
				[300, 0]
			]),
			route('b', [
				[0, 10],
				[300, 10]
			])
		);
		const forward = buildBundlePaths(routes, ['a', 'b'], 1, createWorkBudget());
		const reverse = buildBundlePaths(routes, ['b', 'a'], 1, createWorkBudget());
		const again = buildBundlePaths(routes, ['a', 'b'], 1, createWorkBudget());
		expect(reverse).toEqual(forward);
		expect(again).toEqual(forward);
	});

	it('throws WorkExhausted rather than returning a partial bundle when routing work runs out', () => {
		const tight = createWorkBudget({ placement: 0, routing: 5, evaluation: 0 });
		expect(() =>
			buildBundlePaths(
				routesOf(
					route('a', [
						[0, 0],
						[300, 0]
					]),
					route('b', [
						[0, 10],
						[300, 10]
					])
				),
				['a', 'b'],
				1,
				tight
			)
		).toThrow(WorkExhausted);
	});

	it('scales every length by the unit: doubled coordinates at unit 2 give doubled lanes', () => {
		const [a, b] = buildBundlePaths(
			routesOf(
				route('a', [
					[0, 0],
					[600, 0]
				]),
				route('b', [
					[0, 20],
					[600, 20]
				])
			),
			['a', 'b'],
			2,
			createWorkBudget()
		)!;
		expect(a.waypoints).toEqual([
			{ x: 0, y: 0 },
			{ x: 48, y: 4 },
			{ x: 552, y: 4 },
			{ x: 600, y: 0 }
		]);
		expect(b.waypoints).toEqual([
			{ x: 0, y: 20 },
			{ x: 48, y: 16 },
			{ x: 552, y: 16 },
			{ x: 600, y: 20 }
		]);
	});

	it('refuses a shared stretch too short to hold both ramps', () => {
		expect(
			buildBundlePaths(
				routesOf(
					route('a', [
						[0, 0],
						[300, 0]
					]),
					route('b', [
						[260, 10],
						[600, 10]
					])
				),
				['a', 'b'],
				1,
				createWorkBudget()
			)
		).toBeUndefined();
	});

	it('refuses a three-way crossing once the larger ids are dropped', () => {
		expect(
			buildBundlePaths(
				routesOf(
					route('x', [
						[0, 0],
						[300, 20]
					]),
					route('y', [
						[0, 20],
						[300, 0]
					]),
					route('z', [
						[0, 8],
						[300, 8]
					])
				),
				['x', 'y', 'z'],
				1,
				createWorkBudget()
			)
		).toBeUndefined();
	});
});

function yAt(points: readonly Point[], x: number): number {
	for (let i = 1; i < points.length; i += 1) {
		const p = points[i - 1];
		const q = points[i];
		if (p.x === q.x) continue;
		if (x < Math.min(p.x, q.x) || x > Math.max(p.x, q.x)) continue;
		return p.y + ((x - p.x) / (q.x - p.x)) * (q.y - p.y);
	}
	throw new Error(`no curve point at x=${x}`);
}
