import { invalidateAll } from '$app/navigation';
import { getWorksiteDataset, primeDataset } from '#lib/client/dataset-api.ts';

/**
 * Reloads the Workers table after a Worker write, and rejects when it cannot.
 *
 * `invalidateAll()` never rejects: a throwing layout load swaps in the root
 * error page. So the dataset is read first; if that fails the refresh rejects
 * and the page keeps its last good data. Only a readable dataset is let through
 * to `invalidateAll()`. The one-shot hand-off supplies that layout reload.
 */
export async function refreshWorkers(): Promise<void> {
	const dataset = await getWorksiteDataset();
	primeDataset(dataset);
	await invalidateAll();
}
