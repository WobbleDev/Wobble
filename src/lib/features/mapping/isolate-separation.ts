/**
 * Isolate's separation pass: nudges drawn dots apart until none overlaps.
 *
 * Isolate scales the drawn set down when its neighbourhood is larger than the
 * free canvas, and a dot's radius does not scale with it, so the closest pair can
 * end up on top of each other. This pass moves only the dots it is given, and
 * only as far as needed to restore a clear gap between every pair's edges.
 *
 * Pure and deterministic: pairs are visited in id order, a bounded number of
 * passes runs, and coincident dots are separated along a fixed direction.
 */
import type { Point } from './graph-layout.ts';

/** The clear gap two dots keep between their edges, in map units, beyond their radii. */
export const isolateDotGap = 6;

/** A bound on relaxation passes, so the pass always finishes. */
const maxSeparationPasses = 200;

/**
 * Pushes every overlapping pair apart, symmetrically along the line between them,
 * until each pair's edge gap is at least `isolateDotGap`.
 *
 * Returns the same map instance when no pair overlaps, so the caller can tell that
 * nothing moved. A Worker with no radius given is taken as having radius zero.
 */
export function separateOverlappingDots(
	positions: Map<string, Point>,
	radii: ReadonlyMap<string, number>
): Map<string, Point> {
	const ids = [...positions.keys()].sort();
	const moved = new Map(positions);
	let touched = false;

	for (let pass = 0; pass < maxSeparationPasses; pass++) {
		let overlapped = false;

		for (const [index, a] of ids.entries()) {
			for (const b of ids.slice(index + 1)) {
				const pointA = moved.get(a)!;
				const pointB = moved.get(b)!;
				const required = (radii.get(a) ?? 0) + (radii.get(b) ?? 0) + isolateDotGap;
				let dx = pointB.x - pointA.x;
				let dy = pointB.y - pointA.y;
				let distance = Math.hypot(dx, dy);
				if (distance >= required) continue;

				overlapped = true;
				touched = true;
				if (distance === 0) {
					dx = 1;
					dy = 0;
					distance = 1;
				}
				const push = (required - distance) / 2;
				const ux = dx / distance;
				const uy = dy / distance;
				moved.set(a, { x: pointA.x - ux * push, y: pointA.y - uy * push });
				moved.set(b, { x: pointB.x + ux * push, y: pointB.y + uy * push });
			}
		}

		if (!overlapped) break;
	}

	return touched ? moved : positions;
}
