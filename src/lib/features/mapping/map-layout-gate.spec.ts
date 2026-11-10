// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { createLayoutGate, densityScales, expectedRootFontPx } from './map-layout-gate.ts';

const steps = (
	gate: ReturnType<typeof createLayoutGate>,
	count: number,
	input: Parameters<ReturnType<typeof createLayoutGate>['step']>[0]
) => Array.from({ length: count }, () => gate.step(input));

describe('createLayoutGate', () => {
	it('waits for the appearance, then for the size to hold', () => {
		const gate = createLayoutGate({ maxFrames: 100, stableFrames: 3 });
		expect(steps(gate, 5, { appearanceApplied: false, size: '10x10' })).not.toContain(true);
		expect(steps(gate, 3, { appearanceApplied: true, size: '10x10' })).toEqual([
			false,
			false,
			false
		]);
		expect(gate.step({ appearanceApplied: true, size: '10x10' })).toBe(true);
	});

	it('starts the count again when the size changes', () => {
		const gate = createLayoutGate({ maxFrames: 100, stableFrames: 3 });
		steps(gate, 3, { appearanceApplied: true, size: '10x10' });
		expect(gate.step({ appearanceApplied: true, size: '12x12' })).toBe(false);
		expect(steps(gate, 3, { appearanceApplied: true, size: '12x12' })).toEqual([
			false,
			false,
			true
		]);
	});

	it('proceeds at maxFrames even if the appearance never applies', () => {
		const gate = createLayoutGate({ maxFrames: 3 });
		expect(steps(gate, 3, { appearanceApplied: false, size: '10x10' })).toEqual([
			false,
			false,
			true
		]);
	});

	it('defaults to 20 stable frames under a 120-frame cap', () => {
		const settled = createLayoutGate();
		expect(steps(settled, 21, { appearanceApplied: true, size: '1x1' }).indexOf(true)).toBe(20);
		const never = createLayoutGate();
		expect(steps(never, 120, { appearanceApplied: false, size: '1x1' }).indexOf(true)).toBe(119);
	});
});

describe('expectedRootFontPx', () => {
	it('composes the density and text scales on the 16px base', () => {
		expect(expectedRootFontPx('standard')).toBe(16);
		expect(expectedRootFontPx('compact')).toBe(15);
		expect(expectedRootFontPx('comfortable')).toBe(17);
		expect(expectedRootFontPx('standard', 1.1)).toBeCloseTo(17.6);
	});
});

describe('densityScales', () => {
	it('matches the stylesheet', async () => {
		const { readFileSync } = await import('node:fs');
		const css = readFileSync('src/routes/layout.css', 'utf8');
		for (const [density, scale] of Object.entries(densityScales))
			expect(css).toMatch(
				new RegExp(`html\\[data-density='${density}'\\] \\{\\s*--density-scale: ${scale};`)
			);
	});
});
