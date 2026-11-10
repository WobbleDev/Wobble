import { recoveryPathFromError } from '#lib/client/data-api.ts';
import { ApiError } from '#lib/client/api-error.ts';

export function createPassphraseChange(host: {
	change: (current: string, next: string, confirm: string) => Promise<string>;
}) {
	let current = $state('');
	let next = $state('');
	let confirm = $state('');
	let busy = $state(false);
	let receipt = $state('');
	let recoveryCopy = $state('');
	let error = $state<'required' | 'confirm' | 'wrong' | 'failed' | null>(null);
	return {
		get current() {
			return current;
		},
		set current(value: string) {
			current = value;
		},
		get next() {
			return next;
		},
		set next(value: string) {
			next = value;
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
		get recoveryCopy() {
			return recoveryCopy;
		},
		get receipt() {
			return receipt;
		},
		get error() {
			return error;
		},
		reset() {
			current = '';
			next = '';
			confirm = '';
			receipt = '';
			recoveryCopy = '';
			error = null;
		},
		async submit() {
			if (busy || receipt) return;
			recoveryCopy = '';
			const previous = current;
			const replacement = next;
			const confirmation = confirm;
			current = '';
			next = '';
			confirm = '';
			error = null;
			if (
				!previous.trim() ||
				!replacement.trim() ||
				previous.includes('\0') ||
				replacement.includes('\0')
			) {
				error = 'required';
				return;
			}
			if (replacement !== confirmation) {
				error = 'confirm';
				return;
			}
			busy = true;
			try {
				receipt = await host.change(previous, replacement, confirmation);
			} catch (caught) {
				recoveryCopy = recoveryPathFromError(caught) ?? '';
				error = caught instanceof ApiError && caught.code === 'boot_wrong_key' ? 'wrong' : 'failed';
			} finally {
				busy = false;
			}
		}
	};
}
