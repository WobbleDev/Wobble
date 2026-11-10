import { appliedLocale } from '#lib/i18n/locale.ts';
import { appLocaleHeaderName } from '#lib/shared/app-locale-header.ts';
import { activeWorksiteHeaderName } from '#lib/shared/active-worksite-header.ts';
import { readStoredActiveWorksiteId } from './active-worksite-storage.ts';
import { parseApiResponse } from './api-response.ts';
import { sendApiRequest } from './transport.ts';

/**
 * The init for a request whose body is JSON: the method, the JSON content type and the
 * body serialized once. Every hand-written JSON call goes through here, so the wire
 * shape (method, header, body bytes) is decided in one place.
 */
export function jsonInit(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	};
}

/** `jsonInit` that also names the applied app locale, for a request that generates text. */
export function localizedJsonInit(method: string, body: unknown): RequestInit {
	const init = jsonInit(method, body);
	return {
		...init,
		headers: { ...(init.headers as Record<string, string>), [appLocaleHeaderName]: appliedLocale() }
	};
}

/**
 * Names the Worksite this browser chose, so the server resolves that header first.
 * With nothing stored the header is left out and the server falls back to the
 * first Worksite. Caller headers may be a `Headers`, a tuple list or a record; they
 * are read through `Headers`, so the names come out lowercase as fetch sends them.
 */
function withActiveWorksiteHeader(init: RequestInit): RequestInit {
	const id = readStoredActiveWorksiteId();
	if (id === null) return init;

	return {
		...init,
		headers: {
			...Object.fromEntries(new Headers(init.headers)),
			[activeWorksiteHeaderName]: id
		}
	};
}

/**
 * Sends a request and hands a successful body to `decode`.
 *
 * A non-2xx reply throws the server's message; a body the decoder rejects throws
 * the decoder's own error.
 */
export async function requestJson<T>(
	path: string,
	init: RequestInit,
	fallbackMessage: (status: number) => string,
	decode: (value: unknown) => T
): Promise<T> {
	const response = await sendApiRequest(path, withActiveWorksiteHeader(init));

	return decode(await parseApiResponse(response, fallbackMessage));
}

/** Sends a request whose reply body no caller reads, confirming only that it succeeded. */
export async function requestVoid(
	path: string,
	init: RequestInit,
	fallbackMessage: (status: number) => string
): Promise<void> {
	const response = await sendApiRequest(path, withActiveWorksiteHeader(init));
	await parseApiResponse(response, fallbackMessage);
}
