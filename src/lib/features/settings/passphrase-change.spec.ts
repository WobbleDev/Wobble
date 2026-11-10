import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/client/api-error.ts';
import { createPassphraseChange } from './passphrase-change.svelte.ts';

describe('passphrase change', () => {
	it('requires confirmation and clears all three fields before the core call settles', async () => {
		let complete: (path: string) => void = () => {};
		const change = vi.fn(
			(): Promise<string> =>
				new Promise((resolve) => {
					complete = resolve;
				})
		);
		const flow = createPassphraseChange({ change });
		flow.current = 'old';
		flow.next = 'new';
		flow.confirm = 'different';
		await flow.submit();
		expect(flow.error).toBe('confirm');
		expect(change).not.toHaveBeenCalled();
		flow.current = '  old á  ';
		flow.next = '  new á  ';
		flow.confirm = '  new á  ';
		const pending = flow.submit();
		expect([flow.current, flow.next, flow.confirm]).toEqual(['', '', '']);
		expect(flow.busy).toBe(true);
		expect(change).toHaveBeenCalledWith('  old á  ', '  new á  ', '  new á  ');
		await flow.submit();
		expect(change).toHaveBeenCalledTimes(1);
		complete('/owned/old-key-recovery.sqlite');
		await pending;
		expect(flow.receipt).toBe('/owned/old-key-recovery.sqlite');
	});
	it('keeps a wrong-current refusal distinct from an operation recovery receipt', async () => {
		const change = vi.fn(async () => {
			throw new ApiError(401, 'Do not display the submitted credential', 'boot_wrong_key');
		});
		const flow = createPassphraseChange({ change });
		flow.current = 'wrong';
		flow.next = 'new';
		flow.confirm = 'new';
		await flow.submit();
		expect(flow.error).toBe('wrong');
		expect(flow.receipt).toBe('');
		expect(flow.recoveryCopy).toBe('');
		expect(JSON.stringify(flow)).not.toContain('submitted credential');
	});
	it('shows only a structured retained path after an interrupted operation', async () => {
		const change = vi.fn(async () => {
			throw new ApiError(500, 'Failed', 'database_recovery_required', {
				recoveryPath: '/owned/verified-recovery.sqlite'
			});
		});
		const flow = createPassphraseChange({ change });
		flow.current = 'old';
		flow.next = 'new';
		flow.confirm = 'new';
		await flow.submit();
		expect(flow.error).toBe('failed');
		expect(flow.receipt).toBe('');
		expect(flow.recoveryCopy).toBe('/owned/verified-recovery.sqlite');
	});
});
