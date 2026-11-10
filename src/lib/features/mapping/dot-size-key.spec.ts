// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { DOT_KEY_LARGEST_RADIUS, dotSizeKeyGeometry } from './dot-size-key.ts';
import { nodeRadius } from './map-style.ts';

describe('dotSizeKeyGeometry', () => {
	it('draws the largest step at the fixed radius', () => {
		const { steps } = dotSizeKeyGeometry();
		expect(steps.map(({ label }) => label)).toEqual(['0', '1', '2', '3', '4', '5+']);
		expect(steps.at(-1)!.r).toBe(DOT_KEY_LARGEST_RADIUS);
	});

	it('keeps the map’s relative dot sizes', () => {
		const { steps } = dotSizeKeyGeometry();
		for (const step of steps)
			expect(step.r / DOT_KEY_LARGEST_RADIUS).toBeCloseTo(nodeRadius(step.count) / nodeRadius(5));
	});

	it('spaces each circle past the previous one and its label', () => {
		const { steps } = dotSizeKeyGeometry();
		for (let index = 1; index < steps.length; index += 1)
			expect(steps[index].x - steps[index].r).toBeCloseTo(
				steps[index - 1].x + steps[index - 1].r + 20
			);
	});

	it('has one fixed size', () => {
		expect(dotSizeKeyGeometry()).toMatchObject({ width: 164, height: 24 });
	});
});
