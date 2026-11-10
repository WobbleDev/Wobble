import { describe, expect, it } from 'vitest';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { writeWorkerFilters } from '#lib/shared/worker-filters.ts';
import {
	activeFilterNamesFrom,
	collectWorkerFiltersFrom,
	dropObsoleteFilterParams,
	filterParamsKey
} from './data-table-url-filters.svelte.ts';

function attribute(id: string, name: string, kind: 'category' | 'tag' = 'category') {
	return {
		id,
		name,
		kind,
		answers: []
	} as unknown as WorkerAttributeDefinition;
}

const trade = attribute('trade', 'Trade');
const shift = attribute('shift', 'Shift', 'tag');

function reader(values: Record<string, unknown>) {
	return (columnId: string) => values[columnId];
}

describe('collectWorkerFiltersFrom', () => {
	it('reads attribute answers, gaps and exact readings', () => {
		const filters = collectWorkerFiltersFrom(
			reader({ trade: { answers: ['a', 'a', 'b'], missing: true, exact: ['c'] } }),
			[trade]
		);
		expect(filters.answers.get('trade')).toEqual(['a', 'b']);
		expect(filters.exactAnswers?.get('trade')).toEqual(['c']);
		expect([...filters.missing]).toEqual(['trade']);
	});

	it('reads a Multi-Select Attribute the same way as a Single-Select one', () => {
		const filters = collectWorkerFiltersFrom(
			reader({ shift: { answers: ['day'], missing: true } }),
			[shift]
		);
		expect(filters.answers.get('shift')).toEqual(['day']);
		expect([...filters.missing]).toEqual(['shift']);
	});

	it('reads languages, assessment and agitations, dropping non-strings', () => {
		const filters = collectWorkerFiltersFrom(
			reader({ languages: ['en', 3, 'fr'], assessment: [], agitations: ['x', 9] }),
			[]
		);
		expect(filters.columns.get('languages')).toEqual(['en', 'fr']);
		expect(filters.columns.has('assessment')).toBe(false);
		expect([...filters.agitations]).toEqual(['x']);
	});
});

describe('activeFilterNamesFrom', () => {
	it('names a name search, an attribute filter and a chosen agitation', () => {
		const names = activeFilterNamesFrom(
			reader({ name: 'Ana', trade: ['a'], agitations: ['g1', 'gone'] }),
			[trade],
			[{ id: 'g1', text: 'Heat' }]
		);
		expect(names).toEqual(['“Ana”', 'Trade', 'Heat']);
	});

	it('names an Attribute once however many of its conditions are chosen', () => {
		const names = activeFilterNamesFrom(
			reader({ shift: { answers: ['day'], missing: true, exact: ['night'] } }),
			[shift],
			[]
		);
		expect(names).toEqual(['Shift']);
	});

	it('names nothing when nothing is filtered', () => {
		expect(activeFilterNamesFrom(reader({}), [trade], [])).toEqual([]);
	});
});

describe('the address', () => {
	it('keeps the selected Worker when filters are written', () => {
		const params = new URLSearchParams('worker=7');
		writeWorkerFilters(params, collectWorkerFiltersFrom(reader({ languages: ['en'] }), []));
		expect(params.get('worker')).toBe('7');
		expect(params.getAll('f')).toEqual(['languages:en']);
	});

	it('normalizes away a filter on a deleted attribute and keeps worker', () => {
		const params = new URLSearchParams('worker=7&missing=gone');
		const before = filterParamsKey(params);
		writeWorkerFilters(params, collectWorkerFiltersFrom(reader({}), [trade]));
		expect(params.get('worker')).toBe('7');
		expect(params.has('missing')).toBe(false);
		expect(filterParamsKey(params)).not.toBe(before);
	});

	it('compares filter state regardless of order within a parameter', () => {
		expect(filterParamsKey(new URLSearchParams('f=a:1&f=b:2&worker=1'))).toBe(
			filterParamsKey(new URLSearchParams('f=b:2&f=a:1'))
		);
	});

	it('drops the retired zero-assignment predicate and keeps unrelated params', () => {
		const params = new URLSearchParams('worker=7&assignments=none&f=trade:a');
		expect(dropObsoleteFilterParams(params)).toBe(true);
		expect(params.has('assignments')).toBe(false);
		expect(params.get('worker')).toBe('7');
		expect(params.getAll('f')).toEqual(['trade:a']);
	});

	it('leaves an address without retired predicates alone', () => {
		const params = new URLSearchParams('worker=7');
		expect(dropObsoleteFilterParams(params)).toBe(false);
		expect(params.toString()).toBe('worker=7');
	});
});
