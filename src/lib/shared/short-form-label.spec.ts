import { describe, expect, it } from 'vitest';
import { chooseShortFormLabels, type ShortFormLabelEntry } from './short-form-label.ts';

const measure = (label: string) => [...label].length;
const options = { measure, budget: 10, reserved: ['All'] };

const entry = (
	id: string,
	value: string,
	shortForm?: string,
	ancestors: ShortFormLabelEntry['ancestors'] = []
): ShortFormLabelEntry => ({ id, value, shortForm, ancestors });

const labelsOf = (entries: readonly ShortFormLabelEntry[], budget = 10) =>
	Object.fromEntries(chooseShortFormLabels(entries, { ...options, budget }));

describe('the full name or the Short form, by the column budget', () => {
	it('shows the full name when it fits the budget and the Short form when it does not', () => {
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
		const weighted = chooseShortFormLabels(entries, {
			measure: (label) => (label === 'Back of House Maintenance' ? 200 : 30),
			budget: 80
		});
		expect(weighted.get('b')).toBe('BOH Maint.');
	});

	it('keeps the full name for a value that has no Short form yet', () => {
		expect(labelsOf([entry('a', 'Customer Service North')])).toEqual({
			a: 'Customer Service North'
		});
	});

	it('shows a system reading in full, whatever its Short form and the budget', () => {
		const labels = labelsOf([
			{ id: '', value: 'No Department', shortForm: 'No Dep…', system: true }
		]);
		expect(labels).toEqual({ '': 'No Department' });
	});
});

describe('values that would show the same text', () => {
	const kitchen = { value: 'Kitchen', shortForm: 'Kitchen' };
	const bar = { value: 'Bar', shortForm: 'Bar' };

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
		const lead = { value: 'Lead', shortForm: 'Lead' };
		const entries = [
			entry('a', 'Days', 'Days', [lead, kitchen]),
			entry('b', 'Days', 'Days', [lead, bar])
		];
		expect(labelsOf(entries)).toEqual({ a: 'Kitchen › Lead › Days', b: 'Bar › Lead › Days' });
	});

	it('show each ancestor by the same rule: its full name if it fits, else its Short form', () => {
		const entries = [
			entry('a', 'Days', 'Days', [{ value: 'Back of House Maintenance', shortForm: 'BOH Maint.' }]),
			entry('b', 'Days', 'Days', [{ value: 'Bar', shortForm: 'Bar' }])
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

	it('never add a numeric suffix: siblings that share a Short form show their full names', () => {
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
		entry('k-days', 'Days', 'Days', [{ value: 'Kitchen', shortForm: 'Kitchen' }]),
		entry('b-days', 'Days', 'Days', [{ value: 'Bar', shortForm: 'Bar' }]),
		entry('long', 'Back of House Maintenance', 'BOH Maint.'),
		entry('', 'No Department', undefined, []),
		entry('plain', 'Receiving', 'Receiving')
	];

	it('does not depend on the order of the values, so no page can change it', () => {
		const forward = chooseShortFormLabels(entries, options);
		expect(chooseShortFormLabels([...entries].reverse(), options)).toEqual(forward);
		expect(
			chooseShortFormLabels([entries[2], entries[0], entries[4], entries[1]], options)
		).toEqual(
			new Map([...forward].filter(([id]) => ['k-days', 'b-days', 'long', 'plain'].includes(id)))
		);
	});

	it('does not change its input', () => {
		const frozen = Object.freeze(entries.map((item) => Object.freeze(item)));
		expect(chooseShortFormLabels(frozen, options).size).toBe(5);
	});

	it('answers an empty list with an empty map', () => {
		expect(chooseShortFormLabels([], options).size).toBe(0);
	});
});
