import { describe, expect, it } from 'vitest';
import type { AttributeAnswerDraft } from './attribute-draft.ts';
import {
	editAbbreviation,
	renameAnswerValue,
	abbreviationTooLong,
	shownAbbreviation
} from './abbreviation-draft.ts';

const answer = (overrides: Partial<AttributeAnswerDraft> = {}): AttributeAnswerDraft => ({
	id: 'a',
	value: 'Customer Service',
	...overrides
});

describe('the Abbreviation a Configuration row shows', () => {
	it('shows the edited form as typed', () => {
		expect(
			shownAbbreviation(
				answer({ abbreviation: 'CS', abbreviationOrigin: 'edited' }),
				new Map([['a', 'X']])
			)
		).toBe('CS');
	});

	it('shows the core suggestion for a generated or unsaved value', () => {
		const suggestions = new Map([['a', 'Cust. Svc.']]);
		expect(shownAbbreviation(answer(), suggestions)).toBe('Cust. Svc.');
		expect(
			shownAbbreviation(
				answer({ abbreviation: 'Old', abbreviationOrigin: 'generated' }),
				suggestions
			)
		).toBe('Cust. Svc.');
	});

	it('shows the stored generated form until a suggestion arrives', () => {
		expect(
			shownAbbreviation(
				answer({ abbreviation: 'Cust. Svc.', abbreviationOrigin: 'generated' }),
				new Map()
			)
		).toBe('Cust. Svc.');
		expect(shownAbbreviation(answer(), new Map())).toBe('');
	});
});

describe('editing a Abbreviation', () => {
	it('typing makes it edited', () => {
		expect(
			editAbbreviation(answer({ abbreviation: 'Old', abbreviationOrigin: 'generated' }), 'CS')
		).toEqual({
			id: 'a',
			value: 'Customer Service',
			abbreviation: 'CS',
			abbreviationOrigin: 'edited'
		});
	});

	it('clearing returns it to generated and drops the text', () => {
		const cleared = editAbbreviation(
			answer({ abbreviation: 'CS', abbreviationOrigin: 'edited' }),
			'  '
		);
		expect(cleared).toEqual({ id: 'a', value: 'Customer Service' });
	});
});

describe('renaming a value', () => {
	it('drops a generated form so the next suggestion replaces it', () => {
		expect(
			renameAnswerValue(
				answer({ abbreviation: 'Cust. Svc.', abbreviationOrigin: 'generated' }),
				'Night'
			)
		).toEqual({ id: 'a', value: 'Night' });
	});

	it('never touches an edited form', () => {
		expect(
			renameAnswerValue(answer({ abbreviation: 'CS', abbreviationOrigin: 'edited' }), 'Night')
		).toEqual({ id: 'a', value: 'Night', abbreviation: 'CS', abbreviationOrigin: 'edited' });
	});
});

describe('the Abbreviation limit', () => {
	it('counts graphemes, not code units', () => {
		const ten = '👨‍👩‍👧‍👦'.repeat(10);
		expect(abbreviationTooLong(answer({ abbreviation: ten, abbreviationOrigin: 'edited' }))).toBe(
			false
		);
		expect(
			abbreviationTooLong(answer({ abbreviation: 'Eleven char', abbreviationOrigin: 'edited' }))
		).toBe(true);
	});

	it('ignores a generated form', () => {
		expect(
			abbreviationTooLong(answer({ abbreviation: 'Eleven char', abbreviationOrigin: 'generated' }))
		).toBe(false);
	});
});
