import { recoveryPathFromError } from '#lib/client/data-api.ts';
import { ApiError } from '#lib/client/api-error.ts';
import type { BootStatus } from '#lib/client/boot-api.ts';

export type BootFailure = 'required' | 'confirm' | 'wrong' | 'recovery' | 'failed';

export function createBootForm(
	initial: BootStatus,
	host: {
		create: (passphrase: string, confirm: string) => Promise<BootStatus>;
		unlock: (passphrase: string, confirm?: string) => Promise<BootStatus>;
		refresh: () => Promise<BootStatus>;
		opened: () => Promise<void>;
	}
) {
	let status = $state(initial);
	let passphrase = $state('');
	let confirm = $state('');
	let busy = $state(false);
	let failure = $state<BootFailure | null>(null);
	let recoveryPath = $state('');
	return {
		get recoveryPath() {
			return recoveryPath;
		},
		async continueOpen() {
			if (busy || status.state !== 'open') return;
			busy = true;
			failure = null;
			try {
				await host.opened();
			} catch {
				failure = 'failed';
			} finally {
				busy = false;
			}
		},
		get status() {
			return status;
		},
		sync(next: BootStatus) {
			status = next;
		},
		get passphrase() {
			return passphrase;
		},
		set passphrase(value: string) {
			passphrase = value;
		},
		get confirm() {
			return confirm;
		},
		set confirm(value: string) {
			confirm = value;
		},
		get busy() {
			return busy;
		},
		get failure() {
			return failure;
		},
		async submit() {
			if (busy || status.state !== 'locked') return;
			const submitted = passphrase;
			const confirmation = confirm;
			passphrase = '';
			confirm = '';
			failure = null;
			recoveryPath = '';
			if (!submitted.trim() || submitted.includes('\0')) {
				failure = 'required';
				return;
			}
			const newCredential = status.firstRun || status.legacyPlaintext;
			if (newCredential && submitted !== confirmation) {
				failure = 'confirm';
				return;
			}
			busy = true;
			try {
				status = status.firstRun
					? await host.create(submitted, confirmation)
					: await host.unlock(submitted, newCredential ? confirmation : undefined);
				if (status.state === 'open' && status.conversion === undefined) await host.opened();
				else if (status.state === 'open') recoveryPath = status.conversion?.recoveryPath ?? '';
				else failure = 'recovery';
			} catch (error) {
				recoveryPath = recoveryPathFromError(error) ?? '';
				failure =
					error instanceof ApiError && error.code === 'boot_wrong_key'
						? 'wrong'
						: error instanceof ApiError && error.code === 'database_recovery_required'
							? 'recovery'
							: 'failed';
				try {
					status = await host.refresh();
				} catch {
					/* Keep the last validated boot state. */
				}
			} finally {
				busy = false;
			}
		}
	};
}
