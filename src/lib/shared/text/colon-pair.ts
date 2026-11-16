/**
 * The `<id>:<value>` shape: one id joined to one of its values by the first
 * colon. It is the transport for the Workers filters and the Mapping's hidden
 * values, so one module owns how it is written and read.
 */

/** Reads one `<id>:<value>` string, or null when it names no id or no value. */
export function parseColonPair(raw: string): { id: string; value: string } | null {
	const separator = raw.indexOf(':');
	if (separator <= 0) return null;

	const value = raw.slice(separator + 1);
	return value ? { id: raw.slice(0, separator), value } : null;
}

/** Writes one `<id>:<value>` string. Percent-encoding stays the caller's job. */
export function encodeColonPair(id: string, value: string): string {
	return `${id}:${value}`;
}
