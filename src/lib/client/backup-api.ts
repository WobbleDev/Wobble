import { m } from '#lib/paraglide/messages.js';
import { jsonInit, requestVoid } from './request-json.ts';

/**
 * Asks the operating system, through the desktop shell's save dialog, where to write a backup.
 *
 * Resolves to the chosen path, or `null` when the person cancels. The plugin is imported here,
 * not at module load, so the web bundle never loads it.
 */
export async function pickBackupPath(): Promise<string | null> {
	const { save } = await import('@tauri-apps/plugin-dialog');
	return save({
		defaultPath: 'wobble-backup.sqlite',
		title: m.native_backup_save_title(),
		filters: [{ name: m.native_database_filter(), extensions: ['sqlite', 'db'] }]
	});
}

/**
 * Asks the app to write a copy of its database to `path` (F01's Export backup).
 *
 * The copy is made by SQLite's backup API against the open connection, so the original
 * stays open and untouched; a path the process cannot write throws the server's message.
 */
export function exportBackup(path: string): Promise<void> {
	return requestVoid(
		'/api/backup',
		jsonInit('POST', { path }),
		(status) => `Backup failed with status ${status}.`
	);
}
