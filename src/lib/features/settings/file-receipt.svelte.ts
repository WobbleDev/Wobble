import { dataErrorCopy, revealDataFile, type DataErrorCopy } from '#lib/client/data-api.ts';
import { m } from '#lib/paraglide/messages.js';
import { CopyFeedback } from './copy-feedback.svelte.ts';

export function createFileReceipt(path: () => string) {
	const copy = new CopyFeedback();
	let revealing = $state(false);
	let error = $state<DataErrorCopy | null>(null);
	return {
		copy,
		get revealing() {
			return revealing;
		},
		get error() {
			return error;
		},
		async reveal() {
			revealing = true;
			error = null;
			try {
				await revealDataFile(path());
			} catch (cause) {
				error = dataErrorCopy(cause, m.settings_data_error_show_file());
			} finally {
				revealing = false;
			}
		}
	};
}
