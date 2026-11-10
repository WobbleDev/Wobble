import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAppSettings } from '#lib/shared/app-settings.ts';
import { jsonResponse } from '#lib/testing/http.ts';
import { getAppSettings, resetAppSettings, saveAppSettings } from './settings-api.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('reading settings', () => {
	it('fetches without caching and returns every registered setting', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ settings: { ...defaultAppSettings, theme: 'dark' } }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(getAppSettings()).resolves.toEqual({ ...defaultAppSettings, theme: 'dark' });
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/settings',
			expect.objectContaining({ cache: 'no-store' })
		);
	});

	it('rejects a body that is not valid settings', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ settings: { theme: 'sepia' } }))
		);

		await expect(getAppSettings()).rejects.toThrow('Settings response was invalid.');
	});

	it('surfaces the fallback message when the read fails without a body', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));

		await expect(getAppSettings()).rejects.toThrow('Settings poll failed with status 503.');
	});
});

describe('saving settings', () => {
	it('puts the update without caching and returns the saved settings', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ settings: { ...defaultAppSettings, theme: 'light' } }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(saveAppSettings({ theme: 'light' })).resolves.toEqual({
			...defaultAppSettings,
			theme: 'light'
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/settings',
			expect.objectContaining({ method: 'PUT', cache: 'no-store' })
		);
	});

	it('surfaces the server message when the save fails', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'Nope.' }, 400)));

		await expect(saveAppSettings({ theme: 'light' })).rejects.toThrow('Nope.');
	});
});

describe('resetting settings', () => {
	it('deletes without caching and returns the fresh defaults', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ settings: defaultAppSettings }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(resetAppSettings()).resolves.toEqual(defaultAppSettings);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/settings',
			expect.objectContaining({ method: 'DELETE', cache: 'no-store' })
		);
	});

	it('surfaces the fallback message when the reset fails without a body', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));

		await expect(resetAppSettings()).rejects.toThrow('Settings reset failed with status 503.');
	});
});
