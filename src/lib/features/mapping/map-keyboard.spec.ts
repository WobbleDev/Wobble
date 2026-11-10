// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { interpretMapKey, mapPanStep, mapShiftPanStep } from './map-keyboard.ts';

describe('interpretMapKey', () => {
	it('pans by a fixed step on the arrows, tripled with Shift', () => {
		expect(interpretMapKey('ArrowLeft', false)).toEqual({ type: 'pan', dx: -mapPanStep, dy: 0 });
		expect(interpretMapKey('ArrowRight', false)).toEqual({ type: 'pan', dx: mapPanStep, dy: 0 });
		expect(interpretMapKey('ArrowUp', false)).toEqual({ type: 'pan', dx: 0, dy: -mapPanStep });
		expect(interpretMapKey('ArrowDown', false)).toEqual({ type: 'pan', dx: 0, dy: mapPanStep });
		expect(interpretMapKey('ArrowLeft', true)).toEqual({
			type: 'pan',
			dx: -mapShiftPanStep,
			dy: 0
		});
		expect(mapShiftPanStep).toBe(mapPanStep * 3);
	});

	it('zooms on plus and minus, in either shift state', () => {
		expect(interpretMapKey('+', false)).toEqual({ type: 'zoom', direction: 'in' });
		expect(interpretMapKey('=', false)).toEqual({ type: 'zoom', direction: 'in' });
		expect(interpretMapKey('-', false)).toEqual({ type: 'zoom', direction: 'out' });
		expect(interpretMapKey('_', true)).toEqual({ type: 'zoom', direction: 'out' });
	});

	it('clears on Escape and leaves every other key to its owner', () => {
		expect(interpretMapKey('Escape', false)).toEqual({ type: 'clear' });
		for (const key of ['a', 'Enter', ' ', 'Tab', 'F5', 'Delete']) {
			expect(interpretMapKey(key, false)).toBeNull();
		}
	});
});
