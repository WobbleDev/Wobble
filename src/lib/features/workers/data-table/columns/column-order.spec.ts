import { describe, expect, it } from 'vitest';
import { moveColumn, stepTargetIndex } from './column-order.ts';

const order = ['selection', 'name', 'assessment', 'languages', 'role'];

describe('moveColumn', () => {
	it('moves a column forward to the index given', () => {
		expect(moveColumn(order, 'assessment', 4)).toEqual([
			'selection',
			'name',
			'languages',
			'role',
			'assessment'
		]);
	});

	it('moves a column back to the index given', () => {
		expect(moveColumn(order, 'role', 2)).toEqual([
			'selection',
			'name',
			'role',
			'assessment',
			'languages'
		]);
	});

	it('clamps a move past the start to the first movable position, after Name', () => {
		expect(moveColumn(order, 'role', 0)).toEqual([
			'selection',
			'name',
			'role',
			'assessment',
			'languages'
		]);
	});

	it('clamps a move past the end to the last column', () => {
		expect(moveColumn(order, 'assessment', 99)).toEqual([
			'selection',
			'name',
			'languages',
			'role',
			'assessment'
		]);
	});

	it('leaves the pinned selection and Name columns where they are', () => {
		expect(moveColumn(order, 'name', 3)).toEqual(order);
		expect(moveColumn(order, 'selection', 3)).toEqual(order);
	});

	it('ignores an id that is not in the order', () => {
		expect(moveColumn(order, 'missing', 2)).toEqual(order);
	});

	it('returns a new array and leaves the input alone', () => {
		const input = [...order];
		const result = moveColumn(input, 'role', 2);
		expect(result).not.toBe(input);
		expect(input).toEqual(order);
	});
});

describe('stepTargetIndex', () => {
	// Hidden columns sit in the order but are not visible: a step skips them.
	const withHidden = ['selection', 'name', 'assessment', 'hidden', 'languages', 'role'];
	const visible = ['selection', 'name', 'assessment', 'languages', 'role'];

	it('steps a column right past the next visible column, landing after it', () => {
		const target = stepTargetIndex(withHidden, visible, 'assessment', 1);
		expect(target).toBe(withHidden.indexOf('languages'));
		expect(moveColumn(withHidden, 'assessment', target!)).toEqual([
			'selection',
			'name',
			'hidden',
			'languages',
			'assessment',
			'role'
		]);
	});

	it('steps a column left onto the previous visible column', () => {
		const target = stepTargetIndex(withHidden, visible, 'role', -1);
		expect(target).toBe(withHidden.indexOf('languages'));
		expect(moveColumn(withHidden, 'role', target!)).toEqual([
			'selection',
			'name',
			'assessment',
			'hidden',
			'role',
			'languages'
		]);
	});

	it('returns null at the edges, next to a pinned column, and for pinned or unknown columns', () => {
		expect(stepTargetIndex(withHidden, visible, 'role', 1)).toBeNull();
		// Name is pinned, so a step left onto it is a no-op.
		expect(stepTargetIndex(withHidden, visible, 'assessment', -1)).toBeNull();
		expect(stepTargetIndex(withHidden, visible, 'name', 1)).toBeNull();
		expect(stepTargetIndex(withHidden, visible, 'missing', 1)).toBeNull();
	});
});
