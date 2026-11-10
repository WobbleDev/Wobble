import { goto } from '$app/navigation';
import { resolve } from '$app/paths';

type ViewPath = '/overview' | '/workers' | '/mapping';

const viewShortcuts: Record<string, ViewPath> = {
	'1': '/overview',
	'2': '/workers',
	'3': '/mapping'
};

/** The view a digit shortcut opens, if the key is one. */
export function viewForKey(key: string): ViewPath | undefined {
	return Object.hasOwn(viewShortcuts, key) ? viewShortcuts[key] : undefined;
}

/**
 * Whether the held modifiers are exactly the platform's command key: Cmd on a Mac,
 * Ctrl elsewhere, and never both, nor Alt or Shift.
 */
export function hasCommandModifier(
	event: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey'>,
	isMac: boolean
): boolean {
	if (event.altKey || event.shiftKey) return false;
	return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export interface ShortcutContext {
	/** Whether an active Worksite exists. */
	hasWorksite: () => boolean;
	pathname: () => string;
	isConfigurationPage: () => boolean;
	requestNewWorker: () => void;
}

/**
 * The app's few global shortcuts: Cmd on a Mac, Ctrl elsewhere. Nothing fires
 * while a field has focus (the field owns its keys), except Cmd+S, which saves the
 * Configuration draft from inside its own inputs. Navigation goes through the
 * ordinary links' guard, so a dirty draft still asks first.
 *
 * Returns the `keydown` handler for the window.
 */
export function createShortcutHandler(context: ShortcutContext): (event: KeyboardEvent) => void {
	const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

	return function onShortcut(event: KeyboardEvent) {
		if (event.defaultPrevented) return;
		if (!hasCommandModifier(event, isMac)) return;

		const target = event.target instanceof Element ? event.target : null;
		const inField = !!target?.closest('input, textarea, select, [contenteditable]');
		const key = event.key.toLowerCase();
		if (inField && key !== 's') return;
		// A dialog owns the keyboard until it closes.
		if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;

		const view = viewForKey(key);
		if (key === ',') {
			event.preventDefault();
			void goto(resolve('/settings'));
		} else if (view) {
			event.preventDefault();
			void goto(resolve(view));
		} else if (key === 'f') {
			// A stable hook, not a translated accessible name: Cmd/Ctrl+F must keep
			// finding the search field in every interface language.
			const search = document.querySelector<HTMLInputElement>(
				'[data-worker-search], [data-map-worker-search]'
			);
			if (!search) return;
			event.preventDefault();
			search.focus();
			search.select();
		} else if (key === 'n') {
			if (!(context.hasWorksite() && context.pathname() === '/workers')) return;
			event.preventDefault();
			context.requestNewWorker();
		} else if (key === 's') {
			if (!context.isConfigurationPage()) return;
			event.preventDefault();
			document.querySelector<HTMLButtonElement>('button[data-save-all]:not(:disabled)')?.click();
		}
	};
}
