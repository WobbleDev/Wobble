import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, stubStorage } from '#lib/testing/http.ts';
import { readStoredActiveWorksiteId } from './active-worksite-storage.ts';
import { createWorksite, getWorksiteCounts, setActiveWorksite } from './worksite-api.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('switching the Active Worksite', () => {
	it('puts the id and resolves', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worksite: { id: 'w1' } }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(setActiveWorksite('w1')).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/worksite/active',
			expect.objectContaining({ method: 'PUT', body: JSON.stringify({ id: 'w1' }) })
		);
	});

	it('surfaces the server message when the switch fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ message: 'Worksite "w1" does not exist.' }, 404))
		);

		await expect(setActiveWorksite('w1')).rejects.toThrow('Worksite "w1" does not exist.');
	});

	it('remembers a switched Worksite for later requests', async () => {
		stubStorage();
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ worksite: { id: 'w1' } })));

		await setActiveWorksite('w1');

		expect(readStoredActiveWorksiteId()).toBe('w1');
	});

	it('falls back to its own message when the reply carries none', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

		await expect(setActiveWorksite('w1')).rejects.toThrow(
			'Could not switch the worksite (HTTP 500).'
		);
	});
});

describe('creating a Worksite', () => {
	it('posts and resolves', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worksite: { id: 'w2' } }, 201));
		vi.stubGlobal('fetch', fetchMock);

		await expect(createWorksite()).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/worksite',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('sends the applied template locale when one is given', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worksite: { id: 'w2' } }, 201));
		vi.stubGlobal('fetch', fetchMock);

		await createWorksite('es-419');

		expect(fetchMock).toHaveBeenCalledWith(
			'/api/worksite',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ templateLocale: 'es-419' })
			})
		);
	});

	it('remembers a created Worksite for later requests', async () => {
		stubStorage();
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ worksite: { id: 'w2' } }, 201))
		);

		await createWorksite();

		expect(readStoredActiveWorksiteId()).toBe('w2');
	});

	it('surfaces the server message when creation fails', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'Nope.' }, 400)));

		await expect(createWorksite()).rejects.toThrow('Nope.');
	});
});

describe('Worksite counts', () => {
	it('reads every Worksite count by id', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				jsonResponse({
					counts: [
						{ worksiteId: 'a', workers: 3 },
						{ worksiteId: 'b', workers: 0 }
					]
				})
			)
		);

		await expect(getWorksiteCounts()).resolves.toEqual({ a: 3, b: 0 });
	});

	it('refuses a malformed count', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ counts: [{ worksiteId: 'a', workers: -1 }] }))
		);

		await expect(getWorksiteCounts()).rejects.toThrow('invalid worksite counts');
	});
});
