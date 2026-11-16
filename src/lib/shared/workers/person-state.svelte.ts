/**
 * Person-specific state: which Worker is open, the Mapping person search. It lives in
 * renderer memory only, one partition per Worksite, for the life of the app root. It
 * survives in-app navigation and is gone on reload. It is never written to the
 * address or to any storage; the address carries the question (filters, grouping),
 * never a person.
 */

/** Legacy page parameters that named a person. Stripped on load, never emitted. */
export const personParams = ['q', 'sel', 'worker'] as const;

/** Removes the legacy person parameters in place, answering whether the address changed. */
export function stripPersonParams(params: URLSearchParams): boolean {
	let stripped = false;
	for (const key of personParams) {
		if (!params.has(key)) continue;
		params.delete(key);
		stripped = true;
	}
	return stripped;
}

/** Where an open Workers record came from, so closing it can return the organizer there. */
export type WorkersReturn = {
	sourceRoute: 'workers';
	/** The table cell the record was opened from; null when it was not opened from a cell. */
	sourceFocus: { workerId: string; columnId: string } | null;
	/** The filter parameters in the address when the record was opened or its cohort last rebuilt. */
	returnFiltersHash: string;
};

export class PersonPartition {
	/** The Worker open in the Workers record, or null. */
	workersSelectedId = $state<string | null>(null);
	/** The ordered Worker ids the Workers table showed when the record was opened; Previous/Next walk it. */
	workersCohort = $state.raw<readonly string[]>([]);
	/** The return context of the open record: where to send focus on close. */
	workersReturn = $state.raw<WorkersReturn | null>(null);
	/** The Worker selected on the Mapping, or ''. */
	mapSelectedId = $state('');
	/** The Mapping's person-name search text. */
	mapQuery = $state('');
}

export class PersonState {
	// Looked up, never observed: a SvelteMap would throw when a derived creates a partition.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	readonly #partitions = new Map<string, PersonPartition>();

	/** The partition of one Worksite; a missing Worksite gets a partition that is never shared. */
	forWorksite(worksiteId: string | null | undefined): PersonPartition {
		if (!worksiteId) return new PersonPartition();
		let partition = this.#partitions.get(worksiteId);
		if (!partition) {
			partition = new PersonPartition();
			this.#partitions.set(worksiteId, partition);
		}
		return partition;
	}
}

/** The root-lifetime instance: module scope outlives every route and dies with the page. */
export const personState = new PersonState();
