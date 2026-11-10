/**
 * Graph-distance stress layout: all-pairs shortest paths, weighted stress
 * majorization by localized Gauss–Seidel, and pinned nodes the solver moves
 * around. Pure and deterministic — the same nodes, links and seed key always
 * produce the same positions.
 *
 * An edge's graph distance is 1 by default, shortened to 1/√strength for
 * weighted quotient ties, or stretched between high-degree hubs (hub spacing).
 * Every pair's stress weight is 1/d².
 */
export type StressNode = { id: string };
export type StressLink = { source: string; target: string; strength?: number };
export type StressPoint = { x: number; y: number };

/** Length, in canvas units, of one shortest-path step at unit weight. */
export const stressEdgeLength = 36;
/** Jitter amplitude at the circle seed. */
export const stressSeedJitter = 0.3;
/** Neighbour clearance, as a fraction of the two radii, added inside each target. */
const stressOverlapFactor = 0.9;
/** How much hub spacing adds per degree above a trivial pair. */
const stressHubSpacing = 0.12;

/** The degree of every node, drawn from the links themselves. */
function nodeDegrees(
	nodes: readonly StressNode[],
	links: readonly StressLink[]
): Map<string, number> {
	const degrees = new Map<string, number>(nodes.map(({ id }) => [id, 0]));
	for (const { source, target } of links) {
		if (degrees.has(source)) degrees.set(source, (degrees.get(source) ?? 0) + 1);
		if (degrees.has(target)) degrees.set(target, (degrees.get(target) ?? 0) + 1);
	}
	return degrees;
}

/** The canonical key for an unordered pair, so determinism never reads array order. */
export function pairKey(a: string, b: string): string {
	return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/** A pair's target distance is never allowed to collapse to zero. */
const minPairDistance = 1e-9;

/**
 * All-pairs graph distances as one flat `n²` array, indexed `i·n + j`. This is
 * what the solver reads: a flat array keeps the inner sweep on numbers, with no
 * string key built and no `Map` probe per pair.
 *
 * The walk is Dijkstra from each Worker over the adjacency, not Floyd–Warshall
 * over a dense matrix. A real worksite's relationship graph is sparse — a couple
 * of Relationships per Worker — so the cubic dense pass dominated everything
 * else; this drops to `O(n·(n + m) log n)`. Dijkstra rather than a plain
 * breadth-first walk because hub spacing makes an edge's weight fractional, so a
 * path's weight is not its hop count.
 *
 * Unreachable pairs take `maxFinite + 1`: far enough to pull apart, not so far
 * that one isolate stretches the embedding past its largest real distance.
 */
function distanceMatrix(
	nodes: readonly StressNode[],
	links: readonly StressLink[],
	hubSpacing: boolean,
	linkDistanceFor?: (link: StressLink) => number
): { distances: Float64Array; maxFinite: number } {
	const n = nodes.length;
	const distances = new Float64Array(n * n);
	if (n === 0) return { distances, maxFinite: 0 };

	const indexOf = new Map<string, number>(nodes.map(({ id }, index) => [id, index]));
	const degrees = hubSpacing ? nodeDegrees(nodes, links) : undefined;

	// Neighbours with the lightest weight each edge carries. A duplicate edge
	// keeps its lightest, matching the dense matrix this replaces, and a link
	// naming a Worker outside the set is ignored.
	const adjacency = new Map<number, Map<number, number>>();
	for (const link of links) {
		const { source, target, strength: linkStrength } = link;
		const i = indexOf.get(source);
		const j = indexOf.get(target);
		if (i === undefined || j === undefined || i === j) continue;

		const baseWeight =
			degrees === undefined
				? 1
				: 1 +
					stressHubSpacing *
						Math.max(0, (degrees.get(source) ?? 0) + (degrees.get(target) ?? 0) - 4);
		// A stronger quotient edge is a shorter weighted graph step. Ordinary
		// Worker links have strength 1 and retain their existing geometry.
		const requestedStrength = linkStrength ?? 1;
		const strength =
			Number.isFinite(requestedStrength) && requestedStrength > 0 ? requestedStrength : 1;
		const requestedDistance = linkDistanceFor?.(link);
		const weight =
			requestedDistance !== undefined && Number.isFinite(requestedDistance) && requestedDistance > 0
				? requestedDistance
				: baseWeight / Math.sqrt(strength);

		let neighbours = adjacency.get(i);
		if (!neighbours) adjacency.set(i, (neighbours = new Map()));
		if (weight < (neighbours.get(j) ?? Number.POSITIVE_INFINITY)) neighbours.set(j, weight);

		neighbours = adjacency.get(j);
		if (!neighbours) adjacency.set(j, (neighbours = new Map()));
		if (weight < (neighbours.get(i) ?? Number.POSITIVE_INFINITY)) neighbours.set(i, weight);
	}

	// One Dijkstra run per source, over the shared adjacency.
	const shortest = new Float64Array(n);
	const settled = new Uint8Array(n);
	for (let source = 0; source < n; source += 1) {
		shortest.fill(Number.POSITIVE_INFINITY);
		settled.fill(0);
		shortest[source] = 0;

		for (;;) {
			// The nearest unsettled Worker. A linear scan is the right tool at
			// this size: one group at most, never a whole worksite of thousands.
			let current = -1;
			let best = Number.POSITIVE_INFINITY;
			for (let k = 0; k < n; k += 1) {
				if (!settled[k] && shortest[k] < best) {
					best = shortest[k];
					current = k;
				}
			}
			if (current === -1) break;
			settled[current] = 1;

			for (const [next, weight] of adjacency.get(current) ?? []) {
				if (settled[next]) continue;
				const candidate = best + weight;
				if (candidate < shortest[next]) shortest[next] = candidate;
			}
		}

		distances.set(shortest, source * n);
	}

	// The farthest real distance, so the pairs nothing connects take the next
	// step beyond it rather than an unbounded distance.
	let maxFinite = 0;
	for (let i = 0; i < n; i += 1) {
		for (let j = 0; j < n; j += 1) {
			if (i === j) continue;
			const d = distances[i * n + j];
			if (Number.isFinite(d) && d > maxFinite) maxFinite = d;
		}
	}

	for (let i = 0; i < n; i += 1) {
		for (let j = 0; j < n; j += 1) {
			if (i !== j && !Number.isFinite(distances[i * n + j])) distances[i * n + j] = maxFinite + 1;
		}
	}

	return { distances, maxFinite };
}

/**
 * Graph distances keyed by {@link pairKey}, for callers outside the solver and
 * for the public contract this module has always had. The solver itself reads
 * {@link distanceMatrix} directly.
 */
export function graphDistances(
	nodes: readonly StressNode[],
	links: readonly StressLink[],
	options: { hubSpacing?: boolean } = {}
): Map<string, number> {
	const ids = nodes.map(({ id }) => id);
	const { distances } = distanceMatrix(nodes, links, options.hubSpacing ?? false);

	const keyed = new Map<string, number>();
	for (let i = 0; i < ids.length; i += 1) {
		for (let j = 0; j < ids.length; j += 1) {
			if (i === j) continue;
			keyed.set(pairKey(ids[i], ids[j]), distances[i * ids.length + j]);
		}
	}
	return keyed;
}

/** Sweeps at the top end: the count the solver shipped with, kept as the ceiling. */
export const stressSweepCeiling = 220;
/** Sweeps at the bottom end: enough for a large graph to still read as a layout. */
export const stressSweepFloor = 60;
/**
 * Total sweep-work budget. One sweep costs `O(n²)`, so the cost of a full solve
 * is `budget · n`. At or below 200 Workers the ceiling is what binds, so no map
 * that fits today changes shape; past that the sweeps thin out instead of the
 * solve growing without bound.
 */
export const stressSweepBudget = 44_000;

/**
 * How many Gauss–Seidel sweeps a graph of `n` Workers is worth. A sweep is
 * `O(n²)`, so a constant count lets the solve grow as the square of the Workers table;
 * this spreads a fixed work budget instead, never below the floor (which would
 * leave the circle seed standing) and never above the ceiling.
 */
export function stressSweeps(n: number): number {
	if (n <= 0) return stressSweepCeiling;
	return Math.min(
		stressSweepCeiling,
		Math.max(stressSweepFloor, Math.floor(stressSweepBudget / n))
	);
}

/** Deterministic jitter in [0, 1), keyed on a string. */
function seededJitter(seedKey: string, index: number, round: number): number {
	// Spread, not cryptography: a string hash fanned through integer mixes is
	// enough, and it never reads the clock or Math.random.
	let h = 2166136261;
	for (let i = 0; i < seedKey.length; i += 1) {
		h = (h ^ seedKey.charCodeAt(i)) >>> 0;
		h = (h * 16777619) >>> 0;
	}
	h = (h ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
	h = (h ^ Math.imul(round + 1, 0x85ebca77)) >>> 0;
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35) >>> 0;
	h ^= h >>> 16;
	return h / 0x100000000;
}

/**
 * The deterministic circle seed: radius `m·L/6`, angle `2πk/m` plus seeded
 * jitter, so equal work always starts from the same shape.
 */
function stressCircleSeed(
	seedKey: string,
	ids: readonly string[],
	edgeLength: number = stressEdgeLength
): StressPoint[] {
	const m = Math.max(1, ids.length);
	const radius = (m * edgeLength) / 6;
	return ids.map((id, index) => {
		const angle = (index / m) * Math.PI * 2 + stressSeedJitter * seededJitter(seedKey, index, 0);
		return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
	});
}

let pairVisitTotal = 0;

/**
 * Running count of pair terms the sweeps have visited, across every
 * `stressLayout` call. Tests read the difference around a call to measure the
 * work done, which unlike a stopwatch does not move with machine load.
 */
export function stressPairVisits(): number {
	return pairVisitTotal;
}

export type StressOptions = {
	/** Add the pairwise clearance term, so real nodes keep their radii apart. */
	overlapAware?: boolean;
	/** The solver never moves these nodes. */
	pinnedIds?: ReadonlySet<string>;
	/** Each node's drawn radius, for the clearance term. Defaults to 0. */
	radiusFor?: (id: string) => number;
	/** Target-length scale for each weighted graph-distance step. */
	edgeLength?: number;
	/** Custom graph step in `edgeLength` units, used for radius-aware body links. */
	linkDistanceFor?: (link: StressLink) => number;
	/** Where the sweep starts. Defaults to the module's own circle seed. */
	seed?: ReadonlyMap<string, StressPoint>;
	/** Keys the circle seed's jitter. Defaults to the node ids joined in order. */
	seedKey?: string;
};

/**
 * Weighted stress majorization, localized (Gauss–Seidel): every free node, in
 * sweep after sweep, is moved by the weighted direction sum that carries each
 * pair to its target distance `d_ij·L` (plus the overlap-aware clearance).
 */
export function stressLayout(
	nodes: readonly StressNode[],
	links: readonly StressLink[],
	options: StressOptions = {}
): Map<string, StressPoint> {
	const n = nodes.length;
	if (n === 0) return new Map();

	const ids = nodes.map(({ id }) => id);

	const radiusFor = options.radiusFor ?? (() => 0);
	const pinned = options.pinnedIds ?? new Set<string>();

	const edgeLength = options.edgeLength ?? stressEdgeLength;
	const { distances } = distanceMatrix(
		nodes,
		links,
		options.overlapAware ?? false,
		options.linkDistanceFor
	);
	const radii = ids.map((id) => radiusFor(id));

	// Target distance t_ij = d_ij·L plus the overlap-aware clearance
	// 0.9·(r_i + r_j); pair weight w_ij = 1/d_ij².
	const targets = new Array<number>(n * n);
	const weights = new Array<number>(n * n);
	for (let i = 0; i < n; i += 1) {
		for (let j = 0; j < n; j += 1) {
			if (i === j) {
				targets[i * n + j] = 0;
				weights[i * n + j] = 0;
				continue;
			}
			const d = Math.max(distances[i * n + j], minPairDistance);
			const clearance = options.overlapAware ? stressOverlapFactor * (radii[i] + radii[j]) : 0;
			targets[i * n + j] = d * edgeLength + clearance;
			weights[i * n + j] = 1 / (d * d);
		}
	}

	const seed = options.seed;
	const circle = stressCircleSeed(options.seedKey ?? ids.join('|'), ids, edgeLength);
	const positions: { x: number; y: number }[] = ids.map(
		(id, index) => seed?.get(id) ?? circle[index]
	);

	for (let round = 0; round < stressSweeps(n); round += 1) {
		for (let i = 0; i < n; i += 1) {
			if (pinned.has(ids[i])) continue;

			pairVisitTotal += n;
			let weightSum = 0;
			let moveX = 0;
			let moveY = 0;
			for (let j = 0; j < n; j += 1) {
				const w = weights[i * n + j];
				if (w <= 0) continue;
				const dx = positions[i].x - positions[j].x;
				const dy = positions[i].y - positions[j].y;
				const length = Math.hypot(dx, dy);
				if (length === 0) {
					// Degenerate overlap: nudge deterministically so the sweep cannot stall.
					const push = 0.25 + 0.5 * seededJitter(`${ids[i]}:${ids[j]}`, round, 1);
					moveX += w * push * (i < j ? -1 : 1);
					moveY += 0;
					weightSum += w;
					continue;
				}
				// The weighted move that carries this pair to t_ij exactly.
				const correction = (length - targets[i * n + j]) / length;
				moveX += w * dx * correction;
				moveY += w * dy * correction;
				weightSum += w;
			}

			if (weightSum === 0) continue;
			positions[i] = {
				x: positions[i].x - moveX / weightSum,
				y: positions[i].y - moveY / weightSum
			};
		}
	}

	// Recentre on the laid-out nodes' centroid.
	let cx = 0;
	let cy = 0;
	for (const { x, y } of positions) {
		cx += x;
		cy += y;
	}
	cx /= n;
	cy /= n;

	const result = new Map<string, StressPoint>();
	for (let i = 0; i < n; i += 1) {
		result.set(ids[i], { x: positions[i].x - cx, y: positions[i].y - cy });
	}
	return result;
}

/**
 * The weighted squared gap between each pair's drawn distance and the target
 * `stressLayout` solves for: the energy a multi-start keeps the least of.
 */
export function stressEnergy(
	positions: ReadonlyMap<string, StressPoint>,
	nodes: readonly StressNode[],
	links: readonly StressLink[],
	options: StressOptions = {}
): number {
	const ids = nodes.map(({ id }) => id);
	const n = ids.length;
	const edgeLength = options.edgeLength ?? stressEdgeLength;
	const { distances } = distanceMatrix(
		nodes,
		links,
		options.overlapAware ?? false,
		options.linkDistanceFor
	);
	const radiusFor = options.radiusFor ?? (() => 0);
	let energy = 0;
	for (let i = 0; i < n; i += 1) {
		for (let j = i + 1; j < n; j += 1) {
			const d = Math.max(distances[i * n + j], minPairDistance);
			const w = 1 / (d * d);
			if (!(w > 0) || !Number.isFinite(w)) continue;
			const a = positions.get(ids[i]);
			const b = positions.get(ids[j]);
			if (!a || !b) continue;
			const clearance = options.overlapAware
				? stressOverlapFactor * (radiusFor(ids[i]) + radiusFor(ids[j]))
				: 0;
			const gap = Math.hypot(a.x - b.x, a.y - b.y) - (d * edgeLength + clearance);
			energy += w * gap * gap;
		}
	}
	return energy;
}

/**
 * Scales a layout to fit a canvas region, then runs a short pairwise
 * separation pass as the safety net a fit can need.
 */
export function fitAndSeparate(
	positions: Map<string, StressPoint>,
	radiusFor: (id: string) => number,
	canvas: { width: number; height: number; centre?: StressPoint },
	options: { pad?: number; iterations?: number; scaleCap?: number } = {}
): Map<string, StressPoint> {
	const pad = options.pad ?? 10;
	const iterations = options.iterations ?? 60;
	const scaleCap = options.scaleCap ?? 1.8;

	if (positions.size === 0) return positions;

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [id, { x, y }] of positions) {
		const r = radiusFor(id);
		minX = Math.min(minX, x - r);
		minY = Math.min(minY, y - r);
		maxX = Math.max(maxX, x + r);
		maxY = Math.max(maxY, y + r);
	}
	const w = maxX - minX;
	const h = maxY - minY;

	const centre = canvas.centre ?? { x: 0, y: 0 };
	const fitted = new Map<string, StressPoint>();
	if (w === 0 && h === 0) {
		for (const [id, point] of positions) fitted.set(id, { ...point });
		return fitted;
	}

	const scale = Math.min(
		scaleCap,
		...(w > 0 ? [canvas.width / w] : []),
		...(h > 0 ? [canvas.height / h] : [])
	);
	for (const [id, { x, y }] of positions) {
		fitted.set(id, { x: x * scale + centre.x, y: y * scale + centre.y });
	}

	return separatePositions(fitted, radiusFor, pad, iterations);
}

let separationChecks = 0;

/** Pair checks made by `separatePositions` so far. For specs only. */
export function separationPairChecks(): number {
	return separationChecks;
}

/**
 * Pairwise separation: every two nodes keep their radii plus `pad` apart.
 * Pairs are resolved in sorted-id order against current positions, as an
 * all-pairs sweep would. A uniform grid built each round finds the pairs that
 * can be in range; its query widens by how far nodes have moved this round.
 */
export function separatePositions(
	positions: Map<string, StressPoint>,
	radiusFor: (id: string) => number,
	pad: number,
	iterations: number
): Map<string, StressPoint> {
	const fitted = new Map(
		[...positions].map(([id, point]) => [id, { x: point.x, y: point.y }] as const)
	);
	const ids = [...fitted.keys()].sort();
	const n = ids.length;
	const points = ids.map((id) => fitted.get(id) as StressPoint);
	const radii = ids.map((id) => radiusFor(id));
	let maxRadius = 0;
	for (const r of radii) if (r > maxRadius) maxRadius = r;
	const maxPair = 2 * maxRadius + pad;
	const cell = maxPair > 0 ? maxPair : 1;
	const startX = new Float64Array(n);
	const startY = new Float64Array(n);
	const cellOf = (v: number) => Math.floor(v / cell);
	const keyOf = (cx: number, cy: number) => cx * 73856093 + cy * 19349663;

	for (let round = 0; round < iterations; round += 1) {
		let moved = false;
		const grid = new Map<number, number[]>();
		for (let k = 0; k < n; k += 1) {
			startX[k] = points[k].x;
			startY[k] = points[k].y;
			const key = keyOf(cellOf(startX[k]), cellOf(startY[k]));
			const bucket = grid.get(key);
			if (bucket) bucket.push(k);
			else grid.set(key, [k]);
		}
		let maxDisp = 0;
		const gather = (i: number, reach: number): number[] => {
			const span = Math.ceil((maxPair + 2 * reach) / cell);
			const cx = cellOf(startX[i]);
			const cy = cellOf(startY[i]);
			const found: number[] = [];
			for (let gx = cx - span; gx <= cx + span; gx += 1) {
				for (let gy = cy - span; gy <= cy + span; gy += 1) {
					const bucket = grid.get(keyOf(gx, gy));
					if (!bucket) continue;
					for (const k of bucket) if (k > i) found.push(k);
				}
			}
			found.sort((p, q) => p - q);
			return found;
		};
		for (let i = 0; i < n; i += 1) {
			const a = points[i];
			let reach = maxDisp + 0.5 * cell;
			let candidates = gather(i, reach);
			let last = -1;
			for (let c = 0; c < candidates.length; c += 1) {
				const j = candidates[c];
				if (j === last) continue;
				if (maxDisp > reach) {
					reach = maxDisp + 0.5 * cell;
					candidates = gather(i, reach).filter((k) => k >= j);
					c = -1;
					last = j - 1;
					continue;
				}
				last = j;
				separationChecks += 1;
				const b = points[j];
				const dTarget = radii[i] + radii[j] + pad;
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const length = Math.hypot(dx, dy);
				if (length >= dTarget) continue;
				if (length === 0) {
					const angle = seededJitter(`${ids[i]}:${ids[j]}`, round, 1) * Math.PI * 2;
					a.x -= Math.cos(angle) * dTarget * 0.5;
					a.y -= Math.sin(angle) * dTarget * 0.5;
					b.x += Math.cos(angle) * dTarget * 0.5;
					b.y += Math.sin(angle) * dTarget * 0.5;
				} else {
					const push = (dTarget - length) * 0.5;
					a.x -= (dx / length) * push;
					a.y -= (dy / length) * push;
					b.x += (dx / length) * push;
					b.y += (dy / length) * push;
				}
				const da = Math.hypot(a.x - startX[i], a.y - startY[i]);
				const db = Math.hypot(b.x - startX[j], b.y - startY[j]);
				if (da > maxDisp) maxDisp = da;
				if (db > maxDisp) maxDisp = db;
				moved = true;
			}
		}
		if (!moved) break;
	}
	return fitted;
}
