import { describe, expect, it } from 'vitest';
import { formatDate, formatTime } from '#lib/i18n/format.ts';
import { formatTimestamp, relativeTime } from './format.ts';

const now = Date.parse('2024-05-01T12:00:00.000Z');

/** An ISO stamp this many seconds before `now`. */
function ago(seconds: number): string {
	return new Date(now - seconds * 1000).toISOString();
}

/** A local wall-clock instant, so the expected text does not depend on the machine's zone. */
function local(day: number, hours: number, minutes: number): Date {
	return new Date(2026, 9, day, hours, minutes);
}

describe('formatDate', () => {
	it('writes day-month-year in en-GB', () => {
		expect(formatDate(local(19, 18, 40), 'dmy', 'en-GB')).toBe('19 Oct 2026');
	});

	it('writes numeric month-day-year in en-US, without padding the day', () => {
		expect(formatDate(local(19, 18, 40), 'mdy', 'en-US')).toBe('10/19/2026');
		expect(formatDate(local(9, 18, 40), 'mdy', 'en-US')).toBe('10/9/2026');
	});

	it('writes ISO year-month-day from the local date parts', () => {
		expect(formatDate(local(19, 0, 30), 'iso')).toBe('2026-10-19');
	});

	it('follows the computer when the format is system', () => {
		expect(formatDate(local(19, 18, 40), 'system', 'en-GB')).toBe('19 Oct 2026');
		expect(formatDate(local(19, 18, 40), 'system', 'en-US')).toBe('Oct 19, 2026');
	});
});

describe('formatTime', () => {
	it('writes 24-hour time, including the midnight hour as 00', () => {
		expect(formatTime(local(19, 18, 40), '24', 'en-GB')).toBe('18:40');
		expect(formatTime(local(19, 0, 30), '24', 'en-GB')).toBe('00:30');
	});

	it('writes 12-hour time with a single-digit hour left unpadded', () => {
		expect(formatTime(local(19, 14, 30), '12', 'en-US')).toBe('2:30 PM');
		expect(formatTime(local(19, 9, 5), '12', 'en-US')).toBe('9:05 AM');
	});

	it('follows the computer when the format is system', () => {
		expect(formatTime(local(19, 14, 30), 'system', 'en-GB')).toBe('14:30');
		expect(formatTime(local(19, 14, 30), 'system', 'en-US')).toBe('2:30 PM');
	});
});

describe('formatTimestamp', () => {
	it('joins the chosen date and time formats with a comma', () => {
		const written = local(19, 18, 40).toISOString();

		expect(formatTimestamp(written, { dateFormat: 'dmy', timeFormat: '24' }, 'en-GB')).toBe(
			'19 Oct 2026, 18:40'
		);
		expect(formatTimestamp(written, { dateFormat: 'mdy', timeFormat: '12' }, 'en-US')).toBe(
			'10/19/2026, 6:40 PM'
		);
		expect(formatTimestamp(written, { dateFormat: 'iso', timeFormat: '24' })).toBe(
			'2026-10-19, 18:40'
		);
	});

	it('follows the computer when no formats are given', () => {
		const written = local(19, 18, 40).toISOString();

		expect(formatTimestamp(written, undefined, 'en-US')).toBe('Oct 19, 2026, 6:40 PM');
	});

	it('reads a written-at instant in local time, not UTC', () => {
		// No zone: the date-time form is read as local wall-clock time.
		const formatted = formatTimestamp(
			'2026-10-08T18:40:00',
			{ dateFormat: 'dmy', timeFormat: '24' },
			'en-GB'
		);

		expect(formatted).toBe('8 Oct 2026, 18:40');
		expect(formatted).not.toMatch(/UTC|GMT/);
	});
});

describe('relativeTime', () => {
	it('counts the seconds under a minute', () => {
		expect(relativeTime(ago(10), now)).toBe('10 seconds ago');
	});

	it('says one minute in the singular', () => {
		expect(relativeTime(ago(60), now)).toBe('1 minute ago');
	});

	it('says minutes in the plural', () => {
		expect(relativeTime(ago(300), now)).toBe('5 minutes ago');
	});

	it('says hours past the hour mark', () => {
		expect(relativeTime(ago(2 * 60 * 60), now)).toBe('2 hours ago');
	});
});
