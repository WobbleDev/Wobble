// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { fanLeaves } from './graph-leaf-placement.ts';
import type { StressPoint } from './graph-stress.ts';

const TAU = Math.PI * 2;

function angleFrom(hub: StressPoint, p: StressPoint) {
	return (Math.atan2(p.y - hub.y, p.x - hub.x) + TAU) % TAU;
}

describe('fanLeaves', () => {
	it('degree-one Workers fill the open angle around their hub', () => {
		expect.assertions(3);
		// Same topology as e2e/mapping-leaves.spec.ts: Hub (0) tied to Core A (1),
		// Core B (2) and three leaves (3,4,5); cores tied to each other.
		const positions = new Map<string, StressPoint>([
			['hub', { x: 0, y: 0 }],
			['core-a', { x: 100, y: 0 }],
			['core-b', { x: 0, y: 100 }],
			['leaf-a', { x: 1, y: 1 }],
			['leaf-b', { x: 2, y: 2 }],
			['leaf-c', { x: 3, y: 3 }]
		]);
		const links = [
			{ source: 'hub', target: 'core-a' },
			{ source: 'hub', target: 'core-b' },
			{ source: 'hub', target: 'leaf-a' },
			{ source: 'hub', target: 'leaf-b' },
			{ source: 'hub', target: 'leaf-c' },
			{ source: 'core-a', target: 'core-b' },
			{ source: 'core-a', target: 'hub' },
			{ source: 'core-b', target: 'hub' }
		];
		const placed = fanLeaves(positions, links, () => 4);
		const hub = placed.get('hub')!;
		const occupied = [
			angleFrom(hub, placed.get('core-a')!),
			angleFrom(hub, placed.get('core-b')!)
		].sort((a, b) => a - b);
		const forward = occupied[1] - occupied[0];
		const start = forward > Math.PI ? occupied[0] : occupied[1];
		const gap = Math.max(forward, TAU - forward);
		const leaves = ['leaf-a', 'leaf-b', 'leaf-c']
			.map((id) => (angleFrom(hub, placed.get(id)!) - start + TAU) % TAU)
			.sort((a, b) => a - b);
		for (let i = 0; i < 3; i += 1) expect(leaves[i]).toBeCloseTo((gap * (i + 1)) / 4, 1);
	});

	it('leaves a lone hub and dyads untouched', () => {
		expect.assertions(2);
		const positions = new Map<string, StressPoint>([
			['solo', { x: 0, y: 0 }],
			['a', { x: 10, y: 0 }],
			['b', { x: 20, y: 0 }]
		]);
		const placed = fanLeaves(positions, [{ source: 'a', target: 'b' }], () => 4);
		expect(placed.get('a')).toEqual({ x: 10, y: 0 });
		expect(placed.get('b')).toEqual({ x: 20, y: 0 });
	});
});
