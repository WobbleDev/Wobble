import { describe, expect, it } from 'vitest';
import type { AttributeAnswer } from '#lib/domain-vocabulary.ts';
import { answerDisplayLabel, answerPath, answerPathLabel } from './answer-path.ts';

/** Central / Store A, Central / Packing and Other / Packing: one label in two branches. */
const answers: AttributeAnswer[] = [
	{ id: 'central', value: 'Central' },
	{ id: 'store-a', value: 'Store A', parentId: 'central' },
	{ id: 'central-packing', value: 'Packing', parentId: 'central' },
	{ id: 'other', value: 'Other' },
	{ id: 'other-packing', value: 'Packing', parentId: 'other' }
];

describe('answerPath', () => {
	it('returns the root-to-answer chain in order', () => {
		expect(answerPath(answers, 'store-a').map((answer) => answer.id)).toEqual([
			'central',
			'store-a'
		]);
		expect(answerPath(answers, 'central').map((answer) => answer.id)).toEqual(['central']);
	});

	it('is empty for an answer this Attribute does not define', () => {
		expect(answerPath(answers, 'missing')).toEqual([]);
	});

	it('stops instead of looping when corrupt data holds a cycle', () => {
		const cyclic: AttributeAnswer[] = [
			{ id: 'a', value: 'A', parentId: 'b' },
			{ id: 'b', value: 'B', parentId: 'a' }
		];
		expect(answerPath(cyclic, 'a')).toEqual([]);
	});
});

describe('depth-five answer paths', () => {
	const chain: AttributeAnswer[] = [
		{ id: 'l1', value: 'Level 1' },
		{ id: 'l2', value: 'Level 2', parentId: 'l1' },
		{ id: 'l3', value: 'Level 3', parentId: 'l2' },
		{ id: 'l4', value: 'Level 4', parentId: 'l3' },
		{ id: 'l5', value: 'Level 5', parentId: 'l4' }
	];

	it('returns all five ancestors of the deepest answer, root first', () => {
		expect(answerPath(chain, 'l5').map((answer) => answer.id)).toEqual([
			'l1',
			'l2',
			'l3',
			'l4',
			'l5'
		]);
	});

	it('labels the deepest answer with its full five-level path', () => {
		expect(answerPathLabel(chain, 'l5')).toBe('Level 1 / Level 2 / Level 3 / Level 4 / Level 5');
		expect(answerDisplayLabel(chain, 'l5')).toBe('Level 5');
	});
});

describe('answerPathLabel', () => {
	it('joins the path with a slash separator', () => {
		expect(answerPathLabel(answers, 'store-a')).toBe('Central / Store A');
		expect(answerPathLabel(answers, 'central-packing')).toBe('Central / Packing');
		expect(answerPathLabel(answers, 'central')).toBe('Central');
	});

	it('falls back to the id for a foreign answer', () => {
		expect(answerPathLabel(answers, 'missing')).toBe('missing');
	});
});

describe('answerDisplayLabel', () => {
	it('shows a unique label plainly and a repeated label with its path', () => {
		expect(answerDisplayLabel(answers, 'store-a')).toBe('Store A');
		expect(answerDisplayLabel(answers, 'central-packing')).toBe('Central / Packing');
		expect(answerDisplayLabel(answers, 'other-packing')).toBe('Other / Packing');
	});

	it('keeps a plain label for every root when labels do not repeat', () => {
		expect(answerDisplayLabel(answers, 'central')).toBe('Central');
		expect(answerDisplayLabel(answers, 'other')).toBe('Other');
	});
});

/**
 * Central > Store A > Floor > Aisle > Shelf, and a second five-level chain under Other that
 * repeats Floor, Aisle and Shelf.
 */
const deep: AttributeAnswer[] = [
	{ id: 'l1', value: 'Central' },
	{ id: 'l2', value: 'Store A', parentId: 'l1' },
	{ id: 'l3', value: 'Floor', parentId: 'l2' },
	{ id: 'l4', value: 'Aisle', parentId: 'l3' },
	{ id: 'l5', value: 'Shelf', parentId: 'l4' },
	{ id: 'o1', value: 'Other' },
	{ id: 'o2', value: 'Floor', parentId: 'o1' },
	{ id: 'o3', value: 'Aisle', parentId: 'o2' },
	{ id: 'o4', value: 'Bay', parentId: 'o3' },
	{ id: 'o5', value: 'Shelf', parentId: 'o4' }
];

describe('five-level answer paths', () => {
	it('returns the full five-level chain from the root, in order', () => {
		expect(answerPath(deep, 'l5').map((answer) => answer.id)).toEqual([
			'l1',
			'l2',
			'l3',
			'l4',
			'l5'
		]);
		expect(answerPath(deep, 'o5').map((answer) => answer.id)).toEqual([
			'o1',
			'o2',
			'o3',
			'o4',
			'o5'
		]);
	});

	it('joins five labels into one path', () => {
		expect(answerPathLabel(deep, 'l5')).toBe('Central / Store A / Floor / Aisle / Shelf');
		expect(answerPathLabel(deep, 'o5')).toBe('Other / Floor / Aisle / Bay / Shelf');
	});

	it('names a repeated five-level label, and its repeated ancestors, with the full path', () => {
		expect(answerDisplayLabel(deep, 'l5')).toBe('Central / Store A / Floor / Aisle / Shelf');
		expect(answerDisplayLabel(deep, 'l4')).toBe('Central / Store A / Floor / Aisle');
	});

	it('keeps a unique label at depth five short', () => {
		expect(answerDisplayLabel(deep, 'o4')).toBe('Bay');
	});
});
