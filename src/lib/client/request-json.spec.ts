import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeWorksiteHeaderName } from '#lib/shared/active-worksite-header.ts';
import { jsonResponse } from '#lib/testing/http.ts';
import { appLocaleHeaderName } from '#lib/shared/app-locale-header.ts';
import { jsonInit, localizedJsonInit, requestVoid } from './request-json.ts';

const appliedLocale = vi.hoisted(() => vi.fn(() => 'en'));

vi.mock('#lib/i18n/locale.ts', () => ({ appliedLocale }));

const sendApiRequest = vi.hoisted(() => vi.fn());

vi.mock('./transport.ts', () => ({ sendApiRequest }));

function stubStorage(id: string | null) {
	vi.stubGlobal('localStorage', {
		getItem: () => id,
		setItem: () => undefined,
		removeItem: () => undefined
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	sendApiRequest.mockReset();
});

describe('jsonInit', () => {
	it('carries the method, the JSON content type and the body serialized once', () => {
		expect(jsonInit('PATCH', { field: 'name', value: 'Ada' })).toEqual({
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: '{"field":"name","value":"Ada"}'
		});
	});
});

describe('localizedJsonInit', () => {
	it('adds the applied app locale, which the core uses to pick its Abbreviation lists', () => {
		appliedLocale.mockReturnValueOnce('es-419');
		expect(localizedJsonInit('PUT', [1])).toEqual({
			method: 'PUT',
			headers: { 'content-type': 'application/json', [appLocaleHeaderName]: 'es-419' },
			body: '[1]'
		});
	});
});

describe('the Active Worksite header', () => {
	it('is left out when no Worksite is stored', async () => {
		stubStorage(null);
		sendApiRequest.mockResolvedValue(jsonResponse({}));

		await requestVoid('/api/workers', jsonInit('POST', { name: 'Ada' }), () => 'failed');

		expect(sendApiRequest).toHaveBeenCalledWith('/api/workers', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"name":"Ada"}'
		});
	});

	it('is added to a record of headers', async () => {
		stubStorage('w1');
		sendApiRequest.mockResolvedValue(jsonResponse({}));

		await requestVoid('/api/worksite', jsonInit('PUT', { name: 'Ward' }), () => 'failed');

		expect(sendApiRequest).toHaveBeenCalledWith(
			'/api/worksite',
			expect.objectContaining({
				headers: {
					'content-type': 'application/json',
					[activeWorksiteHeaderName]: 'w1'
				}
			})
		);
	});

	it('is added to a Headers object, with the names read in lowercase', async () => {
		stubStorage('w1');
		sendApiRequest.mockResolvedValue(jsonResponse({}));

		await requestVoid(
			'/api/worksite',
			{ method: 'PUT', headers: new Headers({ 'Content-Type': 'application/json' }) },
			() => 'failed'
		);

		expect(sendApiRequest).toHaveBeenCalledWith(
			'/api/worksite',
			expect.objectContaining({
				headers: {
					'content-type': 'application/json',
					[activeWorksiteHeaderName]: 'w1'
				}
			})
		);
	});

	it('is added to a tuple list of headers', async () => {
		stubStorage('w1');
		sendApiRequest.mockResolvedValue(jsonResponse({}));

		await requestVoid(
			'/api/worksite',
			{ method: 'PUT', headers: [['content-type', 'application/json']] },
			() => 'failed'
		);

		expect(sendApiRequest).toHaveBeenCalledWith(
			'/api/worksite',
			expect.objectContaining({
				headers: {
					'content-type': 'application/json',
					[activeWorksiteHeaderName]: 'w1'
				}
			})
		);
	});
});
