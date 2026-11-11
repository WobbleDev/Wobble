// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { applyTracks, type TrackMetrics, type TrackStage } from './graph-relationship-tracks.ts';
import {
	buildObstacleIndex,
	routeRelationships,
	type Route,
	type RouteRequest
} from './graph-relationship-routing.ts';
import {
	compositionWorkLimits,
	createWorkBudget,
	WorkExhausted
} from '../layout/graph-work-budget.ts';
import { evaluateDrawing } from '../layout/graph-layout-quality.ts';
import { flattenPath, type Box } from '../layout/graph-shapes.ts';
import type { Point } from '../layout/graph-layout.ts';

function straight(id: string, from: [number, number], to: [number, number]): Route {
	const waypoints = [
		{ x: from[0], y: from[1] },
		{ x: to[0], y: to[1] }
	];
	return {
		id,
		source: `${id}-from`,
		target: `${id}-to`,
		d: `M ${from[0]} ${from[1]} L ${to[0]} ${to[1]}`,
		waypoints,
		length: Math.hypot(to[0] - from[0], to[1] - from[1]),
		direct: true,
		blockers: []
	};
}

function permissive(routes: ReadonlyMap<string, Route>): TrackMetrics {
	return {
		properCrossings: 0,
		shallowCrossings: 0,
		conflicts: new Set(),
		invalidRoutes: new Set(),
		lengths: new Map([...routes].map(([id, route]) => [id, route.length]))
	};
}

/** Permissive metrics for the untracked set; `change` applies only once a route carries a track. */
function gated(change: (metrics: TrackMetrics) => TrackMetrics): TrackStage['measure'] {
	return (routes) => {
		const metrics = permissive(routes);
		const tracked = [...routes.values()].some((route) => route.track);
		return tracked ? change(metrics) : metrics;
	};
}

function stageOf(routes: Route[], overrides: Partial<TrackStage> = {}): TrackStage {
	return {
		routes: new Map(routes.map((route) => [route.id, route])),
		unit: 1,
		budget: createWorkBudget(),
		validate: () => true,
		measure: permissive,
		...overrides
	};
}

describe('applyTracks', () => {
	it('moves two parallel ties onto two lanes without mutating the input', () => {
		const stage = stageOf([straight('a', [0, 0], [300, 0]), straight('b', [0, 10], [300, 10])]);
		const before = structuredClone([...stage.routes]);

		const result = applyTracks(stage);

		expect(result.get('a')?.track).toEqual({ bundle: 'a', lane: 0 });
		expect(result.get('b')?.track).toEqual({ bundle: 'a', lane: 1 });
		for (const id of ['a', 'b']) {
			const route = result.get(id)!;
			expect(route.direct).toBe(false);
			expect(route.source).toBe(`${id}-from`);
			expect(route.target).toBe(`${id}-to`);
			const from = stage.routes.get(id)!.waypoints[0];
			const to = stage.routes.get(id)!.waypoints.at(-1);
			expect(route.waypoints[0]).toEqual(from);
			expect(route.waypoints.at(-1)).toEqual(to);
		}
		expect(structuredClone([...stage.routes])).toEqual(before);
	});

	it('drops a member whose curve fails validation and lanes the rest six apart', () => {
		const a = straight('a', [0, 0], [300, 0]);
		const b = straight('b', [0, 10], [300, 10]);
		const c = straight('c', [0, 20], [300, 20]);
		const stage = stageOf([a, b, c], {
			validate: (id) => id !== 'b'
		});

		const result = applyTracks(stage);

		expect(result.get('b')).toBe(b);
		const laneA = result.get('a')!;
		const laneC = result.get('c')!;
		expect([laneA.track?.lane, laneC.track?.lane]).toEqual([0, 1]);
		expect(Math.abs(laneC.waypoints[1].y - laneA.waypoints[1].y)).toBe(6);
	});

	it('returns the original map when a pair loses a member to validation', () => {
		const stage = stageOf([straight('a', [0, 0], [300, 0]), straight('b', [0, 10], [300, 10])], {
			validate: (id) => id !== 'b'
		});

		expect(applyTracks(stage)).toBe(stage.routes);
	});

	it('keeps an earlier bundle and rejects only the later one that fails its gate', () => {
		const stage = stageOf(
			[
				straight('a', [0, 0], [300, 0]),
				straight('b', [0, 10], [300, 10]),
				straight('c', [0, 500], [300, 500]),
				straight('d', [0, 510], [300, 510])
			],
			{
				measure: (routes) => {
					const metrics = permissive(routes);
					const second = ['c', 'd'].some((id) => routes.get(id)?.track);
					return second ? { ...metrics, properCrossings: 1 } : metrics;
				}
			}
		);
		const original = new Map(stage.routes);

		const result = applyTracks(stage);

		expect([result.get('a')?.track?.bundle, result.get('b')?.track?.bundle]).toEqual(['a', 'a']);
		expect(result.get('c')).toBe(original.get('c'));
		expect(result.get('d')).toBe(original.get('d'));
	});

	type Pair = [string, [number, number], [number, number], [number, number], [number, number]];
	const outOfScope: Pair[] = [
		['shorter than 120', [0, 0], [100, 0], [0, 10], [100, 10]],
		['60 apart', [0, 0], [300, 0], [0, 60], [300, 60]]
	];
	it.each(outOfScope)('leaves ties %s alone', (_name, a0, a1, b0, b1) => {
		const stage = stageOf([straight('a', a0, a1), straight('b', b0, b1)]);

		expect(applyTracks(stage)).toBe(stage.routes);
	});

	it('leaves a tie with blockers out of its bundle', () => {
		const blocked = { ...straight('b', [0, 10], [300, 10]), blockers: ['worker-x'] };
		const stage = stageOf([straight('a', [0, 0], [300, 0]), blocked]);

		expect(applyTracks(stage)).toBe(stage.routes);
	});

	it('does not measure when there is no bundle', () => {
		const stage = stageOf([straight('a', [0, 0], [300, 0]), straight('b', [0, 60], [300, 60])], {
			measure: () => {
				throw new Error('measure should not run without a bundle');
			}
		});

		expect(applyTracks(stage)).toBe(stage.routes);
	});

	it('gives identical paths for equal input in either insertion order', () => {
		const routes = () => [
			straight('a', [0, 0], [300, 0]),
			straight('b', [0, 10], [300, 10]),
			straight('c', [0, 20], [300, 20])
		];
		const paths = (map: Map<string, Route>) =>
			Object.fromEntries([...map].map(([id, route]) => [id, route.d]));

		const first = paths(applyTracks(stageOf(routes())));
		const again = paths(applyTracks(stageOf(routes())));
		const reversed = paths(applyTracks(stageOf(routes().reverse())));

		expect(first.a).not.toBe('M 0 0 L 300 0');
		expect(again).toEqual(first);
		expect(reversed).toEqual(first);
	});

	describe('work allowance', () => {
		it('returns the original map when the routing allowance runs out', () => {
			const stage = stageOf([straight('a', [0, 0], [300, 0]), straight('b', [0, 10], [300, 10])], {
				budget: createWorkBudget({ ...compositionWorkLimits, routing: 5 })
			});

			expect(applyTracks(stage)).toBe(stage.routes);
		});

		it('returns the original map when measuring exhausts the allowance', () => {
			const stage = stageOf([straight('a', [0, 0], [300, 0]), straight('b', [0, 10], [300, 10])], {
				measure: () => {
					throw new WorkExhausted('routing');
				}
			});

			expect(applyTracks(stage)).toBe(stage.routes);
		});

		it('rethrows any other error', () => {
			const stage = stageOf([straight('a', [0, 0], [300, 0]), straight('b', [0, 10], [300, 10])], {
				measure: () => {
					throw new Error('boom');
				}
			});

			expect(() => applyTracks(stage)).toThrow('boom');
		});
	});

	describe('acceptance gates', () => {
		const worse: [string, (metrics: TrackMetrics) => TrackMetrics][] = [
			['another proper crossing', (m) => ({ ...m, properCrossings: m.properCrossings + 1 })],
			['another shallow crossing', (m) => ({ ...m, shallowCrossings: m.shallowCrossings + 1 })],
			['a new obstacle conflict', (m) => ({ ...m, conflicts: new Set(['tie:obstacle']) })],
			['a new invalid route', (m) => ({ ...m, invalidRoutes: new Set(['a']) })],
			['a member 6% longer', (m) => ({ ...m, lengths: new Map([...m.lengths, ['a', 1.06 * 300]]) })]
		];
		it.each(worse)('rejects a candidate that adds %s', (_name, change) => {
			const stage = stageOf([straight('a', [0, 0], [300, 0]), straight('b', [0, 10], [300, 10])], {
				measure: gated(change)
			});

			expect(applyTracks(stage)).toBe(stage.routes);
		});

		const allowed: [string, (metrics: TrackMetrics) => TrackMetrics][] = [
			['equal metrics', (m) => m],
			[
				'a member exactly 5% longer',
				(m) => ({ ...m, lengths: new Map([...m.lengths, ['a', 1.05 * 300]]) })
			]
		];
		it.each(allowed)('accepts a candidate with %s', (_name, change) => {
			const stage = stageOf([straight('a', [0, 0], [300, 0]), straight('b', [0, 10], [300, 10])], {
				measure: gated(change)
			});

			expect(applyTracks(stage).get('a')?.track).toEqual({ bundle: 'a', lane: 0 });
		});
	});
});

type Dot = { id: string; x: number; y: number; r?: number };

/** Routes the requests over the dots, each dot an obstacle and an endpoint position. */
function scene(
	dots: readonly Dot[],
	requests: readonly RouteRequest[],
	limits = compositionWorkLimits,
	headings: readonly Box[] = [],
	tidyLimit?: number
): Map<string, Route> {
	const budget = createWorkBudget(limits);
	const index = buildObstacleIndex(
		[
			...dots.map((dot) => ({
				id: dot.id,
				kind: 'dot' as const,
				worker: dot.id,
				x: dot.x,
				y: dot.y,
				r: dot.r ?? 6
			})),
			...headings.map((box, at) => ({ id: `h${at}`, kind: 'heading' as const, box }))
		],
		{ unit: 1 },
		budget
	);
	return routeRelationships({
		requests,
		positions: new Map(dots.map((dot) => [dot.id, { x: dot.x, y: dot.y }])),
		index,
		endpointRegions: new Map(),
		budget
	}).tidy(tidyLimit);
}

function pointsOf(route: Route): Point[] {
	return flattenPath(route.d, 0.25, 64)!.points;
}

/** The y where a horizontal-ish flattened path crosses x. */
function yAt(points: readonly Point[], x: number): number {
	for (let i = 1; i < points.length; i += 1) {
		const a = points[i - 1];
		const b = points[i];
		if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) {
			return a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
		}
	}
	throw new Error(`path does not reach x=${x}`);
}

describe('routeRelationships with tracks', () => {
	it('runs two long near-parallel ties in lanes 6 apart, each rejoining its own dots', () => {
		const routes = scene(
			[
				{ id: 'w1a', x: 0, y: 0 },
				{ id: 'w1b', x: 300, y: 0 },
				{ id: 'w2a', x: 0, y: 20 },
				{ id: 'w2b', x: 300, y: 20 }
			],
			[
				{ id: 't1', source: 'w1a', target: 'w1b' },
				{ id: 't2', source: 'w2a', target: 'w2b' }
			]
		);
		const upper = routes.get('t1')!;
		const lower = routes.get('t2')!;
		expect(upper.track).toEqual({ bundle: 't1', lane: 0 });
		expect(lower.track).toEqual({ bundle: 't1', lane: 1 });
		expect(upper.direct).toBe(false);
		expect(lower.direct).toBe(false);
		expect(pointsOf(upper)[0]).toEqual({ x: 0, y: 0 });
		expect(pointsOf(upper).at(-1)).toEqual({ x: 300, y: 0 });
		expect(pointsOf(lower)[0]).toEqual({ x: 0, y: 20 });
		expect(pointsOf(lower).at(-1)).toEqual({ x: 300, y: 20 });
		expect(yAt(pointsOf(lower), 150) - yAt(pointsOf(upper), 150)).toBeCloseTo(6, 9);
		expect(upper.length).toBeLessThanOrEqual(1.05 * 300);
		expect(lower.length).toBeLessThanOrEqual(1.05 * 300);
	});

	it('orders three ties converging on one dot by where they start, each ending on that dot', () => {
		const routes = scene(
			[
				{ id: 'p', x: 0, y: -12 },
				{ id: 'q', x: 0, y: 0 },
				{ id: 'r', x: 0, y: 12 },
				{ id: 'z', x: 300, y: 0 }
			],
			[
				{ id: 'u', source: 'p', target: 'z' },
				{ id: 'm', source: 'q', target: 'z' },
				{ id: 'l', source: 'r', target: 'z' }
			]
		);
		expect(['u', 'm', 'l'].map((id) => routes.get(id)?.track?.lane)).toEqual([0, 1, 2]);
		for (const id of ['u', 'm', 'l']) {
			expect(pointsOf(routes.get(id)!).at(-1)).toEqual({ x: 300, y: 0 });
		}
	});

	it('leaves two ties whose order flips along the corridor direct', () => {
		const routes = scene(
			[
				{ id: 'a', x: 0, y: 0 },
				{ id: 'b', x: 300, y: 20 },
				{ id: 'c', x: 0, y: 20 },
				{ id: 'd', x: 300, y: 0 }
			],
			[
				{ id: 'x', source: 'a', target: 'b' },
				{ id: 'y', source: 'c', target: 'd' }
			]
		);
		for (const id of ['x', 'y']) {
			expect(routes.get(id)?.direct).toBe(true);
			expect(routes.get(id)?.track).toBeUndefined();
		}
	});

	it('keeps a member whose lane would hit an unrelated dot direct and bundles the rest', () => {
		// Three ties at y 0, 20, 40 share lanes 16, 20, 24. Lane 16 is 4 from the dot at (150, 12),
		// inside its 6 clearance (r 1 + 4 + stroke 1); the direct ties are 12, 8 and 28 away, all clear.
		const routes = scene(
			[
				{ id: 'a0', x: 0, y: 0 },
				{ id: 'b0', x: 300, y: 0 },
				{ id: 'a20', x: 0, y: 20 },
				{ id: 'b20', x: 300, y: 20 },
				{ id: 'a40', x: 0, y: 40 },
				{ id: 'b40', x: 300, y: 40 },
				{ id: 'o', x: 150, y: 12, r: 1 }
			],
			[
				{ id: 'y0', source: 'a0', target: 'b0' },
				{ id: 'y20', source: 'a20', target: 'b20' },
				{ id: 'y40', source: 'a40', target: 'b40' }
			]
		);
		expect(routes.get('y0')?.direct).toBe(true);
		expect(routes.get('y0')?.track).toBeUndefined();
		expect(routes.get('y20')?.track).toEqual({ bundle: 'y20', lane: 0 });
		expect(routes.get('y40')?.track).toEqual({ bundle: 'y20', lane: 1 });
	});

	it.each([
		['shorter than 120', 100, 10],
		['60 apart', 300, 60]
	])('leaves ties %s untouched', (_name, length, gap) => {
		const routes = scene(
			[
				{ id: 'a0', x: 0, y: 0 },
				{ id: 'b0', x: length, y: 0 },
				{ id: 'a1', x: 0, y: gap },
				{ id: 'b1', x: length, y: gap }
			],
			[
				{ id: 't0', source: 'a0', target: 'b0' },
				{ id: 't1', source: 'a1', target: 'b1' }
			]
		);
		for (const id of ['t0', 't1']) {
			expect(routes.get(id)?.direct).toBe(true);
			expect(routes.get(id)?.track).toBeUndefined();
		}
	});

	it('never adds crossings to the direct drawing when a bundle is crossed', () => {
		const dots: Dot[] = [
			{ id: 'pa', x: 0, y: 0 },
			{ id: 'pb', x: 300, y: 0 },
			{ id: 'qa', x: 0, y: 10 },
			{ id: 'qb', x: 300, y: 10 },
			{ id: 'ra', x: 150, y: -100 },
			{ id: 'rb', x: 150, y: 100 }
		];
		const requests: RouteRequest[] = [
			{ id: 'p', source: 'pa', target: 'pb' },
			{ id: 'q', source: 'qa', target: 'qb' },
			{ id: 'r', source: 'ra', target: 'rb' }
		];
		const routed = scene(dots, requests);
		expect(routed.get('p')?.track).toBeDefined();
		const direct = requests.map((request) => {
			const from = dots.find((dot) => dot.id === request.source)!;
			const to = dots.find((dot) => dot.id === request.target)!;
			return {
				id: request.id,
				source: request.source,
				target: request.target,
				d: `M ${from.x} ${from.y} L ${to.x} ${to.y}`
			};
		});
		const crossings = (routes: { id: string; source: string; target: string; d: string }[]) =>
			evaluateDrawing({
				routes,
				dots: dots.map((dot) => ({ id: dot.id, x: dot.x, y: dot.y, r: 6 })),
				names: [],
				headings: [],
				regions: [],
				workerRegions: new Map(),
				unit: 1,
				skipLayoutConflicts: true
			}).properCrossings;
		expect(crossings([...routed.values()])).toBeLessThanOrEqual(crossings(direct));
	});

	it('gives identical paths for the same scene routed twice', () => {
		const dots: Dot[] = [
			{ id: 'a0', x: 0, y: 0 },
			{ id: 'b0', x: 300, y: 0 },
			{ id: 'a20', x: 0, y: 20 },
			{ id: 'b20', x: 300, y: 20 },
			{ id: 'a40', x: 0, y: 40 },
			{ id: 'b40', x: 300, y: 40 }
		];
		const requests: RouteRequest[] = [
			{ id: 'y0', source: 'a0', target: 'b0' },
			{ id: 'y20', source: 'a20', target: 'b20' },
			{ id: 'y40', source: 'a40', target: 'b40' }
		];
		const paths = (routes: Map<string, Route>) =>
			Object.fromEntries([...routes].map(([id, route]) => [id, route.d]));
		const first = paths(scene(dots, requests));
		expect(paths(scene(dots, requests))).toEqual(first);
		expect(first.y20).not.toBe('M 0 20 L 300 20');
	});

	it('returns the untracked ties when the track allowance runs out', () => {
		const dots: Dot[] = [
			{ id: 'w1a', x: 0, y: 0 },
			{ id: 'w1b', x: 300, y: 0 },
			{ id: 'w2a', x: 0, y: 20 },
			{ id: 'w2b', x: 300, y: 20 }
		];
		const requests: RouteRequest[] = [
			{ id: 't1', source: 'w1a', target: 'w1b' },
			{ id: 't2', source: 'w2a', target: 'w2b' }
		];
		// The track pass has its own allowance, apart from the composer's: a tiny one leaves every tie untracked.
		const untracked = scene(dots, requests, compositionWorkLimits, [], 5);
		for (const id of ['t1', 't2']) {
			expect(untracked.get(id)?.direct).toBe(true);
			expect(untracked.get(id)?.track).toBeUndefined();
		}
		const tracked = scene(dots, requests);
		expect(tracked.get('t1')?.track).toBeDefined();
	});

	it('keeps two ties that converge on one heading corner in separate lanes through it', () => {
		// Two cross ties from different sources, 40 apart far away, both detoured round the same heading corner
		// (the "BACK OF HOUSE" kink): they must travel as parallel lanes, never touching.
		const routes = scene(
			[
				{ id: 's1', x: 400, y: -300, r: 8 },
				{ id: 's2', x: 440, y: -300, r: 8 },
				{ id: 't1', x: 140, y: 335, r: 8 },
				{ id: 't2', x: 20, y: 346, r: 8 }
			],
			[
				{ id: 'a', source: 's1', target: 't1' },
				{ id: 'b', source: 's2', target: 't2' }
			],
			compositionWorkLimits,
			[{ left: 0, top: 172, right: 260, bottom: 192 }]
		);
		const a = routes.get('a')!;
		const b = routes.get('b')!;
		expect(a.track).toBeDefined();
		expect(b.track).toBeDefined();
		const xAtY = (points: readonly Point[], y: number) => {
			for (let i = 1; i < points.length; i += 1) {
				const p = points[i - 1];
				const q = points[i];
				if ((p.y - y) * (q.y - y) <= 0 && p.y !== q.y) {
					return p.x + ((y - p.y) / (q.y - p.y)) * (q.x - p.x);
				}
			}
			throw new Error(`path does not reach y=${y}`);
		};
		const pa = pointsOf(a);
		const pb = pointsOf(b);
		for (const y of [0, 60, 120, 160]) {
			expect(Math.abs(xAtY(pa, y) - xAtY(pb, y))).toBeGreaterThanOrEqual(5);
			expect(Math.abs(xAtY(pa, y) - xAtY(pb, y))).toBeLessThanOrEqual(30);
		}
	});
});
