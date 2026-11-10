import { m } from '#lib/paraglide/messages.js';
import { ApiError } from './api-error.ts';
import { decodeDataFile, decodeSafetyCopyPath, isRecord, type DataFileInfo } from './api-decode.ts';
import { jsonInit, requestJson } from './request-json.ts';

/** What Settings shows for a data-control failure: the UI copy and the core's detail. */
export type DataErrorCopy = { message: string; detail: string };

/** Only structured core metadata can produce an error receipt; never parse a path from prose. */
export function recoveryPathFromError(error: unknown): string | null {
	const details = error instanceof ApiError ? error.details : null;
	return isRecord(details) &&
		typeof details.recoveryPath === 'string' &&
		details.recoveryPath.trim().length > 0
		? details.recoveryPath
		: null;
}

/**
 * The copy Settings owns for each data-control code (ADR-0024). Each entry reads the
 * catalog when it is shown, never at module load, so the applied locale decides the text.
 */
const DATA_ERROR_COPY: Record<string, () => string> = {
	restore_source_credential_required: m.settings_restore_source_required,
	restore_legacy_required: m.settings_restore_error_legacy,
	restore_same_file: m.settings_data_error_restore_current_file,
	boot_wrong_key: m.settings_restore_error_key,
	database_recovery_required: m.settings_recovery_required,
	data_file_no_path: m.settings_data_error_no_path,
	restore_path_required: m.settings_data_error_restore_path_required,
	restore_unreadable: m.settings_data_error_restore_unreadable,
	restore_not_a_file: m.settings_data_error_restore_not_a_file,
	restore_current_file: m.settings_data_error_restore_current_file,
	restore_not_sqlite: m.settings_data_error_restore_not_sqlite,
	restore_integrity: m.settings_data_error_restore_integrity,
	restore_not_wobble: m.settings_data_error_restore_not_wobble,
	restore_unsupported_schema: m.settings_data_error_restore_unsupported_schema,
	restore_failed: m.settings_data_error_restore_failed,
	erase_confirmation_required: m.settings_data_error_erase_confirmation_required,
	erase_failed: m.settings_data_error_erase_failed
};

/** The message an error carries, whether it is an Error, a Tauri command's string, or neither. */
function errorDetail(error: unknown): string | undefined {
	if (typeof error === 'string' && error.length > 0) return error;
	if (error instanceof Error && error.message.length > 0) return error.message;
	return undefined;
}

/**
 * Maps a data-control failure to the copy Settings shows (ADR-0024).
 *
 * The code alone picks the copy; a Tauri command rejection or a transport failure has none,
 * so the operation's own fallback is shown. The core's message is always the detail behind
 * Show details, never the visible copy.
 */
export function dataErrorCopy(error: unknown, fallback: string): DataErrorCopy {
	const code = error instanceof ApiError ? error.code : undefined;

	return {
		message: (code ? DATA_ERROR_COPY[code]?.() : undefined) ?? fallback,
		detail: errorDetail(error) ?? fallback
	};
}

/**
 * Reads this installation's live database file: its path, main-file size, and latest
 * main-or-WAL write. The core owns the answer; the browser never guesses it.
 */
export function getDataFile(): Promise<DataFileInfo> {
	return requestJson(
		'/api/data-file',
		{},
		(status) => m.settings_data_error_http_path({ status }),
		decodeDataFile
	);
}

/**
 * Asks the operating system, through the desktop shell's open dialog, which backup to
 * restore. Resolves to the chosen path, or `null` when the person cancels. The plugin is
 * imported here, not at module load, so the web bundle never loads it.
 */
export async function pickRestorePath(): Promise<string | null> {
	const { open } = await import('@tauri-apps/plugin-dialog');
	const chosen = await open({
		multiple: false,
		directory: false,
		title: m.native_restore_open_title(),
		filters: [{ name: m.native_database_filter(), extensions: ['sqlite', 'db', 'backup'] }]
	});

	return typeof chosen === 'string' ? chosen : null;
}

/**
 * Asks the core to swap the chosen backup in (C05). The reply names the safety copy the
 * core wrote beside the database before it swapped, so the dialog can show where it is.
 */
export type RestoreCredential =
	{ kind: 'encrypted'; sourcePassphrase: string } | { kind: 'legacy' };

export function restoreBackup(path: string, credential: RestoreCredential): Promise<string> {
	return requestJson(
		'/api/restore',
		jsonInit('POST', {
			path,
			...(credential.kind === 'legacy'
				? { legacy: true }
				: { sourcePassphrase: credential.sourcePassphrase })
		}),
		(status) => m.settings_data_error_http_restore({ status }),
		decodeSafetyCopyPath
	);
}

/**
 * Asks the core to erase every Worksite (C05). It writes the safety copy first and keeps
 * the schema and the settings; the reply names the copy.
 */
export function eraseAllData(): Promise<string> {
	return requestJson(
		'/api/erase',
		jsonInit('POST', { confirm: 'erase' }),
		(status) => m.settings_data_error_http_erase({ status }),
		decodeSafetyCopyPath
	);
}

/**
 * Reveals the database file in the desktop shell's file manager.
 *
 * The shell's `reveal_data_file` command runs the platform's own reveal (Finder, Explorer,
 * or the desktop's file manager), so the web bundle never touches a filesystem path.
 */
export async function revealDataFile(path: string): Promise<void> {
	const { invoke } = await import('@tauri-apps/api/core');
	await invoke('reveal_data_file', { path });
}
