// @module-tag mapping
import { describe, expect, it } from 'vitest';
import {
	drawnPosition,
	groupPairKey,
	optimalRotation,
	settlePhysics,
	wrappedAngle,
	type GroupBody
} from './graph-group-physics.ts';

const body = (key: string, x: number, y: number, radius: number): GroupBody => ({
	key,
	x,
	y,
	radius,
	crossTies: 0
});

describe('physicsTick / settlePhysics', () => {
	it('pushes overlapping bodies apart past their radii + gap', () => {
		const bodies = [body('a', -10, 0, 40), body('b', 10, 0, 40)];
		const start = {
			centres: new Map([
				['a', { x: -10, y: 0 }],
				['b', { x: 10, y: 0 }]
			]),
			rotations: new Map<string, number>()
		};
		const settled = settlePhysics(start, {
			bodies,
			partnersByGroup: new Map(),
			offsetsByGroup: new Map(),
			gap: 80,
			canvas: { width: 1200, height: 800 }
		});

		const a = settled.centres.get('a') as { x: number; y: number };
		const b = settled.centres.get('b') as { x: number; y: number };
		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(40 + 40 + 80 - 2);
	});

	it('pulls tie-holding bodies together without touching', () => {
		const a = { ...body('a', 0, 0, 40), crossTies: 10 };
		const b = { ...body('b', 600, 0, 40), crossTies: 10 };
		const start = {
			centres: new Map([
				['a', { x: 100, y: 300 }],
				['b', { x: 700, y: 300 }]
			]),
			rotations: new Map<string, number>()
		};
		const settled = settlePhysics(start, {
			bodies: [a, b],
			partnersByGroup: new Map(),
			offsetsByGroup: new Map(),
			gap: 30,
			canvas: { width: 1200, height: 800 }
		});

		const ca = settled.centres.get('a') as { x: number; y: number };
		const cb = settled.centres.get('b') as { x: number; y: number };
		const distance = Math.hypot(ca.x - cb.x, ca.y - cb.y);
		// They came closer than 600 but never inside min distance.
		expect(distance).toBeLessThan(600);
		expect(distance).toBeGreaterThanOrEqual(a.radius + b.radius + 30 - 1e-6);
	});

	it('attracts only pairs with shared Relationships, independent of pair order', () => {
		const a = { ...body('a', 0, 0, 40), crossTies: 12 };
		const b = { ...body('b', 600, 0, 40), crossTies: 12 };
		const start = () => ({
			centres: new Map([
				['a', { x: 300, y: 300 }],
				['b', { x: 900, y: 300 }]
			]),
			rotations: new Map<string, number>()
		});
		const input = {
			partnersByGroup: new Map(),
			offsetsByGroup: new Map(),
			gap: 30,
			canvas: { width: 1200, height: 800 }
		};
		const unrelated = settlePhysics(
			start(),
			{
				...input,
				bodies: [a, b],
				relationshipCountsByPair: new Map()
			},
			{ maxTicks: 1 }
		);
		const related = settlePhysics(
			start(),
			{
				...input,
				bodies: [a, b],
				relationshipCountsByPair: new Map([[groupPairKey('a', 'b'), 3]])
			},
			{ maxTicks: 1 }
		);
		const reversed = settlePhysics(
			start(),
			{
				...input,
				bodies: [b, a],
				relationshipCountsByPair: new Map([[groupPairKey('b', 'a'), 3]])
			},
			{ maxTicks: 1 }
		);
		const distance = (centres: Map<string, { x: number; y: number }>) =>
			Math.hypot(
				(centres.get('a')?.x ?? 0) - (centres.get('b')?.x ?? 0),
				(centres.get('a')?.y ?? 0) - (centres.get('b')?.y ?? 0)
			);

		expect(distance(unrelated.centres)).toBeLessThan(600);
		expect(distance(related.centres)).toBeLessThan(distance(unrelated.centres));
		expect(reversed.centres).toEqual(related.centres);
	});

	it('stops: repeated settlePhysics converges', () => {
		const bodies = [body('a', -50, 0, 40), body('b', 50, 0, 40)];
		const start = {
			centres: new Map([
				['a', { x: -50, y: 0 }],
				['b', { x: 50, y: 0 }]
			]),
			rotations: new Map<string, number>()
		};
		const once = settlePhysics(start, {
			bodies,
			partnersByGroup: new Map(),
			offsetsByGroup: new Map(),
			gap: 80,
			canvas: { width: 1200, height: 800 }
		});
		const twice = settlePhysics(once, {
			bodies,
			partnersByGroup: new Map(),
			offsetsByGroup: new Map(),
			gap: 80,
			canvas: { width: 1200, height: 800 }
		});

		expect(twice.centres.get('a')).toEqual(once.centres.get('a'));
	});

	it('clamps every body inside the canvas by radius + 8', () => {
		const bodies = [body('a', 10, 10, 60)];
		const start = { centres: new Map([['a', { x: 2, y: 2 }]]), rotations: new Map() };
		const settled = settlePhysics(start, {
			bodies,
			partnersByGroup: new Map(),
			offsetsByGroup: new Map(),
			gap: 80,
			canvas: { width: 400, height: 300 }
		});

		const c = settled.centres.get('a') as { x: number; y: number };
		expect(c.x).toBeGreaterThanOrEqual(60 + 8 - 1e-6);
		expect(c.y).toBeGreaterThanOrEqual(60 + 8 - 1e-6);
		expect(c.x).toBeLessThanOrEqual(400 - 60 - 8 + 1e-6);
		expect(c.y).toBeLessThanOrEqual(300 - 60 - 8 + 1e-6);
	});

	it('keeps a dragged body pinned', () => {
		const bodies = [body('a', -10, 0, 40), body('b', 30, 0, 40)];
		const start = {
			centres: new Map([
				['a', { x: 100, y: 100 }],
				['b', { x: 110, y: 100 }]
			]),
			rotations: new Map<string, number>()
		};
		const settled = settlePhysics(start, {
			bodies,
			partnersByGroup: new Map(),
			offsetsByGroup: new Map(),
			gap: 80,
			draggedKeys: new Set(['a']),
			canvas: { width: 1200, height: 800 }
		});

		// The dragged body's centre never moves from where the drag held it.
		expect(settled.centres.get('a')).toEqual({ x: 100, y: 100 });
		// The other body was pushed out to at least the two radii + gap, and
		// stays inside the canvas like any free body would.
		const b = settled.centres.get('b') as { x: number; y: number };
		expect(Math.hypot(b.x - 100, b.y - 100)).toBeGreaterThanOrEqual(40 + 40 + 80 - 2);
		expect(b.x).toBeGreaterThanOrEqual(40 + 8 - 1e-6);
		expect(b.y).toBeGreaterThanOrEqual(40 + 8 - 1e-6);
	});

	it('converges rotations toward the optimal angle', () => {
		// offsets with +x bridges, partner to the right of centre; start rotated.
		const offsets = new Map([['m', { x: 30, y: 0 }]]);
		const partners = new Map([['g', [{ memberId: 'm', direction: { x: 0, y: 1 } }]]]);
		const start = {
			centres: new Map([['g', { x: 300, y: 300 }]]),
			rotations: new Map([['g', Math.PI]])
		};
		const settled = settlePhysics(
			start,
			{
				bodies: [body('g', 300, 300, 40)],
				partnersByGroup: partners,
				offsetsByGroup: new Map([['g', offsets]]),
				gap: 80,
				canvas: { width: 1200, height: 800 }
			},
			{ maxTicks: 400 }
		);

		const rotation = settled.rotations.get('g') as number;
		const optimal = optimalRotation(offsets, partners.get('g') as never[]);
		expect(Math.abs(wrappedAngle(rotation, optimal))).toBeLessThan(0.05);
	});
});

describe('drawnPosition', () => {
	it('is the rotated offset about the centre', () => {
		const point = drawnPosition({ x: 10, y: 20 }, Math.PI / 2, { x: 1, y: 0 });
		expect(point.x).toBeCloseTo(10, 10);
		expect(point.y).toBeCloseTo(21, 10);
	});
});

describe('wrappedAngle / optimalRotation', () => {
	it('wraps into (-π, π]', () => {
		expect(wrappedAngle(0, (Math.PI * 3) / 2)).toBeCloseTo(-Math.PI / 2, 10);
		expect(wrappedAngle((Math.PI * 7) / 4, 0)).toBeCloseTo(Math.PI / 4, 10);
	});

	it('solves the Procrustes angle toward a single partner', () => {
		// offset along +x, partner to the right: rotation 0.
		expect(
			optimalRotation(new Map([['m', { x: 1, y: 0 }]]), [
				{ memberId: 'm', direction: { x: 1, y: 0 } }
			])
		).toBeCloseTo(0, 10);
		// partner below: rotation should carry +x toward +y (+π/2 in SVG coords).
		expect(
			optimalRotation(new Map([['m', { x: 1, y: 0 }]]), [
				{ memberId: 'm', direction: { x: 0, y: 1 } }
			])
		).toBeCloseTo(Math.PI / 2, 10);
	});
});
