import { describe, expect, it } from 'vitest';
import type { AttributeAnswer, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { remainderIdentity } from './answer-hierarchy.ts';
import {
	copyContextualFilters,
	emptyContextualFilters,
	hasContextualFilters,
	parseContextualFilters,
	toPopulationFilters,
	toggleContextAnswer,
	toggleContextMissing,
	withoutContextAnswer,
	withoutContextMissing,
	writeContextualFilters
} from './contextual-filters.ts';

function answer(id: string, value: string, parentId?: string): AttributeAnswer {
	return { id, value, ...(parentId ? { parentId } : {}) };
}

const department: WorkerAttributeDefinition = {
	id: 'dept',
	name: 'Department',
	kind: 'category',
	answers: [answer('packing', 'Packing'), answer('delivery', 'Delivery')]
};

const roles: WorkerAttributeDefinition = {
	id: 'roles',
	name: 'Roles',
	kind: 'tag',
	answers: [answer('trainer', 'Trainer'), answer('steward', 'Steward')]
};

const location: WorkerAttributeDefinition = {
	id: 'location',
	name: 'Location',
	kind: 'category',
	answers: [
		answer('central', 'Central'),
		answer('store-a', 'Store A', 'central'),
		answer('packing', 'Packing', 'store-a')
	]
};

const attributes = [department, roles, location];

function parsed(query: string) {
	return parseContextualFilters(new URLSearchParams(query), attributes);
}

describe('parseContextualFilters', () => {
	it('reads a known answer and drops an unknown Attribute or answer', () => {
		expect(parsed('f=dept:packing').filters.answers).toEqual({ dept: ['packing'] });
		expect(parsed('f=dept:packing').other).toEqual([]);

		const unknownAnswer = parsed('f=dept:unknown');
		expect(unknownAnswer.filters.answers).toEqual({});
		expect(unknownAnswer.other).toEqual([]);

		// An entry that names no Attribute answer is someone else's column, not a filter.
		expect(parsed('f=name:Ada').other).toEqual([{ id: 'name', value: 'Ada' }]);
	});

	it('keeps several answers within one Attribute as alternatives', () => {
		expect(parsed('f=dept:packing&f=dept:delivery').filters.answers).toEqual({
			dept: ['packing', 'delivery']
		});
	});

	it('reads a missing-value link for either cardinality', () => {
		expect(parsed('missing=dept').filters.missing).toEqual(['dept']);
		expect(parsed('missing=roles').filters.missing).toEqual(['roles']);
		expect(parsed('missing=ghost').filters.missing).toEqual([]);
		expect(parsed('missing=').filters.missing).toEqual([]);
	});

	it('collapses a repeated missing reading', () => {
		expect(parsed('missing=dept&missing=dept').filters.missing).toEqual(['dept']);
	});

	it('ignores the retired zero-assignments parameter instead of reviving it', () => {
		const { filters } = parsed('assignments=none');

		expect(filters).toEqual(emptyContextualFilters());
		expect(filters).not.toHaveProperty('noWorkAssignments');
	});

	it('drops a malformed entry without an error', () => {
		expect(parsed('f=dept&f=:packing&f=dept:&f=').filters.answers).toEqual({});
	});
});

describe('direct-parent remainder identities', () => {
	it('reads a remainder into the exact predicate', () => {
		const { filters } = parsed(`f=location:${remainderIdentity('location', 'central')}`);

		expect(filters.answers).toEqual({});
		expect(filters.exactAnswers).toEqual({ location: ['central'] });
	});

	it('drops a stale answer and an identity scoped to another Attribute', () => {
		expect(parsed(`f=location:${remainderIdentity('location', 'ghost')}`).filters).toEqual(
			emptyContextualFilters()
		);
		// The Attribute half of the identity must match the entry's own Attribute.
		expect(parsed(`f=dept:${remainderIdentity('location', 'central')}`).filters.answers).toEqual(
			{}
		);
	});

	it('keeps an ordinary answer and its exact remainder distinguishable', () => {
		const { filters } = parsed(
			`f=location:central&f=location:${remainderIdentity('location', 'central')}`
		);

		expect(filters.answers).toEqual({ location: ['central'] });
		expect(filters.exactAnswers).toEqual({ location: ['central'] });
	});

	it('round-trips the exact reading and projects it into the shared predicates', () => {
		const filters = parsed(`f=location:${remainderIdentity('location', 'store-a')}`).filters;
		const search = writeContextualFilters(new URLSearchParams(), filters);

		expect(search.getAll('f')).toEqual([`location:${remainderIdentity('location', 'store-a')}`]);
		expect(toPopulationFilters(filters)).toEqual({
			answers: new Map(),
			missing: new Set(),
			exactAnswers: new Map([['location', ['store-a']]])
		});
	});
});

describe('writeContextualFilters', () => {
	it('writes every condition in a stable order and omits empty fields', () => {
		const search = writeContextualFilters(new URLSearchParams('worker=w1'), {
			answers: { dept: ['packing'], roles: ['trainer'] },
			missing: ['roles'],
			exactAnswers: { location: ['central'] }
		});

		expect(search.getAll('f')).toEqual([
			'dept:packing',
			'roles:trainer',
			`location:${remainderIdentity('location', 'central')}`
		]);
		expect(search.getAll('missing')).toEqual(['roles']);
		expect(search.get('worker')).toBe('w1');
	});

	it('writes nothing for an empty selection', () => {
		expect(writeContextualFilters(new URLSearchParams(), emptyContextualFilters()).toString()).toBe(
			''
		);
	});

	it('reads back the same selection after a reload', () => {
		const selection = {
			answers: { dept: ['packing', 'delivery'] },
			missing: ['roles'],
			exactAnswers: { location: ['store-a'] }
		};
		const written = writeContextualFilters(new URLSearchParams(), selection);

		expect(parseContextualFilters(written, attributes).filters).toEqual(selection);
	});
});

describe('toPopulationFilters', () => {
	it('projects the selection into the shared predicates', () => {
		expect(
			toPopulationFilters({
				answers: { dept: ['packing'], roles: [] },
				missing: ['roles']
			})
		).toEqual({
			answers: new Map([['dept', ['packing']]]),
			missing: new Set(['roles'])
		});
	});

	it('keeps conditions on different Attributes independent', () => {
		const selection = parsed('f=dept:packing&f=roles:trainer&missing=roles').filters;

		expect(selection.answers).toEqual({ dept: ['packing'], roles: ['trainer'] });
		expect(selection.missing).toEqual(['roles']);
		const predicates = toPopulationFilters(selection);
		expect(predicates.answers).toEqual(
			new Map([
				['dept', ['packing']],
				['roles', ['trainer']]
			])
		);
		expect(predicates.missing).toEqual(new Set(['roles']));
	});

	it('keeps the exact remainder separate from the ordinary answer', () => {
		expect(
			toPopulationFilters({
				answers: {},
				missing: [],
				exactAnswers: { location: ['central'] }
			})
		).toEqual({
			answers: new Map(),
			missing: new Set(),
			exactAnswers: new Map([['location', ['central']]])
		});
	});
});

describe('hasContextualFilters', () => {
	it('is false only for the empty selection', () => {
		expect(hasContextualFilters(emptyContextualFilters())).toBe(false);
		expect(hasContextualFilters({ answers: { dept: ['packing'] }, missing: [] })).toBe(true);
		expect(hasContextualFilters({ answers: {}, missing: ['dept'] })).toBe(true);
		expect(
			hasContextualFilters({ answers: {}, missing: [], exactAnswers: { dept: ['packing'] } })
		).toBe(true);
	});
});

describe('toggling the selection', () => {
	it('adds and removes an answer within its Attribute, keeping the missing reading', () => {
		const withMissing = { ...emptyContextualFilters(), missing: ['dept'] };
		const on = toggleContextAnswer(withMissing, 'dept', 'packing', true);
		expect(on.answers).toEqual({ dept: ['packing'] });
		expect(on.missing).toEqual(['dept']);

		const off = toggleContextAnswer(on, 'dept', 'packing', false);
		expect(off.answers).toEqual({});
		expect(off.missing).toEqual(['dept']);
	});

	it('leaves the source selection unchanged', () => {
		const before = emptyContextualFilters();
		toggleContextAnswer(before, 'dept', 'packing', true);

		expect(before.answers).toEqual({});
	});

	it('toggles a missing reading without adding an answer', () => {
		const on = toggleContextMissing(emptyContextualFilters(), 'roles', true);
		expect(on).toEqual({ answers: {}, missing: ['roles'] });
		expect(toggleContextMissing(on, 'roles', false).missing).toEqual([]);
	});

	it('removes one answer, normal or exact, and one missing reading', () => {
		const filters = {
			answers: { dept: ['packing', 'delivery'] },
			missing: ['dept', 'roles'],
			exactAnswers: { dept: ['packing'], roles: ['trainer'] }
		};

		const withoutPacking = withoutContextAnswer(filters, 'dept', 'packing');
		expect(withoutPacking.answers).toEqual({ dept: ['delivery'] });
		expect(withoutPacking.exactAnswers).toEqual({ roles: ['trainer'] });

		const withoutMissing = withoutContextMissing(filters, 'dept');
		expect(withoutMissing.missing).toEqual(['roles']);
	});
});

describe('copyContextualFilters', () => {
	it('gives the copy its own records', () => {
		const source = {
			answers: { dept: ['packing'] },
			missing: ['roles'],
			exactAnswers: { location: ['central'] }
		};
		const copy = copyContextualFilters(source);

		copy.answers.dept.push('delivery');
		copy.missing.push('dept');
		copy.exactAnswers?.location.push('store-a');

		expect(source).toEqual({
			answers: { dept: ['packing'] },
			missing: ['roles'],
			exactAnswers: { location: ['central'] }
		});
	});
});
