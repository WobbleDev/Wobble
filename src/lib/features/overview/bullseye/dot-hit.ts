/**
 * Which mark a tap means.
 *
 * The fitted chart is the form a coarse pointer gets, and a Worker's mark is only
 * a few screen pixels across there. A tap aims at a point, not at a shape, so the
 * tap is answered by the nearest mark inside the physical target radius instead
 * of only by the painted circle — the pointer's own hover and click behaviour is
 * left untouched.
 *
 * Pure arithmetic in the chart's own 256-unit space, so a spec can pin it.
 */

export interface TapTarget {
	id: string;
	cx: number;
	cy: number;
}

/**
 * The nearest target to `(x, y)` inside `radius`, or `null` when the point lies
 * outside every target's radius. Ties keep the first target in the given order,
 * which is the chart's stable draw order.
 */
export function nearestTarget<T extends TapTarget>(
	targets: readonly T[],
	x: number,
	y: number,
	radius: number
): T | null {
	let nearest: T | null = null;
	let best = Infinity;

	for (const target of targets) {
		const distance = Math.hypot(target.cx - x, target.cy - y);
		/* `<` rather than `<=` keeps the first target on a tie, so the chart's
		   stable draw order decides. */
		if (distance <= radius && distance < best) {
			best = distance;
			nearest = target;
		}
	}

	return nearest;
}
