/**
 * Frames a Free map so the names that stand at rest are readable at the edge.
 *
 * Names are screen-fixed: at a lower zoom the same name covers more of the map, so a frame
 * fitted to the dots alone lets a name at the edge run off the canvas. The frame grows to hold
 * the names as they would stand at the zoom it produces. A bounded number of passes, each only
 * ever enlarging the frame, so it cannot oscillate between a zoom and the names it implies.
 */

export type Rect = { x: number; y: number; width: number; height: number };

/** The zoom steps tried below the dots' own fit: each 3% smaller, bounded. */
export const zoomStep = 0.97;
export const zoomSteps = 48;

function union(a: Rect, b: Rect): Rect {
	const left = Math.min(a.x, b.x);
	const top = Math.min(a.y, b.y);
	const right = Math.max(a.x + a.width, b.x + b.width);
	const bottom = Math.max(a.y + a.height, b.y + b.height);
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The smallest rectangle holding every box, or undefined for none. */
export function boundsOf(
	boxes: Iterable<{ left: number; top: number; right: number; bottom: number }>
) {
	let found: Rect | undefined;
	for (const box of boxes) {
		const next = {
			x: box.left,
			y: box.top,
			width: box.right - box.left,
			height: box.bottom - box.top
		};
		found = found ? union(found, next) : next;
	}
	return found;
}

/**
 * `dots` is the extent of the dots with their margin. `namesAt(zoom)` answers the resting
 * names' boxes in map units as they stand at that zoom. `zoomFor(frame)` answers the zoom the
 * camera would take for a frame, or nothing when it cannot be framed yet.
 *
 * Starts at the zoom that fits the dots and steps down 3% at a time to the first zoom whose
 * names, placed at that very zoom, fit with the dots: the largest map that keeps them readable,
 * found by a bounded search rather than a fit that feeds on its own result.
 */
export function frameWithNames(input: {
	dots: Rect;
	namesAt: (zoom: number, frame: Rect) => Rect[];
	zoomFor: (frame: Rect) => number | undefined;
}): { frame: Rect; zoom: number | undefined } {
	const start = input.zoomFor(input.dots);
	if (start === undefined) return { frame: input.dots, zoom: undefined };
	let frame = input.dots;
	let zoom = start;
	for (let step = 0; step <= zoomSteps; step += 1) {
		zoom = start * zoomStep ** step;
		frame = input.dots;
		// Moving the frame changes where floating chrome lies in map coordinates.
		// Reserve it at the candidate camera, then validate those same placements.
		for (let pass = 0; pass < 3; pass += 1) {
			frame = input.namesAt(zoom, frame).reduce<Rect>((all, box) => union(all, box), frame);
		}
		const required = input.namesAt(zoom, frame).reduce<Rect>((all, box) => union(all, box), frame);
		if (
			required.x !== frame.x ||
			required.y !== frame.y ||
			required.width !== frame.width ||
			required.height !== frame.height
		)
			continue;
		const fit = input.zoomFor(frame);
		// The camera would frame the dots and these names at this zoom or a larger one.
		if (fit === undefined || fit >= zoom * (1 - 1e-9)) break;
	}
	return { frame, zoom };
}
