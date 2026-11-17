/** Relationship ties between dots, and the reach tree that seats Workers by who they connect to. */
import { assessedOptions, type Worker } from '#lib/domain-vocabulary.ts';
import {
	CHART_CENTER,
	DOT_FOOTPRINT,
	TIE_DOT_GAP,
	TIE_MIN_GAP,
	TIE_MIN_LENGTH,
	TIE_SAMPLES,
	TIE_BOWS,
	MIN_PITCH,
	type PlotAssessment
} from './bullseye-shared.ts';

/**
 * A tie is a hairline that stops short of both dots, so it reads as a spoke
 * between them rather than a stroke running through either. It is straight
 * unless that would run it over a dot in `around` it does not join, which only
 * a tie along one band's row can do; then it bows outward, away from the
 * centre, by the least amount that clears every such dot.
 */
export function tiePath(
	start: { cx: number; cy: number },
	end: { cx: number; cy: number },
	around: { cx: number; cy: number }[] = []
): string {
	const dx = end.cx - start.cx;
	const dy = end.cy - start.cy;
	const distance = Math.hypot(dx, dy);
	// Close dots give up some of the gap rather than lose the line between them.
	const trim = Math.max(
		DOT_FOOTPRINT + TIE_MIN_GAP,
		Math.min(DOT_FOOTPRINT + TIE_DOT_GAP, (distance - TIE_MIN_LENGTH) / 2)
	);
	if (distance <= trim * 2) return `M ${start.cx} ${start.cy} L ${end.cx} ${end.cy}`;
	// The normal pointing away from the centre, for the bow.
	const midX = (start.cx + end.cx) / 2;
	const midY = (start.cy + end.cy) / 2;
	const side = Math.sign(-dy * (midX - CHART_CENTER) + dx * (midY - CHART_CENTER)) || 1;
	const nx = (-dy / distance) * side;
	const ny = (dx / distance) * side;
	const others = around.filter(
		(dot) =>
			Math.hypot(dot.cx - start.cx, dot.cy - start.cy) > 0.01 &&
			Math.hypot(dot.cx - end.cx, dot.cy - end.cy) > 0.01
	);
	const f = (n: number) => +n.toFixed(2);
	for (const bow of TIE_BOWS) {
		const px = midX + nx * bow;
		const py = midY + ny * bow;
		const at = (t: number) => ({
			x: (1 - t) ** 2 * start.cx + 2 * (1 - t) * t * px + t ** 2 * end.cx,
			y: (1 - t) ** 2 * start.cy + 2 * (1 - t) * t * py + t ** 2 * end.cy
		});
		const samples = Array.from({ length: TIE_SAMPLES + 1 }, (_, i) => i / TIE_SAMPLES);
		const t0 = samples.find((t) => Math.hypot(at(t).x - start.cx, at(t).y - start.cy) >= trim);
		const t1 = samples.findLast((t) => Math.hypot(at(t).x - end.cx, at(t).y - end.cy) >= trim);
		if (t0 === undefined || t1 === undefined || t1 <= t0) continue;
		const visible = samples.filter((t) => t >= t0 && t <= t1).map(at);
		const clear = others.every((dot) =>
			visible.every((p) => Math.hypot(p.x - dot.cx, p.y - dot.cy) > DOT_FOOTPRINT + TIE_MIN_GAP)
		);
		if (!clear && bow !== TIE_BOWS.at(-1)) continue;
		const from = at(t0);
		const to = at(t1);
		if (bow === 0) return `M ${f(from.x)} ${f(from.y)} L ${f(to.x)} ${f(to.y)}`;
		// The stretch of the curve between t0 and t1, as a curve of its own.
		const cx =
			(1 - t0) * (1 - t1) * start.cx + ((1 - t0) * t1 + t0 * (1 - t1)) * px + t0 * t1 * end.cx;
		const cy =
			(1 - t0) * (1 - t1) * start.cy + ((1 - t0) * t1 + t0 * (1 - t1)) * py + t0 * t1 * end.cy;
		return `M ${f(from.x)} ${f(from.y)} Q ${f(cx)} ${f(cy)} ${f(to.x)} ${f(to.y)}`;
	}
	return `M ${start.cx} ${start.cy} L ${end.cx} ${end.cy}`;
}

export const byId = (a: Worker, b: Worker): number => a.id.localeCompare(b.id);

/** The widest wedge one Committee member's tree may fan across, in radians. */
const MAX_TREE_WEDGE = Math.PI / 2;

/** The bands a reach tree may grow through, inside out, out to the Hostile track. */
const TREE_BANDS: readonly PlotAssessment[] = assessedOptions;

const treeDepth = (worker: Worker): number =>
	TREE_BANDS.indexOf(worker.assessment as PlotAssessment);

/**
 * The Committee's reach as a forest: one tree per Committee member, grown
 * breadth-first through relationships out through every band to the Hostile
 * track. Each reached worker hangs off exactly one parent, in its
 * own band or a band further in, so every branch grows outward. When a worker
 * could hang off several, it takes the one reaching the most new workers, then
 * the lowest id. Returns child id → parent id.
 */
export function reachTree(workers: Worker[]): Map<string, string> {
	const byWorkerId = new Map(workers.map((worker) => [worker.id, worker]));
	const parent = new Map<string, string>();
	const reached = new Set<string>();
	let frontier = workers.filter((worker) => worker.assessment === 'Leader').sort(byId);
	for (const member of frontier) reached.add(member.id);
	while (frontier.length > 0) {
		const candidates = new Map<string, Worker[]>();
		for (const from of frontier) {
			for (const id of from.relationships) {
				const to = byWorkerId.get(id);
				if (!to || reached.has(id) || treeDepth(to) < 1 || treeDepth(to) < treeDepth(from))
					continue;
				candidates.set(id, [...(candidates.get(id) ?? []), from]);
			}
		}
		const load = new Map<string, number>();
		for (const froms of candidates.values())
			for (const from of froms) load.set(from.id, (load.get(from.id) ?? 0) + 1);
		const next: Worker[] = [];
		for (const id of [...candidates.keys()].sort()) {
			const best = [...candidates.get(id)!].sort(
				(a, b) => load.get(b.id)! - load.get(a.id)! || byId(a, b)
			)[0];
			parent.set(id, best.id);
			reached.add(id);
			next.push(byWorkerId.get(id)!);
		}
		frontier = next;
	}
	return parent;
}

/**
 * The Committee in an order that seats members who know the same workers side
 * by side: start at the best-connected member, then keep adding the member who
 * shares the most workers with the one just seated. A tie from a member to a
 * worker in a neighbour's tree then runs a short way along its lane.
 */
function seatBySharing(workers: Worker[], committee: Worker[]): Worker[] {
	const known = new Map(
		committee.map((member) => [
			member.id,
			new Set(
				workers
					.filter(
						(worker) => worker.assessment !== 'Leader' && worker.relationships.includes(member.id)
					)
					.map((worker) => worker.id)
			)
		])
	);
	const shared = (a: Worker, b: Worker) =>
		[...known.get(a.id)!].filter((id) => known.get(b.id)!.has(id)).length;
	const remaining = [...committee].sort(
		(a, b) => known.get(b.id)!.size - known.get(a.id)!.size || byId(a, b)
	);
	const seated = remaining.splice(0, 1);
	while (remaining.length > 0) {
		const last = seated[seated.length - 1];
		let best = 0;
		for (let i = 1; i < remaining.length; i++) {
			if (shared(last, remaining[i]) > shared(last, remaining[best])) best = i;
		}
		seated.push(...remaining.splice(best, 1));
	}
	return seated;
}

/**
 * Where every tree worker aims, as a radial tree layout. Each Committee member
 * gets a wedge of the circle sized by its whole tree, and each worker splits its
 * wedge into one slot per worker in its subtree: its own slot in the middle,
 * each child's share either side. A worker never sits on top of its child, so
 * even a tie within one band stays a visible line. Children in outer bands take
 * the slots nearest the parent and inner ones the far sides, so a spoke to an
 * outer worker never passes over a sibling nearer the centre. Wedges never
 * overlap, so neither do branches.
 */
export function treeAngles(workers: Worker[], parent: Map<string, string>): Map<string, number> {
	const byWorkerId = new Map(workers.map((worker) => [worker.id, worker]));
	const children = new Map<string, Worker[]>();
	for (const [childId, parentId] of parent) {
		children.set(parentId, [...(children.get(parentId) ?? []), byWorkerId.get(childId)!]);
	}
	const size = new Map<string, number>();
	const measure = (worker: Worker): number => {
		const total = (children.get(worker.id) ?? []).reduce((sum, child) => sum + measure(child), 1);
		size.set(worker.id, total);
		return total;
	};
	const committee = seatBySharing(
		workers,
		workers.filter((worker) => worker.assessment === 'Leader').sort(byId)
	);
	const whole = committee.reduce((sum, member) => sum + measure(member), 0);
	const angles = new Map<string, number>();
	const assign = (worker: Worker, from: number, to: number, toward: 'start' | 'end' | null) => {
		const ranked = [...(children.get(worker.id) ?? [])].sort(
			(a, b) => treeDepth(b) - treeDepth(a) || size.get(b.id)! - size.get(a.id)! || byId(a, b)
		);
		// Centre-out: the worker's own slot in the middle, then its children
		// alternately either side, nearest first. A worker reached from within its
		// own band instead takes the end of its wedge facing its parent, with its
		// children running away from it, so nothing of its subtree sits between
		// the two and the tie joining them along the band crosses no one.
		const order: (Worker | null)[] = [null];
		if (toward === 'start') order.push(...ranked);
		else if (toward === 'end') order.unshift(...ranked.reverse());
		else
			ranked.forEach((child, index) =>
				index % 2 === 0 ? order.push(child) : order.unshift(child)
			);
		const slot = (to - from) / size.get(worker.id)!;
		const before = order
			.slice(0, order.indexOf(null))
			.reduce((sum, item) => sum + size.get(item!.id)!, 0);
		const own = from + slot * (before + 0.5);
		let cursor = from;
		for (const item of order) {
			const span = slot * (item ? size.get(item.id)! : 1);
			if (item) {
				const sameBand = treeDepth(item) === treeDepth(worker);
				assign(item, cursor, cursor + span, sameBand ? (cursor < own ? 'end' : 'start') : null);
			} else angles.set(worker.id, cursor + span / 2);
			cursor += span;
		}
	};
	// The first member's wedge is centred on twelve o'clock.
	let cursor = -Math.PI / 2 - (Math.PI * (size.get(committee[0]?.id ?? '') ?? 0)) / whole;
	for (const member of committee) {
		const share = (Math.PI * 2 * size.get(member.id)!) / whole;
		// A tree never fans wider than a quarter turn, however few members share
		// the circle, so its spokes always lean outward rather than across the centre.
		const span = Math.min(share, MAX_TREE_WEDGE);
		const middle = cursor + share / 2;
		assign(member, middle - span / 2, middle + span / 2, null);
		cursor += share;
	}
	return angles;
}

/**
 * The angles, at `radius`, where a tie passes within a dot's reach of that
 * circle. A worker outside the trees is never seated on one of them, so no
 * tie runs over a dot it does not join.
 */
export function tieCrossings(
	segments: { x1: number; y1: number; x2: number; y2: number }[],
	radius: number
): number[] {
	const crossings: number[] = [];
	for (const { x1, y1, x2, y2 } of segments) {
		for (let step = 0; step <= TIE_SAMPLES; step++) {
			const x = x1 + ((x2 - x1) * step) / TIE_SAMPLES;
			const y = y1 + ((y2 - y1) * step) / TIE_SAMPLES;
			if (Math.abs(Math.hypot(x - CHART_CENTER, y - CHART_CENTER) - radius) < MIN_PITCH) {
				crossings.push(Math.atan2(y - CHART_CENTER, x - CHART_CENTER));
			}
		}
	}
	return crossings;
}
