/**
 * Where a highlighted Worker's name tag sits relative to their dot: above it by
 * default, and moved out of a neighbour's way when two tags would cover each
 * other. Coordinates and sizes are in the chart's own 256-unit space.
 */

export type NameTagSide = 'above' | 'below' | 'beside-start' | 'beside-end';

/** A highlighted tag, measured: where its dot is and how large the tag renders. */
export interface MeasuredNameTag {
	id: string;
	cx: number;
	cy: number;
	width: number;
	height: number;
}

export interface NameTagPlacement {
	id: string;
	side: NameTagSide;
}

interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Clear space kept between two neighbouring tags, in the chart's user units. */
const TAG_CLEARANCE = 0.75;

/**
 * The four placements a tag may take, in the order they are tried. Above is the
 * resting place; a colliding tag flips below its dot and, if that still covers a
 * neighbour, sits beside it on the side with more room.
 */
const SIDES: readonly NameTagSide[] = ['above', 'below', 'beside-start', 'beside-end'];

/** The tag's box, anchored to its dot by `gap` in user units. */
function boxFor(tag: MeasuredNameTag, side: NameTagSide, gap: number): Box {
	switch (side) {
		case 'above':
			return {
				left: tag.cx - tag.width / 2,
				top: tag.cy - gap - tag.height,
				right: tag.cx + tag.width / 2,
				bottom: tag.cy - gap
			};
		case 'below':
			return {
				left: tag.cx - tag.width / 2,
				top: tag.cy + gap,
				right: tag.cx + tag.width / 2,
				bottom: tag.cy + gap + tag.height
			};
		case 'beside-start':
			return {
				left: tag.cx - gap - tag.width,
				top: tag.cy - tag.height / 2,
				right: tag.cx - gap,
				bottom: tag.cy + tag.height / 2
			};
		case 'beside-end':
			return {
				left: tag.cx + gap,
				top: tag.cy - tag.height / 2,
				right: tag.cx + gap + tag.width,
				bottom: tag.cy + tag.height / 2
			};
	}
}

function inflate(box: Box, by: number): Box {
	return {
		left: box.left - by,
		top: box.top - by,
		right: box.right + by,
		bottom: box.bottom + by
	};
}

/** The area two boxes share; zero when they do not overlap. */
function overlapArea(a: Box, b: Box): number {
	const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
	const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
	return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Place every measured tag: the selected Leader above its dot first, so their
 * name always reads from the same place, then each tie's tag above and moved
 * below or beside only when that would cover a tag already placed. When every
 * side collides, the one covering the least area wins rather than leaving the
 * tag on top of a neighbour.
 */
export function placeNameTags(
	tags: readonly MeasuredNameTag[],
	selectedId: string | null,
	gap: number
): NameTagPlacement[] {
	const selected = selectedId ? tags.find((tag) => tag.id === selectedId) : undefined;
	const ordered = selected ? [selected, ...tags.filter((tag) => tag !== selected)] : [...tags];
	const placed: Box[] = [];

	return ordered.map((tag) => {
		const sides = tag.id === selectedId ? (['above'] as const) : SIDES;
		let best: { side: NameTagSide; box: Box; overlap: number } | undefined;

		for (const side of sides) {
			const box = boxFor(tag, side, gap);
			const padded = inflate(box, TAG_CLEARANCE);
			const overlap = placed.reduce((total, other) => total + overlapArea(padded, other), 0);
			if (!best || overlap < best.overlap) best = { side, box, overlap };
			if (overlap === 0) break;
		}

		placed.push(best!.box);
		return { id: tag.id, side: best!.side };
	});
}
