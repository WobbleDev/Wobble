import { describe, expect, it } from 'vitest';
import { compareNames } from '#lib/i18n/format.ts';
import type { OptionChoice } from '../answers.ts';
import {
	compareAssessmentScale,
	compareWithEmptiesLast,
	assessmentSortKey,
	heldLabelsKey,
	labelsSortKey
} from './worker-sort.ts';

/**
 * Orders values the way the table engine does: a sort function's result is
 * negated for descending order, and ties keep their original position.
 */
function orderBy<T>(
	values: (T | null)[],
	compareValues: (first: T, second: T) => number,
	descending: boolean
): (T | null)[] {
	return values
		.map((value, index) => ({ value, index }))
		.sort((first, second) => {
			const sign = compareWithEmptiesLast(first.value, second.value, compareValues, descending);
			return (descending ? -sign : sign) || first.index - second.index;
		})
		.map(({ value }) => value);
}

describe('compareWithEmptiesLast', () => {
	it('puts empty values last when ascending', () => {
		expect(orderBy(['Grace', null, 'Ada'], compareNames, false)).toEqual(['Ada', 'Grace', null]);
	});

	it('puts empty values last when descending too', () => {
		expect(orderBy(['Grace', null, 'Ada'], compareNames, true)).toEqual(['Grace', 'Ada', null]);
	});

	it('keeps several empty values together at the end, in their original order', () => {
		expect(orderBy([null, 'Ada', null], compareNames, true)).toEqual(['Ada', null, null]);
		expect(orderBy([null, 'Ada', null], compareNames, false)).toEqual(['Ada', null, null]);
	});

	it('treats two empty values as a tie', () => {
		expect(compareWithEmptiesLast(null, null, compareNames, false)).toBe(0);
		expect(compareWithEmptiesLast(null, null, compareNames, true)).toBe(0);
	});

	it('compares present values with the given text order, ignoring case', () => {
		expect(orderBy(['bob', 'Ada', 'carol'], compareNames, false)).toEqual(['Ada', 'bob', 'carol']);
	});
});

describe('assessment sorting', () => {
	it('treats Unassessed as empty and every other standing as a value', () => {
		expect(assessmentSortKey('Unassessed')).toBeNull();
		expect(assessmentSortKey('Hostile')).toBe('Hostile');
	});

	it('orders standings in scale order, not alphabetically', () => {
		const standings = ['Hostile', 'Leader', 'Disengaged', 'Activist', 'Supporter'] as const;
		expect(orderBy([...standings], compareAssessmentScale, false)).toEqual([
			'Leader',
			'Activist',
			'Supporter',
			'Disengaged',
			'Hostile'
		]);
		expect(orderBy([...standings], compareAssessmentScale, true)).toEqual([
			'Hostile',
			'Disengaged',
			'Supporter',
			'Activist',
			'Leader'
		]);
	});

	it('keeps Unassessed last in both directions', () => {
		const keys = [
			assessmentSortKey('Unassessed'),
			assessmentSortKey('Supporter'),
			assessmentSortKey('Leader')
		];
		expect(orderBy(keys, compareAssessmentScale, false)).toEqual(['Leader', 'Supporter', null]);
		expect(orderBy(keys, compareAssessmentScale, true)).toEqual(['Supporter', 'Leader', null]);
	});
});

describe('labelsSortKey', () => {
	it('is empty when no label is held', () => {
		expect(labelsSortKey([])).toBeNull();
	});

	it('joins the labels in the order given', () => {
		expect(labelsSortKey(['Spanish', 'English'])).toBe('Spanish, English');
	});
});

describe('heldLabelsKey', () => {
	const choices: OptionChoice[] = [
		{ value: 'brunch-id', label: 'Brunch' },
		{ value: 'dinner-id', label: 'Dinner' }
	];

	it('is empty for a blank Category answer', () => {
		expect(heldLabelsKey('', choices)).toBeNull();
	});

	it('is the label of a held Category answer', () => {
		expect(heldLabelsKey('dinner-id', choices)).toBe('Dinner');
	});

	it('is empty for a Tag with nothing held', () => {
		expect(heldLabelsKey([], choices)).toBeNull();
	});

	it('lists a Tag held answers in the order the choices are defined, not the order stored', () => {
		expect(heldLabelsKey(['dinner-id', 'brunch-id'], choices)).toBe('Brunch, Dinner');
	});

	it('ignores held ids that no longer match a choice', () => {
		expect(heldLabelsKey(['gone-id'], choices)).toBeNull();
		expect(heldLabelsKey(['gone-id', 'dinner-id'], choices)).toBe('Dinner');
	});
});
