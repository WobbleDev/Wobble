import { describe, expect, it } from 'vitest';
import {
	compareNames,
	formatDate,
	formatList,
	formatNumber,
	formatPercent,
	formatRelativeTime,
	formatTime
} from './format.ts';

/** A local wall-clock instant, so the expected text never depends on the machine's zone. */
function local(day: number, hours: number, minutes: number): Date {
	return new Date(2026, 9, day, hours, minutes);
}

const now = Date.parse('2026-10-19T18:40:00.000Z');

/** An ISO stamp this many seconds before `now`. */
function ago(seconds: number): string {
	return new Date(now - seconds * 1000).toISOString();
}

describe('regional numbers', () => {
	it('formats a count with the system regional grouping', () => {
		expect(formatNumber(1234.5, {}, ['en-US'])).toBe('1,234.5');
		// Latin American Spanish groups thousands and keeps a dot for the decimal.
		expect(formatNumber(1234.5, {}, ['es-419'])).toBe('1,234.5');
	});

	it('formats a fraction as a percentage', () => {
		expect(formatPercent(0.25, {}, ['en-US'])).toBe('25%');
		expect(formatPercent(0.25, {}, ['es-419'])).toContain('25');
	});
});

describe('list conjunctions', () => {
	it('uses the applied interface language, not the system region', () => {
		expect(formatList(['Ana', 'Beto', 'Carla'], undefined, 'en')).toBe('Ana, Beto, and Carla');
		expect(formatList(['Ana', 'Beto', 'Carla'], undefined, 'es-419')).toBe('Ana, Beto y Carla');
	});
});

describe('relative time', () => {
	it('words a past instant in the applied interface language', () => {
		expect(formatRelativeTime(ago(10), now, 'en')).toBe('10 seconds ago');
		expect(formatRelativeTime(ago(300), now, 'es-419')).toBe('hace 5 minutos');
	});

	it('keeps one minute in the singular', () => {
		expect(formatRelativeTime(ago(60), now, 'en')).toBe('1 minute ago');
		expect(formatRelativeTime(ago(60), now, 'es-419')).toBe('hace 1 minuto');
	});

	it('reads a just-now instant as now, not as a count of zero', () => {
		expect(formatRelativeTime(ago(0), now, 'en')).toBe('now');
		expect(formatRelativeTime(ago(0), now, 'es-419')).toBe('ahora');
	});

	it('moves to hours past the hour mark', () => {
		expect(formatRelativeTime(ago(2 * 60 * 60), now, 'en')).toBe('2 hours ago');
		expect(formatRelativeTime(ago(2 * 60 * 60), now, 'es-419')).toBe('hace 2 horas');
	});
});

describe('the explicit date formats', () => {
	it('keeps day-month-year and localizes only the month name', () => {
		expect(formatDate(local(19, 18, 40), 'dmy', ['en-US'], 'en')).toBe('19 Oct 2026');
		expect(formatDate(local(19, 18, 40), 'dmy', ['en-US'], 'es-419')).toBe('19 oct 2026');
	});

	it('keeps month-day-year numeric even with a Spanish interface', () => {
		expect(formatDate(local(19, 18, 40), 'mdy', ['es-419'], 'es-419')).toBe('10/19/2026');
		expect(formatDate(local(9, 18, 40), 'mdy', ['en-US'], 'en')).toBe('10/9/2026');
	});

	it('keeps ISO local year-month-day', () => {
		expect(formatDate(local(19, 0, 30), 'iso', ['es-419'], 'es-419')).toBe('2026-10-19');
	});

	it('follows the system region when the format is system, even in Spanish', () => {
		expect(formatDate(local(19, 18, 40), 'system', ['en-US'], 'es-419')).toBe('Oct 19, 2026');
		expect(formatDate(local(19, 18, 40), 'system', ['en-GB'], 'es-419')).toBe('19 Oct 2026');
	});
});

describe('the explicit time formats', () => {
	it('keeps the requested 24-hour cycle', () => {
		expect(formatTime(local(19, 18, 40), '24', ['en-US'], 'es-419')).toBe('18:40');
		expect(formatTime(local(19, 0, 30), '24', ['en-US'], 'en')).toBe('00:30');
	});

	it('keeps 12-hour time and localizes its day period', () => {
		expect(formatTime(local(19, 14, 30), '12', ['en-US'], 'en')).toBe('2:30 PM');
		expect(formatTime(local(19, 14, 30), '12', ['en-US'], 'es-419')).toMatch(/^2:30\s/);
		expect(formatTime(local(19, 14, 30), '12', ['en-US'], 'es-419')).toMatch(/p\.\s?m\./);
	});

	it('follows the system region when no cycle is chosen', () => {
		expect(formatTime(local(19, 14, 30), 'system', ['en-US'], 'es-419')).toBe('2:30 PM');
		expect(formatTime(local(19, 14, 30), 'system', ['en-GB'], 'es-419')).toBe('14:30');
	});
});

describe('name ordering', () => {
	it('sorts accented names case-blind and numbers by value', () => {
		const names = ['Beatriz', 'Ángela', 'Worker 10', 'Worker 2'];
		expect([...names].sort(compareNames)).toEqual(['Ángela', 'Beatriz', 'Worker 2', 'Worker 10']);
	});
});
