import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '#lib/testing/http.ts';
import { exportBackup } from './backup-api.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('exporting a backup', () => {
	it('posts the chosen path as JSON', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
		vi.stubGlobal('fetch', fetchMock);

		await expect(exportBackup('/tmp/wobble-backup.sqlite')).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/backup',
			expect.objectContaining({
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: '/tmp/wobble-backup.sqlite' })
			})
		);
	});

	it('surfaces the server message when the copy is refused', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ message: 'A backup path is required.' }, 400))
		);

		await expect(exportBackup('')).rejects.toThrow('A backup path is required.');
	});

	it('surfaces the fallback message when the copy fails without a body', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));

		await expect(exportBackup('/tmp/wobble-backup.sqlite')).rejects.toThrow(
			'Backup failed with status 500.'
		);
	});
});
