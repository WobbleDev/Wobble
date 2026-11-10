// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { searchResultLimit, searchResults } from './map-search-results.ts';

const attributes = [
	{
		id: 'dept',
		name: 'Department',
		kind: 'category',
		answers: [{ id: 'a1', value: 'Kitchen' }]
	}
] as unknown as WorkerAttributeDefinition[];

function worker(id: string, name: string, dept = ''): Worker {
	return {
		id,
		name,
		assessment: 'unknown',
		attributes: dept ? { dept } : {}
	} as unknown as Worker;
}

describe('searchResults', () => {
	it('names nothing for an empty search', () => {
		const out = searchResults({
			query: '  ',
			workers: [worker('1', 'Worker 01')],
			attributes,
			drawnIds: new Set(['1'])
		});
		expect(out).toEqual({ results: [], total: 0 });
	});

	it('separates same-named Workers by their answer and marks hidden ones', () => {
		const out = searchResults({
			query: 'worker 0',
			workers: [worker('1', 'Worker 01', 'a1'), worker('2', 'Worker 01'), worker('3', 'Other')],
			attributes,
			drawnIds: new Set(['1'])
		});
		expect(out.total).toBe(2);
		expect(out.results.map((r) => [r.id, r.detail, r.hidden])).toEqual([
			['1', 'Kitchen', false],
			['2', '', true]
		]);
	});

	it('caps the list but counts every match', () => {
		const workers = Array.from({ length: searchResultLimit + 3 }, (_, i) =>
			worker(`${i}`, `W ${i}`)
		);
		const out = searchResults({ query: 'w', workers, attributes, drawnIds: new Set() });
		expect(out.results).toHaveLength(searchResultLimit);
		expect(out.total).toBe(searchResultLimit + 3);
	});
});
