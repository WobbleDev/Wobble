import { describe, expect, it } from 'vitest';
import { formatFileLastWrite, formatFileSize } from './data-file-details.ts';

describe('Product gap 16 — database file details', () => {
	it('formats the main file size in readable units', () => {
		expect(formatFileSize(0, 'Unavailable')).toBe('0 B');
		expect(formatFileSize(1023, 'Unavailable')).toBe('1023 B');
		expect(formatFileSize(1024, 'Unavailable')).toBe('1.0 KB');
		expect(formatFileSize(1536, 'Unavailable')).toBe('1.5 KB');
		expect(formatFileSize(10 * 1024 * 1024, 'Unavailable')).toBe('10 MB');
	});

	it('says the injected Unavailable copy when the size cannot be read', () => {
		expect(formatFileSize(null, 'Unavailable')).toBe('Unavailable');
		expect(formatFileSize(Number.NaN, 'Unavailable')).toBe('Unavailable');
		expect(formatFileSize(-1, 'Unavailable')).toBe('Unavailable');
		// The label is the reader's locale, never a hard-coded English literal.
		expect(formatFileSize(null, 'No disponible')).toBe('No disponible');
	});

	it('formats the latest write and says the injected Unavailable copy when it cannot be read', () => {
		expect(formatFileLastWrite(null, undefined, 'Unavailable')).toBe('Unavailable');
		expect(formatFileLastWrite('not a date', undefined, 'Unavailable')).toBe('Unavailable');
		expect(formatFileLastWrite('not a date', undefined, 'No disponible')).toBe('No disponible');
		expect(formatFileLastWrite('2026-10-21T20:00:00.000Z', undefined, 'Unavailable')).toMatch(
			/2026/
		);
	});
});
