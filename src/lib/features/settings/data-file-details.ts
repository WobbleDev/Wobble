/**
 * The Data well's live file details, formatted the way the saved Settings read them.
 * A value the core could not read shows the injected "Unavailable" copy rather than a
 * plausible default, so the label is localized at the call site that knows the locale.
 */
import { formatTimestamp, type TimestampFormats } from '#lib/shared/format.ts';

const units = ['KB', 'MB', 'GB', 'TB'] as const;

/** The main SQLite file's size: bytes below 1 KB, then one decimal up to ten units. */
export function formatFileSize(bytes: number | null, unavailable: string): string {
	if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return unavailable;
	if (bytes < 1024) return `${bytes} B`;

	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}

	const rounded = value >= 10 ? String(Math.round(value)) : value.toFixed(1);
	return `${rounded} ${units[unit]}`;
}

/** The latest write across the main database and its WAL, or the "Unavailable" copy. */
export function formatFileLastWrite(
	iso: string | null,
	formats: TimestampFormats | undefined,
	unavailable: string
): string {
	if (iso === null || Number.isNaN(Date.parse(iso))) return unavailable;
	return formatTimestamp(iso, formats);
}
