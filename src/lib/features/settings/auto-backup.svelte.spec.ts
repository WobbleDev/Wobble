import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoBackupStatus } from '#lib/client/auto-backup-api.ts';
import { AUTO_BACKUP_CHECK_MS, createAutoBackup } from './auto-backup.svelte.ts';

const api = vi.hoisted(() => ({
	getAutoBackup: vi.fn(),
	runAutoBackup: vi.fn(),
	saveAutoBackup: vi.fn()
}));
vi.mock('#lib/client/auto-backup-api.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/client/auto-backup-api.ts')>()),
	...api
}));

const off: AutoBackupStatus = {
	available: true,
	enabled: false,
	frequency: 'daily',
	lastBackupAt: null,
	failure: null
};
const on: AutoBackupStatus = { ...off, enabled: true };

beforeEach(() => {
	vi.useFakeTimers();
	for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('the automatic backup keeper', () => {
	it('checks on start and every half hour until stopped, asking for a copy while it is on', async () => {
		api.getAutoBackup.mockResolvedValue(on);
		api.runAutoBackup.mockResolvedValue(on);
		const backup = createAutoBackup();
		const stop = backup.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(api.runAutoBackup).toHaveBeenCalledTimes(1);
		expect(api.runAutoBackup).toHaveBeenLastCalledWith(false);
		expect(backup.status).toEqual(on);

		await vi.advanceTimersByTimeAsync(AUTO_BACKUP_CHECK_MS);
		expect(api.runAutoBackup).toHaveBeenCalledTimes(2);

		stop();
		await vi.advanceTimersByTimeAsync(AUTO_BACKUP_CHECK_MS * 2);
		expect(api.runAutoBackup).toHaveBeenCalledTimes(2);
	});

	it('keeps a failed copy in the status and does not raise a request error for it', async () => {
		const failure = {
			at: '2026-01-02T03:04:05Z',
			message: 'The automatic backup could not be written.'
		};
		api.getAutoBackup.mockResolvedValue(on);
		api.runAutoBackup.mockResolvedValue({ ...on, failure });
		const backup = createAutoBackup();
		backup.start()();
		await vi.advanceTimersByTimeAsync(0);
		expect(backup.status?.failure).toEqual(failure);
		expect(backup.error).toBe('');
	});

	it('sends nothing but a read while it is off', async () => {
		api.getAutoBackup.mockResolvedValue(off);
		const backup = createAutoBackup();
		const stop = backup.start();
		await vi.advanceTimersByTimeAsync(AUTO_BACKUP_CHECK_MS);
		stop();
		expect(api.getAutoBackup).toHaveBeenCalledTimes(2);
		expect(api.runAutoBackup).not.toHaveBeenCalled();
		expect(backup.status).toEqual(off);
	});

	it('stays quiet when a background check cannot reach the core', async () => {
		api.getAutoBackup.mockRejectedValue(new Error('offline'));
		const backup = createAutoBackup();
		backup.start()();
		await vi.advanceTimersByTimeAsync(0);
		expect(backup.error).toBe('');
		expect(backup.status).toBeNull();
	});

	it('turning it on saves, then writes the first copy at once', async () => {
		api.saveAutoBackup.mockResolvedValue(on);
		api.runAutoBackup.mockResolvedValue({ ...on, lastBackupAt: '2026-01-02T03:04:05Z' });
		const backup = createAutoBackup();
		await backup.change({ enabled: true });
		expect(api.saveAutoBackup).toHaveBeenCalledWith({ enabled: true });
		expect(api.runAutoBackup).toHaveBeenCalledWith(false);
		expect(backup.status?.lastBackupAt).toBe('2026-01-02T03:04:05Z');
	});

	it('turning it off saves and does not run a copy', async () => {
		api.saveAutoBackup.mockResolvedValue(off);
		const backup = createAutoBackup();
		await backup.change({ enabled: false });
		expect(api.runAutoBackup).not.toHaveBeenCalled();
		expect(backup.status).toEqual(off);
	});

	it('Back up now forces a copy, and a refused change says so', async () => {
		api.runAutoBackup.mockResolvedValue(on);
		const backup = createAutoBackup();
		await backup.backUpNow();
		expect(api.runAutoBackup).toHaveBeenCalledWith(true);

		api.saveAutoBackup.mockRejectedValue(new Error('refused'));
		await backup.change({ frequency: 'weekly' });
		expect(backup.error).not.toBe('');
		expect(backup.busy).toBe(false);
	});
});
