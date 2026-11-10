import type { ApiRecording } from './replay.ts';

/** The transport the client sends API calls over. */
export type ApiTransport = 'http' | 'tauri' | 'replay';

let transport: ApiTransport = 'http';
let replayReady: Promise<void> | undefined;
let replayHandler: ((path: string, init: RequestInit) => Response) | undefined;

/**
 * Chooses the transport for this session. With an argument it sets the transport directly
 * (the specs use this seam). Without one it switches to the Tauri transport when the webview
 * provides its internals, so the same build talks to `handle()` over IPC inside the shell and
 * over `fetch` everywhere else (the dev server, the shim, the Playwright runs).
 */
export function initApiTransport(next?: ApiTransport, recordings?: readonly ApiRecording[]): void {
	if (next === 'replay') {
		// Loaded lazily like the Tauri branch, so the shipped bundle does not carry the matcher.
		const loaded = import('./replay.ts');
		transport = 'replay';
		replayHandler = undefined;
		replayReady = loaded.then(({ createReplay }) => {
			replayHandler = createReplay(recordings ?? []);
		});
	} else if (next !== undefined) {
		transport = next;
	} else if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
		transport = 'tauri';
	}
}

/**
 * Whether this session is inside the desktop shell. The shell is the only place that can
 * ask the operating system for a file path, so the controls that need one ask this first.
 */
export function isTauriTransport(): boolean {
	return transport === 'tauri';
}

/**
 * Sends one request over the active transport and returns a `Response`, so the callers
 * above stay transport-agnostic. Under Tauri the shell's `api_request` command runs the
 * request through the Rust core and replies with the same status, headers and JSON body
 * the HTTP routes answer.
 */
export async function sendApiRequest(path: string, init: RequestInit): Promise<Response> {
	if (transport === 'replay') {
		await replayReady;
		return replayHandler!(path, init);
	}

	if (transport === 'tauri') {
		// Imported lazily, so the `http` path (the shim and the Playwright runs) never
		// loads Tauri code.
		const { invoke } = await import('@tauri-apps/api/core');
		const [barePath, query = ''] = path.split('?');
		const headers = [...new Headers(init.headers)];

		// Only the five fields the command takes: fetch-only options (`cache`,
		// `credentials`, …) mean nothing over IPC.
		const reply = await invoke<{ status: number; headers: [string, string][]; body: unknown }>(
			'api_request',
			{
				method: init.method ?? 'GET',
				path: barePath,
				query,
				headers,
				body: typeof init.body === 'string' ? init.body : null
			}
		);

		return new Response(JSON.stringify(reply.body), {
			status: reply.status,
			headers: reply.headers
		});
	}

	return fetch(path, init);
}
