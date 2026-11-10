/**
 * Free-layout physics: link springs, softened repulsion, collision and weak
 * centering, cooled by alpha until it rests.
 *
 * Pure and deterministic: starting points come from a hash of the node ids, so
 * two runs of the same input give the same positions.
 */
import {
	fitAndSeparate,
	type StressLink,
	type StressNode,
	type StressPoint
} from './graph-stress.ts';
import { nodeRadius } from './map-style.ts';

/** Alpha cools by this per tick. */
const alphaDecay = 0.97;
/** The alpha floor the run stops at. */
const alphaMin = 0.01;
/** The most ticks a run may take. */
export const freePhysicsMaxTicks = 300;
/** Link rest length between dot edges. */
const restLength = 30;
const springGain = 0.12;
/** Repulsion strength and the softening that keeps it finite. */
const repulsionGain = 6000;
const repulsionSoftening = 20;
/** Weak pull toward the canvas centre. */
const centrePull = 0.004;
/**
 * The gap collision keeps between dot edges. The gathered community start
 * reserves the same clearance, so this pass only corrects residuals.
 */
export const freeDotClearance = 3;
/** Fraction of the velocity kept each tick. */
const damping = 0.6;

export type FreePhysicsOptions = {
	/** Where each worker starts; workers without one are seeded from their id. */
	start?: ReadonlyMap<string, StressPoint>;
	/** Workers held at their given point for the whole run. */
	pinned?: ReadonlyMap<string, StressPoint>;
	/** The alpha the run begins with (1 by default; lower to re-heat gently). */
	alpha?: number;
	/** Called once per tick. */
	onTick?: () => void;
	/** Caps the ticks this run may take (the full cap by default). */
	maxTicks?: number;
};

/** A stable 0..1 value from a string and a salt. */
function hash01(text: string, salt: number): number {
	let h = 2166136261 ^ salt;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	h ^= h >>> 15;
	h = Math.imul(h, 2246822507);
	h ^= h >>> 13;
	return (h >>> 0) / 4294967296;
}

export function freePhysicsLayout(
	nodes: readonly StressNode[],
	links: readonly StressLink[],
	canvas: { width: number; height: number },
	options: FreePhysicsOptions = {}
): Map<string, StressPoint> {
	const cx = canvas.width / 2;
	const cy = canvas.height / 2;
	const ids = nodes.map((n) => n.id);
	const index = new Map(ids.map((id, i) => [id, i]));
	const n = ids.length;
	if (n === 0) return new Map();

	const degree = new Array<number>(n).fill(0);
	const pairs: [number, number][] = [];
	for (const { source, target } of links) {
		const a = index.get(source);
		const b = index.get(target);
		if (a === undefined || b === undefined || a === b) continue;
		pairs.push([a, b]);
		degree[a] += 1;
		degree[b] += 1;
	}
	const radius = degree.map((d) => nodeRadius(d));

	const spread = Math.sqrt(n) * 28;
	// Seed and centre-pull follow the canvas ratio, so a wide canvas settles as
	// a wide cloud instead of a disc fitted by its short side.
	const aspect = Math.max(canvas.width, 1) / Math.max(canvas.height, 1);
	const x = new Float64Array(n);
	const y = new Float64Array(n);
	const vx = new Float64Array(n);
	const vy = new Float64Array(n);
	const fixed = new Array<boolean>(n).fill(false);
	ids.forEach((id, i) => {
		const pin = options.pinned?.get(id);
		const given = pin ?? options.start?.get(id);
		if (given) {
			x[i] = given.x;
			y[i] = given.y;
		} else {
			const angle = hash01(id, 1) * Math.PI * 2;
			const reach = Math.sqrt(hash01(id, 2)) * spread;
			x[i] = cx + Math.cos(angle) * reach * aspect;
			y[i] = cy + Math.sin(angle) * reach;
		}
		if (pin) fixed[i] = true;
	});

	let alpha = options.alpha ?? 1;
	const tickCap = Math.min(options.maxTicks ?? freePhysicsMaxTicks, freePhysicsMaxTicks);
	for (let tick = 0; tick < tickCap && alpha >= alphaMin; tick += 1) {
		for (let i = 0; i < n; i += 1) {
			for (let j = i + 1; j < n; j += 1) {
				let dx = x[j] - x[i];
				let dy = y[j] - y[i];
				if (dx === 0 && dy === 0) {
					dx = hash01(ids[i], j + 3) - 0.5;
					dy = hash01(ids[j], i + 7) - 0.5;
				}
				const d2 = dx * dx + dy * dy;
				const d = Math.sqrt(d2);
				const push = (repulsionGain * alpha) / (d2 + repulsionSoftening * repulsionSoftening);
				let f = -push;
				const touch = radius[i] + radius[j] + freeDotClearance;
				if (d < touch) f -= (touch - d) * 0.5;
				const fx = (dx / d) * f;
				const fy = (dy / d) * f;
				vx[i] -= fx;
				vy[i] -= fy;
				vx[j] += fx;
				vy[j] += fy;
			}
		}
		for (const [a, b] of pairs) {
			const dx = x[b] - x[a];
			const dy = y[b] - y[a];
			const d = Math.hypot(dx, dy) || 1;
			const rest = radius[a] + radius[b] + restLength;
			const f = (d - rest) * springGain * alpha;
			vx[a] += (dx / d) * f;
			vy[a] += (dy / d) * f;
			vx[b] -= (dx / d) * f;
			vy[b] -= (dy / d) * f;
		}
		for (let i = 0; i < n; i += 1) {
			vx[i] += ((cx - x[i]) * centrePull * alpha) / (aspect * aspect);
			vy[i] += (cy - y[i]) * centrePull * alpha;
			if (!fixed[i]) {
				x[i] += vx[i];
				y[i] += vy[i];
			}
			vx[i] *= damping;
			vy[i] *= damping;
		}
		alpha *= alphaDecay;
		options.onTick?.();
	}

	const settled = new Map<string, StressPoint>();
	ids.forEach((id, i) => settled.set(id, { x: x[i], y: y[i] }));
	const radiusFor = (id: string) => radius[index.get(id) as number];

	// Pinned workers keep their point: clamp into the canvas instead of rescaling.
	if (fixed.some(Boolean)) {
		for (const [id, p] of settled) {
			const r = radiusFor(id);
			const i = index.get(id) as number;
			if (fixed[i]) continue;
			p.x = Math.min(Math.max(p.x, r), canvas.width - r);
			p.y = Math.min(Math.max(p.y, r), canvas.height - r);
		}
		return settled;
	}

	const centred = new Map(
		[...settled].map(([id, p]) => [id, { x: p.x - cx, y: p.y - cy }] as const)
	);
	const fitted = fitAndSeparate(
		centred,
		radiusFor,
		{ ...canvas, centre: { x: cx, y: cy } },
		{ iterations: 300 }
	);
	for (const [id, p] of fitted) {
		const r = radiusFor(id);
		p.x = Math.min(Math.max(p.x, r), canvas.width - r);
		p.y = Math.min(Math.max(p.y, r), canvas.height - r);
	}
	return fitted;
}
