import { describe, expect, it } from 'vitest';
import type { WorkerNote } from '#lib/domain-vocabulary.ts';
import { sortedEntries } from './notes-order.ts';

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
