import { describe, expect, it } from 'vitest';
import { categoryValue, emptyValue, tagValues } from './domain-vocabulary.ts';

describe('categoryValue', () => {
	it('returns the string a Category holds', () => {
		expect(categoryValue({ attributes: { department: 'Front of House' } }, 'department')).toBe(
			'Front of House'
		);
	});

	it('refuses a value that is not a string', () => {
		expect(() =>
			categoryValue({ attributes: { department: ['Front of House'] } }, 'department')
		).toThrow('Category value for "department" is invalid.');
	});

	it('refuses a missing value', () => {
		expect(() => categoryValue({ attributes: {} }, 'department')).toThrow(
			'Category value for "department" is invalid.'
		);
	});
});

describe('tagValues', () => {
	it('returns the array a Tag holds', () => {
		expect(tagValues({ attributes: { shifts: ['Dinner', 'Bar'] } }, 'shifts')).toEqual([
			'Dinner',
			'Bar'
		]);
	});

	it('refuses a value that is not an array', () => {
		expect(() => tagValues({ attributes: { shifts: 'Dinner' } }, 'shifts')).toThrow(
			'Tag values for "shifts" are invalid.'
		);
	});

	it('refuses a missing value', () => {
		expect(() => tagValues({ attributes: {} }, 'shifts')).toThrow(
			'Tag values for "shifts" are invalid.'
		);
	});
});

describe('emptyValue', () => {
	it('gives a Category an empty string', () => {
		expect(emptyValue('category')).toBe('');
	});

	it('gives a Tag an empty array', () => {
		expect(emptyValue('tag')).toEqual([]);
	});
});
