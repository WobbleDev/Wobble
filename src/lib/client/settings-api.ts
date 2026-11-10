import type { AppSettings, AppSettingsUpdate } from '#lib/shared/app-settings.ts';
import { decodeSettings } from './api-decode.ts';
import { jsonInit, requestJson } from './request-json.ts';

export function getAppSettings(): Promise<AppSettings> {
	return requestJson(
		'/api/settings',
		{ cache: 'no-store' },
		(status) => `Settings poll failed with status ${status}.`,
		decodeSettings
	);
}

export function saveAppSettings(update: AppSettingsUpdate): Promise<AppSettings> {
	return requestJson(
		'/api/settings',
		{ ...jsonInit('PUT', update), cache: 'no-store' },
		(status) => `Settings save failed with status ${status}.`,
		decodeSettings
	);
}

/** Deletes every settings row; the reply carries the fresh defaults. */
export function resetAppSettings(): Promise<AppSettings> {
	return requestJson(
		'/api/settings',
		{ method: 'DELETE', cache: 'no-store' },
		(status) => `Settings reset failed with status ${status}.`,
		decodeSettings
	);
}
