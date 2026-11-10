import { describe, expect, it, vi } from 'vitest';
import { agitationHref, groupHref, matrixAllHref, matrixCellHref } from './summary-links.ts';

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

/**
 * The group row's link recipe lives in the summary-links module, so the
 * dashboard's group names open the same Workers cohort the removed summary's
 * rows opened: a named answer by its id, a no-value group by the missing
 * reading, a remainder group by its own identity.
 */
describe('groupHref', () => {
	it('filters an ordinary group by attribute:answer', () => {
		expect(groupHref({ attributeId: 'department', answerId: 'front-of-house' })).toBe(
			'/workers?f=department%3Afront-of-house'
		);
	});

	it('opens a no-value group with the attribute missing reading', () => {
		expect(groupHref({ attributeId: 'department', answerId: '', noValue: true })).toBe(
			'/workers?missing=department'
		);
	});

	it('opens a remainder group with the remainder identity, not the parent subtree', () => {
		expect(groupHref({ attributeId: 'location', answerId: 'central', remainder: true })).toBe(
			'/workers?f=location%3A%23self%3Alocation%3Acentral'
		);
	});
});

/**
 * The Overview's matrix links: the All column and each cell open the Agitation's
 * holders across the whole Worksite, and a cell's group flags reach the link.
 */
describe('matrixAllHref and matrixCellHref', () => {
	const attributes = [
		{ id: 'department', name: 'Department', kind: 'category', options: [] }
	] as unknown as Parameters<typeof matrixAllHref>[1];

	it('opens the whole-Worksite holders for the All column', () => {
		expect(matrixAllHref('pay', attributes)).toBe(
			agitationHref(
				{ agitationId: 'pay' },
				{
					answers: new Map(),
					missing: new Set(),
					exactAnswers: new Map(),
					columns: new Map(),
					agitations: new Set()
				},
				attributes
			)
		);
	});

	it('opens a group cell with that group and the one Agitation', () => {
		const cell = matrixCellHref(
			{ attributeId: 'department', answerId: 'front' },
			'pay',
			attributes
		);
		expect(cell).toBe(
			agitationHref(
				{ agitationId: 'pay', group: { attributeId: 'department', answerId: 'front' } },
				{
					answers: new Map(),
					missing: new Set(),
					exactAnswers: new Map(),
					columns: new Map(),
					agitations: new Set()
				},
				attributes
			)
		);
	});

	it('passes the no-value and remainder flags into the cell argument', () => {
		const plain = matrixCellHref({ attributeId: 'department', answerId: '' }, 'pay', attributes);
		const noValue = matrixCellHref(
			{ attributeId: 'department', answerId: '', noValue: true },
			'pay',
			attributes
		);
		const remainder = matrixCellHref(
			{ attributeId: 'department', answerId: 'front', remainder: true },
			'pay',
			attributes
		);
		expect(noValue).not.toBe(plain);
		expect(remainder).not.toBe(
			matrixCellHref({ attributeId: 'department', answerId: 'front' }, 'pay', attributes)
		);
	});
});
