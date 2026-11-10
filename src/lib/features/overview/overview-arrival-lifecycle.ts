/** How long the first-paint arrival runs: long enough for the last bulb to finish flickering on. */
export const ARRIVAL_DURATION_MS = 2400;

export type OverviewArrival = { generation: number };

export type ArrivalLifecycle = {
	readonly generation: number;
	readonly pending: boolean;
	observe(worksiteId: string | null): boolean;
	claim(worksiteId: string): OverviewArrival | null;
};

/** Counts each Worksite activation rather than each unique Worksite ID. */
export function createArrivalLifecycle(initialWorksiteId: string | null): ArrivalLifecycle {
	let observedWorksiteId = initialWorksiteId;
	let pending = initialWorksiteId !== null;
	let generation = initialWorksiteId === null ? 0 : 1;

	return {
		get generation() {
			return generation;
		},
		get pending() {
			return pending;
		},
		observe(worksiteId) {
			if (worksiteId === observedWorksiteId) return false;
			observedWorksiteId = worksiteId;
			generation += 1;
			pending = worksiteId !== null;
			return true;
		},
		claim(worksiteId) {
			if (!pending || observedWorksiteId !== worksiteId) return null;
			pending = false;
			return { generation };
		}
	};
}
