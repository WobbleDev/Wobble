import { describe, expect, it } from 'vitest';
import type { Worker } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import { bandLayout, CHART_CENTER, DOT_FOOTPRINT, reachTree } from './bullseye-geometry.ts';
import { bullseyeLayout, type BullseyeLayout, type RoutedTie } from './bullseye-lanes.ts';
import { assessmentCounts } from './reach.ts';

const worker = (id: string, assessment: Worker['assessment'], relationships: string[] = []) =>
	baseWorker({ id, name: id, assessment, relationships });

/** Workers by id with every edge recorded on both ends, as the app stores them. */
function worksite(
	standings: [string, Worker['assessment']][],
	edges: [string, string][]
): Worker[] {
	const workers = standings.map(([id, assessment]) => worker(id, assessment));
	const byId = new Map(workers.map((entry) => [entry.id, entry]));
	for (const [a, b] of edges) {
		if (a === b || byId.get(a)!.relationships.includes(b)) continue;
		byId.get(a)!.relationships.push(b);
		byId.get(b)!.relationships.push(a);
	}
	return workers;
}

const layoutOf = (workers: Worker[]): BullseyeLayout =>
	bullseyeLayout(workers, assessmentCounts(workers), {
		Leader: 'Leaders',
		Activist: 'Activists',
		Supporter: 'Supporters',
		Disengaged: 'Disengaged'
	});

/** Eight members, fourteen Activists known by two or three of them, fourteen Supporters. */
function heavySharing(): Worker[] {
	const standings: [string, Worker['assessment']][] = [];
	const edges: [string, string][] = [];
	for (let i = 0; i < 8; i++) standings.push([`L${i}`, 'Leader']);
	for (let i = 0; i < 14; i++) {
		standings.push([`A${String(i).padStart(2, '0')}`, 'Activist']);
		const known = 2 + (i % 2);
		for (let k = 0; k < known; k++) {
			edges.push([`A${String(i).padStart(2, '0')}`, `L${(i + k * 3) % 8}`]);
		}
	}
	for (let j = 0; j < 14; j++) {
		const id = `S${String(j).padStart(2, '0')}`;
		standings.push([id, 'Supporter']);
		if (j % 2 === 0) edges.push([id, `A${String(j).padStart(2, '0')}`]);
		else {
			edges.push([id, `L${j % 8}`]);
			edges.push([id, `L${(j + 3) % 8}`]);
		}
	}
	for (let j = 0; j < 6; j++) {
		standings.push([`D${j}`, 'Disengaged']);
		edges.push([`D${j}`, `S${String(j).padStart(2, '0')}`]);
	}
	return worksite(standings, edges);
}

type Pt = { x: number; y: number };

/** The path's points, curves and arcs sampled finely enough to test against. */
function sample(d: string): Pt[] {
	const tokens = d.match(/[MLQA]|-?\d+(?:\.\d+)?/g)!;
	const points: Pt[] = [];
	let at: Pt = { x: 0, y: 0 };
	for (let i = 0; i < tokens.length;) {
		const command = tokens[i++];
		const read = (n: number) => tokens.slice(i, (i += n)).map(Number);
		if (command === 'M' || command === 'L') {
			const [x, y] = read(2);
			if (command === 'L') {
				for (let t = 1; t <= 8; t++)
					points.push({ x: at.x + ((x - at.x) * t) / 8, y: at.y + ((y - at.y) * t) / 8 });
			} else points.push({ x, y });
			at = { x, y };
		} else if (command === 'Q') {
			const [cx, cy, x, y] = read(4);
			for (let t = 1; t <= 8; t++) {
				const u = t / 8;
				points.push({
					x: (1 - u) ** 2 * at.x + 2 * (1 - u) * u * cx + u ** 2 * x,
					y: (1 - u) ** 2 * at.y + 2 * (1 - u) * u * cy + u ** 2 * y
				});
			}
			at = { x, y };
		} else {
			const [radius, , , , sweep, x, y] = read(7);
			const from = Math.atan2(at.y - CHART_CENTER, at.x - CHART_CENTER);
			const to = Math.atan2(y - CHART_CENTER, x - CHART_CENTER);
			const turn =
				sweep === 1
					? (to - from + 4 * Math.PI) % (2 * Math.PI)
					: -((from - to + 4 * Math.PI) % (2 * Math.PI));
			const steps = Math.max(2, Math.ceil(Math.abs(turn) * radius));
			for (let t = 1; t <= steps; t++) {
				const angle = from + (turn * t) / steps;
				points.push({
					x: CHART_CENTER + Math.cos(angle) * radius,
					y: CHART_CENTER + Math.sin(angle) * radius
				});
			}
			at = { x, y };
		}
	}
	return points;
}

/** Where two segments cross, if they do, and the angle between them in degrees. */
function crossing(a1: Pt, a2: Pt, b1: Pt, b2: Pt): number | null {
	const rx = a2.x - a1.x;
	const ry = a2.y - a1.y;
	const sx = b2.x - b1.x;
	const sy = b2.y - b1.y;
	const denominator = rx * sy - ry * sx;
	if (Math.abs(denominator) < 1e-9) return null;
	const t = ((b1.x - a1.x) * sy - (b1.y - a1.y) * sx) / denominator;
	const u = ((b1.x - a1.x) * ry - (b1.y - a1.y) * rx) / denominator;
	if (t < 0 || t > 1 || u < 0 || u > 1) return null;
	const cos = Math.abs(rx * sx + ry * sy) / (Math.hypot(rx, ry) * Math.hypot(sx, sy));
	return (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
}

const drawn = (layout: BullseyeLayout) => layout.ties.filter((tie) => !tie.revealOnly);

const shareEnd = (a: RoutedTie, b: RoutedTie) =>
	a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to;

function expectRightAngleCrossings(layout: BullseyeLayout) {
	const ties = drawn(layout).map((tie) => ({ tie, points: sample(tie.d) }));
	for (let i = 0; i < ties.length; i++) {
		for (let j = i + 1; j < ties.length; j++) {
			if (shareEnd(ties[i].tie, ties[j].tie)) continue;
			const a = ties[i].points;
			const b = ties[j].points;
			for (let p = 1; p < a.length; p++) {
				for (let q = 1; q < b.length; q++) {
					const angle = crossing(a[p - 1], a[p], b[q - 1], b[q]);
					if (angle !== null) {
						expect(
							angle,
							`${ties[i].tie.id} crosses ${ties[j].tie.id} at ${angle.toFixed(1)} degrees`
						).toBeGreaterThan(80);
					}
				}
			}
		}
	}
}

function expectNoTieOverDot(layout: BullseyeLayout) {
	const dots = layout.groups.flatMap((group) => group.dots);
	for (const tie of drawn(layout)) {
		const points = sample(tie.d);
		for (const dot of dots) {
			if (dot.worker.id === tie.from || dot.worker.id === tie.to) continue;
			for (const point of points) {
				expect(
					Math.hypot(point.x - dot.cx, point.y - dot.cy),
					`${tie.id} passes ${dot.worker.id}`
				).toBeGreaterThanOrEqual(DOT_FOOTPRINT - 0.05);
			}
		}
	}
}

/** Each laned tie's circular run: its radius and the angle range it covers. */
function laneRuns(layout: BullseyeLayout) {
	return drawn(layout).flatMap((tie) => {
		const arc = /A ([\d.]+) [\d.]+ 0 [01] ([01]) (-?[\d.]+) (-?[\d.]+)/.exec(tie.d);
		if (!arc) return [];
		const before = /L (-?[\d.]+) (-?[\d.]+) A/.exec(tie.d)!;
		const angle = (x: number, y: number) => Math.atan2(y - CHART_CENTER, x - CHART_CENTER);
		const from = angle(Number(before[1]), Number(before[2]));
		const to = angle(Number(arc[3]), Number(arc[4]));
		const forward = arc[2] === '1';
		const length = forward
			? (to - from + 4 * Math.PI) % (2 * Math.PI)
			: (from - to + 4 * Math.PI) % (2 * Math.PI);
		return [
			{
				id: tie.id,
				radius: Number(arc[1]),
				start: forward ? from : to,
				length
			}
		];
	});
}

/** The room the layout holds clear on the bands' inner edges for lanes. */
const room = (layout: BullseyeLayout) =>
	layout.bands.slice(1).reduce((sum, band) => sum + band.packingInnerRadius - band.innerRadius, 0);

describe('bullseyeLayout', () => {
	it.each([['a heavily shared worksite', heavySharing()]])(
		'crosses only at right angles and never over a dot on %s',
		(_, workers) => {
			const layout = layoutOf(workers);
			expect(drawn(layout).length).toBeGreaterThan(10);
			expectRightAngleCrossings(layout);
			expectNoTieOverDot(layout);
		}
	);

	it.each([['a heavily shared worksite', heavySharing()]])(
		'gives no two ties one lane run on %s',
		(_, workers) => {
			const runs = laneRuns(layoutOf(workers));
			expect(runs.length).toBeGreaterThan(3);
			for (let i = 0; i < runs.length; i++) {
				for (let j = i + 1; j < runs.length; j++) {
					if (Math.abs(runs[i].radius - runs[j].radius) > 0.01) continue;
					const offset = (runs[j].start - runs[i].start + 4 * Math.PI) % (2 * Math.PI);
					const shared = offset <= runs[i].length || 2 * Math.PI - offset <= runs[j].length;
					expect(shared, `${runs[i].id} and ${runs[j].id} share a lane run`).toBe(false);
				}
			}
		}
	);

	it('asks for no lane room when the lanes already fit', () => {
		const workers = worksite(
			[
				['L1', 'Leader'],
				['L2', 'Leader'],
				['A1', 'Activist'],
				['A2', 'Activist'],
				['S1', 'Supporter'],
				['S2', 'Supporter'],
				['D1', 'Disengaged']
			],
			[
				['L1', 'A1'],
				['L2', 'A2'],
				['A1', 'S1'],
				['A2', 'S2']
			]
		);
		const layout = layoutOf(workers);
		expect(layout.bands).toEqual(bandLayout(assessmentCounts(workers)));
		expect(room(layout)).toBe(0);
	});

	it('shows a tie that finds no lane only when asked, and the Committee extras go first', () => {
		const standings: [string, Worker['assessment']][] = [];
		const edges: [string, string][] = [];
		for (let i = 0; i < 12; i++) standings.push([`L${String(i).padStart(2, '0')}`, 'Leader']);
		for (let i = 0; i < 20; i++) {
			const id = `A${String(i).padStart(2, '0')}`;
			standings.push([id, 'Activist']);
			for (let k = 0; k < 12; k++) {
				if ((i + k) % 3 !== 0) edges.push([id, `L${String(k).padStart(2, '0')}`]);
			}
		}
		for (let i = 0; i < 18; i++) {
			const id = `S${String(i).padStart(2, '0')}`;
			standings.push([id, 'Supporter']);
			for (let k = 0; k < 12; k++) {
				if ((i + k) % 2 === 0) edges.push([id, `L${String(k).padStart(2, '0')}`]);
			}
		}
		const workers = worksite(standings, edges);
		const layout = layoutOf(workers);
		const tree = reachTree(workers);
		const treeIds = new Set([...tree].map(([child, parent]) => `${parent}--${child}`));
		const hidden = layout.ties.filter((tie) => tie.revealOnly);
		expect(hidden.length).toBeGreaterThan(0);
		expect(room(layout)).toBeLessThanOrEqual(10 + 1e-6);
		// Extras are routed after the tree, so they run out of lanes first.
		const extras = layout.ties.filter((tie) => !treeIds.has(tie.id));
		expect(extras.length).toBeGreaterThan(treeIds.size);
		const hiddenShare = (ties: RoutedTie[]) =>
			ties.filter((tie) => tie.revealOnly).length / Math.max(1, ties.length);
		expect(hiddenShare(extras)).toBeGreaterThan(
			hiddenShare(layout.ties.filter((tie) => treeIds.has(tie.id)))
		);
		// A tie that is not drawn has no gaps to break.
		expect(hidden.every((tie) => tie.gaps.length === 0)).toBe(true);
	});
});
