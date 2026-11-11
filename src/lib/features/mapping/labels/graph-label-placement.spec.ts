// @module-tag mapping
import { describe, expect, it } from 'vitest';
import {
	boxFor,
	estimateLabelWidth,
	mapLabelText,
	placeLabels,
	placeRegionLabels,
	type LabelRequest,
	type Obstacle
} from './graph-label-placement.ts';

const request = (overrides: Partial<LabelRequest> = {}): LabelRequest => ({
	id: 'a',
	x: 0,
	y: 0,
	radius: 6,
	width: 70,
	height: 12,
	...overrides
});

describe('placeLabels with ties', () => {
	it('steps off a tie that would run under the first spot', () => {
		const ties = [{ source: 'x', target: 'y', ax: -50, ay: 20, bx: 50, by: 20 }];
		const [label] = placeLabels([request()], [], 8, [], ties).values();
		expect(label.side).not.toBe('below');
	});

	it('still places a label when every spot has a tie under it', () => {
		const ties = Array.from({ length: 12 }, (_, index) => ({
			source: 'x',
			target: 'y',
			ax: -200,
			ay: -110 + index * 20,
			bx: 200,
			by: -110 + index * 20
		}));
		expect(placeLabels([request()], [], 8, [], ties).has('a')).toBe(true);
	});
});

describe('placeLabels', () => {
	it('puts a lone label below its dot', () => {
		const [label] = placeLabels([request()], [], 8).values();
		expect(label).toMatchObject({ side: 'below', x: 0, y: 20, textAnchor: 'middle' });
	});

	it('moves right when a dot sits under its label', () => {
		const obstacles: Obstacle[] = [{ id: 'b', x: 0, y: 20, radius: 6 }];
		const [label] = placeLabels([request()], obstacles, 8).values();
		expect(label.side).toBe('right');
	});

	it('separates two labels whose dots touch', () => {
		const requests = [request(), request({ id: 'b', x: 20 })];
		const labels = placeLabels(requests, requests, 8);
		const boxes = requests.map((item) => {
			const label = labels.get(item.id)!;
			const left = label.textAnchor === 'middle' ? label.x - item.width / 2 : label.x;
			return {
				left,
				right: left + item.width,
				top: label.y - item.height / 2,
				bottom: label.y + item.height / 2
			};
		});
		expect(
			boxes[0].right <= boxes[1].left ||
				boxes[1].right <= boxes[0].left ||
				boxes[0].bottom <= boxes[1].top ||
				boxes[1].bottom <= boxes[0].top
		).toBe(true);
	});

	it('moves out to a diagonal or a farther ring when the four sides are boxed in', () => {
		const blockers: Obstacle[] = [
			{ id: 'b', x: 0, y: 20, radius: 8 },
			{ id: 'c', x: 30, y: 0, radius: 8 },
			{ id: 'd', x: -30, y: 0, radius: 8 },
			{ id: 'e', x: 0, y: -20, radius: 8 }
		];
		const placed = [...placeLabels([request()], blockers, 8).values()][0];
		const box = {
			left: placed.textAnchor === 'start' ? placed.x : placed.x - 70,
			right: placed.textAnchor === 'start' ? placed.x + 70 : placed.x,
			top: placed.y - 6,
			bottom: placed.y + 6
		};
		for (const blocker of blockers) {
			const nearestX = Math.max(box.left, Math.min(blocker.x, box.right));
			const nearestY = Math.max(box.top, Math.min(blocker.y, box.bottom));
			expect(Math.hypot(nearestX - blocker.x, nearestY - blocker.y)).toBeGreaterThanOrEqual(8);
		}
	});

	it('keeps a name off a group label that is already on the map', () => {
		const groupLabel = { left: -40, right: 40, top: 8, bottom: 22 };
		const placed = [...placeLabels([request()], [], 8, [groupLabel]).values()][0];
		expect(placed.side).not.toBe('below');
	});

	it('places a label 5× wider than at 1× without overlapping dots', () => {
		const obstacles: Obstacle[] = Array.from({ length: 8 }, (_, index) => {
			const angle = (index / 8) * Math.PI * 2;
			return { id: `b${index}`, x: Math.cos(angle) * 40, y: Math.sin(angle) * 40, radius: 6 };
		});
		const [label] = placeLabels([request({ width: 350 })], obstacles, 8).values();
		expect(label).toBeDefined();
	});

	it('truncates long names to 24 characters and leaves short names unchanged', () => {
		expect(mapLabelText('Henri Marie Raymond de Toulouse-Lautrec-Monfa')).toBe(
			'Henri Marie Raymond de …'
		);
		expect(mapLabelText('Niels Bohr')).toBe('Niels Bohr');
	});
});

it('estimates a label width from character count and font size', () => {
	expect(estimateLabelWidth('abcd', 12)).toBeCloseTo(26.88);
});

describe('placeLabels within a preferred box', () => {
	it('keeps a name inside the box when a clear inward spot exists', () => {
		// A dot on the right edge: the first spot ("below") is centred and reaches past the edge.
		const dot = request({ x: 100, y: 0 });
		const within = { left: -100, top: -50, right: 100, bottom: 50 };
		const free = placeLabels([dot], [], 8).get('a')!;
		const kept = placeLabels([dot], [], 8, [], [], { within }).get('a')!;
		expect(free.side).toBe('below');
		expect(kept.side).toBe('left');
	});

	it('still places the name outside when no spot is inside', () => {
		const dot = request({ x: 0, y: 0, width: 300 });
		const within = { left: -10, top: -10, right: 10, bottom: 10 };
		expect(placeLabels([dot], [], 8, [], [], { within }).has('a')).toBe(true);
	});
});

describe('placeLabels within the visible canvas', () => {
	it('keeps the whole name visible even when an inward spot crosses a Relationship', () => {
		const dot = request({ x: 100, y: 0 });
		const viewport = { left: -100, top: -50, right: 100, bottom: 50 };
		const ties = [{ source: 'b', target: 'c', ax: 50, ay: -50, bx: 50, by: 50 }];
		const placement = placeLabels([dot], [], 8, [], ties, { viewport, tieWeight: 6 }).get('a')!;
		const box = boxFor(dot, placement);
		expect(box.left).toBeGreaterThanOrEqual(viewport.left);
		expect(box.right).toBeLessThanOrEqual(viewport.right);
		expect(box.top).toBeGreaterThanOrEqual(viewport.top);
		expect(box.bottom).toBeLessThanOrEqual(viewport.bottom);
	});

	it('retains the name when no candidate fits the canvas', () => {
		const dot = request({ width: 300 });
		const viewport = { left: -10, top: -10, right: 10, bottom: 10 };
		expect(placeLabels([dot], [], 8, [], [], { viewport }).has(dot.id)).toBe(true);
	});
});

describe('placeLabels on a narrow canvas', () => {
	/** Every side but "below" is taken, so two names at one dot want the same spot. */
	const blockers = (): Obstacle[] => [
		{ id: 'x-right', x: 49, y: 0, radius: 6 },
		{ id: 'x-left', x: -49, y: 0, radius: 6 },
		{ id: 'x-above', x: 0, y: -20, radius: 6 },
		{ id: 'x-below-right', x: 44.9, y: 15.9, radius: 6 },
		{ id: 'x-below-left', x: -44.9, y: 15.9, radius: 6 },
		{ id: 'x-above-right', x: 44.9, y: -15.9, radius: 6 },
		{ id: 'x-above-left', x: -44.9, y: -15.9, radius: 6 }
	];
	const requests = [request({ id: 'a' }), request({ id: 'b' })];
	const options = { rings: [1] };

	it('draws the least-crowded spot when every spot collides', () => {
		const labels = placeLabels(requests, blockers(), 8, [], [], options);
		expect([...labels.keys()]).toEqual(['a', 'b']);
		expect(labels.get('a')?.side).toBe('below');
		expect(labels.get('b')?.side).toBe('below');
	});

	it('drops a listed resting name rather than drawing it over another name', () => {
		const labels = placeLabels(requests, blockers(), 8, [], [], {
			...options,
			dropOnNameCollision: new Set(['b'])
		});
		expect([...labels.keys()]).toEqual(['a']);
	});

	it('keeps a name that is not listed for dropping', () => {
		const labels = placeLabels(requests, blockers(), 8, [], [], {
			...options,
			dropOnNameCollision: new Set(['a'])
		});
		expect([...labels.keys()]).toEqual(['a', 'b']);
	});
});

describe('measured region headings', () => {
	it('uses the measured ascent so the painted heading stays inside its reserved box', () => {
		const region = {
			key: 'Front',
			label: 'Front',
			hull: [
				{ x: 0, y: 0 },
				{ x: 100, y: 0 },
				{ x: 100, y: 100 },
				{ x: 0, y: 100 }
			],
			path: '',
			top: 0,
			labelX: 50,
			labelAt: { x: 50, y: -10, textAnchor: 'middle' as const },
			outlined: true,
			subRegions: []
		};
		const [placed] = placeRegionLabels(
			[region],
			{ x: -200, y: -200, width: 500, height: 500 },
			new Map([['Front', 17]]),
			new Set(),
			[],
			() => ({ width: 140, height: 15, baseline: 12 })
		);
		expect(placed.labelAt.y - 12).toBe(placed.labelBox!.y);
		expect(placed.labelAt.y + 3).toBe(placed.labelBox!.y + placed.labelBox!.height);
	});
});
