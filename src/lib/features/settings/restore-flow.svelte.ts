import {
	dataErrorCopy,
	recoveryPathFromError,
	type DataErrorCopy,
	type RestoreCredential
} from '#lib/client/data-api.ts';

export function createRestoreFlow(host: {
	pick: () => Promise<string | null>;
	restore: (path: string, credential: RestoreCredential) => Promise<string>;
	done: () => void;
	failure: () => string;
	required: () => string;
}) {
	let path = $state('');
	let passphrase = $state('');
	let legacy = $state(false);
	let busy = $state(false);
	let error = $state<DataErrorCopy | null>(null);
	let safetyCopy = $state('');
	let recoveryCopy = $state('');
	function reset() {
		path = '';
		passphrase = '';
		legacy = false;
		error = null;
		safetyCopy = '';
		recoveryCopy = '';
	}
	return {
		get path() {
			return path;
		},
		get busy() {
			return busy;
		},
		get error() {
			return error;
		},
		get recoveryCopy() {
			return recoveryCopy;
		},
		get safetyCopy() {
			return safetyCopy;
		},
		get passphrase() {
			return passphrase;
		},
		set passphrase(value: string) {
			passphrase = value;
		},
		get legacy() {
			return legacy;
		},
		set legacy(value: boolean) {
			legacy = value;
			passphrase = '';
			error = null;
		},
		reset,
		async pick() {
			if (busy) return;
			busy = true;
			error = null;
			try {
				const chosen = await host.pick();
				if (chosen !== null) {
					reset();
					path = chosen;
				}
			} catch (caught) {
				error = dataErrorCopy(caught, host.failure());
				recoveryCopy = recoveryPathFromError(caught) ?? '';
			} finally {
				busy = false;
			}
		},
		async submit() {
			if (busy || !path || safetyCopy) return;
			recoveryCopy = '';
			const submitted = passphrase;
			passphrase = '';
			error = null;
			if (!legacy && (!submitted.trim() || submitted.includes('\0'))) {
				error = { message: host.required(), detail: '' };
				return;
			}
			busy = true;
			try {
				safetyCopy = await host.restore(
					path,
					legacy ? { kind: 'legacy' } : { kind: 'encrypted', sourcePassphrase: submitted }
				);
				host.done();
			} catch (caught) {
				error = dataErrorCopy(caught, host.failure());
				recoveryCopy = recoveryPathFromError(caught) ?? '';
			} finally {
				busy = false;
			}
		}
	};
}
