import { m } from '#lib/paraglide/messages.js';
import { copyText } from './copy-text.ts';

/* Copy reports success only after the clipboard write resolved; a refused copy says so. */
export class CopyFeedback {
	copied = $state(false);
	error = $state('');

	async copy(text: string): Promise<void> {
		this.error = '';
		try {
			await copyText(text);
			this.copied = true;
			setTimeout(() => (this.copied = false), 1600);
		} catch {
			this.error = m.settings_copy_failed();
		}
	}
}
