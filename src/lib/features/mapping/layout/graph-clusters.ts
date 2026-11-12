import { freeDotClearance } from './graph-free-physics.ts';
import { placeQuotientBodies } from './graph-quotient-layout.ts';
import { stressLayout } from './graph-stress.ts';

/**
 * Deterministic Louvain clustering over the visible Relationship
 * graph, plus the gather-start the Free layout settles from. Pure; the
 * clusters never leave the arrangement (nothing draws or names them).
 */

/**
 * Cluster index per id from links alone. Visiting order is sorted by id.
 * Workers without links each form a cluster of one.
 */
export function detectClusters(
	ids: readonly string[],
	links: readonly { source: string; target: string }[]
): Map<string, number> {
	const order = [...ids].sort();
	const index = new Map(order.map((id, i) => [id, i]));
	let n = order.length;
	let adj: Map<number, number>[] = order.map(() => new Map());
	let total = 0;
	for (const { source, target } of links) {
		const a = index.get(source);
		const b = index.get(target);
		if (a === undefined || b === undefined || a === b) continue;
		adj[a].set(b, (adj[a].get(b) ?? 0) + 1);
		adj[b].set(a, (adj[b].get(a) ?? 0) + 1);
		total += 1;
	}
	// Each original worker maps to a node at the current level.
	let membership = order.map((_, i) => i);
	const m2 = 2 * total;
	if (m2 === 0) return finish(order, membership);

	for (;;) {
		const degree = adj.map((row, i) => {
			let d = 0;
			for (const [j, w] of row) d += j === i ? 2 * w : w;
			return d;
		});
		const cluster = Array.from({ length: n }, (_, i) => i);
		const tot = [...degree];
		let moved = false;
		for (let pass = 0; pass < 50; pass += 1) {
			let improved = false;
			for (let i = 0; i < n; i += 1) {
				const weights = new Map<number, number>();
				for (const [j, w] of adj[i]) {
					if (j === i) continue;
					weights.set(cluster[j], (weights.get(cluster[j]) ?? 0) + w);
				}
				const from = cluster[i];
				tot[from] -= degree[i];
				let best = from;
				let bestGain = (weights.get(from) ?? 0) - (tot[from] * degree[i]) / m2;
				for (const c of [...weights.keys()].sort((a, b) => a - b)) {
					const gain = (weights.get(c) ?? 0) - (tot[c] * degree[i]) / m2;
					if (gain > bestGain + 1e-12) {
						bestGain = gain;
						best = c;
					}
				}
				tot[best] += degree[i];
				if (best !== from) {
					cluster[i] = best;
					improved = true;
					moved = true;
				}
			}
			if (!improved) break;
		}
		if (!moved) break;
		// Aggregate: renumber by first appearance, then merge links.
		const renumber = new Map<number, number>();
		for (const c of cluster) if (!renumber.has(c)) renumber.set(c, renumber.size);
		const next: Map<number, number>[] = Array.from({ length: renumber.size }, () => new Map());
		for (let i = 0; i < n; i += 1) {
			const ci = renumber.get(cluster[i]) as number;
			for (const [j, w] of adj[i]) {
				const cj = renumber.get(cluster[j]) as number;
				// Each undirected link is seen from both ends; keep self-loops once per end.
				next[ci].set(cj, (next[ci].get(cj) ?? 0) + (ci === cj && i !== j ? w / 2 : w));
			}
		}
		membership = membership.map((node) => renumber.get(cluster[node]) as number);
		adj = next;
		n = renumber.size;
		if (n === 1) break;
	}
	return finish(order, membership);
}

function finish(order: string[], membership: number[]): Map<string, number> {
	const renumber = new Map<number, number>();
	const result = new Map<string, number>();
	order.forEach((id, i) => {
		const c = membership[i];
		if (!renumber.has(c)) renumber.set(c, renumber.size);
		result.set(id, renumber.get(c) as number);
	});
	return result;
}

type Point = { x: number; y: number };

/**
 * Inferred bodies stay private. Local stress is limited to 64 members (at most
 * 64² distances and 220·64² sweep terms), and never solves the whole visible
 * worksite. Larger bodies use a sorted breadth-first walk on a serpentine grid:
 * O(n + m) adjacency work, O(n log n) sorting, no dense distance table. Its
 * fixed spacing clears the largest drawn dots before the gentle physics pass.
 */
export function gatherStart(
	ids: readonly string[],
	clusters: ReadonlyMap<string, number>,
	canvas: { width: number; height: number },
	links: readonly { source: string; target: string }[] = [],
	radiusFor: (id: string) => number = () => 10
): Map<string, Point> {
	const members = new Map<number, string[]>();
	for (const id of [...ids].sort()) {
		const cluster = clusters.get(id);
		if (cluster === undefined) continue;
		const list = members.get(cluster) ?? [];
		list.push(id);
		members.set(cluster, list);
	}
	const internal = new Map<number, { source: string; target: string }[]>();
	const ties: { source: string; target: string; strength: number }[] = [];
	for (const link of links) {
		const a = clusters.get(link.source);
		const b = clusters.get(link.target);
		if (a === undefined || b === undefined) continue;
		if (a !== b) ties.push({ source: String(a), target: String(b), strength: 1 });
		else {
			const list = internal.get(a) ?? [];
			list.push(link);
			internal.set(a, list);
		}
	}
	const layouts = [...members].map(([cluster, list]) => {
		const localLinks = internal.get(cluster) ?? [];
		const offsets =
			list.length <= 64 && list.length < ids.length
				? stressLayout(
						list.map((id) => ({ id })),
						localLinks,
						{ overlapAware: true, radiusFor }
					)
				: boundedLocal(list, localLinks, radiusFor);
		let radius = 0;
		for (const [id, point] of offsets)
			radius = Math.max(radius, Math.hypot(point.x, point.y) + radiusFor(id));
		return { key: String(cluster), radius, offsets };
	});
	// Inferred clusters stay invisible: no outline and no label, so a linked
	// pair needs no gutter beyond the quotient's own step allowance. Unrelated
	// clusters still pack clear of each other's dots.
	const anchors = placeQuotientBodies(layouts, ties, 0, freeDotClearance);
	const start = new Map<string, Point>();
	for (const { key, offsets } of layouts) {
		const anchor = anchors.get(key)!;
		for (const [id, point] of offsets)
			start.set(id, {
				x: canvas.width / 2 + anchor.x + point.x,
				y: canvas.height / 2 + anchor.y + point.y
			});
	}
	return start;
}

function boundedLocal(
	ids: readonly string[],
	links: readonly { source: string; target: string }[],
	radiusFor: (id: string) => number
): Map<string, Point> {
	const adjacency = new Map(ids.map((id) => [id, [] as string[]]));
	for (const { source, target } of links) {
		adjacency.get(source)?.push(target);
		adjacency.get(target)?.push(source);
	}
	for (const neighbours of adjacency.values()) neighbours.sort();
	const visited = new Set<string>();
	const order: string[] = [];
	for (const id of ids) {
		if (visited.has(id)) continue;
		const queue = [id];
		visited.add(id);
		for (let i = 0; i < queue.length; i += 1) {
			const current = queue[i];
			order.push(current);
			for (const next of adjacency.get(current) ?? []) {
				if (visited.has(next) || !adjacency.has(next)) continue;
				visited.add(next);
				queue.push(next);
			}
		}
	}
	const columns = Math.ceil(Math.sqrt(ids.length));
	const spacing = 2 * Math.max(0, ...ids.map(radiusFor)) + 12;
	return new Map(
		order.map((id, i) => {
			const row = Math.floor(i / columns);
			const column = row % 2 ? columns - 1 - (i % columns) : i % columns;
			return [
				id,
				{
					x: (column - (columns - 1) / 2) * spacing,
					y: (row - (Math.ceil(ids.length / columns) - 1) / 2) * spacing
				}
			];
		})
	);
}
