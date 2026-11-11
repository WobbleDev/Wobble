/**
 * Group-body physics: one rigid body per group, pushed apart when they touch
 * and pulled together by the count of their cross-group ties, plus the group
 * rotations that carry each group's bridges toward their partners.
 *
 * Pure and deterministic: a rotated group's drawn positions are always
 * `centre + R(rotation)·offset`, and the closed-form 2D Procrustes angle means
 * two runs of the same state rotate the same way.
 */
import type { StressPoint } from './graph-stress.ts';

/** The gap two group bodies keep between their radii. */
export const groupGapDefault = 170;
/** Alpha cools by this per tick. */
const alphaDecay = 0.985;
/** The alpha floor the run stops at. */
const alphaMin = 0.01;
/** Per-tick force gain: `k = 0.35·alpha + tieGain`. */
const forceGainAlpha = 0.35;
const forceGainBase = 0.02;
/** The weight one cross-group tie contributes to pulling two bodies together. */
const tiePullPerTie = 0.003;
/** Cross-tie counts above this stop adding pull. */
const tiePullCap = 12;
/** Weak centering toward the canvas centre. */
const centrePull = 0.003;
/** How far a body keeps clear of the canvas edge. */
const canvasClearance = 8;
/** The fraction of the wrapped angle gap a group's rotation closes per tick. */
const rotationStep = 0.1;
/** The drawn position eases toward its body's transform at this rate per frame. */
export const nodeEase = 0.18;
/** The furthest a node may still move in a frame for the glide to count as arrived. */
export const easeStopThreshold = 0.3;

export type GroupBody = {
	/** The group's key. */
	key: string;
	/** The body's centre at rest. */
	x: number;
	y: number;
	/** The body's radius (= the group layout's radius). */
	radius: number;
	/** How many cross-group ties this group holds. */
	crossTies: number;
};

/** Stable key for one unordered pair of group values. */
export function groupPairKey(a: string, b: string): string {
	return JSON.stringify(a < b ? [a, b] : [b, a]);
}

export type PhysicsFrame = {
	centres: Map<string, StressPoint>;
	rotations: Map<string, number>;
};

/** The wrapped angle difference in (-π, π]. */
export function wrappedAngle(from: number, to: number): number {
	let delta = to - from;
	while (delta > Math.PI) delta -= Math.PI * 2;
	while (delta <= -Math.PI) delta += Math.PI * 2;
	return delta;
}

/**
 * The optimal rotation of one group's offsets toward its partners' directions,
 * closed-form 2D Procrustes: `atan2(Σ o.x·u.y − o.y·u.x, Σ o·u)`.
 */
export function optimalRotation(
	offsets: ReadonlyMap<string, StressPoint>,
	partners: readonly { memberId: string; direction: StressPoint }[]
): number {
	let sd = 0;
	let sc = 0;
	for (const { memberId, direction } of partners) {
		const offset = offsets.get(memberId);
		if (!offset) continue;
		sd += offset.x * direction.x + offset.y * direction.y;
		sc += offset.x * direction.y - offset.y * direction.x;
	}
	return Math.atan2(sc, sd);
}

export type PhysicsTickInput = {
	bodies: readonly GroupBody[];
	/** Per group, the partners each rotation steers toward (empty when ports are on). */
	partnersByGroup: ReadonlyMap<string, readonly { memberId: string; direction: StressPoint }[]>;
	/** Per group, the unrotated offsets rotation is solved against. */
	offsetsByGroup: ReadonlyMap<string, ReadonlyMap<string, StressPoint>>;
	/** Number of actual Relationships shared by each unordered pair of groups. */
	relationshipCountsByPair?: ReadonlyMap<string, number>;
	gap: number;
	/** Bodies being dragged do not move. */
	draggedKeys?: ReadonlySet<string>;
	/** Only keep the gap: no tie pull, no centring, no rotation. A drag, or a layout at rest. */
	collisionOnly?: boolean;
	canvas: { width: number; height: number };
};

/**
 * One physics tick at the given alpha: pushes overlapping bodies apart, pulls
 * tie-holding bodies together, centres weakly, clamps every body inside the
 * canvas, and closes each rotation a step toward its optimal angle.
 */
function physicsTick(
	state: { centres: Map<string, StressPoint>; rotations: Map<string, number> },
	input: PhysicsTickInput,
	alpha: number
): void {
	const { bodies, gap, canvas } = input;
	const dragged = input.draggedKeys ?? new Set<string>();
	const k = forceGainAlpha * alpha + forceGainBase;

	// Pairwise body forces, in the bodies' deterministic (input) order.
	for (let i = 0; i < bodies.length; i += 1) {
		for (let j = i + 1; j < bodies.length; j += 1) {
			const a = bodies[i];
			const b = bodies[j];
			const ca = state.centres.get(a.key);
			const cb = state.centres.get(b.key);
			if (!ca || !cb) continue;

			const min = a.radius + b.radius + gap;
			const dx = cb.x - ca.x;
			const dy = cb.y - ca.y;
			const distance = Math.max(Math.hypot(dx, dy), 1e-9);
			const ux = dx / distance;
			const uy = dy / distance;

			const pairTies = input.relationshipCountsByPair?.get(groupPairKey(a.key, b.key)) ?? 0;
			const force = input.collisionOnly
				? distance < min
					? (min - distance) * 0.5
					: 0
				: distance < min
					? (min - distance) * 0.5
					: -Math.min(pairTies, tiePullCap) * tiePullPerTie * (distance - min);

			const move = force * k * 2;
			if (!dragged.has(a.key)) {
				ca.x -= ux * move;
				ca.y -= uy * move;
			}
			if (!dragged.has(b.key)) {
				cb.x += ux * move;
				cb.y += uy * move;
			}
		}
	}

	// Weak centring toward the canvas centre, then the canvas clamp.
	const cx = canvas.width / 2;
	const cy = canvas.height / 2;
	const aspect = canvas.width / Math.max(canvas.height, 1);
	for (const body of bodies) {
		const centre = state.centres.get(body.key);
		if (!centre) continue;
		const reach = body.radius + canvasClearance;
		if (!input.collisionOnly && !dragged.has(body.key)) {
			centre.x += ((cx - centre.x) * centrePull) / (aspect * aspect);
			centre.y += (cy - centre.y) * centrePull;
		}

		// The clamp runs on dragged bodies too, so a drag is bounded by the
		// canvas in the same terms the free bodies are.
		centre.x = Math.min(Math.max(centre.x, reach), Math.max(reach, canvas.width - reach));
		centre.y = Math.min(Math.max(centre.y, reach), Math.max(reach, canvas.height - reach));
	}

	// Rotation closes a wrapped step toward each group's optimal angle.
	if (!input.collisionOnly && input.partnersByGroup.size > 0 && input.offsetsByGroup) {
		for (const [key, partners] of input.partnersByGroup) {
			const offsets = input.offsetsByGroup.get(key);
			if (!offsets || partners.length === 0) continue;
			const current = state.rotations.get(key) ?? 0;
			const target = optimalRotation(offsets, partners);
			state.rotations.set(key, current + wrappedAngle(current, target) * rotationStep);
		}
	}

	// The pairwise push alone cannot guarantee the minimum distance: a tick can
	// overshoot while pulling a third body in. Where a pair still sits inside
	// its minimum, project the pair out along its axis before returning.
	const minGap = input.gap;
	for (let i = 0; i < bodies.length; i += 1) {
		for (let j = i + 1; j < bodies.length; j += 1) {
			const a = bodies[i];
			const b = bodies[j];
			const ca = state.centres.get(a.key);
			const cb = state.centres.get(b.key);
			if (!ca || !cb) continue;
			const min = a.radius + b.radius + minGap;
			const dx = cb.x - ca.x;
			const dy = cb.y - ca.y;
			const distance = Math.hypot(dx, dy);
			if (distance >= min) continue;
			const ux = dx / (distance || 1);
			const uy = dy / (distance || 1);
			const correction = min - distance;
			const aFixed = dragged.has(a.key);
			const bFixed = dragged.has(b.key);
			if (aFixed && bFixed) continue;
			if (aFixed) {
				cb.x += ux * correction;
				cb.y += uy * correction;
			} else if (bFixed) {
				ca.x -= ux * correction;
				ca.y -= uy * correction;
			} else {
				ca.x -= ux * correction * 0.5;
				ca.y -= uy * correction * 0.5;
				cb.x += ux * correction * 0.5;
				cb.y += uy * correction * 0.5;
			}
		}
	}
}

/** Where the drawn node sits: `centre + R(rotation)·offset`. */
export function drawnPosition(
	centre: StressPoint,
	rotation: number,
	offset: StressPoint
): StressPoint {
	const cos = Math.cos(rotation);
	const sin = Math.sin(rotation);
	return {
		x: centre.x + offset.x * cos - offset.y * sin,
		y: centre.y + offset.x * sin + offset.y * cos
	};
}

/**
 * Run the physics synchronously to rest, from the given starting centres, and
 * return the settled centres and rotations. The static path runs this in one
 * call; the animated path runs `physicsTick` per frame with the same inputs.
 */
export function settlePhysics(
	start: { centres: Map<string, StressPoint>; rotations: Map<string, number> },
	input: Omit<PhysicsTickInput, 'gap'> & { gap: number },
	options: { maxTicks?: number } = {}
): { centres: Map<string, StressPoint>; rotations: Map<string, number> } {
	const maxTicks = options.maxTicks ?? 2000;
	const centres = new Map(start.centres);
	const rotations = new Map(start.rotations);
	const state = { centres, rotations };

	let alpha = 1;
	for (let tick = 0; tick < maxTicks && alpha >= alphaMin; tick += 1) {
		physicsTick(state, input, alpha);
		alpha *= alphaDecay;
	}
	return state;
}
