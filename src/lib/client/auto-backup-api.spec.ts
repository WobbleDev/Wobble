import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '#lib/testing/http.ts';
import { getAutoBackup, runAutoBackup, saveAutoBackup } from './auto-backup-api.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

const status = {
	available: true,
	enabled: true,
	frequency: 'daily',
	lastBackupAt: '2026-01-02T03:04:05Z',
	failure: null
};

describe('automatic backup requests', () => {
	it('reads the status', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ autoBackup: status }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(getAutoBackup()).resolves.toEqual(status);
		expect(fetchMock).toHaveBeenCalledWith('/api/auto-backup', { cache: 'no-store' });
	});

	it('puts one change at a time', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ autoBackup: status }));
		vi.stubGlobal('fetch', fetchMock);

		await saveAutoBackup({ frequency: 'weekly' });
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/auto-backup',
			expect.objectContaining({ method: 'PUT', body: JSON.stringify({ frequency: 'weekly' }) })
		);
	});

	it('asks for a due copy by default and for one now with force', async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(() => Promise.resolve(jsonResponse({ autoBackup: status, ran: true })));
		vi.stubGlobal('fetch', fetchMock);

		await runAutoBackup();
		await runAutoBackup(true);
		const bodies = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).body);
		expect(bodies).toEqual([JSON.stringify({ force: false }), JSON.stringify({ force: true })]);
	});

	it('returns a failed copy as data, not as an error', async () => {
		const failure = {
			at: '2026-01-02T03:04:05Z',
			message: 'The automatic backup could not be written.'
		};
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ autoBackup: { ...status, failure }, ran: true }))
		);

		await expect(runAutoBackup()).resolves.toMatchObject({ failure });
	});

	it('rejects a body that is not a status', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ autoBackup: { ...status, frequency: 'hourly' } }))
		);

		await expect(getAutoBackup()).rejects.toThrow('Automatic backup response was invalid.');
	});

	it('throws the server message when the request is refused', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'No.' }, 400)));

		await expect(saveAutoBackup({ enabled: true })).rejects.toThrow('No.');
	});
});
