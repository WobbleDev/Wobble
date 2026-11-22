import { isRecord } from './api-decode.ts';
import { requestJson } from './request-json.ts';

/** The newest lines of the diagnostics log, oldest first. `available` is false when the app keeps no log. */
export type RecentLogs = { available: boolean; lines: string[] };

function decodeLogs(value: unknown): RecentLogs {
	if (
		!isRecord(value) ||
		typeof value.available !== 'boolean' ||
		!Array.isArray(value.lines) ||
		!value.lines.every((line) => typeof line === 'string')
	) {
		throw new Error('Log response was invalid.');
	}

	return { available: value.available, lines: value.lines };
}

/**
 * Reads the newest log lines from the core. The log holds events, routes, statuses, error
 * codes and ids only, so what comes back is safe to paste into a bug report.
 */
export function getRecentLogs(lines = 200): Promise<RecentLogs> {
	return requestJson(
		`/api/logs?lines=${lines}`,
		{ cache: 'no-store' },
		(status) => `Log read failed with status ${status}.`,
		decodeLogs
	);
}

/**
 * Shows the log folder in the platform's file manager. The shell knows where it is, so no
 * path crosses from the page.
 */
export async function revealLogFolder(): Promise<void> {
	const { invoke } = await import('@tauri-apps/api/core');
	await invoke('reveal_log_folder');
}
