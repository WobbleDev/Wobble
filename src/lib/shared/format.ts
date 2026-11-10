/**
 * Turning stored values into the text the Workers table, the Worker form and the
 * map show.
 *
 * The formatting policy itself lives at the locale boundary (`#lib/i18n/format.ts`):
 * system regional preferences decide dates, times and numbers, while the applied
 * interface language decides relative-time prose and day-period text. Callers that
 * format a bare date or time use `#lib/i18n/format.ts` directly.
 */
import type { DateFormatPreference, TimeFormatPreference } from '#lib/shared/app-settings.ts';
import {
	formatDate as formatDateAtLocale,
	formatRelativeTime,
	formatTime as formatTimeAtLocale
} from '#lib/i18n/format.ts';
import { m } from '#lib/paraglide/messages.js';

/** The date and time formats a Note reads in. */
export type TimestampFormats = {
	dateFormat: DateFormatPreference;
	timeFormat: TimeFormatPreference;
};

/** What a caller that has no Settings to read shows: the computer's own formats. */
const defaultTimestampFormats: TimestampFormats = { dateFormat: 'system', timeFormat: 'system' };

/** A written-at instant in the reader's local time and the chosen formats. */
export function formatTimestamp(
	timestamp: string,
	formats: TimestampFormats = defaultTimestampFormats,
	locale?: string,
	interfaceLocale?: string
): string {
	const date = new Date(timestamp);
	return `${formatDateAtLocale(date, formats.dateFormat, locale, interfaceLocale)}, ${formatTimeAtLocale(date, formats.timeFormat, locale, interfaceLocale)}`;
}

export function formatAttributeValue(value: string | string[] | undefined): string {
	if (Array.isArray(value)) return value.join(', ') || m.common_none();
	return value || m.common_none();
}

/** A short "how long ago" for the restored-draft message. */
export function relativeTime(iso: string, now = Date.now(), locale?: string): string {
	return formatRelativeTime(iso, now, locale);
}
