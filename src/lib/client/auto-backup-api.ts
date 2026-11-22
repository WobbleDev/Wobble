import { isRecord } from './api-decode.ts';
import { jsonInit, requestJson } from './request-json.ts';

export const autoBackupFrequencies = ['daily', 'weekly'] as const;
export type AutoBackupFrequency = (typeof autoBackupFrequencies)[number];

/** A copy that could not be written. The message is fixed copy from the core: no path, no system text. */
export type AutoBackupFailure = { at: string; message: string };

/** What the page shows about the scheduled backup. `available` is false when there is no database file. */
export type AutoBackupStatus = {
	available: boolean;
	enabled: boolean;
	frequency: AutoBackupFrequency;
	lastBackupAt: string | null;
	failure: AutoBackupFailure | null;
};

export type AutoBackupChange = { enabled: boolean } | { frequency: AutoBackupFrequency };

function isFailure(value: unknown): value is AutoBackupFailure {
	return isRecord(value) && typeof value.at === 'string' && typeof value.message === 'string';
}

function decodeStatus(value: unknown): AutoBackupStatus {
	const status = isRecord(value) ? value.autoBackup : undefined;
	if (
		!isRecord(status) ||
		typeof status.available !== 'boolean' ||
		typeof status.enabled !== 'boolean' ||
		!autoBackupFrequencies.includes(status.frequency as AutoBackupFrequency) ||
		!(status.lastBackupAt === null || typeof status.lastBackupAt === 'string') ||
		!(status.failure === null || isFailure(status.failure))
	) {
		throw new Error('Automatic backup response was invalid.');
	}

	return {
		available: status.available,
		enabled: status.enabled,
		frequency: status.frequency as AutoBackupFrequency,
		lastBackupAt: status.lastBackupAt,
		failure: status.failure
	};
}

export function getAutoBackup(): Promise<AutoBackupStatus> {
	return requestJson(
		'/api/auto-backup',
		{ cache: 'no-store' },
		(status) => `Automatic backup poll failed with status ${status}.`,
		decodeStatus
	);
}

/** Turns it on or off, or changes how often; the reply is the fresh status. */
export function saveAutoBackup(change: AutoBackupChange): Promise<AutoBackupStatus> {
	return requestJson(
		'/api/auto-backup',
		{ ...jsonInit('PUT', change), cache: 'no-store' },
		(status) => `Automatic backup save failed with status ${status}.`,
		decodeStatus
	);
}

/**
 * Asks the core to write a copy if one is due, or now with `force` ("Back up now"). The core
 * decides, so a repeat call, a second window or a restart never doubles up. A copy that
 * fails is not a thrown error: it comes back as `status.failure`.
 */
export function runAutoBackup(force = false): Promise<AutoBackupStatus> {
	return requestJson(
		'/api/auto-backup/run',
		{ ...jsonInit('POST', { force }), cache: 'no-store' },
		(status) => `Automatic backup failed with status ${status}.`,
		decodeStatus
	);
}
