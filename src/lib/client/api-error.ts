/**
 * An error reply from the core: the status, the core's diagnostic message, and the
 * stable code the UI maps to its own copy (ADR-0024). The code crosses the client
 * boundary as untrusted data — anything that is not a string counts as absent, and the
 * caller falls back to generic copy.
 *
 * `details` is the parsed reply body, kept as untrusted data so a coded refusal can
 * carry the state that explains it (a stale Configuration preview's changed definition).
 * A caller must narrow it through a decoder before using any part of it.
 */
export class ApiError extends Error {
	readonly status: number;
	readonly code?: string;
	readonly details: unknown;

	constructor(status: number, message: string, code?: string, details?: unknown) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

/** The code from an untrusted reply body, or undefined. */
export function readErrorCode(value: unknown): string | undefined {
	return typeof value === 'object' &&
		value !== null &&
		'code' in value &&
		typeof value.code === 'string'
		? value.code
		: undefined;
}
