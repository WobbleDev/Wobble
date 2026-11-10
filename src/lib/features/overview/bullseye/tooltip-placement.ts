/**
 * Where a dot's name draws, decided from the dot's own position in the
 * reference. A name that would fall past the reference's top edge is drawn
 * below the dot instead, so the shell's clip cannot cut it off.
 */

/** The room a name needs above a dot before it has to draw below instead. */
export const CALLOUT_ROOM_ABOVE = 32;

export interface CalloutAnchor {
	/** The name's anchor: the dot's top edge, or its bottom when it draws below. */
	y: number;
	below: boolean;
}

export function calloutAnchor(top: number, height: number): CalloutAnchor {
	const below = top < CALLOUT_ROOM_ABOVE;
	return { y: below ? top + height : top, below };
}
