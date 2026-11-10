import { decodeSafetyCopyPath, isRecord } from './api-decode.ts';
import { jsonInit, requestJson } from './request-json.ts';

export type BootStatus =
	| { state: 'open'; encrypted: true; conversion?: { databasePath: string; recoveryPath: string } }
	| { state: 'locked'; firstRun: boolean; legacyPlaintext: boolean; markerPending: boolean }
	| { state: 'failed'; reason: string; recoveryPath: string | null };

/** Boot is independent of datasets and encrypted preferences. Reject malformed
 * lifecycle responses rather than interpreting missing flags as an unlocked app. */
export function decodeBootStatus(value: unknown): BootStatus {
	if (isRecord(value)) {
		if (value.state === 'open' && value.encrypted === true) {
			if (value.conversion === undefined) return { state: 'open', encrypted: true };
			if (
				isRecord(value.conversion) &&
				typeof value.conversion.databasePath === 'string' &&
				value.conversion.databasePath.length > 0 &&
				typeof value.conversion.recoveryPath === 'string' &&
				value.conversion.recoveryPath.length > 0
			) {
				return {
					state: 'open',
					encrypted: true,
					conversion: {
						databasePath: value.conversion.databasePath,
						recoveryPath: value.conversion.recoveryPath
					}
				};
			}
			throw new Error('The conversion receipt is invalid.');
		}
		if (
			value.state === 'locked' &&
			typeof value.firstRun === 'boolean' &&
			typeof value.legacyPlaintext === 'boolean' &&
			typeof value.markerPending === 'boolean'
		) {
			return {
				state: 'locked',
				firstRun: value.firstRun,
				legacyPlaintext: value.legacyPlaintext,
				markerPending: value.markerPending
			};
		}
		if (
			value.state === 'failed' &&
			typeof value.reason === 'string' &&
			(value.recoveryPath === null || typeof value.recoveryPath === 'string')
		) {
			return { state: 'failed', reason: value.reason, recoveryPath: value.recoveryPath };
		}
	}
	throw new Error('The storage lifecycle response is invalid.');
}

function failed(status: number): string {
	return `Storage request failed (${status}).`;
}

export function getBootStatus(): Promise<BootStatus> {
	return requestJson('/api/boot-status', {}, failed, decodeBootStatus);
}

export function createStorage(passphrase: string, confirm: string): Promise<BootStatus> {
	return requestJson(
		'/api/boot-create',
		jsonInit('POST', { passphrase, confirm }),
		failed,
		decodeBootStatus
	);
}

export function unlockStorage(passphrase: string, confirm?: string): Promise<BootStatus> {
	return requestJson(
		'/api/boot-unlock',
		jsonInit('POST', { passphrase, ...(confirm === undefined ? {} : { confirm }) }),
		failed,
		decodeBootStatus
	);
}

/** The returned recovery copy keeps the old passphrase. */
export function changePassphrase(current: string, next: string, confirm: string): Promise<string> {
	return requestJson(
		'/api/boot-change-passphrase',
		jsonInit('POST', { current, next, confirm }),
		failed,
		decodeSafetyCopyPath
	);
}
