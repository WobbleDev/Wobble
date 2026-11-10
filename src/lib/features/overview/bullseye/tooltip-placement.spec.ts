import { describe, expect, it } from 'vitest';
import { CALLOUT_ROOM_ABOVE, calloutAnchor } from './tooltip-placement.ts';

describe('calloutAnchor', () => {
	it('anchors a name above a dot that has room above it', () => {
		const dotTop = 400;
		expect(calloutAnchor(dotTop, 12)).toEqual({ y: dotTop, below: false });
	});

	it('anchors to the dot top right at the room it needs', () => {
		expect(calloutAnchor(CALLOUT_ROOM_ABOVE, 12).below).toBe(false);
	});

	it('draws below when the dot would push the name past the reference top', () => {
		const dotTop = CALLOUT_ROOM_ABOVE - 1;
		expect(calloutAnchor(dotTop, 12)).toEqual({ y: dotTop + 12, below: true });
	});

	it('draws below for a dot against the reference top', () => {
		expect(calloutAnchor(2, 12)).toEqual({ y: 14, below: true });
	});
});
