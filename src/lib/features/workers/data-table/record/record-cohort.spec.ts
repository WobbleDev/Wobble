import { describe, expect, it, vi } from 'vitest';
import type { Worker } from '#lib/domain-vocabulary.ts';
import { PersonPartition } from '#lib/shared/workers/person-state.svelte.ts';
import { createRecordCohort } from './record-cohort.svelte.ts';

const worker = (id: string, name = id.toUpperCase()) => ({ id, name }) as unknown as Worker;

function setup(
	overrides: { rows?: string[]; workers?: Worker[]; mobile?: boolean; flush?: boolean } = {}
) {
	const person = new PersonPartition();
	const rows = (overrides.rows ?? ['a', 'b', 'c']).map((id) => ({ id }));
	const workers = overrides.workers ?? ['a', 'b', 'c'].map((id) => worker(id));
	const flushDrafts = vi.fn(async () => overrides.flush ?? true);
	const scrollToRow = vi.fn();
	const setSheet = vi.fn();
	const focusHeading = vi.fn(async () => {});
	const closeRecord = vi.fn();
	const record = createRecordCohort({
		person: () => person,
		rows: () => rows,
		data: () => workers,
		flushDrafts,
		scrollToRow,
		isMobile: () => overrides.mobile ?? false,
		setSheet,
		focusHeading,
		closeRecord,
		filtersHash: () => 'department=sales'
	});
	return { record, person, workers, flushDrafts, scrollToRow, setSheet, focusHeading, closeRecord };
}

describe('the open record’s cohort', () => {
	it('captures the rows it was opened from and where closing returns to', () => {
		const { record, person } = setup();
		person.workersSelectedId = 'a';
		record.capture({ workerId: 'a', columnId: 'name' });
		expect(person.workersCohort).toEqual(['a', 'b', 'c']);
		expect(person.workersReturn).toEqual({
			sourceRoute: 'workers',
			sourceFocus: { workerId: 'a', columnId: 'name' },
			returnFiltersHash: 'department=sales'
		});
	});

	it('walks to the next and previous Worker and lands focus in the heading', async () => {
		const { record, person, scrollToRow, setSheet, focusHeading } = setup({ mobile: true });
		record.capture(null);
		person.workersSelectedId = 'b';

		await record.step(1);
		expect(person.workersSelectedId).toBe('c');
		expect(scrollToRow).toHaveBeenCalledWith(2);
		expect(setSheet).toHaveBeenCalledWith(true);
		expect(focusHeading).toHaveBeenCalled();

		await record.step(-1);
		expect(person.workersSelectedId).toBe('b');
		expect(scrollToRow).toHaveBeenLastCalledWith(1);
	});

	it('keeps the record and its input when the save is refused', async () => {
		const { record, person, scrollToRow } = setup({ flush: false });
		record.capture(null);
		person.workersSelectedId = 'b';
		await record.step(1);
		expect(person.workersSelectedId).toBe('b');
		expect(scrollToRow).not.toHaveBeenCalled();
	});

	it('stops at the ends of the snapshot without saving', async () => {
		const { record, person, flushDrafts } = setup();
		record.capture(null);
		person.workersSelectedId = 'c';
		await record.step(1);
		expect(person.workersSelectedId).toBe('c');
		expect(flushDrafts).not.toHaveBeenCalled();
	});

	it('skips a member deleted since the snapshot', async () => {
		const { record, person } = setup({ workers: [worker('a'), worker('c')] });
		record.capture(null);
		person.workersSelectedId = 'a';
		await record.step(1);
		expect(person.workersSelectedId).toBe('c');
	});

	it('reports the place in the cohort for the panel strip', () => {
		const { record, person } = setup();
		record.capture(null);
		person.workersSelectedId = 'b';
		expect(record.cohort).toMatchObject({
			position: 2,
			total: 3,
			hasPrevious: true,
			hasNext: true
		});
		person.workersSelectedId = 'a';
		expect(record.cohort).toMatchObject({ hasPrevious: false, hasNext: true });
	});

	it('drops the record, the cohort and the return context together', () => {
		const { record, person } = setup();
		record.capture({ workerId: 'a', columnId: 'name' });
		person.workersSelectedId = 'a';
		record.drop();
		expect(person.workersSelectedId).toBeNull();
		expect(person.workersCohort).toEqual([]);
		expect(person.workersReturn).toBeNull();
	});

	it('keeps an open Worker the rows no longer show, and says it is outside the filters', () => {
		const { record, person } = setup({ rows: ['a', 'c'] });
		person.workersSelectedId = 'b';
		expect(record.selectedRow).toBeUndefined();
		expect(record.selectedWorker?.id).toBe('b');
		expect(record.outsideFilters).toBe(true);
		expect(record.cohort.outsideFilters).toBe(true);
	});

	it('keeps the record open on a created Worker until the rows carry it', () => {
		const { record, person, workers } = setup({ workers: [worker('a')] });
		person.workersSelectedId = 'new';
		expect(record.selectedWorker).toBeUndefined();
		record.rememberCreated(worker('new', 'Ada'));
		expect(record.selectedWorker?.name).toBe('Ada');
		// The list still does not carry it, so the fallback is kept.
		record.forgetListed();
		expect(record.selectedWorker?.name).toBe('Ada');
		// Once the list carries it, the fallback is no longer needed.
		workers.push(worker('new', 'Ada'));
		record.forgetListed();
		expect(record.selectedWorker?.name).toBe('Ada');
	});

	it('shows the way back when the whole cohort is gone', () => {
		const { record, person, workers } = setup();
		record.capture(null);
		// Every member of the snapshot was deleted while the record was open.
		workers.length = 0;
		person.workersSelectedId = null;
		expect(record.cohortEmpty).toBe(true);
		expect(record.cohort.empty).toBe(true);
	});

	it('returns to the list by closing the sheet and the panel', () => {
		const { record, setSheet, closeRecord } = setup();
		record.returnToList();
		expect(setSheet).toHaveBeenCalledWith(false);
		expect(closeRecord).toHaveBeenCalled();
	});
});
