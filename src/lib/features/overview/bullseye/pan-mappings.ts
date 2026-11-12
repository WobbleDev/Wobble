/**
 * The bullseye chart backdrop's own arithmetic: how far a drag may travel, how a scale
 * change keeps the point under the pointer where it is, and how a wheel becomes a
 * scale. All of it is pure and DOM-free so it can be asserted directly; the
 * gesture itself lives in `pan.svelte.ts`.
 */

export interface Vec2 {
	x: number;
	y: number;
}

/**
 * The bullseye's scale, the reader's to set with the wheel. Shrinking to the
 * floor brings the whole chart inside its frame; magnifying to the ceiling is
 * held to a size where the rings still read as a chart and every Worker dot can
 * still be reached.
 */
/** The chart's resting size as a share of its frame. */
export const REST_SCALE = 0.9;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;

/** How much of a wheel's pixel delta becomes scale. */
const WHEEL_SENSITIVITY = 0.0015;

/**
 * A wheel reports its delta in pixels, lines or pages. There is no DOM constant
 * for the pixel size of a line or a page, and the values are only a feel; they
 * are fixed here so the arithmetic stays pure and a test can pin it.
 */
const LINE_PIXELS = 16;
const PAGE_PIXELS = 100;

const DELTA_PIXELS = [1, LINE_PIXELS, PAGE_PIXELS];

/** The scale the reader gets when the value on hand is not a number at all. */
const ZOOM_DEFAULT = 1;

/** Hold a scale inside the range, treating anything non-finite as the default. */
export function clampZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) return ZOOM_DEFAULT;
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * The scale after one wheel event: a wheel turned away magnifies, a wheel turned
 * back shrinks, and the step is proportional so a notch and a trackpad glide
 * both feel the same. `deltaMode` widens a line or a page to the pixels it
 * stands for before the step is read.
 */
export function zoomAfterWheel(zoom: number, deltaY: number, deltaMode: number): number {
	const pixels = DELTA_PIXELS[deltaMode] ?? 1;
	return clampZoom(zoom * Math.exp(-deltaY * pixels * WHEEL_SENSITIVITY));
}

/** How much one zoom key press changes the scale. */
const KEY_ZOOM_STEP = 1.25;

/**
 * The scale after one zoom key press: the magnify keys grow it by one step and the
 * shrink keys divide it by one, and any other key leaves it alone. The result is
 * always inside the range.
 */
export function zoomAfterKey(zoom: number, key: string): number {
	if (key === '+' || key === '=') return clampZoom(zoom * KEY_ZOOM_STEP);
	if (key === '-' || key === '−') return clampZoom(zoom / KEY_ZOOM_STEP);
	return zoom;
}

/**
 * The least of the chart a drag must leave inside the chart region, as a share of
 * the chart's own side. There is no reset control to bring back a chart thrown
 * away, so the bound is what makes it unlosable: a quarter is enough to hold the
 * reader's place on the chart and enough to grab it again.
 */
export const MIN_VISIBLE_SHARE = 0.25;

/** The chart's resting box, and the frame it is dragged across, in the frame's own coordinates. */
export interface PanFrame {
	/** The layer's resting centre: where the stylesheet puts it, with no drag. */
	centre: Vec2;
	/** The layer's side at this scale, so its resting box is `centre ± size / 2` on both axes. */
	size: number;
	/** The chart backdrop's own size. */
	frame: { width: number; height: number };
	/** The leading column's right edge, which the chart's own region starts at. */
	columnRight: number;
}

/** How far the layer may sit from rest, per axis, as offsets in px. */
export interface PanBounds {
	min: Vec2;
	max: Vec2;
}

/**
 * The travel a drag may use, so at least `MIN_VISIBLE_SHARE` of the layer stays in
 * the chart region on every axis: horizontally the layer's right edge may not pass
 * `columnRight + the share`, and its left edge may not pass the frame's right edge
 * less the share; vertically the frame's own two edges are the limits. A frame
 * whose leading column reaches past its own right edge would invert the pair, so
 * that axis collapses to its midpoint rather than leaving the chart with no legal
 * offset at all.
 */
export function panBounds(frame: PanFrame): PanBounds {
	const half = frame.size / 2;
	const visible = frame.size * MIN_VISIBLE_SHARE;
	const left = frame.centre.x - half;
	const top = frame.centre.y - half;
	const right = frame.centre.x + half;
	const bottom = frame.centre.y + half;

	/** A pair that has crossed itself has no room left: hold the axis at its middle. */
	const pair = (min: number, max: number) => {
		if (min <= max) return { min, max };
		const middle = (min + max) / 2;
		return { min: middle, max: middle };
	};

	const x = pair(frame.columnRight + visible - right, frame.frame.width - visible - left);
	const y = pair(visible - bottom, frame.frame.height - visible - top);

	return { min: { x: x.min, y: y.min }, max: { x: x.max, y: y.max } };
}

/**
 * The pan that keeps the point under the pointer where it is when the scale
 * becomes `ratio` times what it was. `offset` is the pointer in the layer's
 * resting frame — the pointer less `centre` — so the arithmetic holds wherever
 * the layer has been dragged to.
 */
export function anchorPan(pan: Vec2, offset: Vec2, ratio: number): Vec2 {
	return {
		x: pan.x * ratio + offset.x * (1 - ratio),
		y: pan.y * ratio + offset.y * (1 - ratio)
	};
}
