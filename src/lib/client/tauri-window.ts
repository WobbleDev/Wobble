/**
 * The desktop window, as the frontend sees it. Every call is a no-op outside the Tauri
 * shell (the dev server, the shim, the Playwright runs), and the Tauri modules are
 * imported lazily so those paths never load them.
 */
import { isTauriTransport } from './transport.ts';

/**
 * Shows the window, which tauri.conf.json starts hidden so the user never sees it blank.
 * Waits two frames, so the themed first paint has landed. The shell shows it anyway after
 * a few seconds if this never runs.
 */
export async function showWindowAfterFirstPaint(): Promise<void> {
	if (!isTauriTransport()) return;
	await new Promise<void>((done) =>
		requestAnimationFrame(() => requestAnimationFrame(() => done()))
	);
	const { getCurrentWindow } = await import('@tauri-apps/api/window');
	await getCurrentWindow().show();
}

/**
 * Calls `onRequest` when the user asks to close the window. The handler is handed a
 * `keepOpen` call; otherwise the window closes as usual. Returns a function that removes
 * the listener.
 */
export function onWindowCloseRequested(onRequest: (keepOpen: () => void) => void): () => void {
	if (!isTauriTransport()) return () => {};
	let unlisten: (() => void) | undefined;
	let removed = false;
	void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
		const off = await getCurrentWindow().onCloseRequested((event) => {
			onRequest(() => event.preventDefault());
		});
		if (removed) off();
		else unlisten = off;
	});
	return () => {
		removed = true;
		unlisten?.();
	};
}

/** Closes the window without asking `onCloseRequested` again. */
export async function destroyWindow(): Promise<void> {
	if (!isTauriTransport()) return;
	const { getCurrentWindow } = await import('@tauri-apps/api/window');
	await getCurrentWindow().destroy();
}

/** Browser stand-in for the native quit request, so e2e can drive the guard. */
const QUIT_REQUESTED_BROWSER_EVENT = 'wobble:quit-requested';
/** Fired in the browser where the desktop shell would exit; e2e listens for it. */
const EXIT_REQUESTED_BROWSER_EVENT = 'wobble:exit-requested';

/**
 * Calls `onRequest` when the user asks to quit the app (Cmd+Q, the app menu, the Dock).
 * The core waits for the page: this acknowledges at once so its fallback timer stands
 * down, and the handler decides, calling `exitApp` to quit and doing nothing to stay.
 * Outside the shell the same handler runs on a window event, which the e2e suite fires.
 * Returns a function that removes the listener.
 */
export function onQuitRequested(onRequest: () => void): () => void {
	if (!isTauriTransport()) {
		const listener = () => onRequest();
		window.addEventListener(QUIT_REQUESTED_BROWSER_EVENT, listener);
		return () => window.removeEventListener(QUIT_REQUESTED_BROWSER_EVENT, listener);
	}
	let unlisten: (() => void) | undefined;
	let removed = false;
	void Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core')]).then(
		async ([{ listen }, { invoke }]) => {
			const off = await listen('quit-requested', () => {
				void invoke('quit_ack');
				onRequest();
			});
			if (removed) off();
			else unlisten = off;
		}
	);
	return () => {
		removed = true;
		unlisten?.();
	};
}

/**
 * Clears the saved window state and returns the window to tauri.conf.json's default size
 * and place. No-op outside the desktop shell.
 */
export async function resetWindow(): Promise<void> {
	if (!isTauriTransport()) return;
	const { invoke } = await import('@tauri-apps/api/core');
	await invoke('reset_window');
}

/** Quits the app (the core exits). In the browser it fires a window event instead. */
export async function exitApp(): Promise<void> {
	if (!isTauriTransport()) {
		window.dispatchEvent(new Event(EXIT_REQUESTED_BROWSER_EVENT));
		return;
	}
	const { invoke } = await import('@tauri-apps/api/core');
	await invoke('exit_app');
}
