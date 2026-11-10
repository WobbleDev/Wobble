// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { fitGroupsToCanvas } from './graph-canvas-fit.ts';

/** Three groups stacked in a tall column, each a pair of Workers. */
function column() {
	const groups = ['top', 'middle', 'bottom'];
	const centres = new Map(groups.map((key, index) => [key, { x: 0, y: index * 300 }]));
	const positions = new Map<string, { x: number; y: number }>();
	const memberOf = new Map<string, string>();
	for (const [key, centre] of centres) {
		positions.set(`${key}-a`, { x: centre.x - 40, y: centre.y });
		positions.set(`${key}-b`, { x: centre.x + 40, y: centre.y + 10 });
		memberOf.set(`${key}-a`, key);
		memberOf.set(`${key}-b`, key);
	}
	return { centres, positions, memberOf };
}

const extent = (points: Iterable<{ x: number; y: number }>) => {
	const list = [...points];
	const xs = list.map((p) => p.x);
	const ys = list.map((p) => p.y);
	return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

describe('fitGroupsToCanvas', () => {
	it('lays a tall column of groups along a wide canvas', () => {
		const { centres, positions, memberOf } = column();
		const fitted = fitGroupsToCanvas({
			positions,
			centres,
			memberOf,
			radiusFor: () => 6,
			canvas: { width: 1600, height: 800 },
			gap: 40,
			padding: 20
		});
		const { w, h } = extent(fitted.centres.values());
		expect(w).toBeGreaterThan(h);
	});

	it('moves each group whole, so its shape is unchanged', () => {
		const { centres, positions, memberOf } = column();
		const fitted = fitGroupsToCanvas({
			positions,
			centres,
			memberOf,
			radiusFor: () => 6,
			canvas: { width: 1600, height: 800 },
			gap: 40,
			padding: 20
		});
		for (const key of ['top', 'middle', 'bottom']) {
			const a = fitted.positions.get(`${key}-a`)!;
			const b = fitted.positions.get(`${key}-b`)!;
			expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(Math.hypot(80, 10), 6);
		}
	});

	it('keeps groups apart by the gap', () => {
		const { centres, positions, memberOf } = column();
		const fitted = fitGroupsToCanvas({
			positions,
			centres,
			memberOf,
			radiusFor: () => 6,
			// A very wide canvas pulls rows together as far as they can go.
			canvas: { width: 4000, height: 200 },
			gap: 40,
			padding: 20
		});
		const ids = [...fitted.positions.keys()];
		for (const a of ids)
			for (const b of ids) {
				if (memberOf.get(a) === memberOf.get(b)) continue;
				const p = fitted.positions.get(a)!;
				const q = fitted.positions.get(b)!;
				expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(40);
			}
	});
});
