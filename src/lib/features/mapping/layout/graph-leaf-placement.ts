/** Deterministic degree-one fans; no Worker or Relationship is removed. */
import type { StressPoint } from './graph-stress.ts';
export type LeafBound = { centre: StressPoint; radius: number };

/**
 * Only global degree-one Workers qualify. Local callers pass that global set;
 * a leaf whose neighbour is outside the local body keeps its existing place.
 * At most six clearance rings are tried per angular gap, then the old finite
 * placement wins. Dyads stay untouched. Only accepted leaves move.
 */
export function fanLeaves(
	positions: ReadonlyMap<string, StressPoint>,
	links: readonly { source: string; target: string }[],
	radiusFor: (id: string) => number,
	eligible?: ReadonlySet<string>,
	bounds?: ReadonlyMap<string, LeafBound>
): Map<string, StressPoint> {
	const result = new Map(positions);
	const neighbours = new Map<string, Set<string>>();
	for (const { source, target } of links) {
		if (source === target) continue;
		for (const [a, b] of [
			[source, target],
			[target, source]
		]) {
			const set = neighbours.get(a) ?? new Set<string>();
			set.add(b);
			neighbours.set(a, set);
		}
	}
	const leaves = new Map<string, string[]>();
	for (const [id, adjacent] of neighbours) {
		if (adjacent.size !== 1 || !result.has(id) || (eligible && !eligible.has(id))) continue;
		const hub = [...adjacent][0];
		if (!result.has(hub) || (neighbours.get(hub)?.size ?? 0) <= 1) continue;
		const list = leaves.get(hub) ?? [];
		list.push(id);
		leaves.set(hub, list);
	}
	const tau = Math.PI * 2;
	for (const hub of [...leaves.keys()].sort()) {
		const ids = leaves.get(hub)!.sort();
		const leafSet = new Set(ids);
		const origin = result.get(hub)!;
		const angles = [...(neighbours.get(hub) ?? [])]
			.filter((id) => !leafSet.has(id) && result.has(id))
			.map((id) => {
				const p = result.get(id)!;
				return (Math.atan2(p.y - origin.y, p.x - origin.x) + tau) % tau;
			})
			.sort((a, b) => a - b);
		const gaps = angles.length
			? angles.map((start, i) => ({
					start,
					size: (angles[(i + 1) % angles.length] - start + tau) % tau || tau
				}))
			: [{ start: 0, size: tau }];
		gaps.sort((a, b) => b.size - a.size || a.start - b.start);
		let accepted: Map<string, StressPoint> | undefined;
		const largestRadius = Math.max(...ids.map(radiusFor));
		const rest = radiusFor(hub) + largestRadius + 30;
		for (const gap of gaps) {
			for (let ring = 0; ring < 6; ring += 1) {
				const distance =
					Math.max(rest, ((ids.length + 1) * (2 * largestRadius + 3)) / gap.size) +
					ring * (2 * largestRadius + 3);
				const candidate = new Map(
					ids.map((id, i) => {
						const angle =
							gap.start + gap.size * (angles.length ? (i + 1) / (ids.length + 1) : i / ids.length);
						return [
							id,
							{ x: origin.x + Math.cos(angle) * distance, y: origin.y + Math.sin(angle) * distance }
						];
					})
				);
				const invalid = [...candidate].some(([id, p]) => {
					const bound = bounds?.get(id);
					if (
						bound &&
						Math.hypot(p.x - bound.centre.x, p.y - bound.centre.y) + radiusFor(id) >
							bound.radius + 1e-6
					)
						return true;
					return [...result].some(([other, q]) => {
						if (other === id) return false;
						const point = candidate.get(other) ?? q;
						return (
							Math.hypot(p.x - point.x, p.y - point.y) < radiusFor(id) + radiusFor(other) + 1 - 1e-6
						);
					});
				});
				if (!invalid) {
					accepted = candidate;
					break;
				}
			}
			if (accepted) break;
		}
		for (const [id, p] of accepted ?? []) result.set(id, p);
	}
	return result;
}
