/**
 * Group collision on the drawn outlines and heading boxes: the minimum-translation
 * sweeps and the bounded orientation reconciliation that keeps a drawing clear.
 */
import { spacingPolicy, type ComposerContext, type Layout } from './graph-composition-context.ts';
import { bodyOf, keyOf, outlineProxy, regionsOf, type Body } from './graph-composition-layout.ts';
import type { ChildCell } from './graph-composition-children.ts';
import type { Point } from '../graph-layout.ts';
import {
	boundsOf,
	convexSeparation,
	pointInPolygon,
	rotatePolygon,
	translatePolygon
} from '../graph-shapes.ts';

function separationPairs(ctx: ComposerContext, a: Body, b: Body) {
	const min = spacingPolicy.minOutlinePx * ctx.unit0;
	const text = spacingPolicy.textClearancePx * ctx.unit0;
	return [
		{ first: a.hull, second: b.hull, min },
		{ first: a.heading, second: b.hull, min: text },
		{ first: a.hull, second: b.heading, min: text },
		{ first: a.heading, second: b.heading, min: text }
	];
}

/** At most six stable-order minimum-translation sweeps; false if a clash remains. */
export function repair(ctx: ComposerContext, layout: Layout): boolean {
	const bodies = new Map(ctx.keys.map((key) => [key, bodyOf(ctx, key, layout.positions)]));
	const move = (key: string, dx: number, dy: number) => {
		const body = bodies.get(key)!;
		bodies.set(key, {
			key,
			hull: translatePolygon(body.hull, dx, dy),
			heading: translatePolygon(body.heading, dx, dy)
		});
		layout.centres.set(key, {
			x: layout.centres.get(key)!.x + dx,
			y: layout.centres.get(key)!.y + dy
		});
		for (const id of ctx.membersByKey.get(key) ?? []) {
			const p = layout.positions.get(id)!;
			layout.positions.set(id, { x: p.x + dx, y: p.y + dy });
		}
	};
	const worst = (a: Body, b: Body) => {
		let best: { shortfall: number; normal: Point } | undefined;
		const reach =
			Math.max(spacingPolicy.minOutlinePx, spacingPolicy.preferredOutlinePx) * ctx.unit0;
		const boxA = boundsOf([...a.hull, ...a.heading]);
		const boxB = boundsOf([...b.hull, ...b.heading]);
		if (
			boxA.right + reach < boxB.left ||
			boxB.right + reach < boxA.left ||
			boxA.bottom + reach < boxB.top ||
			boxB.bottom + reach < boxA.top
		)
			return undefined;
		for (const pair of separationPairs(ctx, a, b)) {
			const { gap, normal } = convexSeparation(pair.first, pair.second, ctx.budget);
			const shortfall = pair.min - gap;
			if (shortfall > 1e-6 && (!best || shortfall > best.shortfall)) best = { shortfall, normal };
		}
		return best;
	};
	for (let sweep = 0; sweep < 6; sweep += 1) {
		let moved = false;
		for (let i = 0; i < ctx.keys.length; i += 1) {
			for (let j = i + 1; j < ctx.keys.length; j += 1) {
				const found = worst(bodies.get(ctx.keys[i])!, bodies.get(ctx.keys[j])!);
				if (!found) continue;
				const half = found.shortfall / 2;
				move(ctx.keys[i], -found.normal.x * half, -found.normal.y * half);
				move(ctx.keys[j], found.normal.x * half, found.normal.y * half);
				moved = true;
			}
		}
		if (!moved) return true;
	}
	for (let i = 0; i < ctx.keys.length; i += 1) {
		for (let j = i + 1; j < ctx.keys.length; j += 1) {
			if (worst(bodies.get(ctx.keys[i])!, bodies.get(ctx.keys[j])!)) return false;
		}
	}
	return true;
}

/** Bounded orientation: identity, then +-10 and +-20 degrees, two sweeps, kept only if it clears. */
export function reconcile(ctx: ComposerContext, layout: Layout): void {
	const crossTies = ctx.links.flatMap((link) => {
		const a = keyOf(ctx, link.source);
		const b = keyOf(ctx, link.target);
		return a === b ? [] : [{ source: link.source, target: link.target, a, b }];
	});
	const angles = [0, 10, -10, 20, -20].map((degrees) => (degrees * Math.PI) / 180);
	for (let sweep = 0; sweep < 2; sweep += 1) {
		let changed = false;
		for (const key of ctx.keys) {
			const ties = crossTies.filter((tie) => tie.a === key || tie.b === key);
			if (ties.length === 0) continue;
			const centre = layout.centres.get(key)!;
			const members = ctx.membersByKey.get(key) ?? [];
			const costAt = (angle: number) => {
				const turned = rotatePolygon(
					members.map((id) => layout.positions.get(id)!),
					centre,
					angle
				);
				const moved = new Map(members.map((id, i) => [id, turned[i]]));
				ctx.budget.spend('placement', ties.length);
				let cost = 0;
				for (const tie of ties) {
					const inside = tie.a === key ? tie.source : tie.target;
					const outside = tie.a === key ? tie.target : tie.source;
					const p = moved.get(inside)!;
					const q = layout.positions.get(outside)!;
					cost += (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
				}
				return cost;
			};
			const identity = costAt(0);
			const ranked = angles
				.slice(1)
				.map((angle) => ({ angle, cost: costAt(angle) }))
				.filter(({ cost }) => cost < identity * (1 - 1e-6))
				.sort((x, y) => x.cost - y.cost);
			for (const { angle } of ranked) {
				const trial: Layout = {
					positions: new Map(layout.positions),
					centres: new Map(layout.centres)
				};
				rotatePolygon(
					members.map((id) => layout.positions.get(id)!),
					centre,
					angle
				).forEach((p, i) => trial.positions.set(members[i], p));
				const clears = ctx.keys.every((other) => {
					if (other === key) return true;
					const a = bodyOf(ctx, key, trial.positions);
					const b = bodyOf(ctx, other, trial.positions);
					return separationPairs(ctx, a, b).every(
						(pair) => convexSeparation(pair.first, pair.second, ctx.budget).gap >= pair.min - 1e-6
					);
				});
				if (!clears) continue;
				trial.positions.forEach((p, id) => layout.positions.set(id, p));
				changed = true;
				break;
			}
		}
		if (!changed) break;
	}
}

/**
 * One bounded child-orientation reconciliation after the parents are
 * placed: each child body may take at most one small rotation about its
 * own anchor, kept only when it shortens actual ties materially while
 * sibling clearance and parent containment hold. The caller rebuilds and
 * validates the final geometry afterwards.
 */
export function reconcileChildren(
	ctx: ComposerContext,
	layout: Layout,
	cells: Map<string, ChildCell[]>
): boolean {
	if (!ctx.subAttribute) return false;
	const childMin = spacingPolicy.minChildPx * ctx.unit0;
	const childText = spacingPolicy.textClearancePx * ctx.unit0;
	const childPref = spacingPolicy.preferredChildPx * ctx.unit0;
	let reconciled = false;
	const angles = [10, -10, 20, -20].map((degrees) => (degrees * Math.PI) / 180);
	const clearOf = (poly: Point[], heading: Point[] | undefined, other: ChildCell) => {
		const pairs: { first: Point[]; second: Point[]; min: number }[] = [
			{ first: poly, second: other.poly, min: childMin }
		];
		if (heading && other.heading)
			pairs.push({ first: heading, second: other.heading, min: childText });
		if (heading) pairs.push({ first: heading, second: other.poly, min: childText });
		if (other.heading) pairs.push({ first: poly, second: other.heading, min: childText });
		const reach = Math.max(childMin, childPref);
		return pairs.every((pair) => {
			const boxA = boundsOf(pair.first);
			const boxB = boundsOf(pair.second);
			if (
				boxA.right + reach < boxB.left ||
				boxB.right + reach < boxA.left ||
				boxA.bottom + reach < boxB.top ||
				boxB.bottom + reach < boxA.top
			)
				return true;
			return convexSeparation(pair.first, pair.second, ctx.budget).gap >= pair.min - 1e-6;
		});
	};
	for (const parent of ctx.keys) {
		const groupCells = cells.get(parent) ?? [];
		if (groupCells.length < 2) continue;
		let outer = outlineProxy(regionsOf(ctx, layout.positions, parent)[0], ctx.unit0);
		for (const cell of groupCells) {
			const ties: { inside: number; outside: string }[] = [];
			ctx.links.forEach((link) => {
				const member = cell.members.indexOf(link.source as string);
				if (member >= 0) ties.push({ inside: member, outside: link.target as string });
				else {
					const other = cell.members.indexOf(link.target as string);
					if (other >= 0) ties.push({ inside: other, outside: link.source as string });
				}
			});
			if (ties.length === 0) continue;
			const centre = cell.anchor;
			const costAt = (angle: number) => {
				const turned = rotatePolygon(
					cell.members.map((id) => layout.positions.get(id)!),
					centre,
					angle
				);
				ctx.budget.spend('placement', ties.length);
				let cost = 0;
				for (const tie of ties) {
					const p = turned[tie.inside];
					const q = layout.positions.get(tie.outside)!;
					cost += (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
				}
				return cost;
			};
			const identity = costAt(0);
			const ranked = angles
				.map((angle) => ({ angle, cost: costAt(angle) }))
				.filter(({ cost }) => cost < identity * (1 - 1e-2))
				.sort((x, y) => x.cost - y.cost);
			for (const { angle } of ranked) {
				const turnedPoly = rotatePolygon(cell.poly, centre, angle);
				const turnedHeading = cell.heading ? rotatePolygon(cell.heading, centre, angle) : undefined;
				const clears = groupCells.every(
					(other) => other === cell || clearOf(turnedPoly, turnedHeading, other)
				);
				if (!clears) continue;
				if (!turnedPoly.every((p) => pointInPolygon(p, outer))) continue;
				const turned = rotatePolygon(
					cell.members.map((id) => layout.positions.get(id)!),
					centre,
					angle
				);
				turned.forEach((p, i) => layout.positions.set(cell.members[i], p));
				cell.poly = turnedPoly;
				cell.heading = turnedHeading;
				// The anchor is the rotation centre, so it does not move.
				outer = outlineProxy(regionsOf(ctx, layout.positions, parent)[0], ctx.unit0);
				reconciled = true;
				break;
			}
		}
	}
	return reconciled;
}
