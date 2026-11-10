// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { mapPath, shiftRoute, shifted, translateGroupRegions } from './graph-manual.ts';
import type { GroupRegion } from './graph-layout.ts';
import type { Route } from './graph-relationship-routing.ts';

const route = (d: string, waypoints: { x: number; y: number }[]): Route => ({
	id: 'r',
	source: 'a',
	target: 'b',
	d,
	waypoints,
	length: 0,
	direct: false,
	blockers: []
});

describe('mapPath', () => {
	it('rewrites every coordinate pair of M, L and Q commands', () => {
		expect(mapPath('M 0 0 L 10 0 Q 20 0 20 10', (p) => ({ x: p.x + 1, y: p.y + 2 }))).toBe(
			'M 1 2 L 11 2 Q 21 2 21 12'
		);
	});
});

describe('shiftRoute', () => {
	const path = route('M 0 0 L 10 0 Q 20 0 20 10 L 20 30', [
		{ x: 0, y: 0 },
		{ x: 20, y: 0 },
		{ x: 20, y: 30 }
	]);

	it('leaves an untouched path as it is', () => {
		expect(shiftRoute(path, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(path);
	});

	it('translates a path rigidly when both ends move together', () => {
		const moved = shiftRoute(path, { x: 5, y: -5 }, { x: 5, y: -5 });
		expect(moved.d).toBe('M 5 -5 L 15 -5 Q 25 -5 25 5 L 25 25');
		expect(moved.waypoints[2]).toEqual({ x: 25, y: 25 });
	});

	it('keeps both ends attached when only one moves, blending between', () => {
		const moved = shiftRoute(path, { x: 0, y: 0 }, { x: 0, y: 40 });
		expect(moved.waypoints[0]).toEqual({ x: 0, y: 0 });
		expect(moved.waypoints[2]).toEqual({ x: 20, y: 70 });
		expect(moved.d.startsWith('M 0 0')).toBe(true);
		expect(moved.d.endsWith('L 20 70')).toBe(true);
	});
});

describe('shifted', () => {
	it('adds deltas and drops an entry that returns to nothing', () => {
		const once = shifted(new Map(), 'a', { x: 3, y: 4 });
		expect(once.get('a')).toEqual({ x: 3, y: 4 });
		expect(shifted(once, 'a', { x: -3, y: -4 }).size).toBe(0);
	});
});

describe('frozen group geometry', () => {
	const child = {
		key: 'a::child',
		label: 'Child',
		hull: [{ x: 1, y: 2 }],
		path: 'M 1 2 L 3 4 Z',
		top: 2,
		labelX: 1,
		labelAt: { x: 1, y: 0, textAnchor: 'start' as const },
		outlined: true
	};
	const region: GroupRegion = { ...child, key: 'a', label: 'A', subRegions: [child] };
	it('returns untouched groups without repacking or relocating headings', () => {
		expect(translateGroupRegions([region], new Map(), new Map())[0]).toBe(region);
	});
	it('translates a group outline and every heading rigidly, including children', () => {
		const [moved] = translateGroupRegions(
			[region],
			new Map([['a', { x: 10, y: 20 }]]),
			new Map([['a', { x: 40, y: 60 }]])
		);
		expect(moved.labelAt).toEqual({ ...region.labelAt, x: 31, y: 40 });
		expect(moved.subRegions[0].labelAt).toEqual(moved.labelAt);
		expect(moved.path).toBe('M 31 42 L 33 44 Z');
		expect(region.labelAt.x).toBe(1);
	});
});
