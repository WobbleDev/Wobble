/**
 * The free canvas: the room the map's own drawing has —
 * the canvas minus the measured control strip, bottom bar and open worker card.
 *
 * This is the one place that measurement is computed, so the key's placement, the
 * reset, and the Isolate fit cannot drift apart. Below lg the strip, bar and card
 * are in normal flow and cover nothing: there the canvas element is already the
 * free canvas, and every inset is zero.
 */

export type Box = { x: number; y: number; width: number; height: number };

/** How much the chrome floating over the canvas covers, in surface pixels. */
export type FreeCanvasInsets = { top: number; right: number; bottom: number; left: number };

/** The floating chrome's gutter from the canvas edge (`lg:right-3`, `lg:bottom-3`). */
export const floatingGutter = 12;
/** The open worker card's drawn width (`lg:w-80`). */
const floatingCardWidth = 320;

export function freeCanvasInsets(input: {
	/** Whether the chrome floats over the canvas at all; it does from lg up. */
	floating: boolean;
	stripHeight: number;
	barHeight: number;
	cardOpen: boolean;
}): FreeCanvasInsets {
	if (!input.floating) return { top: 0, right: 0, bottom: 0, left: 0 };

	return {
		top: input.stripHeight,
		right: input.cardOpen ? floatingCardWidth + floatingGutter : 0,
		bottom: input.barHeight,
		left: 0
	};
}

/** The free canvas as a box inside the surface, measured from the surface's top-left. */
export function freeCanvasBox(
	surface: { width: number; height: number },
	insets: FreeCanvasInsets
): Box {
	return {
		x: insets.left,
		y: insets.top,
		width: Math.max(0, surface.width - insets.left - insets.right),
		height: Math.max(0, surface.height - insets.top - insets.bottom)
	};
}

/**
 * That box in the map's own coordinates. The chart centres the drawn layer on the
 * surface, so the map's origin sits at the surface's middle: a box the insets
 * describe in surface pixels shifts by half the surface in each axis. Isolate's
 * fit reads this, so the spread neighbourhood centres in the room it really has.
 */
export function freeCanvasInMap(
	surface: { width: number; height: number },
	insets: FreeCanvasInsets
): Box {
	const box = freeCanvasBox(surface, insets);
	return {
		x: box.x - surface.width / 2,
		y: box.y - surface.height / 2,
		width: box.width,
		height: box.height
	};
}
