// @module-tag mapping
import { describe, expect, it } from 'vitest';
import {
	flattenedRoutes,
	haloClipPathOf,
	layoutReservedRects,
	regionKeysOf,
	settledFrameOf
} from './map-drawing.ts';
import type { WorkerGraphNode } from './worker-relationship-map-model.ts';

const node = (id: string) => ({ id, name: id }) as unknown as WorkerGraphNode;

describe('settledFrameOf', () => {
	const base = {
		visibleNodes: [node('a'), node('b')],
		positions: new Map([
			['a', { x: 0, y: 0 }],
			['b', { x: 100, y: 50 }]
		]),
		baseRadiusFor: () => 10,
		labelGap: 8,
		grouped: false,
		composedFrame: undefined,
		regions: []
	};

	it('pads the dots by the widest radius and the label gap', () => {
		expect(settledFrameOf(base)).toEqual({ x: -18, y: -18, width: 136, height: 86 });
	});

	it('is nothing without drawn Workers', () => {
		expect(settledFrameOf({ ...base, visibleNodes: [] })).toBeUndefined();
	});

	it('uses a composition frame when grouped', () => {
		const composedFrame = { x: 1, y: 2, width: 3, height: 4 };
		expect(settledFrameOf({ ...base, grouped: true, composedFrame })).toEqual(composedFrame);
		expect(settledFrameOf({ ...base, composedFrame })).toEqual({
			x: -18,
			y: -18,
			width: 136,
			height: 86
		});
	});
});

describe('layoutReservedRects', () => {
	it('puts each key in its bottom corner of the free canvas, 12px in', () => {
		expect(
			layoutReservedRects({
				floating: true,
				free: { width: 800, height: 600 },
				keySize: { width: 100, height: 40 },
				dotKeySize: { width: 60, height: 30 }
			})
		).toEqual([
			{ x: 12, y: 548, width: 100, height: 40 },
			{ x: 728, y: 558, width: 60, height: 30 }
		]);
	});

	it('reserves nothing when the chrome is not floating or a key is unmeasured', () => {
		const free = { width: 800, height: 600 };
		const keySize = { width: 100, height: 40 };
		expect(layoutReservedRects({ floating: false, free, keySize, dotKeySize: keySize })).toEqual(
			[]
		);
		expect(
			layoutReservedRects({
				floating: true,
				free,
				keySize: { width: 0, height: 0 },
				dotKeySize: undefined
			})
		).toEqual([]);
	});
});

describe('regionKeysOf', () => {
	it('is empty without ids', () => {
		expect(regionKeysOf([node('a')], undefined, undefined, undefined).size).toBe(0);
		expect(regionKeysOf([node('a')], new Set(), undefined, undefined).size).toBe(0);
	});
});

describe('haloClipPathOf', () => {
	it('is empty without dots', () => {
		expect(haloClipPathOf([])).toBe('');
	});

	it('boxes the hit areas and cuts a hole one unit wider than each dot', () => {
		expect(haloClipPathOf([{ x: 5, y: 5, radius: 4, hit: 10 }])).toBe(
			'M -5 -5 H 15 V 15 H -5 Z M 0 5 a 5 5 0 1 0 10 0 a 5 5 0 1 0 -10 0 Z'
		);
	});
});

describe('flattenedRoutes', () => {
	it('is nothing without published routes', () => {
		expect(flattenedRoutes(undefined, 1)).toBeUndefined();
	});

	it('flattens a straight path to one tie segment', () => {
		const routes = new Map([['a-b', { d: 'M 0 0 L 10 0', source: 'a', target: 'b' }]]);
		expect(flattenedRoutes(routes, 1)).toEqual([
			{ source: 'a', target: 'b', ax: 0, ay: 0, bx: 10, by: 0 }
		]);
	});
});
