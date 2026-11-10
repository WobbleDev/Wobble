// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { evaluateDrawing, publishedConflicts, scoreLayoutQuality } from './graph-layout-quality.ts';
import type { Point } from './graph-layout.ts';

const points = (entries: [string, number, number][]) =>
	new Map<string, Point>(entries.map(([id, x, y]) => [id, { x, y }]));

const relationships = (...pairs: [string, string][]) =>
	pairs.map(([source, target], index) => ({ id: `r${index}`, source, target }));

describe('scoreLayoutQuality', () => {
	it('counts the union of drawn footprints, independent of outliers and tie ink', () => {
		const base = {
			positions: points([
				['a', 0, 0],
				['b', 10, 0]
			]),
			links: [],
			bodies: [],
			outwardPartitions: [],
			canvas: { width: 20, height: 20 },
			footprints: [
				{ kind: 'rect' as const, x: 1, y: 1, width: 2, height: 2 },
				{ kind: 'rect' as const, x: 2, y: 1, width: 2, height: 2 }
			],
			sampleSize: 1
		};
		const score = scoreLayoutQuality(base);
		const outlier = scoreLayoutQuality({
			...base,
			positions: points([
				['a', 0, 0],
				['b', 10, 0],
				['far', 1000, 1000]
			])
		});
		const tieInkAndRegion = scoreLayoutQuality({
			...base,
			links: relationships(['a', 'b']),
			bodies: [{ id: 'large-region', members: ['a', 'b'] }]
		});
		expect(score.usefulCoverage).toBeGreaterThan(0);
		expect(score.usefulCoverage).toBe(6 / 400);
		expect(outlier.usefulCoverage).toBe(score.usefulCoverage);
		expect(outlier.largestEmptyPocket).toBe(score.largestEmptyPocket);
		expect(tieInkAndRegion.usefulCoverage).toBe(score.usefulCoverage);
		expect(tieInkAndRegion.largestEmptyPocket).toBe(score.largestEmptyPocket);
	});

	it('distinguishes a local empty pocket from the same marks spread across the canvas', () => {
		const measure = (
			footprints: { kind: 'rect'; x: number; y: number; width: number; height: number }[]
		) =>
			scoreLayoutQuality({
				positions: new Map(),
				links: [],
				bodies: [],
				outwardPartitions: [],
				canvas: { width: 10, height: 10 },
				footprints,
				sampleSize: 1
			});
		const clustered = measure(
			Array.from({ length: 10 }, (_, x) => ({
				kind: 'rect' as const,
				x,
				y: 0,
				width: 1,
				height: 1
			}))
		);
		const spread = measure(
			Array.from({ length: 10 }, (_, y) => ({
				kind: 'rect' as const,
				x: 4,
				y,
				width: 1,
				height: 1
			}))
		);
		expect(clustered.usefulCoverage).toBe(spread.usefulCoverage);
		expect(clustered.largestEmptyPocket).toBeGreaterThan(spread.largestEmptyPocket);
	});

	it('counts proper crossings once and keeps collinear overlap separate', () => {
		const score = scoreLayoutQuality({
			positions: points([
				['a', 0, 0],
				['b', 10, 10],
				['c', 0, 10],
				['d', 10, 0],
				['e', 0, 20],
				['f', 10, 20]
			]),
			links: relationships(['a', 'b'], ['c', 'd'], ['e', 'f']),
			bodies: [],
			outwardPartitions: [],
			canvas: { width: 100, height: 100 }
		});

		expect(score.properCrossings).toBe(1);
		expect(score.collinearOverlaps).toBe(0);
		expect(score.longestToMedianRatio).toBe(1);
		expect(score.outwardLength).toBe(0);
	});

	it('reports collinear overlaps and ignores shared endpoints', () => {
		const score = scoreLayoutQuality({
			positions: points([
				['a', 0, 0],
				['b', 10, 0],
				['c', 5, 0],
				['d', 15, 0],
				['e', 10, 0],
				['f', 10, 10]
			]),
			links: relationships(['a', 'b'], ['c', 'd'], ['b', 'f']),
			bodies: [],
			outwardPartitions: [],
			canvas: { width: 100, height: 100 }
		});

		expect(score.properCrossings).toBe(0);
		expect(score.collinearOverlaps).toBe(1);
	});

	it('measures outward ties normalized by the occupied Arrangement extent', () => {
		const score = scoreLayoutQuality({
			positions: points([
				['a', 0, 0],
				['b', 3, 4],
				['c', 6, 8]
			]),
			links: relationships(['a', 'b'], ['b', 'c']),
			bodies: [],
			outwardPartitions: [
				new Map([
					['a', 'left'],
					['b', 'right'],
					['c', 'left']
				])
			],
			canvas: { width: 30, height: 40 }
		});

		expect(score.outwardLength).toBe(10);
		expect(score.normalizedOutwardLength).toBeCloseTo(1);
	});

	it('does not reward uniform shrinking of an Arrangement', () => {
		const original = points([
			['a', 0, 0],
			['b', 3, 4],
			['c', 6, 8]
		]);
		const shrunk = new Map(
			[...original].map(([id, point]) => [id, { x: point.x / 10, y: point.y / 10 }])
		);
		const score = (positions: ReadonlyMap<string, Point>) =>
			scoreLayoutQuality({
				positions,
				links: relationships(['a', 'b'], ['b', 'c']),
				bodies: [],
				outwardPartitions: [
					new Map([
						['a', 'left'],
						['b', 'right'],
						['c', 'left']
					])
				],
				canvas: { width: 30, height: 40 }
			});

		expect(score(shrunk).normalizedOutwardLength).toBeCloseTo(
			score(original).normalizedOutwardLength
		);
		expect(score(shrunk).outwardLength).toBeCloseTo(score(original).outwardLength / 10);
	});

	it('detects a relationship passing through an unrelated singleton body', () => {
		const score = scoreLayoutQuality({
			positions: points([
				['a', -10, 0],
				['b', 10, 0],
				['c', 0, 0]
			]),
			links: relationships(['a', 'b']),
			bodies: [{ id: 'other', members: ['c'] }],
			outwardPartitions: [],
			canvas: { width: 100, height: 100 },
			bodyPadding: 1
		});

		expect(score.bodyPassThroughs).toBe(1);
	});

	it('uses a padded capsule for a two-member body and remains finite for empty and degenerate input', () => {
		const throughPair = scoreLayoutQuality({
			positions: points([
				['a', -10, 0],
				['b', 10, 0],
				['c', 0, -10],
				['d', 0, 10]
			]),
			links: relationships(['c', 'd']),
			bodies: [{ id: 'pair', members: ['a', 'b'] }],
			outwardPartitions: [],
			canvas: { width: 100, height: 100 },
			bodyPadding: 1
		});
		const empty = scoreLayoutQuality({
			positions: new Map(),
			links: [],
			bodies: [],
			outwardPartitions: [],
			canvas: { width: 0, height: 0 }
		});
		const degenerate = scoreLayoutQuality({
			positions: points([
				['a', 0, 0],
				['b', 0, 0]
			]),
			links: relationships(['a', 'b']),
			bodies: [],
			outwardPartitions: [],
			canvas: { width: 100, height: 100 }
		});

		expect(throughPair.bodyPassThroughs).toBe(1);
		for (const value of Object.values(empty)) expect(Number.isFinite(value)).toBe(true);
		for (const value of Object.values(degenerate)) expect(Number.isFinite(value)).toBe(true);
		expect(empty.longestToMedianRatio).toBe(0);
		expect(degenerate.longestToMedianRatio).toBe(0);
	});

	it('keeps a positive maximum finite when the median Relationship length is zero', () => {
		const score = scoreLayoutQuality({
			positions: points([
				['a', 0, 0],
				['b', 0, 0],
				['c', 5, 0],
				['d', 5, 0],
				['e', 10, 0],
				['f', 20, 0]
			]),
			links: relationships(['a', 'b'], ['c', 'd'], ['e', 'f']),
			bodies: [],
			outwardPartitions: [],
			canvas: { width: 100, height: 100 }
		});

		expect(Number.isFinite(score.longestToMedianRatio)).toBe(true);
		expect(score.longestToMedianRatio).toBeGreaterThan(1e15);
	});
});

describe('evaluateDrawing', () => {
	const dot = (id: string, x: number, y: number, r = 6) => ({ id, x, y, r });
	const base = (over: Partial<Parameters<typeof evaluateDrawing>[0]>) =>
		evaluateDrawing({
			routes: [],
			dots: [],
			names: [],
			headings: [],
			regions: [],
			workerRegions: new Map(),
			unit: 1,
			...over
		});

	it('finds a curve entering a dot that its endpoints would not reveal', () => {
		const dots = [dot('a', 0, 0), dot('b', 100, 0), dot('mid', 50, 38)];
		const curved = base({
			dots,
			routes: [{ id: 'ab', source: 'a', target: 'b', d: 'M 0 0 Q 50 80 100 0' }]
		});
		expect(curved.dotConflicts).toEqual(['ab:mid']);
		const straight = base({
			dots,
			routes: [{ id: 'ab', source: 'a', target: 'b', d: 'M 0 0 L 100 0' }]
		});
		expect(straight.dotConflicts).toEqual([]);
	});

	it('counts crossings once per pair, separates shallow ones, and ignores shared endpoints', () => {
		const result = base({
			dots: [
				dot('a', 0, 0),
				dot('b', 100, 100),
				dot('c', 0, 100),
				dot('d', 100, 0),
				dot('e', 0, 1)
			],
			routes: [
				{ id: 'ab', source: 'a', target: 'b', d: 'M 0 0 L 100 100' },
				{ id: 'cd', source: 'c', target: 'd', d: 'M 0 100 L 100 0' },
				{ id: 'ae', source: 'a', target: 'e', d: 'M 0 0 L 0 1' }
			]
		});
		expect(result.properCrossings).toBe(1);
		expect(result.shallowCrossings).toBe(0);
		const grazing = base({
			dots: [dot('a', 0, 0), dot('b', 100, 10), dot('c', 0, 8), dot('d', 100, 0)],
			routes: [
				{ id: 'ab', source: 'a', target: 'b', d: 'M 0 0 L 100 10' },
				{ id: 'cd', source: 'c', target: 'd', d: 'M 0 8 L 100 0' }
			]
		});
		expect(grazing.properCrossings).toBe(1);
		expect(grazing.shallowCrossings).toBe(1);
	});

	it('reports a long shared run but not two routes that merely run alongside', () => {
		const together = base({
			dots: [dot('a', 0, 0), dot('b', 100, 0), dot('c', 0, 1), dot('d', 100, 1)],
			routes: [
				{ id: 'ab', source: 'a', target: 'b', d: 'M 0 0 L 100 0' },
				{ id: 'cd', source: 'c', target: 'd', d: 'M 0 1 L 100 1' }
			]
		});
		expect(together.sharedRuns).toBe(1);
		const apart = base({
			dots: [dot('a', 0, 0), dot('b', 100, 0), dot('c', 0, 40), dot('d', 100, 40)],
			routes: [
				{ id: 'ab', source: 'a', target: 'b', d: 'M 0 0 L 100 0' },
				{ id: 'cd', source: 'c', target: 'd', d: 'M 0 40 L 100 40' }
			]
		});
		expect(apart.sharedRuns).toBe(0);
	});

	it('names a tie through an unrelated region, a name box or a heading, by identity', () => {
		const square = [
			{ x: 40, y: -20 },
			{ x: 60, y: -20 },
			{ x: 60, y: 20 },
			{ x: 40, y: 20 }
		];
		const dots = [dot('a', 0, 0), dot('b', 100, 0)];
		const routes = [{ id: 'ab', source: 'a', target: 'b', d: 'M 0 0 L 100 0' }];
		const result = base({
			dots,
			routes,
			regions: [{ key: 'R', polygon: square, outlined: true }],
			names: [{ id: 'name:z', worker: 'z', box: { left: 70, top: -5, right: 90, bottom: 5 } }],
			headings: [{ id: 'H', box: { left: 10, top: -5, right: 30, bottom: 5 } }]
		});
		expect(result.regionConflicts).toEqual(['ab:R']);
		expect(result.nameConflicts).toEqual(['ab:name:z']);
		expect(result.headingConflicts).toEqual(['ab:H']);
		const own = base({
			dots,
			routes,
			regions: [{ key: 'R', polygon: square, outlined: true }],
			workerRegions: new Map([['a', ['R']]])
		});
		expect(own.regionConflicts).toEqual([]);
	});

	it('flags a path that misses an endpoint', () => {
		const result = base({
			dots: [dot('a', 0, 0), dot('b', 100, 0)],
			routes: [{ id: 'ab', source: 'a', target: 'b', d: 'M 5 0 L 100 0' }]
		});
		expect(result.invalidRoutes).toEqual(['ab']);
	});

	it('skips the tie-free layout checks when asked, leaving the route measures unchanged', () => {
		const input = {
			dots: [
				dot('a', 0, 0),
				dot('b', 100, 100),
				dot('c', 0, 100),
				dot('d', 100, 0),
				dot('x', 50, 200),
				dot('y', 52, 200)
			],
			routes: [
				{ id: 'ab', source: 'a', target: 'b', d: 'M 0 0 L 100 100' },
				{ id: 'cd', source: 'c', target: 'd', d: 'M 0 100 L 100 0' }
			]
		};
		const full = base(input);
		const skipped = base({ ...input, skipLayoutConflicts: true });
		expect(full.layoutConflicts).toEqual(['dots:x:y']);
		expect(skipped.layoutConflicts).toEqual([]);
		expect(skipped).toEqual({ ...full, layoutConflicts: [], outlineGap: Infinity });
		expect(skipped.properCrossings).toBe(1);
	});
});

describe('publishedConflicts', () => {
	it('publishes the composition-time reading when the render-time allowance is exhausted', () => {
		// 65,001 dots reserve 260,004 evaluation primitives, past the 250,000 allowance
		// before any route is flattened: the render-time reading cannot finish.
		const conflicts = { dot: ['kept'], name: [], heading: [], region: [], layout: ['layout'] };
		const drawing = {
			routes: [],
			dots: Array.from({ length: 65_001 }, (_, index) => ({
				id: `d${index}`,
				x: index,
				y: 0,
				r: 1
			})),
			names: [],
			headings: [],
			regions: [],
			workerRegions: new Map<string, readonly string[]>(),
			unit: 1
		};

		expect(publishedConflicts({ conflicts, drawing })).toBe(conflicts);
	});
});
