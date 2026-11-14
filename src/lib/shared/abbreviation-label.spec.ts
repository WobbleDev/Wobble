import { describe, expect, it } from 'vitest';
import { chooseAbbreviationLabels, type AbbreviationLabelEntry } from './abbreviation-label.ts';

const measure = (label: string) => [...label].length;
const options = { measure, budget: 10, reserved: ['All'] };

const entry = (
	id: string,
	value: string,
	abbreviation?: string,
	ancestors: AbbreviationLabelEntry['ancestors'] = []
): AbbreviationLabelEntry => ({ id, value, abbreviation, ancestors });

const labelsOf = (entries: readonly AbbreviationLabelEntry[], budget = 10) =>
	Object.fromEntries(chooseAbbreviationLabels(entries, { ...options, budget }));

describe('the full name or the Abbreviation, by the column budget', () => {
	it('shows the full name when it fits the budget and the Abbreviation when it does not', () => {
		const entries = [
			entry('a', 'Kitchen', 'Kitchen'),
			entry('b', 'Back of House Maintenance', 'BOH Maint.'),
			entry('c', 'Customer Service', 'Cust. Svc.')
		];
		expect(labelsOf(entries)).toEqual({ a: 'Kitchen', b: 'BOH Maint.', c: 'Cust. Svc.' });
	});

	it('decides against the supplied measurement, so spare width brings full names back', () => {
		const entries = [entry('b', 'Back of House Maintenance', 'BOH Maint.')];
		expect(labelsOf(entries, 24)).toEqual({ b: 'BOH Maint.' });
		expect(labelsOf(entries, 25)).toEqual({ b: 'Back of House Maintenance' });
		const weighted = chooseAbbreviationLabels(entries, {
			measure: (label) => (label === 'Back of House Maintenance' ? 200 : 30),
			budget: 80
		});
		expect(weighted.get('b')).toBe('BOH Maint.');
	});

	it('keeps the full name for a value that has no Abbreviation yet', () => {
		expect(labelsOf([entry('a', 'Customer Service North')])).toEqual({
			a: 'Customer Service North'
		});
	});

	it('shows a system reading in full, whatever its Abbreviation and the budget', () => {
		const labels = labelsOf([
			{ id: '', value: 'No Department', abbreviation: 'No Dep…', system: true }
		]);
		expect(labels).toEqual({ '': 'No Department' });
	});
});

describe('values that would show the same text', () => {
	const kitchen = { value: 'Kitchen', abbreviation: 'Kitchen' };
	const bar = { value: 'Bar', abbreviation: 'Bar' };

	it('are told apart by their nearest ancestor, shown root first', () => {
		const entries = [
			entry('k-days', 'Days', 'Days', [kitchen]),
			entry('b-days', 'Days', 'Days', [bar])
		];
		expect(labelsOf(entries)).toEqual({ 'k-days': 'Kitchen › Days', 'b-days': 'Bar › Days' });
	});

	it('use the fewest ancestors that separate them, and only for the values that collide', () => {
		const entries = [
			entry('k-days', 'Days', 'Days', [kitchen]),
			entry('b-days', 'Days', 'Days', [bar]),
			entry('nights', 'Nights', 'Nights', [kitchen])
		];
		expect(labelsOf(entries)).toEqual({
			'k-days': 'Kitchen › Days',
			'b-days': 'Bar › Days',
			nights: 'Nights'
		});
	});

	it('go as far up the path as the collision needs', () => {
		// Ancestors are listed nearest first: Days sits under Lead, which sits under the root.
		const lead = { value: 'Lead', abbreviation: 'Lead' };
		const entries = [
			entry('a', 'Days', 'Days', [lead, kitchen]),
			entry('b', 'Days', 'Days', [lead, bar])
		];
		expect(labelsOf(entries)).toEqual({ a: 'Kitchen › Lead › Days', b: 'Bar › Lead › Days' });
	});

	it('show each ancestor by the same rule: its full name if it fits, else its Abbreviation', () => {
		const entries = [
			entry('a', 'Days', 'Days', [
				{ value: 'Back of House Maintenance', abbreviation: 'BOH Maint.' }
			]),
			entry('b', 'Days', 'Days', [{ value: 'Bar', abbreviation: 'Bar' }])
		];
		expect(labelsOf(entries)).toEqual({ a: 'BOH Maint. › Days', b: 'Bar › Days' });
	});

	it('compare case- and punctuation-insensitively', () => {
		const entries = [
			entry('a', 'Maintenance', 'Maint.', [kitchen]),
			entry('b', 'Maintenance Staff', 'MAINT', [bar])
		];
		expect(labelsOf(entries, 5)).toEqual({ a: 'Kitchen › Maint.', b: 'Bar › MAINT' });
	});

	it('never add a numeric suffix: siblings that share a Abbreviation show their full names', () => {
		const entries = [
			entry('n', 'Customer Service North', 'Customer …'),
			entry('s', 'Customer Service South', 'Customer …')
		];
		expect(labelsOf(entries)).toEqual({
			n: 'Customer Service North',
			s: 'Customer Service South'
		});
	});

	it('keep a value apart from a reserved heading such as All', () => {
		const labels = labelsOf([entry('a', 'All', 'All', [kitchen])]);
		expect(labels.a).toBe('Kitchen › All');
	});
});

describe('the choice', () => {
	const entries = [
		entry('k-days', 'Days', 'Days', [{ value: 'Kitchen', abbreviation: 'Kitchen' }]),
		entry('b-days', 'Days', 'Days', [{ value: 'Bar', abbreviation: 'Bar' }]),
		entry('long', 'Back of House Maintenance', 'BOH Maint.'),
		entry('', 'No Department', undefined, []),
		entry('plain', 'Receiving', 'Receiving')
	];

	it('does not depend on the order of the values, so no page can change it', () => {
		const forward = chooseAbbreviationLabels(entries, options);
		expect(chooseAbbreviationLabels([...entries].reverse(), options)).toEqual(forward);
		expect(
			chooseAbbreviationLabels([entries[2], entries[0], entries[4], entries[1]], options)
		).toEqual(
			new Map([...forward].filter(([id]) => ['k-days', 'b-days', 'long', 'plain'].includes(id)))
		);
	});

	it('does not change its input', () => {
		const frozen = Object.freeze(entries.map((item) => Object.freeze(item)));
		expect(chooseAbbreviationLabels(frozen, options).size).toBe(5);
	});

	it('answers an empty list with an empty map', () => {
		expect(chooseAbbreviationLabels([], options).size).toBe(0);
	});
});
