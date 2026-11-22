import {
	getAutoBackup,
	runAutoBackup,
	saveAutoBackup,
	type AutoBackupChange,
	type AutoBackupStatus
} from '#lib/client/auto-backup-api.ts';
import { m } from '#lib/paraglide/messages.js';

/** How often the open app asks the core whether a copy is due; the core decides, so this is only a prompt. */
export const AUTO_BACKUP_CHECK_MS = 30 * 60 * 1000;

export const autoBackupContextKey = Symbol('auto-backup');

/**
 * The scheduled backup as the open app sees it: the status, the keeper that prompts the core
 * to copy when one is due, and the controls. A failed copy lands in `status.failure`, which the
 * shell shows as a banner and Settings shows beside the control; a failed request lands in
 * `error`. Create it during component initialisation and call `start()` from `onMount`.
 */
export function createAutoBackup() {
	let status = $state<AutoBackupStatus | null>(null);
	let busy = $state(false);
	let error = $state('');

	async function guarded(work: () => Promise<AutoBackupStatus>): Promise<void> {
		busy = true;
		error = '';
		try {
			status = await work();
		} catch {
			error = m.settings_auto_backup_error();
		} finally {
			busy = false;
		}
	}

	/* The background prompt reads first and only asks for a copy while the setting is on, so
	   with it off the app sends nothing but a read. It never raises `error`: a failed request
	   is retried at the next check, and a failed copy is already reported in `status.failure`. */
	async function check(): Promise<void> {
		try {
			const current = await getAutoBackup();
			status = current.enabled ? await runAutoBackup(false) : current;
		} catch {
			/* retried at the next check */
		}
	}

	return {
		get status() {
			return status;
		},
		get busy() {
			return busy;
		},
		get error() {
			return error;
		},
		/** Reads the status, writes a copy if one is due, then keeps checking. Returns the cleanup. */
		start(): () => void {
			void check();
			const timer = setInterval(() => void check(), AUTO_BACKUP_CHECK_MS);
			return () => clearInterval(timer);
		},
		refresh: () => guarded(() => getAutoBackup()),
		/** Saves a change; turning it on also writes the first copy straight away. */
		async change(change: AutoBackupChange): Promise<void> {
			await guarded(async () => {
				const saved = await saveAutoBackup(change);
				return saved.enabled ? runAutoBackup(false) : saved;
			});
		},
		backUpNow: () => guarded(() => runAutoBackup(true))
	};
}

export type AutoBackup = ReturnType<typeof createAutoBackup>;
