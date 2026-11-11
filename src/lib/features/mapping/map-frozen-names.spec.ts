// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { cliquesWorksite, hubBundleWorksite } from '../../../../e2e/mapping-composition-dataset.ts';
import { worksiteGraph } from '#lib/testing/mapping/composition-worksite-fixture.ts';
import {
	freeNamedMap,
	nameSide,
	standoff,
	type FreeNamedMap
} from '#lib/testing/mapping/free-name-fixture.ts';
import { attachName, freezeName, thawName } from './map-frozen-names.ts';
import type { PlacedName } from './map-name-placement.ts';

const placed: PlacedName = {
	x: 130,
	y: 60,
	textAnchor: 'start',
	side: 'right',
	box: { left: 130, right: 190, top: 53, bottom: 67 }
};

describe('frozen names', () => {
	const dot = { x: 100, y: 60 };

	it('thaws to exactly the placement at the zoom it was frozen at', () => {
		const frozen = freezeName(placed, dot, 6, 2);
		const back = thawName(frozen, dot, 6, 2);
		expect(back.x).toBeCloseTo(placed.x, 9);
		expect(back.y).toBeCloseTo(placed.y, 9);
		expect(back.box.right).toBeCloseTo(placed.box.right, 9);
	});

	it('keeps its side and its screen size at any other zoom', () => {
		const frozen = freezeName(placed, dot, 6, 2);
		for (const zoom of [0.5, 1, 4]) {
			const now = thawName(frozen, dot, 6, zoom);
			expect(now.side).toBe('right');
			expect((now.box.right - now.box.left) * zoom).toBeCloseTo(120, 6);
			expect((now.box.bottom - now.box.top) * zoom).toBeCloseTo(28, 6);
		}
	});

	it('travels with its dot and with nothing else', () => {
		const frozen = freezeName(placed, dot, 6, 2);
		const moved = thawName(frozen, { x: 140, y: 10 }, 6, 2);
		expect(moved.x).toBeCloseTo(placed.x + 40, 9);
		expect(moved.y).toBeCloseTo(placed.y - 50, 9);
	});

	it('attaches a newly revealed name to the right of its dot without a search', () => {
		const name = attachName(dot, 6, { width: 40, height: 14 }, 2);
		expect(name.side).toBe('right');
		expect(name.x).toBeCloseTo(100 + 6 + 3, 9);
		expect(name.y).toBe(60);
	});
});

it('keeps the nearest screen gap constant for an off-center name at every zoom', () => {
	const name: PlacedName = {
		x: 20,
		y: 8,
		textAnchor: 'start',
		side: 'right',
		box: { left: 20, right: 100, top: -2, bottom: 12 }
	};
	const frozen = freezeName(name, { x: 0, y: 0 }, 6, 1);
	for (const zoom of [0.5, 1, 2, 4]) {
		const now = thawName(frozen, { x: 0, y: 0 }, 6, zoom);
		expect((now.box.left - 6) * zoom).toBeCloseTo(14, 9);
		expect(now.box.top).toBeLessThanOrEqual(0);
		expect(now.box.bottom).toBeGreaterThanOrEqual(0);
	}
});

/** The zoom a press of the zoom buttons takes: 30% a step. */
const zoomStep = 1.3;

const nearFixtures = [
	['cliques', cliquesWorksite()],
	['hub-bundle', hubBundleWorksite()]
] as const;

/** The names a Free map draws at a zoom: each frozen name thawed there, by arithmetic. */
function drawnAt(map: FreeNamedMap, zoom: number) {
	return new Map(
		[...map.frozen].map(([id, frozen]) => [
			id,
			thawName(frozen, map.positions.get(id)!, map.radiusFor(map.nodeById.get(id)!), zoom)
		])
	);
}

/** Camera changes preserve attachments: each name keeps its side and its gap in screen pixels. */
function expectRestingNamesKept(
	map: FreeNamedMap,
	before: ReadonlyMap<string, PlacedName>,
	beforeZoom: number,
	after: ReadonlyMap<string, PlacedName>,
	afterZoom: number,
	when: string
) {
	for (const [id, name] of before) {
		const now = after.get(id);
		expect(now, `${when}: ${id} is still drawn`).toBeDefined();
		const dot = map.dot(id);
		expect(nameSide(dot, now!.box), `${when}: ${id} keeps its side`).toBe(nameSide(dot, name.box));
		expect(
			Math.abs(standoff(dot, now!.box) * afterZoom - standoff(dot, name.box) * beforeZoom),
			`${when}: ${id} keeps its screen gap`
		).toBeLessThan(1.5);
	}
}

/**
 * Zooming out widens every screen-fixed name in map units, so a kept spot can be
 * covered where zooming in keeps it clear. A covered spot is re-placed by design:
 * only a name that kept its side must also keep its screen gap.
 */
function expectRestingNamesKeptOrReplaced(
	map: FreeNamedMap,
	before: ReadonlyMap<string, PlacedName>,
	beforeZoom: number,
	after: ReadonlyMap<string, PlacedName>,
	afterZoom: number,
	when: string
) {
	for (const [id, name] of before) {
		const now = after.get(id);
		expect(now, `${when}: ${id} is still drawn`).toBeDefined();
		const dot = map.dot(id);
		if (nameSide(dot, now!.box) !== nameSide(dot, name.box)) continue;
		expect(
			Math.abs(standoff(dot, now!.box) * afterZoom - standoff(dot, name.box) * beforeZoom),
			`${when}: ${id} keeps its screen gap`
		).toBeLessThan(1.5);
	}
}

describe('frozen names on a framed Free map', () => {
	for (const [slug, worksite] of nearFixtures) {
		const map = freeNamedMap(worksiteGraph(worksite), { width: 1000, height: 1000 });
		const zoom = map.camera.zoom;
		const before = drawnAt(map, zoom);

		it(`draws the names as they were placed at the framing (${slug})`, () => {
			expect(before.size, 'names are shown at rest').toBeGreaterThan(0);
			for (const [id, name] of before) {
				expect(name.box.left).toBeCloseTo(map.placed.get(id)!.box.left, 6);
				expect(name.box.top).toBeCloseTo(map.placed.get(id)!.box.top, 6);
			}
		});

		it(`holds each resting name on its side of the dot while zooming in (${slug})`, () => {
			const zoomedIn = zoom * zoomStep ** 3;
			const after = drawnAt(map, zoomedIn);
			let moved = 0;
			for (const [id, name] of before) {
				const now = after.get(id);
				const dot = map.dot(id);
				if (
					!now ||
					nameSide(dot, now.box) !== nameSide(dot, name.box) ||
					Math.abs(standoff(dot, now.box) * zoomedIn - standoff(dot, name.box) * zoom) >= 1.5
				)
					moved += 1;
			}
			expect(moved, 'zooming in covers no kept spot').toBe(0);
			expectRestingNamesKept(map, before, zoom, after, zoomedIn, 'zooming in');
		});

		it(`keeps every resting name near its dot while zooming out (${slug})`, () => {
			const zoomedOut = zoom / zoomStep ** 3;
			const after = drawnAt(map, zoomedOut);
			expect(after.size, 'every resting name is still drawn').toBe(before.size);
			expectRestingNamesKeptOrReplaced(map, before, zoom, after, zoomedOut, 'zooming out');
		});
	}
});
