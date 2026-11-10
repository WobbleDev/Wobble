/**
 * The Worksite calls the shell makes: switching the Active Worksite, and creating a
 * fresh one.
 *
 * Every browser call to the backend goes through `src/lib/client/`, so this module is
 * one of the places a Tauri build swaps `fetch` for an `invoke`.
 */
import { decodeWorksiteCounts, decodeWorksiteId } from './api-decode.ts';
import type { SavedWorksiteReply } from '#lib/client/generated/SavedWorksiteReply.ts';
import { storeActiveWorksiteId } from './active-worksite-storage.ts';
import { jsonInit, requestJson, requestVoid } from './request-json.ts';

/** Makes the Worksite with this id the Active Worksite. */
export async function setActiveWorksite(id: string): Promise<void> {
	await requestVoid(
		'/api/worksite/active',
		jsonInit('PUT', { id }),
		(status) => `Could not switch the worksite (HTTP ${status}).`
	);
	storeActiveWorksiteId(id);
}

/**
 * Creates an empty Worksite, which the server then makes active.
 *
 * `templateLocale` is the locale this session actually applied, never a pending saved
 * preference. Omitting it keeps the legacy bodyless English creation.
 */
export async function createWorksite(templateLocale?: 'en' | 'es-419'): Promise<void> {
	const id = await requestJson(
		'/api/worksite',
		templateLocale ? jsonInit('POST', { templateLocale }) : { method: 'POST' },
		(status) => `Could not create the worksite (HTTP ${status}).`,
		(value) => decodeWorksiteId(value as SavedWorksiteReply as unknown)
	);
	storeActiveWorksiteId(id);
}

/** Every Worksite's Worker count by id, from one grouped query. */
export function getWorksiteCounts(): Promise<Record<string, number>> {
	return requestJson(
		'/api/worksite/counts',
		{ cache: 'no-store' },
		(status) => `Could not count the workers (HTTP ${status}).`,
		decodeWorksiteCounts
	);
}
