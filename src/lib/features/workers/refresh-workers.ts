import { invalidateAll } from '$app/navigation';
import { getWorksiteDataset, primeDataset } from '#lib/client/dataset-api.ts';

let latestRefresh = 0;

/**
 * Reloads the Workers table after a Worker write, and rejects when it cannot.
 *
 * `invalidateAll()` never rejects: a throwing layout load swaps in the root
 * error page. So the dataset is read first; if that fails the refresh rejects
 * and the page keeps its last good data. Only a readable dataset is let through
 * to `invalidateAll()`. The one-shot hand-off supplies that layout reload.
 *
 * Overlapping refreshes: only the newest one applies its reply. An older read that
 * resolves last would otherwise prime, and then render, an out-of-date dataset.
 */
export async function refreshWorkers(): Promise<void> {
	const request = ++latestRefresh;
	const dataset = await getWorksiteDataset();
	if (request !== latestRefresh) return;
	primeDataset(dataset);
	await invalidateAll();
}
