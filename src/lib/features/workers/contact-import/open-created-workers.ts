/**
 * Continuation after an import: the created Workers open in the Workers record, through
 * the same outside-filters path a created Worker takes. The ids become a private,
 * transient cohort in renderer memory (the record's Previous and Next walk it); it is
 * never saved, and never written to the address.
 */
import { personState } from '#lib/shared/person-state.svelte.ts';

export function openCreatedWorkers(
	worksiteId: string | null,
	ids: readonly string[],
	filtersHash: string
) {
	const first = ids[0];
	if (first === undefined) return;
	const person = personState.forWorksite(worksiteId);
	person.workersCohort = [...ids];
	person.workersReturn = {
		sourceRoute: 'workers',
		sourceFocus: null,
		returnFiltersHash: filtersHash
	};
	person.workersSelectedId = first;
}
