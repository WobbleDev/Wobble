import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '#lib/testing/http.ts';
import { ApiError } from './api-error.ts';
import { dataErrorCopy, eraseAllData, getDataFile, restoreBackup } from './data-api.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('dataErrorCopy', () => {
	const codes = [
		'data_file_no_path',
		'restore_path_required',
		'restore_unreadable',
		'restore_not_a_file',
		'restore_current_file',
		'restore_not_sqlite',
		'restore_integrity',
		'restore_not_wobble',
		'restore_unsupported_schema',
		'restore_failed',
		'erase_confirmation_required',
		'erase_failed'
	];

	it('gives every data-control code its own copy and keeps the core message as the detail', () => {
		const fallback = 'The operation failed.';
		const messages = codes.map((code) => {
			const copy = dataErrorCopy(new ApiError(400, `core: ${code}`, code), fallback);

			expect(copy.message, code).not.toBe(fallback);
			expect(copy.message.length, code).toBeGreaterThan(0);
			expect(copy.detail, code).toBe(`core: ${code}`);
			return copy.message;
		});

		expect(new Set(messages).size).toBe(codes.length);
	});

	it("falls back to the operation's copy for a code the UI does not know", () => {
		expect(
			dataErrorCopy(new ApiError(500, 'SQLite said no.', 'some_future_code'), 'Could not restore.')
		).toEqual({ message: 'Could not restore.', detail: 'SQLite said no.' });
	});

	it('handles a Tauri command rejection, which is a string with no code', () => {
		expect(dataErrorCopy('workers.sqlite is not a file.', 'Could not show the file.')).toEqual({
			message: 'Could not show the file.',
			detail: 'workers.sqlite is not a file.'
		});
	});

	it('falls back to the operation copy for a detail when the error carries no message', () => {
		expect(dataErrorCopy(new Error(''), 'Could not read the database path.')).toEqual({
			message: 'Could not read the database path.',
			detail: 'Could not read the database path.'
		});
	});
});

describe('reading the database file', () => {
	it('gets the path, size and latest write the core reports', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				path: '/tmp/wobble/workers.sqlite',
				sizeBytes: 4096,
				modifiedAt: '2026-10-21T20:00:00.000Z'
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(getDataFile()).resolves.toEqual({
			path: '/tmp/wobble/workers.sqlite',
			sizeBytes: 4096,
			modifiedAt: '2026-10-21T20:00:00.000Z'
		});
		expect(fetchMock).toHaveBeenCalledWith('/api/data-file', expect.objectContaining({}));
	});

	it('keeps an unreadable size or write time null instead of inventing one', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ path: '/tmp/wobble/workers.sqlite', sizeBytes: null, modifiedAt: null })
				)
		);

		await expect(getDataFile()).resolves.toEqual({
			path: '/tmp/wobble/workers.sqlite',
			sizeBytes: null,
			modifiedAt: null
		});
	});

	it('surfaces the server message when the path cannot be read', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ message: 'The database has no file path.' }, 400))
		);

		await expect(getDataFile()).rejects.toThrow('The database has no file path.');
	});
});

describe('restoring a backup', () => {
	it('posts the chosen path and returns the safety copy', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ safetyCopyPath: '/tmp/workers.pre-restore-1.sqlite' }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			restoreBackup('/tmp/backup.sqlite', {
				kind: 'encrypted',
				sourcePassphrase: 'backup credential'
			})
		).resolves.toBe('/tmp/workers.pre-restore-1.sqlite');
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/restore',
			expect.objectContaining({
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: '/tmp/backup.sqlite', sourcePassphrase: 'backup credential' })
			})
		);
	});

	it('requires explicit legacy restore without sending a source credential', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ safetyCopyPath: '/tmp/pre-restore.sqlite' }));
		vi.stubGlobal('fetch', fetchMock);
		await restoreBackup('/tmp/legacy.sqlite', { kind: 'legacy' });
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/restore',
			expect.objectContaining({
				body: JSON.stringify({ path: '/tmp/legacy.sqlite', legacy: true })
			})
		);
	});

	it('surfaces the server message when the backup is refused', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ message: 'The chosen file is not a file.' }, 400))
		);

		await expect(
			restoreBackup('/tmp/backup.sqlite', {
				kind: 'encrypted',
				sourcePassphrase: 'backup credential'
			})
		).rejects.toThrow('The chosen file is not a file.');
	});

	it('refuses a reply without the safety copy', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})));

		await expect(
			restoreBackup('/tmp/backup.sqlite', {
				kind: 'encrypted',
				sourcePassphrase: 'backup credential'
			})
		).rejects.toThrow('Server returned an invalid safety copy path.');
	});
});

describe('erasing all data', () => {
	it('posts the typed confirmation and returns the safety copy', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ safetyCopyPath: '/tmp/workers.pre-erase-1.sqlite' }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(eraseAllData()).resolves.toBe('/tmp/workers.pre-erase-1.sqlite');
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/erase',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ confirm: 'erase' })
			})
		);
	});

	it('surfaces the server message when the confirmation is refused', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ message: 'Type erase to confirm.' }, 400))
		);

		await expect(eraseAllData()).rejects.toThrow('Type erase to confirm.');
	});
});
