/**
 * The one Phone rule on the frontend, shared by the record panel's mask and the CSV
 * import (ticket 02): digits only, a leading 1 dropped when 11 digits remain, laid out
 * `(AAA) EEE-NNNN`. It checks the count, not whether the area code is real.
 */

/** The value's digits, with a leading 1 dropped when 11 remain. */
function rawPhoneDigits(value: string): string {
	let digits = value.replace(/\D/g, '');
	if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
	return digits;
}

/** The value's digits, with a leading 1 dropped when 11 remain, capped at 10. */
export function phoneDigits(value: string): string {
	return rawPhoneDigits(value).slice(0, 10);
}

/** `(AAA) EEE-NNNN`, partial as the digits arrive: `(555`, `(555) 01`, and so on. */
export function formatPhoneDigits(digits: string): string {
	if (digits.length === 0) return '';
	if (digits.length <= 3) {
		return `(${digits}${digits.length === 3 ? ')' : ''}`;
	}
	if (digits.length <= 6) {
		return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
	}
	return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** What the Phone editor shows for whatever was typed or pasted. */
export function formatPhoneInput(value: string): string {
	return formatPhoneDigits(phoneDigits(value));
}

/**
 * The CSV import's rule: the stored shape of a clean number, or `null` when the value
 * cannot become one. An empty value is clean and stays empty. Mirrors the core's
 * `normalize_phone`; the editor's mask caps instead because it is shaping typing.
 */
export function normalizePhone(value: string): string | null {
	const trimmed = value.trim();
	if (trimmed === '') return '';

	const digits = rawPhoneDigits(trimmed);
	return digits.length === 10 ? formatPhoneDigits(digits) : null;
}
