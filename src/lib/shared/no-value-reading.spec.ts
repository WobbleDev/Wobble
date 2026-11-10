import { describe, expect, it } from 'vitest';
import { attributeDefinition } from '#lib/testing/builders.ts';
import { answerValueReading, noValueReading } from './no-value-reading.ts';

const attribute = (name: string, options: string[] = []) =>
	attributeDefinition({
		id: name.toLowerCase(),
		name,
		answers: options.map((value) => ({ id: `${name.toLowerCase()}~${value}`, value }))
	});

describe('noValueReading', () => {
	it('reads as No and the Attribute name as it is configured now', () => {
		expect(noValueReading(attribute('Department', ['Packing']))).toEqual({
			label: 'No Department',
			description: null
		});
		// The same Attribute after a rename: the reading follows the name, not an id.
		expect(noValueReading(attribute('Team', ['Packing']))).toEqual({
			label: 'No Team',
			description: null
		});
	});

	it('adds No selection only when a real value reads exactly as the reading', () => {
		expect(noValueReading(attribute('Department', ['Packing', 'No Department']))).toEqual({
			label: 'No Department',
			description: 'No selection'
		});
	});

	it('leaves a real value that reads differently alone', () => {
		expect(noValueReading(attribute('Department', ['No Team', 'Packing'])).description).toBeNull();
		expect(noValueReading(attribute('Department', ['no department'])).description).toBeNull();
	});

	it('reads the no-value state for an Attribute with no values', () => {
		expect(noValueReading(attribute('Roles'))).toEqual({ label: 'No Roles', description: null });
	});
});

describe('answerValueReading', () => {
	it('keeps a held value text and reads no value by the shared rule', () => {
		const department = attribute('Department', ['Packing', 'No Department']);
		expect(answerValueReading(department, 'Packing')).toBe('Packing');
		expect(answerValueReading(department, '')).toBe('No Department, No selection');
		expect(answerValueReading(attribute('Team'), undefined)).toBe('No Team');
	});

	it('joins several values and distinguishes the real colliding value', () => {
		const department = attribute('Department', ['Packing', 'No Department']);
		expect(answerValueReading(department, ['Packing', 'No Department'])).toBe(
			'Packing, No Department'
		);
	});
});
