/** Rigid orientation against actual, settled outward Relationship endpoints. */
import { compareText, keyAsLabel, type LabelOf } from './graph-analysis.ts';
import type { StressPoint } from './graph-stress.ts';
import { properIntersectionParams } from './graph-layout-quality.ts';

/** Distance from a point to a segment. */
function distanceToSegment(p: StressPoint, a: StressPoint, b: StressPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	const t =
		lengthSquared === 0
			? 0
			: Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The clearance a tie keeps from a dot that is not its end, as the quality measure counts it. */
const dotClearance = 4;

/**
 * Two deterministic coordinate-descent sweeps, 36 rotations × two reflections
 * per body. Identity wins equivalent choices. Each accepted rigid transform
 * shortens actual outward length and preserves existing dot clearance. No
 * solver, membership change, or all-pairs graph-distance table is involved.
 */
export function orientBodies(
	positions: ReadonlyMap<string, StressPoint>,
	memberOf: ReadonlyMap<string, string>,
	links: readonly { source: string; target: string }[],
	radiusFor: (id: string) => number,
	centres?: ReadonlyMap<string, StressPoint>,
	labelOf: LabelOf = keyAsLabel,
	options: { endCrossings?: boolean; dotHits?: boolean } = {}
): Map<string, StressPoint> {
	const result = new Map(positions);
	const members = new Map<string, string[]>();
	for (const [id, key] of memberOf) {
		if (!result.has(id)) continue;
		const list = members.get(key) ?? [];
		list.push(id);
		members.set(key, list);
	}
	const outward = new Map<string, { member: string; partner: string }[]>();
	for (const { source, target } of links) {
		const a = memberOf.get(source);
		const b = memberOf.get(target);
		if (a === undefined || b === undefined || a === b) continue;
		for (const [key, member, partner] of [
			[a, source, target],
			[b, target, source]
		]) {
			if (!result.has(member) || !result.has(partner)) continue;
			const list = outward.get(key) ?? [];
			list.push({ member, partner });
			outward.set(key, list);
		}
	}
	for (let sweep = 0; sweep < 2; sweep += 1) {
		for (const key of [...members.keys()].sort((a, b) => compareText(labelOf(a), labelOf(b)))) {
			const ids = members.get(key)!;
			const ties = outward.get(key) ?? [];
			if (ids.length < 2 || ties.length === 0) continue;
			const centre = centres?.get(key) ?? {
				x: ids.reduce((sum, id) => sum + result.get(id)!.x, 0) / ids.length,
				y: ids.reduce((sum, id) => sum + result.get(id)!.y, 0) / ids.length
			};
			const offsets = ids.map((id) => ({
				id,
				x: result.get(id)!.x - centre.x,
				y: result.get(id)!.y - centre.y
			}));
			const reach = Math.max(...offsets.map((p) => Math.hypot(p.x, p.y) + radiusFor(p.id)));
			// Only dots inside the invariant bounding circle can collide under a
			// rotation/reflection. Distant bodies cost one check per dot per sweep.
			const nearby = [...result].filter(
				([id, p]) =>
					memberOf.get(id) !== key &&
					Math.hypot(p.x - centre.x, p.y - centre.y) < reach + radiusFor(id)
			);
			const length = (candidate: ReadonlyMap<string, StressPoint>) =>
				ties.reduce((sum, tie) => {
					const a = candidate.get(tie.member)!;
					const b = result.get(tie.partner)!;
					return sum + Math.hypot(a.x - b.x, a.y - b.y);
				}, 0);
			// Near-end crossings: a tie that crosses another tie or an outside link close to
			// its own endpoint reads as a dot-to-dot tangle. Ties and nearby outside links only.
			const endTies = ties;
			const others =
				options.endCrossings || options.dotHits
					? links.flatMap(({ source, target }) => {
							if (memberOf.get(source) === key || memberOf.get(target) === key) return [];
							if (!result.has(source) || !result.has(target)) return [];
							const near = [source, target].some((id) => {
								const p = result.get(id)!;
								return Math.hypot(p.x - centre.x, p.y - centre.y) < reach + 400;
							});
							return near ? [{ member: source, partner: target }] : [];
						})
					: [];
			const endCrossingsOf = (candidate: ReadonlyMap<string, StressPoint>) => {
				if (!options.endCrossings) return 0;
				if (endTies.length * (endTies.length + others.length) > 4000) return 0;
				const position = (id: string) => candidate.get(id) ?? result.get(id)!;
				const segments = [...endTies, ...others].map((tie) => ({
					ids: [tie.member, tie.partner] as const,
					a: position(tie.member),
					b: position(tie.partner)
				}));
				let count = 0;
				for (let i = 0; i < endTies.length; i += 1) {
					for (let j = i + 1; j < segments.length; j += 1) {
						const first = segments[i];
						const second = segments[j];
						if (first.ids.includes(second.ids[0]) || first.ids.includes(second.ids[1])) continue;
						const params = properIntersectionParams(first.a, first.b, second.a, second.b);
						if (params && Math.min(params.t, 1 - params.t, params.u, 1 - params.u) < 0.2)
							count += 1;
					}
				}
				return count;
			};
			// Ties that pass through a dot they do not end at: the rotated body's own ties, the
			// outside links that now cross its dots, and its ties across nearby dots.
			const dotHitsOf = (candidate: ReadonlyMap<string, StressPoint>) => {
				if (!options.dotHits) return 0;
				const position = (id: string) => candidate.get(id) ?? result.get(id)!;
				const segments = [...endTies, ...others];
				const dots = [...candidate.keys(), ...nearby.map(([id]) => id)];
				if (segments.length * dots.length > 20000) return 0;
				let count = 0;
				for (const tie of segments) {
					const a = position(tie.member);
					const b = position(tie.partner);
					for (const id of dots) {
						if (id === tie.member || id === tie.partner) continue;
						if (distanceToSegment(position(id), a, b) < radiusFor(id) + dotClearance) count += 1;
					}
				}
				return count;
			};
			let best = new Map(ids.map((id) => [id, result.get(id)!]));
			let bestLength = length(best);
			let bestHits = dotHitsOf(best);
			let bestEnds = endCrossingsOf(best);
			for (const reflection of [1, -1]) {
				for (let step = 0; step < 36; step += 1) {
					const angle = (step * Math.PI) / 18;
					const c = Math.cos(angle);
					const s = Math.sin(angle);
					const candidate = new Map(
						offsets.map((p) => [
							p.id,
							{
								x: centre.x + reflection * p.x * c - p.y * s,
								y: centre.y + reflection * p.x * s + p.y * c
							}
						])
					);
					const candidateLength = length(candidate);
					const candidateHits = dotHitsOf(candidate);
					const candidateEnds = endCrossingsOf(candidate);
					const better =
						candidateHits < bestHits ||
						(candidateHits === bestHits &&
							(candidateEnds < bestEnds ||
								(candidateEnds === bestEnds && candidateLength < bestLength - 1e-9)));
					if (!better) continue;
					const collision = [...candidate].some(([id, p]) =>
						nearby.some(
							([other, q]) =>
								Math.hypot(p.x - q.x, p.y - q.y) < radiusFor(id) + radiusFor(other) - 1e-6
						)
					);
					if (collision) continue;
					best = candidate;
					bestLength = candidateLength;
					bestHits = candidateHits;
					bestEnds = candidateEnds;
				}
			}
			for (const [id, p] of best) result.set(id, p);
		}
	}
	return result;
}
