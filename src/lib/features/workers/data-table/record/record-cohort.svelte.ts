/**
 * The open Worker's cohort: the ordered rows the record was opened from, where Previous and
 * Next walk, and where closing returns focus. The grid owns the table, the panel and the
 * address; this owns the record's neighbourhood so the component only renders it.
 */
import { SvelteSet } from 'svelte/reactivity';
import type { Worker } from '#lib/domain-vocabulary.ts';
import type { PersonPartition } from '#lib/shared/workers/person-state.svelte.ts';
import { cohortExhausted, cohortPosition } from '../filters/worker-cohort.ts';

/** What the cohort reads from the grid and asks it to do. */
export type RecordCohortHost = {
	/** The open record, its cohort snapshot and its return context. */
	person: () => PersonPartition;
	/** The rows the table shows now: the cohort is a snapshot of their ids. */
	rows: () => readonly { id: string }[];
	/** Every Worker, not only the filtered rows: a record opened out of the filters stays open. */
	data: () => readonly Worker[];
	/** Saves the open record's drafts; a refusal keeps the record and what was typed. */
	flushDrafts: () => Promise<boolean>;
	scrollToRow: (index: number) => void;
	/** Whether the record rides in the narrow-screen sheet. */
	isMobile: () => boolean;
	/** Opens or closes that sheet. */
	setSheet: (open: boolean) => void;
	/** Focus into the open record's heading, once the panel has rendered. */
	focusHeading: () => Promise<void>;
	/** Closes the panel itself, on the way back to the list. */
	closeRecord: () => void;
	/** The filter parameters in the address now. */
	filtersHash: () => string;
};

export function createRecordCohort(host: RecordCohortHost) {
	/**
	 * A Worker created while the list could not refresh: the record stays open on it until the
	 * rows carry it.
	 */
	let created = $state<Worker | null>(null);

	const selectedRow = $derived(
		host.person().workersSelectedId === null
			? undefined
			: host.rows().find((row) => row.id === host.person().workersSelectedId)
	);
	const selectedWorker = $derived.by(() => {
		const id = host.person().workersSelectedId;
		if (id === null) return undefined;
		return (
			host.data().find((worker) => worker.id === id) ?? (created?.id === id ? created : undefined)
		);
	});
	/** The open Worker is one the rows no longer show: the card says so. */
	const outsideFilters = $derived(!!selectedWorker && !selectedRow);
	const liveIds = $derived(new SvelteSet(host.data().map((worker) => worker.id)));
	const isLive = (id: string) => liveIds.has(id) || created?.id === id;
	const cohortAt = $derived(
		cohortPosition(host.person().workersCohort, host.person().workersSelectedId, isLive)
	);
	/** Every Worker of the list the record was opened from is gone: the card shows a way back. */
	const cohortEmpty = $derived(
		host.person().workersSelectedId === null && cohortExhausted(host.person().workersCohort, isLive)
	);

	/** Snapshots the rows now as Previous and Next walk, and where closing returns to. */
	function capture(sourceFocus: { workerId: string; columnId: string } | null) {
		host.person().workersCohort = host.rows().map((row) => row.id);
		host.person().workersReturn = {
			sourceRoute: 'workers',
			sourceFocus,
			returnFiltersHash: host.filtersHash()
		};
	}

	/** Drops the open record and its cohort; the return context goes with them. */
	function drop() {
		host.person().workersSelectedId = null;
		host.person().workersCohort = [];
		host.person().workersReturn = null;
	}

	/** Keeps the record open on a Worker the list could not refresh yet. */
	function rememberCreated(worker: Worker) {
		created = worker;
	}

	/** The rows carry the created Worker now, so the fallback is no longer needed. */
	function forgetListed() {
		if (created && host.data().some((worker) => worker.id === created?.id)) created = null;
	}

	/** Previous or Next: save what is typed first; a refused save keeps the record and its input. */
	async function step(direction: -1 | 1) {
		const target = direction < 0 ? cohortAt.previousId : cohortAt.nextId;
		if (target === null) return;
		if (!(await host.flushDrafts())) return;
		host.person().workersSelectedId = target;
		host.setSheet(host.isMobile());
		const index = host.rows().findIndex((row) => row.id === target);
		if (index >= 0) host.scrollToRow(index);
		await host.focusHeading();
	}

	/** The way back from the record: closes it and puts focus where the organizer came from. */
	function returnToList() {
		host.setSheet(false);
		host.closeRecord();
	}

	/** The record panel's Previous/Next/back strip, as the panel renders it. */
	const cohort = $derived({
		position: cohortAt.position,
		total: cohortAt.total,
		hasPrevious: cohortAt.previousId !== null,
		hasNext: cohortAt.nextId !== null,
		outsideFilters,
		empty: cohortEmpty,
		onPrevious: () => void step(-1),
		onNext: () => void step(1),
		onReturn: returnToList
	});

	return {
		get selectedRow() {
			return selectedRow;
		},
		get selectedWorker() {
			return selectedWorker;
		},
		get outsideFilters() {
			return outsideFilters;
		},
		get cohortEmpty() {
			return cohortEmpty;
		},
		get cohort() {
			return cohort;
		},
		capture,
		drop,
		rememberCreated,
		forgetListed,
		step,
		returnToList
	};
}
