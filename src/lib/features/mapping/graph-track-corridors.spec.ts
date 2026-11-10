// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { createWorkBudget, WorkExhausted } from './graph-work-budget.ts';
import { findBundles, longestLeg, type TrackRoute } from './graph-track-corridors.ts';

function straight(id: string, points: [number, number][]): TrackRoute {
	return {
		id,
		source: `${id}-from`,
		target: `${id}-to`,
		waypoints: points.map(([x, y]) => ({ x, y }))
	};
}

function bundles(routes: TrackRoute[], unit = 1) {
	return findBundles(routes, unit, createWorkBudget());
}

describe('longestLeg', () => {
	it('picks the longest segment of a bent route and keeps route direction', () => {
		const route = straight('bent', [
			[0, 0],
			[50, 0],
			[50, 200],
			[60, 200]
		]);
		expect(longestLeg(route)).toEqual({
			id: 'bent',
			index: 1,
			a: { x: 50, y: 0 },
			b: { x: 50, y: 200 }
		});
	});

	it('returns undefined for a route with a single point', () => {
		expect(longestLeg(straight('dot', [[0, 0]]))).toBeUndefined();
	});
});

describe('findBundles', () => {
	it('bundles two long parallel ties 10 apart', () => {
		expect(
			bundles([
				straight('a', [
					[0, 0],
					[300, 0]
				]),
				straight('b', [
					[0, 10],
					[300, 10]
				])
			])
		).toEqual([['a', 'b']]);
	});

	it('never bundles a tie shorter than the minimum, even beside a long parallel one', () => {
		expect(
			bundles([
				straight('long', [
					[0, 0],
					[300, 0]
				]),
				straight('short', [
					[0, 5],
					[100, 5]
				])
			])
		).toEqual([]);
	});

	it('leaves out ties 60 apart, ties 20 degrees apart and ties overlapping only 50 along the axis', () => {
		const base = straight('base', [
			[0, 0],
			[300, 0]
		]);
		expect(
			bundles([
				base,
				straight('far', [
					[0, 60],
					[300, 60]
				])
			])
		).toEqual([]);
		// Centred on x = 260 so the offset stays within joinDistancePx; only the angle fails.
		const half = 65;
		const cos20 = Math.cos((20 * Math.PI) / 180);
		const sin20 = Math.sin((20 * Math.PI) / 180);
		expect(
			bundles([
				base,
				straight('angled', [
					[260 - half * cos20, -half * sin20],
					[260 + half * cos20, half * sin20]
				])
			])
		).toEqual([]);
		// Same geometry at 5 degrees bundles, so the angled case above is not vacuous.
		const cos5 = Math.cos((5 * Math.PI) / 180);
		const sin5 = Math.sin((5 * Math.PI) / 180);
		expect(
			bundles([
				base,
				straight('gentle', [
					[260 - half * cos5, -half * sin5],
					[260 + half * cos5, half * sin5]
				])
			])
		).toEqual([['base', 'gentle']]);
		expect(
			bundles([
				base,
				straight('overlap50', [
					[250, 10],
					[400, 10]
				])
			])
		).toEqual([]);
	});

	it('bundles a reversed tie with its parallel neighbour', () => {
		expect(
			bundles([
				straight('a', [
					[0, 0],
					[300, 0]
				]),
				straight('b', [
					[300, 10],
					[0, 10]
				])
			])
		).toEqual([['a', 'b']]);
	});

	it('bundles transitively: near neighbours join even when the outer pair is 40 apart', () => {
		expect(
			bundles([
				straight('a', [
					[0, 0],
					[300, 0]
				]),
				straight('b', [
					[0, 20],
					[300, 20]
				]),
				straight('c', [
					[0, 40],
					[300, 40]
				])
			])
		).toEqual([['a', 'b', 'c']]);
	});

	it('caps a bundle at six ids and is independent of input order', () => {
		const ties = [1, 2, 3, 4, 5, 6, 7].map((n) =>
			straight(`t${n}`, [
				[0, 4 * (n - 1)],
				[300, 4 * (n - 1)]
			])
		);
		const expected = [['t1', 't2', 't3', 't4', 't5', 't6']];
		expect(bundles(ties)).toEqual(expected);
		expect(bundles([...ties].reverse())).toEqual(expected);
		expect(bundles([ties[3], ties[0], ties[6], ties[2], ties[5], ties[1], ties[4]])).toEqual(
			expected
		);
	});

	it('gives the same bundles when every coordinate is doubled and unit is doubled', () => {
		const at1 = bundles([
			straight('a', [
				[0, 0],
				[300, 0]
			]),
			straight('b', [
				[0, 10],
				[300, 10]
			]),
			straight('c', [
				[0, 60],
				[300, 60]
			])
		]);
		const at2 = bundles(
			[
				straight('a', [
					[0, 0],
					[600, 0]
				]),
				straight('b', [
					[0, 20],
					[600, 20]
				]),
				straight('c', [
					[0, 120],
					[600, 120]
				])
			],
			2
		);
		expect(at1).toEqual([['a', 'b']]);
		expect(at2).toEqual(at1);
	});

	it('throws WorkExhausted when the routing allowance runs out', () => {
		const budget = createWorkBudget({ placement: 0, routing: 5, evaluation: 0 });
		const ties = [
			straight('a', [
				[0, 0],
				[300, 0]
			]),
			straight('b', [
				[0, 10],
				[300, 10]
			])
		];
		expect(() => findBundles(ties, 1, budget)).toThrow(WorkExhausted);
	});
});
