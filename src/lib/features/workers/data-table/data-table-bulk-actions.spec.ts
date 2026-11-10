import { describe, expect, it, vi } from 'vitest';
import type { AssessmentOption, Worker, WorkerAttributeValue } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import {
	bulkValueState,
	createBulkActions,
	runSingleEdit,
	type BulkEndpoints
} from './data-table-bulk-actions.ts';
import type { BulkCopy } from './bulk-actions-copy.ts';
import type { DataTableEditReport } from './data-table-features.ts';

/** The English copy the component passes in, so the reports read as users see them. */
const copy: BulkCopy = {
	assessmentField: 'Assessment',
	languagesField: 'Languages',
	reloadFailed: 'Could not reload the Workers table.',
	count: (count) => `${count} ${count === 1 ? 'worker' : 'workers'}`,
	saved: (field, count) => `Saved ${field} for ${count} ${count === 1 ? 'worker' : 'workers'}`,
	savedPartial: (field, applied, requested) =>
		`Saved ${field} for ${applied} of ${requested} workers`,
	assessmentFailed: (count) =>
		`Could not set the assessment for ${count} ${count === 1 ? 'worker' : 'workers'}.`,
	languagesFailed: (count) =>
		`Could not change the Languages for ${count} ${count === 1 ? 'worker' : 'workers'}.`,
	setFailed: (field, count) =>
		`Could not set ${field} for ${count} ${count === 1 ? 'worker' : 'workers'}.`,
	changeFailed: (field, count) =>
		`Could not change ${field} for ${count} ${count === 1 ? 'worker' : 'workers'}.`,
	deleteFailed: (count) => `Could not delete ${count} ${count === 1 ? 'worker' : 'workers'}.`,
	deleted: (count) => `${count} ${count === 1 ? 'worker' : 'workers'} deleted`,
	deletedPartial: (applied, total) => `Deleted ${applied} of ${total} workers`
};

const department = {
	id: 'department',
	name: 'Department',
	kind: 'category' as const,
	options: ['Front of House', 'Back of House'],
	answers: [
		{ id: 'fof', value: 'Front of House' },
		{ id: 'boh', value: 'Back of House' }
	]
};
const shifts = {
	id: 'shifts',
	name: 'Shifts',
	kind: 'tag' as const,
	options: ['Dinner', 'Brunch'],
	answers: [
		{ id: 'dinner', value: 'Dinner' },
		{ id: 'brunch', value: 'Brunch' }
	]
};
const spanish = { id: 'es', name: 'Spanish' };
const polish = { id: 'pl', name: 'Polish' };

const worker = (id: string, overrides: Partial<Worker> = {}) =>
	baseWorker({
		id,
		name: `Worker ${id}`,
		assessment: 'Supporter',
		attributes: { department: 'fof', shifts: ['dinner'] },
		languages: ['es'],
		...overrides
	});

/** The report's Undo, asserted present so callers do not have to narrow it. */
function undoOf(
	report: DataTableEditReport
): () => ReturnType<NonNullable<DataTableEditReport['undo']>> {
	if (!report.undo) throw new Error('expected the report to offer an Undo');
	return report.undo;
}

/**
 * Endpoint spies that record their calls and answer like the core does.
 *
 * Every endpoint takes an optional predicate that returns a message to reject
 * with, so a test can fail the first, a middle, or the last call of a batch and
 * can let a later attempt succeed.
 */
function endpoints(
	options: {
		assessmentFails?: (
			workerId: string,
			assessment: AssessmentOption,
			attempt: number
		) => string | null;
		languageFails?: (workerId: string, languageIds: string[], attempt: number) => string | null;
		attributeFails?: (
			workerId: string,
			attributeId: string,
			value: WorkerAttributeValue,
			attempt: number
		) => string | null;
		deleteFails?: (workerId: string, attempt: number) => string | null;
		refreshFails?: (attempt: number) => string | null;
	} = {}
) {
	const calls: {
		updateAssessment: [string, AssessmentOption][];
		updateLanguages: [string, string[]][];
		deleteWorker: string[];
	} = { updateAssessment: [], updateLanguages: [], deleteWorker: [] };
	const attributes: [string, string, WorkerAttributeValue][] = [];
	const attempted: string[] = [];
	let refreshes = 0;

	const refresh = vi.fn(async () => {
		refreshes += 1;
		const failure = options.refreshFails?.(refreshes);
		if (failure) throw new Error(failure);
	});

	const bulk: BulkEndpoints = {
		updateAssessment: async (workerId, assessment) => {
			attempted.push(workerId);
			const failure = options.assessmentFails?.(workerId, assessment, attempted.length);
			if (failure) throw new Error(failure);
			calls.updateAssessment.push([workerId, assessment]);
		},
		updateLanguages: async (workerId, languageIds) => {
			attempted.push(workerId);
			const failure = options.languageFails?.(workerId, [...languageIds], attempted.length);
			if (failure) throw new Error(failure);
			calls.updateLanguages.push([workerId, [...languageIds]]);
		},
		updateAttribute: async (workerId, attributeId, value) => {
			attempted.push(workerId);
			const failure = options.attributeFails?.(workerId, attributeId, value, attempted.length);
			if (failure) throw new Error(failure);
			attributes.push([workerId, attributeId, value]);
		},
		deleteWorker: async (workerId) => {
			attempted.push(workerId);
			const failure = options.deleteFails?.(workerId, attempted.length);
			if (failure) throw new Error(failure);
			calls.deleteWorker.push(workerId);
		},
		refresh
	};

	return {
		bulk,
		calls,
		attributes,
		attempted,
		deleted: calls.deleteWorker,
		refresh
	};
}

describe('the Workers table bulk appliers', () => {
	it('sets one assessment across the selection and undoes every previous standing', async () => {
		const { bulk, calls, refresh } = endpoints();
		const actions = createBulkActions(bulk, copy);
		const workers = [worker('a'), worker('b', { assessment: 'Disengaged' })];

		const report = await actions.setAssessment(workers, 'Hostile');

		expect(calls.updateAssessment).toEqual([
			['a', 'Hostile'],
			['b', 'Hostile']
		]);
		expect(report.message).toBe('Saved Assessment for 2 workers');
		// One reload for the batch, not one per Worker.
		expect(refresh).toHaveBeenCalledTimes(1);

		await undoOf(report)();

		expect(calls.updateAssessment.slice(2)).toEqual([
			['a', 'Supporter'],
			['b', 'Disengaged']
		]);
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('adds a language without duplicating it and restores the previous sets', async () => {
		const { bulk, calls } = endpoints();
		const actions = createBulkActions(bulk, copy);
		const workers = [worker('a', { languages: ['es'] }), worker('b', { languages: [] })];

		const report = await actions.addLanguage(workers, spanish);

		expect(calls.updateLanguages).toEqual([
			['a', ['es']],
			['b', ['es']]
		]);
		expect(report.message).toBe('Saved Languages for 2 workers');

		await undoOf(report)();

		expect(calls.updateLanguages.slice(2)).toEqual([
			['a', ['es']],
			['b', []]
		]);
	});

	it('removes a language from every selected worker', async () => {
		const { bulk, calls } = endpoints();
		const actions = createBulkActions(bulk, copy);

		const report = await actions.removeLanguage([worker('a', { languages: ['es', 'pl'] })], polish);

		expect(calls.updateLanguages).toEqual([['a', ['es']]]);
		expect(report.message).toBe('Saved Languages for 1 worker');
	});

	it('sets and clears a category for the whole selection', async () => {
		const { bulk, attributes } = endpoints();
		const actions = createBulkActions(bulk, copy);
		const workers = [
			worker('a'),
			worker('b', {
				attributes: { department: 'boh' }
			})
		];

		const set = await actions.setCategoryValue(workers, department, 'boh');
		expect(attributes).toEqual([
			['a', 'department', 'boh'],
			['b', 'department', 'boh']
		]);
		expect(set.message).toBe('Saved Department for 2 workers');

		const cleared = await actions.setCategoryValue(workers, department, '');
		expect(cleared.message).toBe('Saved Department for 2 workers');

		await undoOf(set)();

		expect(attributes.slice(4)).toEqual([
			['a', 'department', 'fof'],
			['b', 'department', 'boh']
		]);
	});

	it('adds and removes one tag across the selection', async () => {
		const { bulk, attributes } = endpoints();
		const actions = createBulkActions(bulk, copy);
		const workers = [
			worker('a'),
			worker('b', {
				attributes: { shifts: ['dinner', 'brunch'] }
			})
		];

		const added = await actions.addTag(workers, shifts, 'brunch');
		expect(attributes).toEqual([
			['a', 'shifts', ['dinner', 'brunch']],
			['b', 'shifts', ['dinner', 'brunch']]
		]);
		expect(added.message).toBe('Saved Shifts for 2 workers');

		const removed = await actions.removeTag(workers, shifts, 'dinner');
		expect(removed.message).toBe('Saved Shifts for 2 workers');

		await undoOf(removed)();

		expect(attributes.slice(4)).toEqual([
			['a', 'shifts', ['dinner']],
			['b', 'shifts', ['dinner', 'brunch']]
		]);
	});

	it("clears every tag across the selection and restores each Worker's own set", async () => {
		const { bulk, attributes } = endpoints();
		const actions = createBulkActions(bulk, copy);
		const workers = [worker('a'), worker('b', { attributes: { shifts: ['dinner', 'brunch'] } })];

		const cleared = await actions.clearTags(workers, shifts);
		expect(attributes).toEqual([
			['a', 'shifts', []],
			['b', 'shifts', []]
		]);
		expect(cleared.message).toBe('Saved Shifts for 2 workers');

		await undoOf(cleared)();

		expect(attributes.slice(2)).toEqual([
			['a', 'shifts', ['dinner']],
			['b', 'shifts', ['dinner', 'brunch']]
		]);
	});

	it('does nothing and offers no Undo when the selection is empty', async () => {
		const { bulk, refresh } = endpoints();
		const actions = createBulkActions(bulk, copy);

		const report = await actions.setAssessment([], 'Hostile');

		expect(report.message).toBe('Saved Assessment for 0 workers');
		expect(report.undo).toBeUndefined();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('deletes the selection once per worker and reports completion with no Undo', async () => {
		const { bulk, deleted, refresh } = endpoints();
		const actions = createBulkActions(bulk, copy);
		const workers = [
			worker('a', { relationships: ['b', 'survivor'] }),
			worker('b', { relationships: ['a'] })
		];

		const report = await actions.deleteWorkers(workers);

		expect(deleted).toEqual(['a', 'b']);
		expect(report.message).toBe('2 workers deleted');
		expect(refresh).toHaveBeenCalledTimes(1);
		// Recreating the records would not restore their ids or Relationships, so
		// the completion report deliberately carries no way back.
		expect(report.undo).toBeUndefined();
	});
});

describe('a batch that stops part-way', () => {
	it('stops at the first rejection, reloads anyway, and undoes only what saved', async () => {
		const { bulk, calls, attempted, refresh } = endpoints({
			assessmentFails: (workerId) => (workerId === 'a' ? 'Worker a could not be saved' : null)
		});
		const actions = createBulkActions(bulk, copy);
		const workers = [worker('a'), worker('b'), worker('c')];

		const report = await actions.setAssessment(workers, 'Hostile');

		// Only the first call is attempted, and it did not save.
		expect(attempted).toEqual(['a']);
		expect(calls.updateAssessment).toEqual([]);
		expect(report.message).toBe('Could not set the assessment for 3 workers.');
		expect(report.error).toBe('Worker a could not be saved');
		expect(report.undo).toBeUndefined();
		// The Workers table is reloaded even though the batch failed.
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('never runs the calls behind a middle failure and undoes the successful subset', async () => {
		const { bulk, calls, attempted, refresh } = endpoints({
			assessmentFails: (workerId) => (workerId === 'b' ? 'Worker b could not be saved' : null)
		});
		const actions = createBulkActions(bulk, copy);
		const workers = [worker('a'), worker('b'), worker('c')];

		const report = await actions.setAssessment(workers, 'Hostile');

		// The third update is never called.
		expect(attempted).toEqual(['a', 'b']);
		expect(calls.updateAssessment).toEqual([['a', 'Hostile']]);
		expect(report.message).toBe('Saved Assessment for 1 of 3 workers');
		expect(report.error).toBe('Worker b could not be saved');
		expect(refresh).toHaveBeenCalledTimes(1);

		await undoOf(report)();

		// Undo covers the Worker that saved, and only that one.
		expect(calls.updateAssessment.slice(1)).toEqual([['a', 'Supporter']]);
	});

	it('stops at a last-call failure and undoes the two that saved', async () => {
		const { bulk, calls } = endpoints({
			assessmentFails: (workerId) => (workerId === 'c' ? 'Worker c could not be saved' : null)
		});
		const actions = createBulkActions(bulk, copy);
		const workers = [worker('a'), worker('b'), worker('c')];

		const report = await actions.setAssessment(workers, 'Hostile');

		expect(report.message).toBe('Saved Assessment for 2 of 3 workers');
		expect(calls.updateAssessment).toEqual([
			['a', 'Hostile'],
			['b', 'Hostile']
		]);

		await undoOf(report)();

		expect(calls.updateAssessment.slice(2)).toEqual([
			['a', 'Supporter'],
			['b', 'Supporter']
		]);
	});

	it('reports a partial Language change through the same runner', async () => {
		const { bulk, calls, attempted } = endpoints({
			languageFails: (workerId) => (workerId === 'b' ? 'Worker b could not be saved' : null)
		});
		const actions = createBulkActions(bulk, copy);
		const workers = [
			worker('a', { languages: [] }),
			worker('b', { languages: [] }),
			worker('c', { languages: [] })
		];

		const report = await actions.addLanguage(workers, polish);

		expect(attempted).toEqual(['a', 'b']);
		expect(calls.updateLanguages).toEqual([['a', ['pl']]]);
		expect(report.message).toBe('Saved Languages for 1 of 3 workers');
		expect(report.error).toBe('Worker b could not be saved');
	});

	it('keeps the apply failure and the reload failure independently visible', async () => {
		const { bulk, refresh } = endpoints({
			assessmentFails: (workerId) => (workerId === 'b' ? 'Worker b could not be saved' : null),
			refreshFails: (attempt) => (attempt === 1 ? 'The Workers table could not be reloaded' : null)
		});
		const actions = createBulkActions(bulk, copy);

		const report = await actions.setAssessment([worker('a'), worker('b')], 'Hostile');

		expect(report.message).toBe('Saved Assessment for 1 of 2 workers');
		expect(report.error).toBe('Worker b could not be saved');
		expect(report.refreshError).toBe('The Workers table could not be reloaded');
		// A reload error must not hide the original failure.
		expect(report.error).not.toBe(report.refreshError);

		await report.retryRefresh?.();
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('surfaces a reload that fails again, rather than swallowing it', async () => {
		const { bulk } = endpoints({ refreshFails: (attempt) => `Reload failed (${attempt})` });
		const actions = createBulkActions(bulk, copy);

		const report = await actions.setAssessment([worker('a')], 'Hostile');

		expect(report.refreshError).toBe('Reload failed (1)');
		await expect(report.retryRefresh?.()).rejects.toThrow('Reload failed (2)');
	});

	it('reports a reload failure after a full save without claiming less was applied', async () => {
		const { bulk, refresh } = endpoints({
			refreshFails: (attempt) => (attempt === 1 ? 'The Workers table could not be reloaded' : null)
		});
		const actions = createBulkActions(bulk, copy);

		const report = await actions.setAssessment([worker('a'), worker('b')], 'Hostile');

		expect(report.message).toBe('Saved Assessment for 2 workers');
		expect(report.error).toBeUndefined();
		expect(report.refreshError).toBe('The Workers table could not be reloaded');
		expect(report.retryRefresh).toBeDefined();

		await report.retryRefresh?.();
		expect(refresh).toHaveBeenCalledTimes(2);
	});
});

describe('an Undo that stops part-way', () => {
	it('refreshes, keeps the restorations it could not make, and retries only those', async () => {
		let refuseWorkerB = true;
		const { bulk, calls, refresh } = endpoints({
			assessmentFails: (workerId, assessment) =>
				refuseWorkerB && workerId === 'b' && assessment === 'Supporter'
					? 'Worker b could not be restored'
					: null
		});
		const actions = createBulkActions(bulk, copy);
		const workers = [worker('a'), worker('b'), worker('c')];

		const report = await actions.setAssessment(workers, 'Hostile');
		expect(calls.updateAssessment).toEqual([
			['a', 'Hostile'],
			['b', 'Hostile'],
			['c', 'Hostile']
		]);

		const undo = undoOf(report);
		const first = await undo();

		expect(first).toEqual({
			restored: 1,
			total: 3,
			remaining: 2,
			error: 'Worker b could not be restored',
			refreshError: null
		});
		// Refreshed even though a restoration failed.
		expect(refresh).toHaveBeenCalledTimes(2);

		refuseWorkerB = false;
		const second = await undo();

		expect(second).toEqual({
			restored: 2,
			total: 3,
			remaining: 0,
			error: null,
			refreshError: null
		});
		// Worker a was not restored twice.
		expect(calls.updateAssessment.slice(3)).toEqual([
			['a', 'Supporter'],
			['b', 'Supporter'],
			['c', 'Supporter']
		]);
	});

	it('reports a reload failure during Undo without dropping the restorations', async () => {
		let reloads = 0;
		const { bulk } = endpoints({
			refreshFails: () => {
				reloads += 1;
				return reloads > 1 ? 'The Workers table could not be reloaded' : null;
			}
		});
		const actions = createBulkActions(bulk, copy);

		const report = await actions.setAssessment([worker('a')], 'Hostile');
		const result = await undoOf(report)();

		expect(result.restored).toBe(1);
		expect(result.remaining).toBe(0);
		expect(result.refreshError).toBe('The Workers table could not be reloaded');
	});
});

describe('a partial delete', () => {
	it('is reported as irreversible rather than offered as recreation', async () => {
		const { bulk, deleted, attempted, refresh } = endpoints({
			deleteFails: (workerId) => (workerId === 'b' ? 'Worker b could not be deleted' : null)
		});
		const actions = createBulkActions(bulk, copy);

		const report = await actions.deleteWorkers([worker('a'), worker('b'), worker('c')]);

		expect(attempted).toEqual(['a', 'b']);
		expect(deleted).toEqual(['a']);
		expect(report.message).toBe('Deleted 1 of 3 workers');
		expect(report.error).toBe('Worker b could not be deleted');
		// Recreating the deleted Worker would not be a restoration.
		expect(report.undo).toBeUndefined();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('keeps the reload failure visible beside the delete failure', async () => {
		const { bulk } = endpoints({
			deleteFails: (workerId) => (workerId === 'b' ? 'Worker b could not be deleted' : null),
			refreshFails: (attempt) => (attempt === 1 ? 'The Workers table could not be reloaded' : null)
		});
		const actions = createBulkActions(bulk, copy);

		const report = await actions.deleteWorkers([worker('a'), worker('b')]);

		expect(report.message).toBe('Deleted 1 of 2 workers');
		expect(report.error).toBe('Worker b could not be deleted');
		expect(report.refreshError).toBe('The Workers table could not be reloaded');
		expect(report.retryRefresh).toBeDefined();
		expect(report.undo).toBeUndefined();
	});
});

describe('a single-Worker edit', () => {
	/** Fakes whose nth call can be made to reject; counts every call. */
	function fakes(
		options: { applyFails?: boolean; refreshFails?: number; restoreFails?: number } = {}
	) {
		const calls = { apply: 0, restore: 0, refresh: 0 };
		let refreshFails = options.refreshFails ?? 0;
		let restoreFails = options.restoreFails ?? 0;
		return {
			calls,
			apply: async () => {
				calls.apply += 1;
				if (options.applyFails) throw new Error('write rejected');
			},
			restore: async () => {
				calls.restore += 1;
				if (restoreFails-- > 0) throw new Error('restore rejected');
			},
			refresh: async () => {
				calls.refresh += 1;
				if (refreshFails-- > 0) throw new Error('reload rejected');
			}
		};
	}

	const base = { summary: 'Assessment for Ana set to Ally', fallback: 'Could not save.' };

	it('reports the change and offers Undo when the write and reload succeed', async () => {
		const f = fakes();
		const report = await runSingleEdit({ ...base, ...f });

		expect(report.message).toBe(base.summary);
		expect(report.error).toBeUndefined();
		expect(report.refreshError).toBeUndefined();
		expect(report.retryRefresh).toBeUndefined();
		expect(report.undo).toBeDefined();
	});

	it('reports a failed reload separately and keeps Undo when the write landed', async () => {
		const f = fakes({ refreshFails: 1 });
		const report = await runSingleEdit({ ...base, ...f });

		expect(report.error).toBeUndefined();
		expect(report.refreshError).toBe('reload rejected');
		expect(report.retryRefresh).toBeDefined();
		expect(report.undo).toBeDefined();
	});

	it('retries only the reload, and can fail again', async () => {
		const f = fakes({ refreshFails: 2 });
		const report = await runSingleEdit({ ...base, ...f });

		await expect(report.retryRefresh!()).rejects.toThrow('reload rejected');
		await expect(report.retryRefresh!()).resolves.toBeUndefined();
		expect(f.calls.apply).toBe(1);
		expect(f.calls.refresh).toBe(3);
	});

	it('reports a failed write with no Undo, no retry and no reload', async () => {
		const f = fakes({ applyFails: true });
		const report = await runSingleEdit({ ...base, ...f });

		expect(report.error).toBe('write rejected');
		expect(report.undo).toBeUndefined();
		expect(report.retryRefresh).toBeUndefined();
		expect(f.calls.refresh).toBe(0);
	});

	it('restores and reloads on Undo', async () => {
		const f = fakes();
		const report = await runSingleEdit({ ...base, ...f });

		const result = await undoOf(report)();
		expect(result).toMatchObject({ restored: 1, total: 1, remaining: 0, error: null });
		expect(result.refreshError).toBeNull();
		expect(f.calls.refresh).toBe(2);
	});

	it('says so when the restore landed but its reload failed', async () => {
		const f = fakes();
		const failing = await runSingleEdit({
			...base,
			apply: f.apply,
			restore: f.restore,
			refresh: async () => {
				throw new Error('reload rejected');
			}
		});

		const result = await undoOf(failing)();
		expect(result.refreshError).toBe('reload rejected');
		expect(result.remaining).toBe(0);
		expect(result.retryRefresh).toBeDefined();
	});

	it('keeps Undo retryable when the restore fails', async () => {
		const f = fakes({ restoreFails: 1 });
		const report = await runSingleEdit({ ...base, ...f });
		const undo = undoOf(report);

		const first = await undo();
		expect(first).toMatchObject({ restored: 0, remaining: 1, error: 'restore rejected' });

		const second = await undo();
		expect(second).toMatchObject({ restored: 1, remaining: 0, error: null });
	});

	it('never offers Undo without a restore, as with deletion', async () => {
		const f = fakes({ refreshFails: 1 });
		const report = await runSingleEdit({
			summary: 'Ana deleted',
			fallback: 'Could not delete.',
			apply: f.apply,
			refresh: f.refresh
		});

		expect(report.refreshError).toBe('reload rejected');
		expect(report.retryRefresh).toBeDefined();
		expect(report.undo).toBeUndefined();
	});
});

describe('bulkValueState', () => {
	const holdsSpanish = (candidate: Worker) => candidate.languages.includes('es');

	it('answers none for an empty list', () => {
		expect(bulkValueState([], holdsSpanish)).toBe('none');
	});

	it('answers all when every Worker holds it', () => {
		expect(bulkValueState([worker('a'), worker('b')], holdsSpanish)).toBe('all');
	});

	it('answers some when one of two holds it', () => {
		const without = worker('b', { languages: [] });
		expect(bulkValueState([worker('a'), without], holdsSpanish)).toBe('some');
	});

	it('answers none when none of two holds it', () => {
		const first = worker('a', { languages: [] });
		const second = worker('b', { languages: [] });
		expect(bulkValueState([first, second], holdsSpanish)).toBe('none');
	});
});
