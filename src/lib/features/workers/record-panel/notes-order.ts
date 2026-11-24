import type { WorkerNote } from '#lib/domain-vocabulary.ts';

/** The notes history: newest written first. */
export function sortedEntries(entries: WorkerNote[]): WorkerNote[] {
	return [...entries].sort(
		(first, second) => Date.parse(second.timestamp) - Date.parse(first.timestamp)
	);
}
