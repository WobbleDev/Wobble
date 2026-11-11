// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { layoutGroupRegions, type PlacedWorker, type Point } from './layout/graph-layout.ts';
import type { WorkerGraphLink, WorkerGraphNode } from './worker-relationship-map-model.ts';
import {
	deriveVisibleGraph,
	dossierNeighbours,
	isIsolateInEffect,
	isolateDrawnLinkIds,
	isolateFitPositions,
	isolateNeighbourhood,
	cameraForSize,
	referenceFromCamera,
	viewportFactor,
	labelledWorkerIds,
	linkRegions,
	resolveEffectiveLayout
} from './map-view-model.ts';
import { answerIdsFixture, attributeFixture } from '#lib/testing/mapping/answer-fixtures.ts';
import { isolateDotGap } from './layout/isolate-separation.ts';

const department = attributeFixture({
	id: 'dept',
	name: 'Department',
	kind: 'category',
	options: ['Front of House', 'Back of House']
});

function node(id: string, relationshipCount = 0, departmentValue = ''): WorkerGraphNode {
	return {
		id,
		name: id,
		assessment: 'Unassessed',
		attributes: answerIdsFixture({ dept: departmentValue }),
		relationshipCount
	};
}

function link(source: string, target: string): WorkerGraphLink {
	return { id: JSON.stringify([source, target]), source, target, value: 1 };
}

describe('resolveEffectiveLayout', () => {
	it.each([
		{
			name: 'Grouped stays Grouped when grouped',
			layout: 'grouped',
			grouped: true,
			expected: 'grouped'
		},
		{ name: 'Free stays Free when grouped', layout: 'free', grouped: true, expected: 'free' },
		{
			name: 'A stored Grouped choice draws ungrouped with no grouping',
			layout: 'grouped',
			grouped: false,
			expected: 'free'
		},
		{
			name: 'A stored free choice draws ungrouped with no grouping',
			layout: 'free',
			grouped: false,
			expected: 'free'
		}
	] as const)('$name', ({ layout, grouped, expected }) => {
		expect(resolveEffectiveLayout(layout, grouped ? department : undefined)).toBe(expected);
	});
});

describe('isIsolateInEffect', () => {
	it('needs both the focus and a selected Worker', () => {
		expect(isIsolateInEffect(true, 'a')).toBe(true);
		expect(isIsolateInEffect(true, '')).toBe(false);
		expect(isIsolateInEffect(false, 'a')).toBe(false);
	});
});

describe('isolateFitPositions', () => {
	// A small neighbourhood — a, b, c — and a stranger far outside it.
	const arrangement = new Map<string, Point>([
		['a', { x: 100, y: 100 }],
		['b', { x: 140, y: 100 }],
		['c', { x: 100, y: 130 }],
		['away', { x: 900, y: 700 }]
	]);
	const drawn = ['a', 'b', 'c'];
	/** A free canvas whose middle is the origin, so a centred fit reads plainly. */
	const freeCanvas = { x: -400, y: -300, width: 800, height: 600 };

	const fit = (
		positions: Map<string, Point> = arrangement,
		drawnIds: string[] = drawn,
		canvas = freeCanvas
	) => isolateFitPositions({ positions, drawnIds, freeCanvas: canvas }).positions;

	const boundsOf = (positions: Map<string, Point>, ids: readonly string[]) => {
		const points = ids.map((id) => positions.get(id)!);
		const xs = points.map((point) => point.x);
		const ys = points.map((point) => point.y);
		return {
			centreX: (Math.min(...xs) + Math.max(...xs)) / 2,
			centreY: (Math.min(...ys) + Math.max(...ys)) / 2
		};
	};
	const distance = (positions: Map<string, Point>, from: string, to: string) =>
		Math.hypot(
			positions.get(from)!.x - positions.get(to)!.x,
			positions.get(from)!.y - positions.get(to)!.y
		);

	it('centres the drawn set in the free canvas', () => {
		const fitted = fit(arrangement, drawn, { x: -200, y: -100, width: 700, height: 500 });
		const { centreX, centreY } = boundsOf(fitted, drawn);

		expect(centreX).toBeCloseTo(-200 + 700 / 2, 6);
		expect(centreY).toBeCloseTo(-100 + 500 / 2, 6);
	});

	it('caps a tiny neighbourhood at three times the usual spacing', () => {
		const fitted = fit();

		// a—b was 40 units on the whole map, and a—c 30: both are spread threefold.
		expect(distance(fitted, 'a', 'b')).toBeCloseTo(120, 6);
		expect(distance(fitted, 'a', 'c')).toBeCloseTo(90, 6);
	});

	it('shortens the distances of a neighbourhood larger than the canvas', () => {
		const wide = new Map<string, Point>([
			['a', { x: 0, y: 0 }],
			['b', { x: 2000, y: 0 }],
			['c', { x: 0, y: 1500 }]
		]);
		const fitted = fit(wide);

		const scale = distance(fitted, 'a', 'b') / 2000;
		expect(scale).toBeLessThan(1);
		expect(distance(fitted, 'a', 'c') / 1500).toBeCloseTo(scale, 6);
	});

	it('keeps the shape: every pairwise distance takes the same scale', () => {
		const fitted = fit();
		const scale = distance(fitted, 'a', 'b') / distance(arrangement, 'a', 'b');

		expect(distance(fitted, 'a', 'c') / distance(arrangement, 'a', 'c')).toBeCloseTo(scale, 6);
		expect(distance(fitted, 'b', 'c') / distance(arrangement, 'b', 'c')).toBeCloseTo(scale, 6);
	});

	it('leaves the arrangement untouched, and everyone outside the drawn set where they were', () => {
		const before = new Map(arrangement);
		const fitted = fit();

		expect(arrangement).toEqual(before);
		expect(fitted.get('away')).toEqual(arrangement.get('away'));
	});

	it('centres a lone drawn Worker, having no distances to scale', () => {
		const before = new Map(arrangement);
		const fitted = fit(arrangement, ['a']);

		expect(fitted.get('a')).toEqual({
			x: freeCanvas.x + freeCanvas.width / 2,
			y: freeCanvas.y + freeCanvas.height / 2
		});
		expect(arrangement).toEqual(before);
		expect(fitted.get('b')).toEqual(arrangement.get('b'));
	});

	it('keeps every drawn dot clear of its neighbours when the neighbourhood is larger than the canvas', () => {
		// A hub with six spokes, the spokes 60 units out. A 150-unit canvas leaves 38 units
		// for the set, so the fit scales it down to about a third and the spokes land on the hub.
		const hub = 'hub';
		const spokes = Array.from({ length: 6 }, (_, index) => `spoke-${index}`);
		const ringed = new Map<string, Point>([[hub, { x: 0, y: 0 }]]);
		spokes.forEach((id, index) => {
			const angle = (index / spokes.length) * 2 * Math.PI;
			ringed.set(id, { x: 60 * Math.cos(angle), y: 60 * Math.sin(angle) });
		});
		const radii = new Map<string, number>([[hub, 24], ...spokes.map((id) => [id, 4] as const)]);
		const ids = [hub, ...spokes];

		const { positions: fitted, radii: fittedRadii } = isolateFitPositions({
			positions: ringed,
			drawnIds: ids,
			freeCanvas: { x: -75, y: -75, width: 150, height: 150 },
			radii
		});

		// Two dots must be at least the fixed gap clear, measured at the radii they are drawn with.
		let closestEdgeGap = Infinity;
		for (const [index, from] of ids.entries()) {
			for (const to of ids.slice(index + 1)) {
				const edgeGap =
					distance(fitted, from, to) - (fittedRadii.get(from)! + fittedRadii.get(to)!);
				closestEdgeGap = Math.min(closestEdgeGap, edgeGap);
			}
		}
		expect(closestEdgeGap).toBeGreaterThanOrEqual(isolateDotGap);
	});

	describe('dot radii', () => {
		// Drawn as {a, b, c} on the 800x600 canvas, so the fit is set by the height: the
		// spread is 1000 units tall, (600 - 2 × 56) / 2000 = 0.244. Hand-derived, not by the code.
		const wideArrangement = new Map<string, Point>([
			['a', { x: 0, y: 0 }],
			['b', { x: 2000, y: 0 }],
			['c', { x: 0, y: 1500 }],
			['away', { x: 900, y: 700 }]
		]);

		it('shrinks each radius with the fit, and moves no dot when shrinking alone clears every pair', () => {
			const { positions, radii } = isolateFitPositions({
				positions: wideArrangement,
				drawnIds: ['a', 'b', 'c'],
				freeCanvas,
				radii: new Map([
					['a', 24],
					['b', 4],
					['c', 4]
				])
			});

			expect(radii.get('a')).toBeCloseTo(24 * 0.244, 6);
			expect(radii.get('b')).toBe(4);
			expect(radii.get('c')).toBe(4);

			// Scaled 0.244 about the centroid (666.67, 500) and centred on the canvas origin.
			expect(positions.get('a')!.x).toBeCloseTo(-244, 6);
			expect(positions.get('a')!.y).toBeCloseTo(-183, 6);
			expect(positions.get('b')!.x).toBeCloseTo(244, 6);
			expect(positions.get('b')!.y).toBeCloseTo(-183, 6);
			expect(positions.get('c')!.x).toBeCloseTo(-244, 6);
			expect(positions.get('c')!.y).toBeCloseTo(183, 6);
		});

		it('grows every radius to 1.25× when the neighbourhood is smaller than the canvas', () => {
			// The same small neighbourhood as the fit tests: its fit is capped at 3×, so every
			// radius takes the 1.25× growth ceiling, and the floor never bites on the way up.
			const { radii: fitted } = isolateFitPositions({
				positions: new Map<string, Point>([
					['a', { x: 100, y: 100 }],
					['b', { x: 140, y: 100 }],
					['c', { x: 100, y: 130 }]
				]),
				drawnIds: ['a', 'b', 'c'],
				freeCanvas,
				radii: new Map([
					['a', 24],
					['b', 4],
					['c', 4]
				])
			});

			expect(fitted.get('a')).toBe(30);
			expect(fitted.get('b')).toBe(5);
			expect(fitted.get('c')).toBe(5);
		});

		it('caps the growth at 1.25× however small the neighbourhood, since the fit caps at 3×', () => {
			// Spread 1 unit: the fit would be 688, so it is capped at 3× and the radii at 1.25×.
			const { radii } = isolateFitPositions({
				positions: new Map<string, Point>([
					['a', { x: 0, y: 0 }],
					['b', { x: 1, y: 0 }]
				]),
				drawnIds: ['a', 'b'],
				freeCanvas,
				radii: new Map([
					['a', 24],
					['b', 4]
				])
			});

			expect(radii.get('a')).toBe(30);
			expect(radii.get('b')).toBe(5);
		});

		it('scales each radius with the fit between 1× and 1.25×', () => {
			// Spread 625 units along the width: the fit is (800 - 112) / 625 = 1.1008, between 1× and 1.25×.
			const { radii } = isolateFitPositions({
				positions: new Map<string, Point>([
					['a', { x: 0, y: 0 }],
					['b', { x: 625, y: 0 }]
				]),
				drawnIds: ['a', 'b'],
				freeCanvas,
				radii: new Map([
					['a', 24],
					['b', 4]
				])
			});

			expect(radii.get('a')).toBeCloseTo(24 * (688 / 625), 6);
			expect(radii.get('b')).toBeCloseTo(4 * (688 / 625), 6);
		});

		it('has a radius factor of exactly 1 at 1×, and one just under 1× barely shrinks', () => {
			// Spread 688 units fits the 688 units of width exactly, so the fit is 1×.
			const atOne = isolateFitPositions({
				positions: new Map<string, Point>([
					['a', { x: 0, y: 0 }],
					['b', { x: 688, y: 0 }]
				]),
				drawnIds: ['a', 'b'],
				freeCanvas,
				radii: new Map([
					['a', 24],
					['b', 4]
				])
			}).radii;
			expect(atOne.get('a')).toBe(24);
			expect(atOne.get('b')).toBe(4);

			// Spread 689 units: the fit is 688 / 689, just under 1×, so the hub is only a hair smaller.
			const justUnder = isolateFitPositions({
				positions: new Map<string, Point>([
					['a', { x: 0, y: 0 }],
					['b', { x: 689, y: 0 }]
				]),
				drawnIds: ['a', 'b'],
				freeCanvas,
				radii: new Map([
					['a', 24],
					['b', 4]
				])
			}).radii;
			expect(justUnder.get('a')).toBeCloseTo(24, 1);
		});

		it('separates two grown dots that the fit leaves within the gap', () => {
			// A hub and a spoke 30 apart, base edges 2 units apart. The spread is 30 units wide, so
			// the fit is (148 - 112) / 30 = 1.2×: the dots grow to 28.8 and 4.8, and their
			// edges come within 2.4 units, so the separation pass must clear them.
			const pair = new Map<string, Point>([
				['hub', { x: 0, y: 0 }],
				['spoke', { x: 30, y: 0 }]
			]);
			const radii = new Map([
				['hub', 24],
				['spoke', 4]
			]);
			const { positions, radii: grown } = isolateFitPositions({
				positions: pair,
				drawnIds: ['hub', 'spoke'],
				freeCanvas: { x: -74, y: -300, width: 148, height: 600 },
				radii
			});

			expect(grown.get('hub')).toBeCloseTo(24 * 1.2, 6);
			expect(grown.get('spoke')).toBeCloseTo(4 * 1.2, 6);
			const edgeGap =
				distance(positions, 'hub', 'spoke') - (grown.get('hub')! + grown.get('spoke')!);
			expect(edgeGap).toBeGreaterThanOrEqual(isolateDotGap);
		});

		it('keeps a lone drawn Worker at its own radius', () => {
			const { radii } = isolateFitPositions({
				positions: wideArrangement,
				drawnIds: ['a'],
				freeCanvas,
				radii: new Map([['a', 24]])
			});

			expect(radii.get('a')).toBe(24);
		});

		it('floors a shrunk radius at the smallest normal dot, and leaves a smaller one alone', () => {
			// Spread 100000 units along the width: the fit is (800 - 112) / 100000, far below the floor.
			const stretched = new Map<string, Point>([
				['a', { x: 0, y: 0 }],
				['b', { x: 100000, y: 0 }],
				['c', { x: 50000, y: 0 }]
			]);
			const { radii } = isolateFitPositions({
				positions: stretched,
				drawnIds: ['a', 'b', 'c'],
				freeCanvas,
				radii: new Map([
					['a', 24],
					['b', 10],
					['c', 3]
				])
			});

			expect(radii.get('a')).toBe(4);
			expect(radii.get('b')).toBe(4);
			expect(radii.get('c')).toBe(3);
		});

		it('separates the dots, at their shrunk radii, when even the floor leaves them overlapping', () => {
			// Six spokes 60 units round a hub, on a canvas so small the fit is about 1/15:
			// the spokes sit 4 units from the hub, closer than the floored radii allow.
			const hub = 'hub';
			const spokes = Array.from({ length: 6 }, (_, index) => `spoke-${index}`);
			const ringed = new Map<string, Point>([[hub, { x: 0, y: 0 }]]);
			spokes.forEach((id, index) => {
				const angle = (index / spokes.length) * 2 * Math.PI;
				ringed.set(id, { x: 60 * Math.cos(angle), y: 60 * Math.sin(angle) });
			});
			const ids = [hub, ...spokes];

			const { positions, radii } = isolateFitPositions({
				positions: ringed,
				drawnIds: ids,
				freeCanvas: { x: -60, y: -60, width: 120, height: 120 },
				radii: new Map(ids.map((id) => [id, id === hub ? 24 : 4] as const))
			});

			expect(ids.every((id) => radii.get(id) === 4)).toBe(true);
			let closestEdgeGap = Infinity;
			for (const [index, from] of ids.entries()) {
				for (const to of ids.slice(index + 1)) {
					closestEdgeGap = Math.min(
						closestEdgeGap,
						distance(positions, from, to) - (radii.get(from)! + radii.get(to)!)
					);
				}
			}
			expect(closestEdgeGap).toBeGreaterThanOrEqual(isolateDotGap);
		});

		it('gives radii only for the drawn Workers, the same way every time', () => {
			const input = {
				positions: arrangement,
				drawnIds: drawn,
				freeCanvas,
				radii: new Map([
					['a', 24],
					['b', 4],
					['c', 4],
					['away', 9]
				])
			};

			const first = isolateFitPositions(input);
			const second = isolateFitPositions(input);

			expect([...first.radii.keys()].sort()).toEqual(['a', 'b', 'c']);
			expect(second).toEqual(first);
		});
	});

	it('draws its regions around the fitted positions with unchanged padding', () => {
		const groups = [{ value: 'Front', label: 'Front', subGroups: [] }];
		const placedIn = (positions: Map<string, Point>): PlacedWorker[] =>
			drawn.map((id) => ({
				x: positions.get(id)!.x,
				y: positions.get(id)!.y,
				group: 'Front',
				subGroup: ''
			}));
		const spanOf = (hull: readonly Point[]) =>
			Math.max(...hull.map((point) => point.x)) - Math.min(...hull.map((point) => point.x));

		const fitted = fit();
		const wholeMap = layoutGroupRegions(groups, placedIn(arrangement))[0];
		const spread = layoutGroupRegions(groups, placedIn(fitted))[0];

		// The outline grew with the spread, and still encloses every member.
		expect(spanOf(spread.hull)).toBeGreaterThan(spanOf(wholeMap.hull));
		for (const id of drawn) expect(insideHull(spread.hull, fitted.get(id)!)).toBe(true);
	});
});

/** Whether a point sits inside a convex hull: every edge puts it on the same side. */
function insideHull(hull: readonly Point[], point: Point): boolean {
	const sides = hull.map((a, index) => {
		const b = hull[(index + 1) % hull.length];
		return Math.sign((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x));
	});

	return sides.every((side) => side >= 0) || sides.every((side) => side <= 0);
}

describe('deriveVisibleGraph', () => {
	const nodes = [node('a'), node('b'), node('c')];
	const links = [link('a', 'b'), link('b', 'c'), link('a', 'c')];

	it('keeps every node and link when nothing is excluded', () => {
		const visible = deriveVisibleGraph(nodes, links, new Set());

		expect(visible.nodes.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
		expect(visible.links.map((entry) => entry.id)).toEqual(links.map((entry) => entry.id));
	});

	it('removes an excluded node and every link that touched it', () => {
		const visible = deriveVisibleGraph(nodes, links, new Set(['b']));

		expect(visible.nodes.map((entry) => entry.id)).toEqual(['a', 'c']);
		expect(visible.links.map((entry) => entry.id)).toEqual([link('a', 'c').id]);
	});

	it('returns nothing when every node is excluded', () => {
		const visible = deriveVisibleGraph(nodes, links, new Set(['a', 'b', 'c']));

		expect(visible.nodes).toEqual([]);
		expect(visible.links).toEqual([]);
	});
});

describe('labelledWorkerIds', () => {
	it('keeps the selected and hovered workers and fills the rest by Relationship count', () => {
		const ids = labelledWorkerIds([node('a', 1), node('b', 9), node('c', 5), node('d', 7)], {
			selectedId: 'a',
			hoveredId: 'c',
			cap: 3
		});

		expect([...ids].sort()).toEqual(['a', 'b', 'c']);
	});

	it('keeps a selection even when it would exceed the cap', () => {
		const ids = labelledWorkerIds([node('a', 1), node('b', 9)], {
			selectedId: 'a',
			hoveredId: 'b',
			cap: 1
		});

		expect([...ids].sort()).toEqual(['a', 'b']);
	});

	it('labels the highest-relationship workers when nothing is selected', () => {
		const ids = labelledWorkerIds([node('a', 1), node('b', 9), node('c', 5)], { cap: 2 });

		expect([...ids].sort()).toEqual(['b', 'c']);
	});
});

describe('linkRegions', () => {
	it('reads a link between two workers in one region as within', () => {
		const readings = linkRegions(
			[node('a', 0, 'Front'), node('b', 0, 'Front')],
			[link('a', 'b')],
			department
		);

		expect(readings.get(link('a', 'b').id)).toBe('within');
	});

	it('reads a link between two regions as cross', () => {
		const readings = linkRegions(
			[node('a', 0, 'Front'), node('b', 0, 'Back')],
			[link('a', 'b')],
			department
		);

		expect(readings.get(link('a', 'b').id)).toBe('cross');
	});

	it('reads every link as within without a grouping', () => {
		const readings = linkRegions(
			[node('a', 0, 'Front'), node('b', 0, 'Back')],
			[link('a', 'b')],
			undefined
		);

		expect(readings.size).toBe(0);
	});
});

describe('isolateNeighbourhood', () => {
	// a - b - c - d, plus a lone worker e.
	const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => node(id));
	const links = [link('a', 'b'), link('b', 'c'), link('c', 'd')];
	const adjacency = new Map<string, Set<string>>([
		['a', new Set(['b'])],
		['b', new Set(['a', 'c'])],
		['c', new Set(['b', 'd'])],
		['d', new Set(['c'])],
		['e', new Set()]
	]);

	it('keeps the selected worker, the first degree and the second, ghosting only the second', () => {
		const result = isolateNeighbourhood(adjacency, 'a', true);

		expect([...(result?.keptIds ?? [])].sort()).toEqual(['a', 'b', 'c']);
		expect([...(result?.firstDegree ?? [])]).toEqual(['b']);
		expect([...(result?.secondDegree ?? [])]).toEqual(['c']);
		expect(result?.secondDegree.has('a')).toBe(false);
		expect(result?.secondDegree.has('b')).toBe(false);
		expect(result?.keptIds.has('d')).toBe(false);
	});

	it('drops the links of the workers outside the neighbourhood', () => {
		const kept = isolateNeighbourhood(adjacency, 'a', true)?.keptIds ?? new Set<string>();
		const outside = new Set(nodes.filter((entry) => !kept.has(entry.id)).map((n) => n.id));
		const visible = deriveVisibleGraph(nodes, links, outside);

		expect(visible.nodes.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
		expect(visible.links.map((entry) => entry.id)).toEqual([link('a', 'b').id, link('b', 'c').id]);
	});

	it('keeps a worker with no Relationships to themselves', () => {
		const result = isolateNeighbourhood(adjacency, 'e', true);

		expect([...(result?.keptIds ?? [])]).toEqual(['e']);
		expect(result?.firstDegree.size).toBe(0);
		expect(result?.secondDegree.size).toBe(0);
	});

	it('is undefined when not isolated or nothing is selected', () => {
		expect(isolateNeighbourhood(adjacency, 'a', false)).toBeUndefined();
		expect(isolateNeighbourhood(adjacency, '', true)).toBeUndefined();
	});
});

describe('isolateDrawnLinkIds', () => {
	// a—b—c—d is a chain; a—f—b closes a triangle off it, and d—e leaves the neighbourhood.
	const links = [
		link('a', 'b'),
		link('a', 'f'),
		link('b', 'f'),
		link('b', 'c'),
		link('b', 'd'),
		link('c', 'd'),
		link('d', 'e')
	];
	const adjacency = new Map<string, Set<string>>([
		['a', new Set(['b', 'f'])],
		['b', new Set(['a', 'c', 'd', 'f'])],
		['c', new Set(['b', 'd'])],
		['d', new Set(['b', 'c', 'e'])],
		['e', new Set(['d'])],
		['f', new Set(['a', 'b'])]
	]);
	const neighbourhood = isolateNeighbourhood(adjacency, 'a', true)!;

	it('draws the ties touching the selected worker and the first↔first ones', () => {
		const drawn = isolateDrawnLinkIds(links, neighbourhood);

		expect(drawn.has(link('a', 'b').id)).toBe(true);
		expect(drawn.has(link('a', 'f').id)).toBe(true);
		expect(drawn.has(link('b', 'f').id)).toBe(true);
	});

	it('draws the faded tie from a first- to a second-degree worker', () => {
		const drawn = isolateDrawnLinkIds(links, neighbourhood);

		expect([...neighbourhood.secondDegree].sort()).toEqual(['c', 'd']);
		expect(drawn.has(link('b', 'c').id)).toBe(true);
		expect(drawn.has(link('b', 'd').id)).toBe(true);
	});

	it('leaves two second-degree workers, and anyone outside the neighbourhood, unwired', () => {
		const drawn = isolateDrawnLinkIds(links, neighbourhood);

		expect(drawn.has(link('c', 'd').id)).toBe(false);
		expect(drawn.has(link('d', 'e').id)).toBe(false);
		expect(drawn.size).toBe(5);
	});
});

describe('dossierNeighbours', () => {
	it('sorts names alphabetically and carries each relationship count', () => {
		const nodes = [
			{ ...node('cy', 4), name: 'Cy' },
			{ ...node('ana', 2), name: 'Ana' },
			{ ...node('bo', 1), name: 'Bo' }
		];
		const neighbours = dossierNeighbours(
			'selected',
			new Map([['selected', new Set(['cy', 'ana', 'bo'])]]),
			new Map(nodes.map((worker) => [worker.id, worker]))
		);
		expect(neighbours.map(({ name, relationshipCount }) => [name, relationshipCount])).toEqual([
			['Ana', 2],
			['Bo', 1],
			['Cy', 4]
		]);
	});
});

describe('the viewport refit camera', () => {
	const layout = { width: 800, height: 600 };
	const reference = { zoom: 1.2, panX: 10, panY: -20 };

	it('is the identity at the layout size', () => {
		expect(cameraForSize({ reference, layout, live: layout })).toEqual(reference);
	});

	it.each([
		[{ width: 400, height: 300 }, 0.5],
		[{ width: 400, height: 600 }, 0.5],
		[{ width: 1600, height: 600 }, 1],
		[{ width: 1600, height: 1200 }, 2]
	])('scales zoom and pan by the smaller ratio at %o', (live, factor) => {
		expect(viewportFactor(layout, live)).toBeCloseTo(factor);
		const result = cameraForSize({ reference, layout, live });
		expect(result.zoom).toBeCloseTo(reference.zoom * factor);
		expect(result.panX).toBeCloseTo(reference.panX * factor);
		expect(result.panY).toBeCloseTo(reference.panY * factor);
	});

	it('restores the exact camera after any resize sequence back to the layout size', () => {
		const sizes = [
			{ width: 400, height: 600 },
			{ width: 800, height: 300 },
			{ width: 1300, height: 90 },
			layout
		];
		let shown = reference;
		for (const live of sizes) shown = cameraForSize({ reference, layout, live });
		expect(shown).toEqual(reference);
	});

	it('turns a camera set at a live size into a reference that shows it back', () => {
		const live = { width: 500, height: 450 };
		const camera = { zoom: 0.9, panX: 4, panY: 8 };
		const stored = referenceFromCamera({ camera, layout, live });
		const shown = cameraForSize({ reference: stored, layout, live });
		expect(shown.zoom).toBeCloseTo(camera.zoom);
		expect(shown.panX).toBeCloseTo(camera.panX);
		expect(shown.panY).toBeCloseTo(camera.panY);
	});

	it('ignores an unmeasured canvas', () => {
		const none = { width: 0, height: 0 };
		expect(viewportFactor(none, none)).toBe(1);
	});
});
