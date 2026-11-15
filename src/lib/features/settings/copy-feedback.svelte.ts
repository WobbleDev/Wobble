import { m } from '#lib/paraglide/messages.js';
import { copyText } from './copy-text.ts';

/* Copy reports success only after the clipboard write resolved; a refused copy says so. */
export class CopyFeedback {
	copied = $state(false);
	error = $state('');
	private timer: ReturnType<typeof setTimeout> | undefined;

	/** Clears the pending "Copied" reset; call it when the owning component unmounts. */
	dispose(): void {
		clearTimeout(this.timer);
	}

	async copy(text: string): Promise<void> {
		this.error = '';
		try {
			await copyText(text);
			this.copied = true;
			// A second click restarts the 1.6 s window instead of ending it early.
			clearTimeout(this.timer);
			this.timer = setTimeout(() => (this.copied = false), 1600);
		} catch {
			this.error = m.settings_copy_failed();
		}
	}
}
