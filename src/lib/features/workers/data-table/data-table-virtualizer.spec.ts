import { describe, expect, it } from 'vitest';
import { shouldMeasure } from './data-table-virtualizer.svelte.ts';

describe('shouldMeasure', () => {
	it('measures an element the first time it is seen', () => {
		const measured = new WeakMap<object, number>();
		const element = {};

		expect(shouldMeasure(measured, element, 3)).toBe(true);
	});

	it('skips an element already measured at the same index', () => {
		const measured = new WeakMap<object, number>();
		const element = {};
		shouldMeasure(measured, element, 3);

		expect(shouldMeasure(measured, element, 3)).toBe(false);
	});

	it('measures again when the same element moves to a new index', () => {
		const measured = new WeakMap<object, number>();
		const element = {};
		shouldMeasure(measured, element, 3);

		expect(shouldMeasure(measured, element, 4)).toBe(true);
		expect(shouldMeasure(measured, element, 4)).toBe(false);
	});

	it('measures a different element even at an index already measured', () => {
		const measured = new WeakMap<object, number>();
		shouldMeasure(measured, {}, 3);

		expect(shouldMeasure(measured, {}, 3)).toBe(true);
	});
});
