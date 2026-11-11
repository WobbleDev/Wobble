// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { tidyLayout } from './graph-tidy.ts';
import type { StressPoint } from './graph-stress.ts';

const radius = () => 5;

function distanceToSegment(point: StressPoint, a: StressPoint, b: StressPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const t = Math.max(
		0,
		Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy))
	);
	return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

describe('tidyLayout', () => {
	it('moves a tie off a dot it does not end at', () => {
		const positions = new Map([
			['a', { x: 0, y: 0 }],
			['b', { x: 120, y: 0 }],
			['c', { x: 60, y: 1 }],
			['d', { x: 60, y: 80 }]
		]);
		const links = [
			{ source: 'a', target: 'b' },
			{ source: 'c', target: 'd' }
		];
		const tidy = tidyLayout(positions, links, radius);
		expect(distanceToSegment(tidy.get('c')!, tidy.get('a')!, tidy.get('b')!)).toBeGreaterThan(9);
	});

	it('untangles a crossing that lands near the end of a tie', () => {
		// c–d crosses a–b just beside a.
		const positions = new Map([
			['a', { x: 0, y: 0 }],
			['b', { x: 120, y: 0 }],
			['c', { x: 12, y: -40 }],
			['d', { x: 12, y: 40 }],
			['e', { x: 60, y: 60 }]
		]);
		const links = [
			{ source: 'a', target: 'b' },
			{ source: 'c', target: 'd' },
			{ source: 'd', target: 'e' }
		];
		const tidy = tidyLayout(positions, links, radius);
		const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => tidy.get(id)!);
		const side = (p: StressPoint) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
		const crosses =
			Math.sign(side(c)) !== Math.sign(side(d)) &&
			Math.sign((d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x)) !==
				Math.sign((d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x));
		expect(crosses).toBe(false);
	});

	it('keeps each Worker inside its bound', () => {
		const positions = new Map([
			['a', { x: 0, y: 0 }],
			['b', { x: 120, y: 0 }],
			['c', { x: 60, y: 1 }],
			['d', { x: 60, y: 80 }]
		]);
		const links = [
			{ source: 'a', target: 'b' },
			{ source: 'c', target: 'd' }
		];
		const bound = { centre: { x: 60, y: 1 }, radius: 7 };
		const tidy = tidyLayout(positions, links, radius, { bounds: new Map([['c', bound]]) });
		const c = tidy.get('c')!;
		expect(Math.hypot(c.x - 60, c.y - 1) + 5).toBeLessThanOrEqual(7 + 1e-9);
	});
});
