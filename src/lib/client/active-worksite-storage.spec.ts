import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeWorksiteHeaderName } from '#lib/shared/active-worksite-header.ts';
import { jsonResponse, stubStorage } from '#lib/testing/http.ts';
import { readStoredActiveWorksiteId, storeActiveWorksiteId } from './active-worksite-storage.ts';
import { requestVoid } from './request-json.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('remembering the Active Worksite', () => {
	it('round-trips a stored id and forgets it when given null', () => {
		stubStorage();
		expect(readStoredActiveWorksiteId()).toBeNull();

		storeActiveWorksiteId('ws-2');
		expect(readStoredActiveWorksiteId()).toBe('ws-2');

		storeActiveWorksiteId(null);
		expect(readStoredActiveWorksiteId()).toBeNull();
	});

	it('keeps no memory where storage is unavailable', () => {
		vi.stubGlobal('localStorage', undefined);

		expect(readStoredActiveWorksiteId()).toBeNull();
		expect(() => storeActiveWorksiteId('ws-2')).not.toThrow();
	});
});

describe('sending the Active Worksite header', () => {
	it('names the stored Worksite alongside the caller headers', async () => {
		stubStorage();
		storeActiveWorksiteId('ws-2');
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
		vi.stubGlobal('fetch', fetchMock);

		await requestVoid(
			'/api/settings',
			{ headers: { 'content-type': 'application/json' } },
			() => 'nope'
		);

		expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
			'content-type': 'application/json',
			[activeWorksiteHeaderName]: 'ws-2'
		});
	});

	it('leaves the header out when nothing is stored', async () => {
		stubStorage();
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
		vi.stubGlobal('fetch', fetchMock);

		await requestVoid('/api/settings', {}, () => 'nope');

		expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
	});
});
