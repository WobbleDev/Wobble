/**
 * Child-first composition: the interior of a Sub-grouped parent.
 */
import { compareText, groupValue } from '../layout/graph-analysis.ts';
import { regionKey, subRegionKey, type Point } from '../layout/graph-layout.ts';
import {
	boundsOf,
	convexSeparation,
	pointInPolygon,
	translatePolygon
} from '../layout/graph-shapes.ts';
import { spacingPolicy, type ComposerContext, type Layout } from './graph-composition-context.ts';
import {
	bodyFromRegion,
	dotOutline,
	keyOf,
	meanOf,
	outlineProxy,
	regionsOf
} from './graph-composition-layout.ts';
import { sizeOfHeading } from './graph-composition-text.ts';

/** One child's drawn footprint: its outline, its heading box, and its members. */
export type ChildCell = {
	key: string;
	members: string[];
	anchor: Point;
	poly: Point[];
	heading?: Point[];
};

function childResult(
	ctx: ComposerContext,
	parent: string,
	layout: Layout
): { cells: ChildCell[]; shaped: number } | undefined {
	if (!ctx.subAttribute) return { cells: [], shaped: 0 };
	const childMin = spacingPolicy.minChildPx * ctx.unit0;
	const childPref = spacingPolicy.preferredChildPx * ctx.unit0;
	const memberIds = ctx.membersByKey.get(parent) ?? [];
	const subValueOf = (id: string) => groupValue(ctx.nodeIndex.get(id)!, ctx.subAttribute);
	const kids = [...new Set(memberIds.map(subValueOf))].sort((a, b) =>
		compareText(ctx.subLabel(a), ctx.subLabel(b))
	);
	if (kids.length < 2) return { cells: [], shaped: 0 };
	const shipped = regionsOf(ctx, ctx.original.positions).find(
		(region) => region.key === regionKey(parent)
	);
	if (!shipped) return undefined;
	const cells: ChildCell[] = kids.map((kid) => {
		const ids = memberIds.filter((id) => subValueOf(id) === kid);
		const anchor = meanOf(ids.map((id) => ctx.original.positions.get(id)!));
		const sub = shipped.subRegions.find((region) => region.key === subRegionKey(parent, kid));
		const poly =
			sub && sub.outlined
				? outlineProxy(sub, ctx.unit0)
				: dotOutline(ctx, ids, ctx.original.positions);
		const heading =
			sub && sub.outlined
				? bodyFromRegion(sub.key, sub, sizeOfHeading(ctx, sub.key), ctx.unit0).heading
				: undefined;
		return { key: kid, members: ids, anchor, poly, heading };
	});
	// One bounded quotient-relaxation sweep from the shipped anchors: each
	// child drifts toward the weighted centroid of its tie partners (one
	// Jacobi-style stress step with uniform weights), inside a 4px trust
	// region. The solved layout stays the frame; the stage refines it from
	// the ties instead of reshuffling it, so the routed drawing stays
	// within the no-novel-conflict rule.
	const partners = new Map<string, Map<string, number>>();
	for (const link of ctx.links) {
		if (keyOf(ctx, link.source) !== parent || keyOf(ctx, link.target) !== parent) continue;
		const a = subValueOf(link.source);
		const b = subValueOf(link.target);
		if (a === b) continue;
		const bumps: [string, string][] = [
			[a, b],
			[b, a]
		];
		for (const [from, to] of bumps) {
			const targets = partners.get(from) ?? new Map<string, number>();
			targets.set(to, (targets.get(to) ?? 0) + 1);
			partners.set(from, targets);
		}
	}
	ctx.budget.spend(
		'placement',
		kids.length * (kids.length + cells.reduce((count, cell) => count + cell.members.length, 0))
	);
	const moved = new Map<ChildCell, Point>(cells.map((cell) => [cell, { x: 0, y: 0 }]));
	const atAnchor = (cell: ChildCell) => {
		const delta = moved.get(cell)!;
		return { x: cell.anchor.x + delta.x, y: cell.anchor.y + delta.y };
	};
	const trustPx = 4 * ctx.unit0;
	for (const cell of cells) {
		const targets = partners.get(cell.key);
		if (!targets || targets.size === 0) continue;
		let wx = 0;
		let wy = 0;
		let w = 0;
		for (const [other, strength] of targets) {
			const anchor = atAnchor(cells.find((candidate) => candidate.key === other)!);
			wx += anchor.x * strength;
			wy += anchor.y * strength;
			w += strength;
		}
		if (w === 0) continue;
		const here = atAnchor(cell);
		const dx = wx / w - here.x;
		const dy = wy / w - here.y;
		const length = Math.hypot(dx, dy);
		if (length <= 1e-9) continue;
		const step = Math.min(1, trustPx / length);
		const delta = moved.get(cell)!;
		delta.x += dx * step;
		delta.y += dy * step;
	}
	const at = (cell: ChildCell) => {
		const delta = moved.get(cell)!;
		return translatePolygon(cell.poly, delta.x, delta.y);
	};
	const atHeading = (cell: ChildCell) =>
		cell.heading
			? translatePolygon(cell.heading, moved.get(cell)!.x, moved.get(cell)!.y)
			: undefined;
	const pairsOf = (a: ChildCell, b: ChildCell) => {
		// Outlines only: a child's heading spot is estimated until the final
		// placement puts it; reserving the estimate here fails stages the
		// finished drawing would pass. Parent-level separation and the final
		// no-novel-conflict rule still gate headings.
		const pairs: { first: Point[]; second: Point[]; min: number }[] = [
			{ first: at(a), second: at(b), min: childMin }
		];
		return pairs;
	};
	// At most six stable-order minimum-translation sweeps; false if a clash remains.
	const worstPair = (a: ChildCell, b: ChildCell) => {
		let best: { shortfall: number; normal: Point } | undefined;
		const reach = Math.max(childMin, childPref);
		const boxA = boundsOf([...at(a), ...(atHeading(a) ?? [])]);
		const boxB = boundsOf([...at(b), ...(atHeading(b) ?? [])]);
		if (
			boxA.right + reach < boxB.left ||
			boxB.right + reach < boxA.left ||
			boxA.bottom + reach < boxB.top ||
			boxB.bottom + reach < boxA.top
		)
			return undefined;
		for (const pair of pairsOf(a, b)) {
			const { gap, normal } = convexSeparation(pair.first, pair.second, ctx.budget);
			const shortfall = pair.min - gap;
			if (shortfall > 1e-6 && (!best || shortfall > best.shortfall)) best = { shortfall, normal };
		}
		return best;
	};
	for (let sweep = 0; sweep < 6; sweep += 1) {
		let changed = false;
		for (let i = 0; i < cells.length; i += 1) {
			for (let j = i + 1; j < cells.length; j += 1) {
				const found = worstPair(cells[i], cells[j]);
				if (!found) continue;
				const half = found.shortfall / 2;
				const a = moved.get(cells[i])!;
				const b = moved.get(cells[j])!;
				a.x -= found.normal.x * half;
				a.y -= found.normal.y * half;
				b.x += found.normal.x * half;
				b.y += found.normal.y * half;
				changed = true;
			}
		}
		if (!changed) break;
	}
	for (let i = 0; i < cells.length; i += 1) {
		for (let j = i + 1; j < cells.length; j += 1) {
			if (worstPair(cells[i], cells[j])) return undefined;
		}
	}
	// Carry every member rigidly with its cell, and settle the cells on
	// their final absolute footprints for the reconciliation below.
	for (const cell of cells) {
		const delta = moved.get(cell)!;
		for (const id of cell.members) {
			const p = layout.positions.get(id)!;
			layout.positions.set(id, { x: p.x + delta.x, y: p.y + delta.y });
		}
		cell.anchor = { x: cell.anchor.x + delta.x, y: cell.anchor.y + delta.y };
		cell.poly = translatePolygon(cell.poly, delta.x, delta.y);
		if (cell.heading) cell.heading = translatePolygon(cell.heading, delta.x, delta.y);
	}
	return { cells, shaped: kids.length };
}

/**
 * Compose each parent's children from their ties and clearances, then carry
 * the members rigidly with their cells. Either every parent clears, or the
 * whole stage is discarded: no partial interiors are published.
 */
export function composeChildrenFirst(
	ctx: ComposerContext,
	from: Layout
):
	{ layout: Layout; cells: Map<string, ChildCell[]>; shaped: number; maxMove: number } | undefined {
	if (!ctx.subAttribute) return undefined;
	const layout: Layout = { positions: new Map(from.positions), centres: new Map(from.centres) };
	const cells = new Map<string, ChildCell[]>();
	let shaped = 0;
	let maxMove = 0;
	for (const parent of ctx.keys) {
		const stage = childResult(ctx, parent, layout);
		if (!stage) return undefined;
		shaped += stage.shaped;
		for (const cell of stage.cells) {
			const before = ctx.original.positions.get(cell.members[0])!;
			const after = layout.positions.get(cell.members[0])!;
			// Rigid within each cell: the first member's move is the cell's move.
			maxMove = Math.max(maxMove, Math.hypot(after.x - before.x, after.y - before.y));
		}
		cells.set(parent, stage.cells);
	}
	return { layout, cells, shaped, maxMove };
}

/**
 * Child clearance and containment in map units, measured once per
 * interior: every top-level move below is rigid within each parent, so
 * sibling gaps and containment carry over to its drawings.
 */
export type ChildMetrics = { gapMap: number; escaped?: string };

export function measureChildren(
	ctx: ComposerContext,
	positions: ReadonlyMap<string, Point>,
	unit: number
): ChildMetrics {
	const reach = spacingPolicy.preferredChildPx * unit;
	let gapMap = Infinity;
	let escaped: string | undefined;
	for (const top of regionsOf(ctx, positions)) {
		const kids = top.subRegions.filter((sub) => sub.outlined);
		const proxies = kids.map((sub) => ({ key: sub.key, poly: outlineProxy(sub, unit) }));
		for (let i = 0; i < proxies.length; i += 1) {
			for (let j = i + 1; j < proxies.length; j += 1) {
				const boxA = boundsOf(proxies[i].poly);
				const boxB = boundsOf(proxies[j].poly);
				if (
					boxA.right + reach < boxB.left ||
					boxB.right + reach < boxA.left ||
					boxA.bottom + reach < boxB.top ||
					boxB.bottom + reach < boxA.top
				)
					continue;
				const { gap } = convexSeparation(proxies[i].poly, proxies[j].poly, ctx.budget);
				gapMap = Math.min(gapMap, gap);
			}
		}
		const outer = outlineProxy(top, unit);
		for (const { key, poly } of proxies) {
			if (escaped === undefined && poly.some((p) => !pointInPolygon(p, outer))) {
				escaped = key;
			}
		}
	}
	return { gapMap, escaped };
}
