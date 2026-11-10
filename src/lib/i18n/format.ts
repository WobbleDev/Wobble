/**
 * The display-formatting policy at the locale boundary.
 *
 * Two locales are in play and must never be conflated:
 *
 * - The **system regional locale** decides how dates, times, numbers,
 *   percentages and visible collation look. It comes from the WebView's ordered
 *   preferred languages and stays independent of the interface language.
 * - The **applied interface locale** decides relative-time prose, day-period
 *   text inside an explicit 12-hour clock, list conjunctions, and the month name
 *   of an explicit day-month-year date.
 *
 * Callers pass an explicit locale only in focused policy tests; in the app the
 * defaults read the two sources above at call time, so nothing is frozen at
 * module import.
 */
import { appliedLocale, readPreferredLanguages } from './locale.ts';

/** A locale tag, an ordered list of tags, or undefined for the runtime default. */
export type FormattingLocale = string | readonly string[] | undefined;

/** The WebView's preferred languages, best first; empty when unavailable. */
function systemLocales(): string[] {
	return readPreferredLanguages().filter(
		(tag): tag is string => typeof tag === 'string' && tag.trim() !== ''
	);
}

function toLocales(locale: FormattingLocale): string[] | undefined {
	if (locale === undefined) return undefined;
	return typeof locale === 'string' ? [locale] : [...locale];
}

/** A count in the system's regional number format. */
export function formatNumber(
	value: number,
	options: Intl.NumberFormatOptions = {},
	locale: FormattingLocale = systemLocales()
): string {
	return new Intl.NumberFormat(toLocales(locale), options).format(value);
}

/** A fraction shown as a percentage in the system's regional format. */
export function formatPercent(
	value: number,
	options: Intl.NumberFormatOptions = {},
	locale: FormattingLocale = systemLocales()
): string {
	return new Intl.NumberFormat(toLocales(locale), { ...options, style: 'percent' }).format(value);
}

/** A human-readable list in the applied interface language: "a, b and c". */
export function formatList(
	items: readonly string[],
	options: Intl.ListFormatOptions = { type: 'conjunction' },
	locale: string = appliedLocale()
): string {
	return new Intl.ListFormat(locale, options).format(items);
}

/**
 * A short "how long ago" in the applied interface language. A negative offset
 * reaches into the past, which is the direction a written timestamp always has.
 */
export function formatRelativeTime(
	iso: string,
	now: number = Date.now(),
	locale: string = appliedLocale()
): string {
	const seconds = Math.round((Date.parse(iso) - now) / 1000);
	const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
	const magnitude = Math.abs(seconds);

	if (magnitude < 60) return format.format(seconds, 'second');
	if (magnitude < 60 * 60) return format.format(Math.round(seconds / 60), 'minute');
	return format.format(Math.round(seconds / (60 * 60)), 'hour');
}

/** Name order for the Workers table and Relationship candidates. */
export function compareNames(first: string, second: string): number {
	return new Intl.Collator(toLocales(systemLocales()), {
		numeric: true,
		sensitivity: 'base'
	}).compare(first, second);
}

/** The visible date of an instant, in the chosen format. */
export function formatDate(
	date: Date,
	format: 'dmy' | 'mdy' | 'iso' | 'system',
	systemLocale: FormattingLocale = systemLocales(),
	interfaceLocale: string = appliedLocale()
): string {
	if (format === 'dmy') {
		// Order is fixed day-month-year; only the month name follows the interface.
		const parts = new Intl.DateTimeFormat(interfaceLocale, {
			day: 'numeric',
			month: 'short',
			year: 'numeric'
		}).formatToParts(date);
		const day = parts.find((part) => part.type === 'day')?.value ?? '';
		const month = parts.find((part) => part.type === 'month')?.value ?? '';
		const year = parts.find((part) => part.type === 'year')?.value ?? '';
		return `${day} ${month} ${year}`;
	}
	if (format === 'mdy') {
		// Numeric and language-independent: month/day/year, never padded.
		const parts = new Intl.DateTimeFormat('en-US', {
			day: 'numeric',
			month: 'numeric',
			year: 'numeric'
		}).formatToParts(date);
		const month = parts.find((part) => part.type === 'month')?.value ?? '';
		const day = parts.find((part) => part.type === 'day')?.value ?? '';
		const year = parts.find((part) => part.type === 'year')?.value ?? '';
		return `${month}/${day}/${year}`;
	}
	if (format === 'iso') {
		// The local date parts, so a reader west of UTC never sees tomorrow's date.
		const year = String(date.getFullYear()).padStart(4, '0');
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	return new Intl.DateTimeFormat(toLocales(systemLocale), { dateStyle: 'medium' }).format(date);
}

/** The clock time of an instant, in the chosen format. */
export function formatTime(
	date: Date,
	format: '12' | '24' | 'system',
	systemLocale: FormattingLocale = systemLocales(),
	interfaceLocale: string = appliedLocale()
): string {
	if (format === '12') {
		// The cycle is requested explicitly; the day-period text follows the interface.
		return new Intl.DateTimeFormat(interfaceLocale, {
			hour: 'numeric',
			minute: '2-digit',
			hour12: true
		}).format(date);
	}
	if (format === '24') {
		return new Intl.DateTimeFormat(interfaceLocale, {
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23'
		}).format(date);
	}

	return new Intl.DateTimeFormat(toLocales(systemLocale), { timeStyle: 'short' }).format(date);
}
