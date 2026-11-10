/**
 * The map's keyboard vocabulary, read off a key event: arrows pan, `+`/`-`
 * zoom, Escape clears the selection. Pure, so the reading order and the steps
 * are unit-tested without standing up a surface.
 */
export type MapKeyAction =
	| { type: 'pan'; dx: number; dy: number }
	| { type: 'zoom'; direction: 'in' | 'out' }
	| { type: 'clear' };

/** An arrow-key pan step in CSS px, tripled while Shift is held. */
export const mapPanStep = 32;
export const mapShiftPanStep = 96;

/** What the map does with a key, or null when the key is not the map's to read. */
export function interpretMapKey(key: string, shiftKey: boolean): MapKeyAction | null {
	const step = shiftKey ? mapShiftPanStep : mapPanStep;

	switch (key) {
		case 'ArrowLeft':
			return { type: 'pan', dx: -step, dy: 0 };
		case 'ArrowRight':
			return { type: 'pan', dx: step, dy: 0 };
		case 'ArrowUp':
			return { type: 'pan', dx: 0, dy: -step };
		case 'ArrowDown':
			return { type: 'pan', dx: 0, dy: step };
		case '+':
		case '=':
			return { type: 'zoom', direction: 'in' };
		case '-':
		case '_':
			return { type: 'zoom', direction: 'out' };
		case 'Escape':
			return { type: 'clear' };
		default:
			return null;
	}
}
