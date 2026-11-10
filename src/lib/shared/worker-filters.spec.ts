import { describe, expect, it } from 'vitest';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import { remainderIdentity } from './answer-hierarchy.ts';
import {
	NO_SELECTION_CHOICE,
	agitationFilterMatches,
	answerFilterMatches,
	knownAnswerIds,
	parseWorkerFilters,
	readAnswerFilter,
	toColumnFilters,
	toggleAnswerFilter,
	withoutExactAnswerFilter,
	writeWorkerFilters,
	type WorkerFilters
} from './worker-filters.ts';

const department: WorkerAttributeDefinition = {
	id: 'department',
	name: 'Department',
	kind: 'category',
	answers: [
		{ id: 'a1', value: 'Front of House' },
		{ id: 'a2', value: 'Delivery' },
		{ id: 'a3', value: 'No Department' }
	]
};
const roles: WorkerAttributeDefinition = {
	id: 'roles',
	name: 'Roles',
	kind: 'tag',
	answers: [
		{ id: 'r1', value: 'Trainer' },
		{ id: 'r2', value: 'Steward', parentId: 'r1' }
	]
};
const location: WorkerAttributeDefinition = {
	id: 'location',
	name: 'Location',
	kind: 'category',
	answers: [
		{ id: 'central', value: 'Central' },
		{ id: 'store-a', value: 'Store A', parentId: 'central' }
	]
};
const attributes = [department, roles, location];
const agitations = [
	{ id: 'ag-equipment', text: 'Equipment' },
	{ id: 'ag-schedule', text: 'Schedule' }
];

const worker = (
	attributeValues: Record<string, string | string[]>,
	heldAgitations: string[] = []
) =>
	baseWorker({
		name: 'Casey',
		attributes: attributeValues,
		agitations: heldAgitations
	});

function filtersOf(query: string): WorkerFilters {
	return parseWorkerFilters(new URLSearchParams(query), attributes, agitations);
}

const emptyFilters: WorkerFilters = {
	answers: new Map(),
	missing: new Set(),
	columns: new Map(),
	agitations: new Set()
};

describe('parseWorkerFilters', () => {
	it('reads answer ids and merges values per column', () => {
		const filters = filtersOf('f=department:a1&f=department:a2&f=roles:r1');

		expect(filters.answers).toEqual(
			new Map([
				['department', ['a1', 'a2']],
				['roles', ['r1']]
			])
		);
	});

	it('drops answer text from an old link, leaving no filter and no error', () => {
		expect(filtersOf('f=department:Front%20of%20House').answers).toEqual(new Map());
	});

	it('keeps values for columns it does not check', () => {
		expect(filtersOf('f=name:Casey').columns).toEqual(new Map([['name', ['Casey']]]));
	});

	it('returns no filters when there are no filter params', () => {
		const filters = filtersOf('');

		expect(filters.answers).toEqual(emptyFilters.answers);
		expect(filters.missing).toEqual(emptyFilters.missing);
		expect(filters.columns).toEqual(emptyFilters.columns);
		expect(filters.agitations).toEqual(emptyFilters.agitations);
		expect(filters).not.toHaveProperty('noWorkAssignments');
		expect(filters).not.toHaveProperty('assignmentAnswers');
	});

	it('ignores params that name no column or no value', () => {
		expect(filtersOf('f=&f=department&f=:a1&f=department:').answers).toEqual(new Map());
	});

	it('splits on the first colon, so a value can itself contain colons', () => {
		expect(
			filtersOf(`f=location:${remainderIdentity('location', 'central')}`).exactAnswers
		).toEqual(new Map([['location', ['central']]]));
	});

	it('keeps the order each column first appears in', () => {
		expect([...filtersOf('f=roles:r1&f=department:a1').answers.keys()]).toEqual([
			'roles',
			'department'
		]);
	});

	it('does not trim whitespace, so a padded answer id is treated as unknown', () => {
		expect(filtersOf('f=department:%20a1%20').answers).toEqual(new Map());
	});

	it('reads the missing-value reading for either cardinality', () => {
		expect(filtersOf('missing=department&missing=roles').missing).toEqual(
			new Set(['department', 'roles'])
		);
	});

	it('normalizes the retired zero-assignments parameter away', () => {
		const filters = filtersOf('assignments=none&f=department:a1');

		expect(filters.answers).toEqual(new Map([['department', ['a1']]]));
		expect(filters).not.toHaveProperty('noWorkAssignments');
	});
});

describe('knownAnswerIds', () => {
	it('maps each attribute id to the set of its answer ids', () => {
		expect(knownAnswerIds([department, roles])).toEqual(
			new Map([
				['department', new Set(['a1', 'a2', 'a3'])],
				['roles', new Set(['r1', 'r2'])]
			])
		);
	});

	it('returns an empty map for no attributes', () => {
		expect(knownAnswerIds([])).toEqual(new Map());
	});
});

describe('Product gap 06 Worker filters', () => {
	it('keeps answer ids separate from the include-no-selection condition', () => {
		const filters = filtersOf('f=department:a1&missing=department');

		expect(filters.answers.get('department')).toEqual(['a1']);
		expect(filters.missing.has('department')).toBe(true);
	});

	it('deduplicates missing and ignores unknown and deleted ids', () => {
		expect(filtersOf('missing=department&missing=department&missing=ghost').missing).toEqual(
			new Set(['department'])
		);
	});

	it('drops an unknown or deleted answer id, keeping the rest', () => {
		expect(filtersOf('f=department:a1&f=department:gone').answers).toEqual(
			new Map([['department', ['a1']]])
		);
	});

	it('writes f and missing back and preserves unrelated address state', () => {
		const search = writeWorkerFilters(new URLSearchParams('worker=w9&f=old:1'), {
			answers: new Map([['department', ['a1']]]),
			missing: new Set(['roles']),
			columns: new Map([['name', ['Casey']]]),
			agitations: new Set()
		});

		expect(search.getAll('f')).toEqual(['department:a1', 'name:Casey']);
		expect(search.getAll('missing')).toEqual(['roles']);
		expect(search.get('worker')).toBe('w9');
	});

	it('drops the retired parameter when writing', () => {
		const search = writeWorkerFilters(new URLSearchParams('assignments=none'), emptyFilters);

		expect(search.toString()).toBe('');
	});

	it('round-trips its own encoding', () => {
		const filters: WorkerFilters = {
			answers: new Map([['department', ['a1', 'a2']]]),
			missing: new Set(['roles']),
			exactAnswers: new Map([['location', ['store-a']]]),
			columns: new Map([['name', ['Casey']]]),
			agitations: new Set(['ag-equipment'])
		};

		expect(filtersOf(writeWorkerFilters(new URLSearchParams(), filters).toString())).toEqual(
			filters
		);
	});

	it('turns the model into the table column filter values', () => {
		const entries = toColumnFilters({
			answers: new Map([['department', ['a1']]]),
			missing: new Set(['department']),
			exactAnswers: new Map([['location', ['central']]]),
			columns: new Map([['name', ['Casey']]]),
			agitations: new Set(['ag-equipment'])
		});

		expect(entries).toEqual([
			{ id: 'department', value: { answers: ['a1'], missing: true } },
			{ id: 'location', value: { answers: [], missing: false, exact: ['central'] } },
			{ id: 'name', value: ['Casey'] },
			{ id: 'agitations', value: ['ag-equipment'] }
		]);
	});

	it('adds a missing-only column filter entry', () => {
		expect(
			toColumnFilters({
				answers: new Map(),
				missing: new Set(['roles']),
				columns: new Map(),
				agitations: new Set()
			})
		).toEqual([{ id: 'roles', value: { answers: [], missing: true } }]);
	});

	it('ORs named answers and no selection within one Attribute', () => {
		const blank = worker({ department: '' });
		const held = worker({ department: 'a1' });

		expect(answerFilterMatches(blank, department, ['a1', 'a2'])).toBe(false);
		expect(answerFilterMatches(held, department, ['a1', 'a2'])).toBe(true);
		expect(answerFilterMatches(blank, department, { answers: ['a1'], missing: true })).toBe(true);
		expect(answerFilterMatches(held, department, { answers: [], missing: true })).toBe(false);
	});

	it('matches the missing-value reading for a Multi-Select Attribute', () => {
		const missingRoles = { answers: [], missing: true };
		expect(answerFilterMatches(worker({ roles: [] }), roles, missingRoles)).toBe(true);
		expect(answerFilterMatches(worker({ roles: ['r1'] }), roles, missingRoles)).toBe(false);
	});

	it('treats an empty filter as matching every Worker', () => {
		expect(answerFilterMatches(worker({}), department, [])).toBe(true);
	});

	it('toggles answers and the no-selection condition through one helper', () => {
		const withAnswer = toggleAnswerFilter(undefined, 'a1', true);
		expect(withAnswer).toEqual({ answers: ['a1'], missing: false });

		const withMissing = toggleAnswerFilter(withAnswer, NO_SELECTION_CHOICE, true);
		expect(withMissing).toEqual({ answers: ['a1'], missing: true });

		expect(toggleAnswerFilter(withMissing, 'a1', false)).toEqual({ answers: [], missing: true });
		expect(
			toggleAnswerFilter({ answers: [], missing: true }, NO_SELECTION_CHOICE, false)
		).toBeUndefined();
	});

	it('reads the filter value defensively', () => {
		expect(readAnswerFilter(['a1', 2])).toEqual({ answers: ['a1'], missing: false });
		expect(readAnswerFilter({ answers: ['a1'], missing: true, exact: ['a2', 3] })).toEqual({
			answers: ['a1'],
			missing: true,
			exact: ['a2']
		});
		expect(readAnswerFilter('nope')).toEqual({ answers: [], missing: false });
	});
});

describe('ordinary parent selection includes descendants', () => {
	it('matches a Worker holding a descendant of the selected parent', () => {
		expect(answerFilterMatches(worker({ roles: ['r2'] }), roles, ['r1'])).toBe(true);
	});

	it('does not match a parent holder when a child is selected', () => {
		expect(answerFilterMatches(worker({ roles: ['r1'] }), roles, ['r2'])).toBe(false);
	});

	it('keeps same-named answers in different branches distinguishable', () => {
		const branches: WorkerAttributeDefinition = {
			id: 'branches',
			name: 'Branches',
			kind: 'category',
			answers: [
				{ id: 'north', value: 'North' },
				{ id: 'north-center', value: 'Center', parentId: 'north' },
				{ id: 'south', value: 'South' },
				{ id: 'south-center', value: 'Center', parentId: 'south' }
			]
		};
		const held = worker({ branches: 'south-center' });

		expect(answerFilterMatches(held, branches, ['north'])).toBe(false);
		expect(answerFilterMatches(held, branches, ['south'])).toBe(true);
	});

	it('matches a Worker holding a depth-five answer when any ancestor is selected', () => {
		const chain: WorkerAttributeDefinition = {
			id: 'chain',
			name: 'Chain',
			kind: 'tag',
			answers: [
				{ id: 'l1', value: 'Level 1' },
				{ id: 'l2', value: 'Level 2', parentId: 'l1' },
				{ id: 'l3', value: 'Level 3', parentId: 'l2' },
				{ id: 'l4', value: 'Level 4', parentId: 'l3' },
				{ id: 'l5', value: 'Level 5', parentId: 'l4' }
			]
		};
		const holdsL5 = worker({ chain: ['l5'] });

		expect(answerFilterMatches(holdsL5, chain, ['l1'])).toBe(true);
		expect(answerFilterMatches(holdsL5, chain, ['l2'])).toBe(true);
		expect(answerFilterMatches(holdsL5, chain, ['l3'])).toBe(true);
		expect(answerFilterMatches(holdsL5, chain, ['l4'])).toBe(true);
		expect(answerFilterMatches(holdsL5, chain, ['l5'])).toBe(true);
	});

	it('does not match a depth-five answer from a sibling or a child of a shallower holder', () => {
		const chain: WorkerAttributeDefinition = {
			id: 'chain',
			name: 'Chain',
			kind: 'tag',
			answers: [
				{ id: 'l1', value: 'Level 1' },
				{ id: 'l2', value: 'Level 2', parentId: 'l1' },
				{ id: 'l3', value: 'Level 3', parentId: 'l2' },
				{ id: 'l4', value: 'Level 4', parentId: 'l3' },
				{ id: 'l5', value: 'Level 5', parentId: 'l4' }
			]
		};

		expect(answerFilterMatches(worker({ chain: ['l2'] }), chain, ['l3'])).toBe(false);
		expect(answerFilterMatches(worker({ chain: ['l4'] }), chain, ['l5'])).toBe(false);
	});
});

describe('Product gap 08 Agitation filters', () => {
	it('reads repeated agitation ids, deduplicating and dropping unknown or deleted ids', () => {
		expect(
			filtersOf('agitation=ag-equipment&agitation=ag-equipment&agitation=gone').agitations
		).toEqual(new Set(['ag-equipment']));
	});

	it('keeps the Agitation facet independent of Attribute answers', () => {
		expect(filtersOf('agitation=ag-schedule&f=department:a1').agitations).toEqual(
			new Set(['ag-schedule'])
		);
	});

	it('writes agitation beside f and missing and preserves unrelated address state', () => {
		const search = writeWorkerFilters(new URLSearchParams('worker=w1'), {
			answers: new Map(),
			missing: new Set(),
			columns: new Map(),
			agitations: new Set(['ag-schedule'])
		});

		expect(search.getAll('agitation')).toEqual(['ag-schedule']);
		expect(search.get('worker')).toBe('w1');
	});

	it('round-trips agitation conditions alongside f and missing', () => {
		const filters = filtersOf('agitation=ag-equipment&f=department:a1&missing=roles');

		expect(filtersOf(writeWorkerFilters(new URLSearchParams(), filters).toString())).toEqual(
			filters
		);
	});

	it('turns the Agitation set into its own column-filter facet', () => {
		expect(
			toColumnFilters({
				answers: new Map(),
				missing: new Set(),
				columns: new Map(),
				agitations: new Set(['ag-equipment'])
			})
		).toEqual([{ id: 'agitations', value: ['ag-equipment'] }]);
	});

	it('ORs several selected Agitations within the facet', () => {
		expect(
			agitationFilterMatches(worker({}, ['ag-equipment']), ['ag-schedule', 'ag-equipment'])
		).toBe(true);
		expect(agitationFilterMatches(worker({}, ['ag-schedule']), ['ag-equipment'])).toBe(false);
	});

	it('matches every Worker when the facet has no selection', () => {
		expect(agitationFilterMatches(worker({}, []), [])).toBe(true);
		expect(agitationFilterMatches(worker({}, []), 'nope')).toBe(true);
	});

	it('keeps membership by stable id when an Agitation is renamed', () => {
		const renamed = [{ id: 'ag-equipment', text: 'New equipment' }];

		expect(
			parseWorkerFilters(new URLSearchParams('agitation=ag-equipment'), attributes, renamed)
				.agitations
		).toEqual(new Set(['ag-equipment']));
	});
});

describe('a Multi-Select group under a Single-Select Attribute (ADR 0043)', () => {
	const site: WorkerAttributeDefinition = {
		id: 'site',
		name: 'Site',
		kind: 'category',
		answers: [
			{ id: 'foh', value: 'Front of House', mode: 'multi' },
			{ id: 'server', value: 'Server', parentId: 'foh' },
			{ id: 'host', value: 'Host', parentId: 'foh' },
			{ id: 'boh', value: 'Back of House' }
		]
	};
	const holdsServerAndHost = worker({ site: ['server', 'host'] });

	it('matches a Worker holding several sub-values by the parent and by each one held', () => {
		expect(answerFilterMatches(holdsServerAndHost, site, ['foh'])).toBe(true);
		expect(answerFilterMatches(holdsServerAndHost, site, ['host'])).toBe(true);
	});

	it('does not match that Worker through a sibling branch they do not hold', () => {
		expect(answerFilterMatches(holdsServerAndHost, site, ['boh'])).toBe(false);
	});
});

describe('direct-parent remainder filters', () => {
	it('reads the remainder system identity into exact predicates, not answers', () => {
		const filters = filtersOf(`f=location:${remainderIdentity('location', 'central')}`);

		expect(filters.answers).toEqual(new Map());
		expect(filters.exactAnswers).toEqual(new Map([['location', ['central']]]));
	});

	it('drops a stale or mismatched remainder identity', () => {
		expect(filtersOf(`f=location:${remainderIdentity('location', 'gone')}`).exactAnswers).toBe(
			undefined
		);
		expect(filtersOf(`f=roles:${remainderIdentity('location', 'central')}`).exactAnswers).toBe(
			undefined
		);
	});

	it('round-trips the exact reading through the address', () => {
		const filters: WorkerFilters = {
			answers: new Map(),
			missing: new Set(),
			exactAnswers: new Map([['location', ['central']]]),
			columns: new Map(),
			agitations: new Set()
		};

		expect(filtersOf(writeWorkerFilters(new URLSearchParams(), filters).toString())).toEqual(
			filters
		);
	});

	it('carries the remainder in the column filter value', () => {
		expect(
			toColumnFilters({
				answers: new Map(),
				missing: new Set(),
				exactAnswers: new Map([['location', ['central']]]),
				columns: new Map(),
				agitations: new Set()
			})
		).toEqual([{ id: 'location', value: { answers: [], missing: false, exact: ['central'] } }]);
	});

	it('matches only the held answer itself, never a descendant', () => {
		const exact = { answers: [], missing: false, exact: ['central'] };

		expect(answerFilterMatches(worker({ location: 'central' }), location, exact)).toBe(true);
		expect(answerFilterMatches(worker({ location: 'store-a' }), location, exact)).toBe(false);
	});

	it('removes only the exact reading, keeping the other conditions', () => {
		expect(
			withoutExactAnswerFilter({ answers: ['a1'], missing: false, exact: ['central'] }, 'central')
		).toEqual({ answers: ['a1'], missing: false });
		expect(
			withoutExactAnswerFilter({ answers: [], missing: true, exact: ['central'] }, 'central')
		).toEqual({ answers: [], missing: true });
	});

	it('keeps the exact reading when an ordinary answer is toggled', () => {
		const withExact = { answers: [], missing: false, exact: ['central'] };

		expect(toggleAnswerFilter(withExact, 'a1', true)).toEqual({
			answers: ['a1'],
			missing: false,
			exact: ['central']
		});
	});
});
