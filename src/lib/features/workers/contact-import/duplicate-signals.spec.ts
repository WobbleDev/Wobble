import { describe, expect, it } from 'vitest';
import { duplicateFinder, type ExistingContact } from './duplicate-signals.ts';

const existing: ExistingContact[] = [
	{ id: 'w1', name: 'Ada Lovelace', email: 'ada@example.test', phone: '(555) 010-0100' },
	{ id: 'w2', name: 'Grace Hopper', email: 'grace@example.test', phone: '' },
	{ id: 'w3', name: 'Worker 07', email: '', phone: '(555) 010-0107' }
];
const find = duplicateFinder(existing);
const row = (name: string, email = '', phone = '') => ({ name, email, phone });

describe('duplicate suggestions', () => {
	it('suggests nothing for a row that matches no one', () => {
		expect(find(row('Worker 99', 'new@example.test', '555-010-0199'))).toEqual([]);
	});

	it('matches a phone after normalising it', () => {
		expect(find(row('Someone Else', '', '+1 555.010.0100'))).toEqual([
			{ workerId: 'w1', workerName: 'Ada Lovelace', reasons: ['phone'] }
		]);
	});

	it('matches an email ignoring case and space', () => {
		expect(find(row('Someone Else', '  GRACE@example.test '))).toEqual([
			{ workerId: 'w2', workerName: 'Grace Hopper', reasons: ['email'] }
		]);
	});

	it('matches a name by its words, ignoring order, case, accents and punctuation', () => {
		expect(find(row('lovelace, ADA'))).toEqual([
			{ workerId: 'w1', workerName: 'Ada Lovelace', reasons: ['name'] }
		]);
		expect(find(row('Grâce  Hopper'))).toHaveLength(1);
	});

	it('does not match on a blank phone, blank email or a number that is not clean', () => {
		expect(find(row('Worker 50', '', ''))).toEqual([]);
		expect(find(row('Worker 51', '', '555-0100'))).toEqual([]);
	});

	it('lists every reason a candidate matches, in the fixed order phone, email, name', () => {
		expect(find(row('Ada Lovelace', 'ada@example.test', '555-010-0100'))).toEqual([
			{ workerId: 'w1', workerName: 'Ada Lovelace', reasons: ['phone', 'email', 'name'] }
		]);
	});

	it('lists candidates in the Worksite order, never by how many reasons they share', () => {
		const suggestions = find(row('Worker 07', 'grace@example.test', '555-010-0100'));
		expect(suggestions.map((suggestion) => suggestion.workerId)).toEqual(['w1', 'w2', 'w3']);
		expect(suggestions.map((suggestion) => suggestion.reasons)).toEqual([
			['phone'],
			['email'],
			['name']
		]);
	});

	it('carries no score or rank', () => {
		for (const suggestion of find(row('Ada Lovelace', 'ada@example.test', '555-010-0100'))) {
			expect(Object.keys(suggestion).sort()).toEqual(['reasons', 'workerId', 'workerName']);
		}
	});
});
