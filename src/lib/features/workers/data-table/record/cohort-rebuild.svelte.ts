/**
 * The record's cohort follows the organizer's own filter or sort change: the rows now showing
 * become the cohort, a record that left them moves to the first row, and a screen reader hears
 * what happened. The grid owns the table and the record; this owns the rebuild.
 */
import { tick, untrack } from 'svelte';
import { m } from '#lib/paraglide/messages.js';
import type { PersonPartition } from '#lib/shared/workers/person-state.svelte.ts';

/** What the rebuild reads from the grid and asks it to do. */
export type CohortRebuildHost = {
	person: () => PersonPartition;
	/** The rows the table shows now, with the name each one shows. */
	rows: () => readonly { id: string; original: { name: string } }[];
	/**
	 * The organizer's current filter and sort, as one comparable string. Anything that is not
	 * their own change (the address being normalized on mount) must not alter it.
	 */
	intentKey: () => string;
	/** The filter parameters in the address now. */
	filtersHash: () => string;
	/** Saves the open record's drafts; a refusal keeps the record and what was typed. */
	flushDrafts: () => Promise<boolean>;
	/** Opens or closes the narrow-screen sheet. */
	setSheet: (open: boolean) => void;
	isMobile: () => boolean;
};

export function createCohortRebuild(host: CohortRebuildHost) {
	/** What a screen reader hears when a deliberate filter or sort change rebuilds the list. */
	let notice = $state('');
	let previousKey: string | null = null;

	// Only the organizer's own filter or sort change rebuilds the cohort. Mount
	// normalization rewrites the address, never these columns, so it cannot reach here.
	$effect(() => {
		const key = host.intentKey();
		const previous = previousKey;
		previousKey = key;
		if (previous === null || previous === key) return;
		untrack(() => void rebuild());
	});

	async function rebuild() {
		await tick();
		const person = host.person();
		const rows = host.rows();
		const ids = rows.map((row) => row.id);
		person.workersCohort = ids;
		const sourceFocus = person.workersReturn?.sourceFocus ?? null;
		const hadRecord = person.workersSelectedId !== null || person.workersReturn !== null;
		if (!hadRecord) return;
		person.workersReturn = {
			sourceRoute: 'workers',
			sourceFocus,
			returnFiltersHash: host.filtersHash()
		};
		const first = rows[0];
		// A record still among the new rows keeps its place; one that left them moves to the first.
		const stillShown = ids.includes(person.workersSelectedId ?? '');
		if (person.workersSelectedId !== null && first && !stillShown) {
			if (!(await host.flushDrafts())) {
				notice = m.workers_cohort_rebuilt_blocked();
				return;
			}
			person.workersSelectedId = first.id;
			host.setSheet(host.isMobile());
		}
		const shownId = person.workersSelectedId;
		const name = rows.find((row) => row.id === shownId)?.original.name ?? first?.original.name;
		notice = name
			? m.workers_cohort_rebuilt({
					name,
					position: Math.max(1, ids.indexOf(shownId ?? '') + 1),
					count: ids.length
				})
			: m.workers_cohort_rebuilt_empty();
	}

	return {
		get notice() {
			return notice;
		}
	};
}
