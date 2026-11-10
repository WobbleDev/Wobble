import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/client/api-error.ts';
import { createRestoreFlow } from './restore-flow.svelte.ts';

function host() {
	return {
		pick: vi.fn(async (): Promise<string | null> => '/owned/backup.sqlite'),
		restore: vi.fn(async () => '/owned/recovery.sqlite'),
		done: vi.fn(),
		failure: () => 'Restore failed',
		required: () => 'Backup credential required'
	};
}

describe('restore review', () => {
	it('requires explicit review after choosing a file and sends the exact source credential', async () => {
		const events = host();
		const flow = createRestoreFlow(events);
		await flow.pick();
		expect(events.restore).not.toHaveBeenCalled();
		flow.passphrase = '  exact source á  ';
		await flow.submit();
		expect(events.restore).toHaveBeenCalledWith('/owned/backup.sqlite', {
			kind: 'encrypted',
			sourcePassphrase: '  exact source á  '
		});
		expect(flow.passphrase).toBe('');
		expect(flow.safetyCopy).toBe('/owned/recovery.sqlite');
		expect(events.done).toHaveBeenCalledTimes(1);
	});
	it('clears a stale credential when explicitly switching to legacy restore', async () => {
		const events = host();
		const flow = createRestoreFlow(events);
		await flow.pick();
		flow.passphrase = 'must not travel';
		flow.legacy = true;
		expect(flow.passphrase).toBe('');
		await flow.submit();
		expect(events.restore).toHaveBeenCalledWith('/owned/backup.sqlite', { kind: 'legacy' });
	});
	it('rejects missing credentials without a write and clears fields before awaiting restore', async () => {
		const events = host();
		const flow = createRestoreFlow(events);
		await flow.pick();
		await flow.submit();
		expect(events.restore).not.toHaveBeenCalled();
		expect(flow.error?.message).toBe('Backup credential required');
		let complete: (path: string) => void = () => {};
		events.restore.mockImplementation(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				})
		);
		flow.passphrase = 'source';
		const pending = flow.submit();
		expect(flow.passphrase).toBe('');
		expect(flow.busy).toBe(true);
		await flow.submit();
		expect(events.restore).toHaveBeenCalledTimes(1);
		complete('/owned/recovery.sqlite');
		await pending;
	});
	it('separates a failed-operation recovery receipt from successful restoration', async () => {
		const events = host();
		events.restore.mockRejectedValue(
			new ApiError(500, 'Restore failed', 'restore_failed', {
				recoveryPath: '/owned/verified-recovery.sqlite'
			})
		);
		const flow = createRestoreFlow(events);
		await flow.pick();
		flow.passphrase = 'source';
		await flow.submit();
		expect(flow.safetyCopy).toBe('');
		expect(flow.recoveryCopy).toBe('/owned/verified-recovery.sqlite');
		expect(flow.error).not.toBeNull();
		expect(events.done).not.toHaveBeenCalled();
	});
});
