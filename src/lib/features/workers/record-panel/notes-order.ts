import type { WorkerNote } from '#lib/domain-vocabulary.ts';

/** The notes history: newest written first. */
export function sortedEntries(entries: WorkerNote[]): WorkerNote[] {
	return [...entries].sort(
		(first, second) => Date.parse(second.timestamp) - Date.parse(first.timestamp)
	);
}

/** The entries whose text contains the query, ignoring case; a blank query keeps all. */
export function matchingEntries(entries: WorkerNote[], query: string): WorkerNote[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return entries;
	return entries.filter((note) => note.text.toLocaleLowerCase().includes(needle));
}
