/** How long the first-paint entrance animation runs: long enough for the last bulb to finish flickering on. */
export const ENTRANCE_ANIMATION_DURATION_MS = 2400;

export type OverviewEntranceAnimation = { generation: number };

export type EntranceAnimationLifecycle = {
	readonly generation: number;
	readonly pending: boolean;
	observe(worksiteId: string | null): boolean;
	claim(worksiteId: string): OverviewEntranceAnimation | null;
};

/** Counts each Worksite activation rather than each unique Worksite ID. */
export function createEntranceAnimationLifecycle(
	initialWorksiteId: string | null
): EntranceAnimationLifecycle {
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
