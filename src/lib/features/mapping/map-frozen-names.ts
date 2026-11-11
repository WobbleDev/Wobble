/**
 * Names that keep the place they were given.
 *
 * An automatic arrangement chooses where each standing name sits once, at the camera
 * the drawing was framed at. A frozen name keeps that choice as a screen-pixel offset
 * from its dot (less the dot's own reach, which grows with the drawing), so zoom, pan,
 * a moved dot or a changed pointer never searches again: the name's side, its size and
 * its distance in pixels stay what they were, and only arithmetic places it.
 */
import type { Point } from './layout/graph-layout.ts';
import { nameLeader, type Box, type LabelSide } from './labels/graph-label-placement.ts';
import type { PlacedName } from './labels/map-name-placement.ts';

export type FrozenName = {
	side: LabelSide;
	textAnchor: 'start' | 'middle' | 'end';
	/** Outward normal toward the nearest point of the name box, and its share of the dot radius. */
	direction: Point;
	reach: number;
	/** The anchor's remaining offset from that point, in screen pixels. */
	offset: Point;
	/** The box relative to the anchor, in screen pixels. */
	box: Box;
};

export function freezeName(
	placed: PlacedName,
	dot: Point,
	radius: number,
	zoom: number
): FrozenName {
	const dx = placed.x - dot.x;
	const dy = placed.y - dot.y;
	const nearestX = Math.max(placed.box.left, Math.min(dot.x, placed.box.right)) - dot.x;
	const nearestY = Math.max(placed.box.top, Math.min(dot.y, placed.box.bottom)) - dot.y;
	const length = Math.hypot(nearestX, nearestY);
	const direction = length > 0 ? { x: nearestX / length, y: nearestY / length } : { x: 1, y: 0 };
	const reach = radius > 0 ? Math.min(radius, length) / radius : 0;
	const along = radius * reach;
	return {
		side: placed.side,
		textAnchor: placed.textAnchor,
		direction,
		reach,
		offset: {
			x: (dx - direction.x * along) * zoom,
			y: (dy - direction.y * along) * zoom
		},
		box: {
			left: (placed.box.left - placed.x) * zoom,
			right: (placed.box.right - placed.x) * zoom,
			top: (placed.box.top - placed.y) * zoom,
			bottom: (placed.box.bottom - placed.y) * zoom
		}
	};
}

/** Where a frozen name stands for a dot now, at a camera zoom. Arithmetic only. */
export function thawName(frozen: FrozenName, dot: Point, radius: number, zoom: number): PlacedName {
	const along = radius * frozen.reach;
	const x = dot.x + frozen.direction.x * along + frozen.offset.x / zoom;
	const y = dot.y + frozen.direction.y * along + frozen.offset.y / zoom;
	const box = {
		left: x + frozen.box.left / zoom,
		right: x + frozen.box.right / zoom,
		top: y + frozen.box.top / zoom,
		bottom: y + frozen.box.bottom / zoom
	};
	return {
		x,
		y,
		textAnchor: frozen.textAnchor,
		side: frozen.side,
		box,
		leader: nameLeader({ ...dot, radius }, box, 12 / zoom)
	};
}

/**
 * A name revealed after the placement (a hover or a selection outside the standing
 * set): it attaches to the right of its dot at a fixed gap, with no search. The
 * pointer may cover something there; that is accepted, and it leaves every other
 * name where it was.
 */
export function attachName(
	dot: Point,
	radius: number,
	size: { width: number; height: number },
	zoom: number
): PlacedName {
	const x = dot.x + radius + 6 / zoom;
	const width = (size.width + 3) / zoom;
	const height = size.height / zoom;
	return {
		x,
		y: dot.y,
		textAnchor: 'start',
		side: 'right',
		box: { left: x, right: x + width, top: dot.y - height / 2, bottom: dot.y + height / 2 }
	};
}
