import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/client/api-error.ts';
import type { BootStatus } from '#lib/client/boot-api.ts';
import { createBootForm } from './boot-form.svelte.ts';

const locked: BootStatus = {
	state: 'locked',
	firstRun: false,
	legacyPlaintext: false,
	markerPending: false
};
const open: BootStatus = { state: 'open', encrypted: true };
function host() {
	return {
		create: vi.fn(async (): Promise<BootStatus> => open),
		unlock: vi.fn(async (): Promise<BootStatus> => open),
		refresh: vi.fn(async (): Promise<BootStatus> => locked),
		opened: vi.fn(async () => {})
	};
}

describe('boot credential submission', () => {
	it('clears both inputs before awaiting IPC and preserves accepted characters exactly', async () => {
		const events = host();
		let finish: (status: BootStatus) => void = () => {};
		events.unlock.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const form = createBootForm(locked, events);
		form.passphrase = "  exact á ' credential  ";
		form.confirm = 'temporary confirmation';
		const submission = form.submit();
		expect(form.passphrase).toBe('');
		expect(form.confirm).toBe('');
		expect(form.busy).toBe(true);
		expect(events.unlock).toHaveBeenCalledWith("  exact á ' credential  ", undefined);
		await form.submit();
		expect(events.unlock).toHaveBeenCalledTimes(1);
		finish(open);
		await submission;
		expect(events.opened).toHaveBeenCalledTimes(1);
		expect(form.busy).toBe(false);
	});
	it.each(['', '   ', '\0'])('rejects invalid credentials before sending: %j', async (value) => {
		const events = host();
		const form = createBootForm(locked, events);
		form.passphrase = value;
		await form.submit();
		expect(form.failure).toBe('required');
		expect(events.unlock).not.toHaveBeenCalled();
	});
	it('requires exact new-credential confirmation and uses create only for first run', async () => {
		const events = host();
		const form = createBootForm({ ...locked, state: 'locked', firstRun: true }, events);
		form.passphrase = 'new';
		form.confirm = 'different';
		await form.submit();
		expect(form.failure).toBe('confirm');
		expect(events.create).not.toHaveBeenCalled();
		form.passphrase = 'new';
		form.confirm = 'new';
		await form.submit();
		expect(events.create).toHaveBeenCalledWith('new', 'new');
	});
	it('confirms legacy conversion through unlock and does not create a new installation', async () => {
		const events = host();
		const form = createBootForm({ ...locked, state: 'locked', legacyPlaintext: true }, events);
		form.passphrase = 'convert';
		form.confirm = 'convert';
		await form.submit();
		expect(events.unlock).toHaveBeenCalledWith('convert', 'convert');
		expect(events.create).not.toHaveBeenCalled();
	});
	it('shows a coded refusal without retaining the server diagnostic or submitted secret', async () => {
		const events = host();
		events.unlock.mockRejectedValue(new ApiError(401, 'private diagnostic', 'boot_wrong_key'));
		const form = createBootForm(locked, events);
		form.passphrase = 'private credential';
		await form.submit();
		expect(form.failure).toBe('wrong');
		expect(form.passphrase).toBe('');
		expect(JSON.stringify(form)).not.toContain('private');
		expect(events.opened).not.toHaveBeenCalled();
	});
	it('keeps confirmed open state when the subsequent dataset load fails', async () => {
		const events = host();
		events.opened.mockRejectedValue(new Error('Dataset unavailable'));
		events.refresh.mockResolvedValue(open);
		const form = createBootForm(locked, events);
		form.passphrase = 'accepted';
		await form.submit();
		expect(form.status).toEqual(open);
		expect(form.failure).toBe('failed');
		expect(form.passphrase).toBe('');
	});
	it('keeps the verified conversion receipt until Continue before loading datasets', async () => {
		const events = host();
		const conversion = {
			databasePath: '/owned/live.sqlite',
			recoveryPath: '/owned/recovery.sqlite'
		};
		events.unlock.mockResolvedValue({ state: 'open', encrypted: true, conversion });
		const form = createBootForm({ ...locked, state: 'locked', legacyPlaintext: true }, events);
		form.passphrase = 'convert';
		form.confirm = 'convert';
		await form.submit();
		expect(form.status).toEqual({ state: 'open', encrypted: true, conversion });
		expect(events.opened).not.toHaveBeenCalled();
		expect(form.recoveryPath).toBe(conversion.recoveryPath);
		await form.continueOpen();
		expect(events.opened).toHaveBeenCalledTimes(1);
	});
});
