import { ApiError } from '#lib/client/api-error.ts';

/** Startup diagnostics contain only an HTTP error status, never response text or payloads. */
export function startupStatus(error: unknown): number {
	return error instanceof ApiError &&
		Number.isInteger(error.status) &&
		error.status >= 400 &&
		error.status <= 599
		? error.status
		: 500;
}
