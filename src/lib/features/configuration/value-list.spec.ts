import { describe, expect, it } from 'vitest';
import { createValueList } from './value-list.svelte.ts';

/**
 * The shared rules of one draft list. The Agitations and Languages editors reach these through
 * `ConfigurationDraftState`, which is specced beside it; this covers the list on its own, so a
 * rule that would otherwise only show up through the class has one home.
 */
function list(overrides: { locked?: () => boolean } = {}) {
	return createValueList({
		field: 'text',
		makeEntry: (id, text) => ({ id, text }),
		duplicateMessage: () => 'That value is already in the list.',
		locked: overrides.locked ?? (() => false)
	});
}

describe('a draft value list', () => {
	it('adds the trimmed box text and clears the box and its error', () => {
		const values = list();
		values.error = 'an old complaint';
		values.input = '  Short breaks  ';
		values.add();
		expect(values.draft.map((entry) => entry.text)).toEqual(['Short breaks']);
		expect(values.input).toBe('');
		expect(values.error).toBe('');
	});

	it('refuses a blank box without touching the list', () => {
		const values = list();
		values.input = '   ';
		values.add();
		expect(values.draft).toEqual([]);
		expect(values.error).toBe('');
	});

	it("reports a duplicate with the list's own message and keeps the box text", () => {
		const values = list();
		values.input = 'Pay';
		values.add();
		values.input = 'pay';
		values.add();
		expect(values.draft).toHaveLength(1);
		expect(values.error).toBe('That value is already in the list.');
		expect(values.input).toBe('pay');
	});

	it('does nothing while the draft is locked', () => {
		let locked = true;
		const values = list({ locked: () => locked });
		values.input = 'Pay';
		values.add();
		expect(values.draft).toEqual([]);

		locked = false;
		values.add();
		const [pay] = values.draft;
		locked = true;
		values.remove(pay.id);
		values.merge(pay.id, pay.id);
		expect(values.rename(pay.id, 'Hours')).toEqual({ status: 'ok' });
		expect(values.draft.map((entry) => entry.text)).toEqual(['Pay']);
	});

	it('applies a rename only when the edit is new and not blank', () => {
		const values = list();
		values.input = 'Pay';
		values.add();
		const [pay] = values.draft;

		expect(values.rename(pay.id, '  ')).toEqual({ status: 'blank' });
		expect(values.rename(pay.id, 'pay')).toEqual({ status: 'ok' });
		expect(values.rename(pay.id, 'Hours')).toEqual({ status: 'ok' });
		expect(values.draft.map((entry) => entry.text)).toEqual(['Hours']);
	});

	it('folds a merged value out of what the editor shows until the draft is discarded', () => {
		const values = list();
		for (const text of ['Pay', 'Hours']) {
			values.input = text;
			values.add();
		}
		const [pay, hours] = values.draft;
		values.merge(hours.id, pay.id);

		expect(values.visible.map((entry) => entry.text)).toEqual(['Pay']);
		expect(values.draft).toHaveLength(2);
	});

	it('submits the box like an add, with the browser default suppressed', () => {
		const values = list();
		values.input = 'Pay';
		let prevented = false;
		values.submit({ preventDefault: () => (prevented = true) } as unknown as SubmitEvent);
		expect(prevented).toBe(true);
		expect(values.visible.map((entry) => entry.text)).toEqual(['Pay']);
	});
});
