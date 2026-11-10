import { describe, expect, it } from 'vitest';
import type { WorkerNote } from '#lib/domain-vocabulary.ts';
import { matchingEntries, sortedEntries } from './notes-order.ts';

function note(overrides: Partial<WorkerNote> & Pick<WorkerNote, 'id' | 'timestamp'>): WorkerNote {
	return { text: 'A note.', ...overrides };
}

describe('sortedEntries', () => {
	it('orders by written time, newest first', () => {
		const entries = [
			note({ id: 'older', timestamp: '2026-10-01T09:00:00.000Z' }),
			note({ id: 'newest', timestamp: '2026-10-08T08:00:00.000Z' }),
			note({ id: 'oldest', timestamp: '2026-09-30T08:00:00.000Z' })
		];

		expect(sortedEntries(entries).map((entry) => entry.id)).toEqual(['newest', 'older', 'oldest']);
	});
});

describe('matchingEntries', () => {
	const entries = [
		note({ id: 'a', timestamp: '2026-10-01T09:00:00.000Z', text: 'Called about Shifts' }),
		note({ id: 'b', timestamp: '2026-10-02T09:00:00.000Z', text: 'Met at the door' })
	];

	it('keeps every entry for a blank query', () => {
		expect(matchingEntries(entries, '  ')).toEqual(entries);
	});

	it('matches text ignoring case and keeps order', () => {
		expect(matchingEntries(entries, 'shifts').map((entry) => entry.id)).toEqual(['a']);
		expect(matchingEntries(entries, 'zzz')).toEqual([]);
	});
});
