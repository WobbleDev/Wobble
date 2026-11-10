/**
 * A UUID v4 for a new record. `crypto.randomUUID` is only exposed in a secure
 * context, which a packaged webview may not present, so fall back to
 * `crypto.getRandomValues` and keep the id's shape identical either way.
 */
export function newId(): string {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
