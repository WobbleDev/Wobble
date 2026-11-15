import { beforeEach, describe, expect, it, vi } from 'vitest';

const invalidateAll = vi.fn(async () => {});
const getWorksiteDataset = vi.fn();
const primeDataset = vi.fn();

vi.mock('$app/navigation', () => ({ invalidateAll }));
vi.mock('#lib/client/dataset-api.ts', () => ({ getWorksiteDataset, primeDataset }));

const { refreshWorkers } = await import('./refresh-workers.ts');

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}

describe('refreshWorkers', () => {
	beforeEach(() => {
		invalidateAll.mockClear();
		getWorksiteDataset.mockReset();
		primeDataset.mockClear();
	});

	it('primes the dataset and invalidates', async () => {
		getWorksiteDataset.mockResolvedValueOnce({ id: 'only' });
		await refreshWorkers();
		expect(primeDataset).toHaveBeenCalledWith({ id: 'only' });
		expect(invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('ignores an older read that resolves after a newer one', async () => {
		const older = deferred<unknown>();
		const newer = deferred<unknown>();
		getWorksiteDataset.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

		const first = refreshWorkers();
		const second = refreshWorkers();
		newer.resolve({ id: 'newer' });
		await second;
		older.resolve({ id: 'older' });
		await first;

		expect(primeDataset).toHaveBeenCalledTimes(1);
		expect(primeDataset).toHaveBeenCalledWith({ id: 'newer' });
		expect(invalidateAll).toHaveBeenCalledTimes(1);
	});
});
