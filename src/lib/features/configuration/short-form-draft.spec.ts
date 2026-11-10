import { describe, expect, it } from 'vitest';
import type { AttributeAnswerDraft } from './attribute-draft.ts';
import {
	editShortForm,
	renameAnswerValue,
	shortFormTooLong,
	shownShortForm
} from './short-form-draft.ts';

const answer = (overrides: Partial<AttributeAnswerDraft> = {}): AttributeAnswerDraft => ({
	id: 'a',
	value: 'Customer Service',
	...overrides
});

describe('the Short form a Configuration row shows', () => {
	it('shows the edited form as typed', () => {
		expect(
			shownShortForm(answer({ shortForm: 'CS', shortFormOrigin: 'edited' }), new Map([['a', 'X']]))
		).toBe('CS');
	});

	it('shows the core suggestion for a generated or unsaved value', () => {
		const suggestions = new Map([['a', 'Cust. Svc.']]);
		expect(shownShortForm(answer(), suggestions)).toBe('Cust. Svc.');
		expect(
			shownShortForm(answer({ shortForm: 'Old', shortFormOrigin: 'generated' }), suggestions)
		).toBe('Cust. Svc.');
	});

	it('shows the stored generated form until a suggestion arrives', () => {
		expect(
			shownShortForm(answer({ shortForm: 'Cust. Svc.', shortFormOrigin: 'generated' }), new Map())
		).toBe('Cust. Svc.');
		expect(shownShortForm(answer(), new Map())).toBe('');
	});
});

describe('editing a Short form', () => {
	it('typing makes it edited', () => {
		expect(editShortForm(answer({ shortForm: 'Old', shortFormOrigin: 'generated' }), 'CS')).toEqual(
			{ id: 'a', value: 'Customer Service', shortForm: 'CS', shortFormOrigin: 'edited' }
		);
	});

	it('clearing returns it to generated and drops the text', () => {
		const cleared = editShortForm(answer({ shortForm: 'CS', shortFormOrigin: 'edited' }), '  ');
		expect(cleared).toEqual({ id: 'a', value: 'Customer Service' });
	});
});

describe('renaming a value', () => {
	it('drops a generated form so the next suggestion replaces it', () => {
		expect(
			renameAnswerValue(answer({ shortForm: 'Cust. Svc.', shortFormOrigin: 'generated' }), 'Night')
		).toEqual({ id: 'a', value: 'Night' });
	});

	it('never touches an edited form', () => {
		expect(
			renameAnswerValue(answer({ shortForm: 'CS', shortFormOrigin: 'edited' }), 'Night')
		).toEqual({ id: 'a', value: 'Night', shortForm: 'CS', shortFormOrigin: 'edited' });
	});
});

describe('the Short form limit', () => {
	it('counts graphemes, not code units', () => {
		const ten = '👨‍👩‍👧‍👦'.repeat(10);
		expect(shortFormTooLong(answer({ shortForm: ten, shortFormOrigin: 'edited' }))).toBe(false);
		expect(shortFormTooLong(answer({ shortForm: 'Eleven char', shortFormOrigin: 'edited' }))).toBe(
			true
		);
	});

	it('ignores a generated form', () => {
		expect(
			shortFormTooLong(answer({ shortForm: 'Eleven char', shortFormOrigin: 'generated' }))
		).toBe(false);
	});
});
