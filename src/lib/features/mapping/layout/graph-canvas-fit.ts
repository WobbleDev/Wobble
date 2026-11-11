/**
 * Shapes a settled grouped arrangement to its canvas. Groups are placed by who
 * they connect to, which ignores the canvas, so a chain of groups can run
 * diagonally or down a wide view and spill past the frame at any zoom.
 *
 * Two moves, both on whole groups so nothing inside a group changes:
 * 1. Turn the arrangement so its long axis runs along the canvas's long side.
 *    A rotation keeps every distance, so neighbouring groups stay neighbours.
 * 2. If it still has the wrong proportions, squeeze the spacing between group
 *    centres along the overflowing axis and widen it along the free one, then
 *    push apart any groups that now come closer than the gap. A squeeze that
 *    lines groups up so a tie between two of them runs through a third is
 *    refused: fitting never buys proportions with a tie through a group.
 *
 * Deterministic: groups are handled in key order.
 */
import type { Point } from './graph-layout.ts';
import { compareText, keyAsLabel, type LabelOf } from './graph-analysis.ts';

type Circle = { key: string; x: number; y: number; r: number; weight: number };

export function fitGroupsToCanvas(input: {
	/** The text each group id stands for, which orders the groups. */
	labelOf?: LabelOf;
	positions: ReadonlyMap<string, Point>;
	centres: ReadonlyMap<string, Point>;
	memberOf: ReadonlyMap<string, string>;
	radiusFor: (id: string) => number;
	canvas: { width: number; height: number };
	/** Clear room kept between neighbouring groups. */
	gap: number;
	/** The outline drawn around a group's dots. */
	padding: number;
	/** Pairs of groups with a Relationship between them. */
	groupTies?: readonly [string, string][];
}): { positions: Map<string, Point>; centres: Map<string, Point> } {
	const positions = new Map(input.positions);
	const centres = new Map(input.centres);
	const labelOf = input.labelOf ?? keyAsLabel;
	const keys = [...centres.keys()].sort((a, b) => compareText(labelOf(a), labelOf(b)));
	if (keys.length < 2 || input.canvas.width <= 0 || input.canvas.height <= 0)
		return { positions, centres };

	const membersOf = new Map<string, string[]>(keys.map((key) => [key, []]));
	for (const id of positions.keys()) membersOf.get(input.memberOf.get(id) ?? '')?.push(id);
	const circles: Circle[] = keys.map((key) => {
		const centre = centres.get(key)!;
		const members = membersOf.get(key)!;
		const reach = Math.max(
			0,
			...members.map((id) => {
				const p = positions.get(id)!;
				return Math.hypot(p.x - centre.x, p.y - centre.y) + input.radiusFor(id);
			})
		);
		return {
			key,
			x: centre.x,
			y: centre.y,
			r: reach + input.padding,
			weight: Math.max(1, members.length)
		};
	});
	const total = circles.reduce((sum, c) => sum + c.weight, 0);
	const pivot = {
		x: circles.reduce((sum, c) => sum + c.x * c.weight, 0) / total,
		y: circles.reduce((sum, c) => sum + c.y * c.weight, 0) / total
	};

	// 1. Turn the principal axis of the group centres onto the canvas's long side.
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (const c of circles) {
		const dx = c.x - pivot.x;
		const dy = c.y - pivot.y;
		sxx += c.weight * dx * dx;
		syy += c.weight * dy * dy;
		sxy += c.weight * dx * dy;
	}
	const principal = 0.5 * Math.atan2(2 * sxy, sxx - syy);
	const target = input.canvas.width >= input.canvas.height ? 0 : Math.PI / 2;
	const turn = target - principal;
	const cos = Math.cos(turn);
	const sin = Math.sin(turn);
	const rotate = (p: Point): Point => {
		const dx = p.x - pivot.x;
		const dy = p.y - pivot.y;
		return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
	};
	for (const c of circles) Object.assign(c, rotate(c));

	// 2. Scale the spacing toward the canvas's proportions, then restore the gap.
	const want = Math.log(input.canvas.width / input.canvas.height);
	const settled = (k: number): Circle[] => {
		const moved = circles.map((c) => ({
			...c,
			x: pivot.x + (c.x - pivot.x) * k,
			y: pivot.y + (c.y - pivot.y) / k
		}));
		separate(moved, input.gap);
		return moved;
	};
	const index = new Map(keys.map((key, i) => [key, i]));
	const ties = (input.groupTies ?? []).flatMap(([a, b]) => {
		const i = index.get(a);
		const j = index.get(b);
		return i === undefined || j === undefined || i === j ? [] : [[i, j] as const];
	});
	const crossings = (moved: readonly Circle[]) => {
		let count = 0;
		for (const [i, j] of ties)
			for (let k = 0; k < moved.length; k += 1) {
				if (k === i || k === j) continue;
				if (distanceToSegment(moved[k], moved[i], moved[j]) < moved[k].r) count += 1;
			}
		return count;
	};
	// Tied groups pulled further apart than they settled lose their closeness.
	const stretched = (moved: readonly Circle[]) =>
		ties.reduce((sum, [i, j]) => {
			const before = Math.hypot(circles[i].x - circles[j].x, circles[i].y - circles[j].y);
			const after = Math.hypot(moved[i].x - moved[j].x, moved[i].y - moved[j].y);
			return sum + Math.max(0, Math.log(after / Math.max(before, 1e-9)));
		}, 0) / Math.max(ties.length, 1);
	const score = (moved: readonly Circle[], k: number) =>
		mismatch(moved, want) +
		crossings(moved) * 10 +
		stretched(moved) * 6 +
		Math.abs(Math.log(k)) * 0.05;
	let best = settled(1);
	let bestScore = score(best, 1);
	for (let step = -20; step <= 20; step += 1) {
		if (step === 0) continue;
		const k = Math.exp(step * 0.05);
		const candidate = settled(k);
		// A small preference for leaving the spacing alone breaks near-ties.
		const value = score(candidate, k);
		if (value < bestScore - 1e-9) {
			best = candidate;
			bestScore = value;
		}
	}

	for (const [index, key] of keys.entries()) {
		const before = rotate(centres.get(key)!);
		const after = best[index];
		const shift = { x: after.x - before.x, y: after.y - before.y };
		centres.set(key, { x: after.x, y: after.y });
		for (const id of membersOf.get(key)!) {
			const p = rotate(positions.get(id)!);
			positions.set(id, { x: p.x + shift.x, y: p.y + shift.y });
		}
	}
	return { positions, centres };
}

/** How far the circles' bounding box is from the wanted log aspect ratio. */
function mismatch(circles: readonly Circle[], want: number): number {
	const left = Math.min(...circles.map((c) => c.x - c.r));
	const right = Math.max(...circles.map((c) => c.x + c.r));
	const top = Math.min(...circles.map((c) => c.y - c.r));
	const bottom = Math.max(...circles.map((c) => c.y + c.r));
	return Math.abs(Math.log((right - left) / Math.max(bottom - top, 1e-9)) - want);
}

/** Pairwise pushes until no two circles come closer than the gap. */
function separate(circles: Circle[], gap: number): void {
	for (let pass = 0; pass < 100; pass += 1) {
		let moved = false;
		for (let i = 0; i < circles.length; i += 1)
			for (let j = i + 1; j < circles.length; j += 1) {
				const a = circles[i];
				const b = circles[j];
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const distance = Math.hypot(dx, dy);
				const minimum = a.r + b.r + gap;
				if (distance >= minimum - 1e-6) continue;
				const ux = distance > 1e-9 ? dx / distance : 1;
				const uy = distance > 1e-9 ? dy / distance : 0;
				const push = (minimum - distance) / 2;
				a.x -= ux * push;
				a.y -= uy * push;
				b.x += ux * push;
				b.y += uy * push;
				moved = true;
			}
		if (!moved) break;
	}
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	const t = lengthSquared
		? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
		: 0;
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
