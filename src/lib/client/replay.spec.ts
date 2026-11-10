import { describe, expect, it } from 'vitest';
import { createReplay, createSeedReplay, parseRecordingFile } from './replay.ts';

const replay = createReplay([
	{
		method: 'GET',
		path: '/api/workers',
		query: 'scope=roster',
		status: 200,
		body: { workers: [] }
	},
	{ method: 'GET', path: '/api/workers', status: 200, body: { workers: ['all'] } },
	{ method: 'POST', path: '/api/workers', status: 201, body: { worker: { id: 'w1' } } },
	{ method: 'DELETE', path: '/api/settings', status: 204, body: null }
]);

describe('createReplay', () => {
	it('matches on method, pathname and exact query', async () => {
		const scoped = replay('/api/workers?scope=roster', { method: 'GET' });
		expect(await scoped.json()).toEqual({ workers: [] });
		expect(await replay('/api/workers', {}).json()).toEqual({ workers: ['all'] });
		const created = replay('/api/workers', { method: 'POST' });
		expect(created.status).toBe(201);
	});

	it('answers the n-th identical request from the n-th recording, then repeats the last', async () => {
		const ordered = createReplay([
			{ method: 'GET', path: '/api/dataset', status: 200, body: { n: 1 } },
			{ method: 'GET', path: '/api/dataset', status: 200, body: { n: 2 } },
			{ method: 'GET', path: '/api/other', status: 200, body: { o: 1 } }
		]);
		expect(await ordered('/api/dataset', {}).json()).toEqual({ n: 1 });
		expect(await ordered('/api/other', {}).json()).toEqual({ o: 1 });
		expect(await ordered('/api/dataset', {}).json()).toEqual({ n: 2 });
		expect(await ordered('/api/dataset', {}).json()).toEqual({ n: 2 });
	});

	it('returns the same recording for repeated identical requests', async () => {
		expect(await replay('/api/workers', {}).json()).toEqual(
			await replay('/api/workers', {}).json()
		);
	});

	it('answers bodyless statuses without a body', () => {
		expect(replay('/api/settings', { method: 'DELETE' }).status).toBe(204);
	});

	it('throws on a miss', () => {
		expect(() => replay('/api/workers?scope=other', { method: 'GET' })).toThrow(
			'No API recording for GET /api/workers?scope=other'
		);
		expect(() => replay('/api/nothing', {})).toThrow('No API recording for GET /api/nothing');
	});
});

describe('createSeedReplay', () => {
	const seed = createSeedReplay([
		{ method: 'POST', path: '/api/workers', status: 201, body: { id: 'a' } },
		{ method: 'POST', path: '/api/workers', status: 201, body: { id: 'b' } },
		{ method: 'GET', path: '/api/workers?x=1', status: 200, body: { n: 1 } }
	]);

	it('answers the n-th call per method and path from the n-th entry', () => {
		expect(seed('POST', '/api/workers').body).toEqual({ id: 'a' });
		expect(seed('post', '/api/workers').body).toEqual({ id: 'b' });
	});

	it('counts per method and ignores the query', () => {
		expect(seed('GET', '/api/workers').body).toEqual({ n: 1 });
	});

	it('throws with method and path when entries run out', () => {
		expect(() => seed('POST', '/api/workers?y=2')).toThrow(
			'No seed recording for POST /api/workers'
		);
		expect(() => seed('PUT', '/api/other')).toThrow('No seed recording for PUT /api/other');
	});
});

describe('parseRecordingFile', () => {
	it('reads the array and object shapes', () => {
		expect(parseRecordingFile([]).pages).toEqual([]);
		expect(parseRecordingFile({ pages: [], seed: [] }).seed).toEqual([]);
	});
});
