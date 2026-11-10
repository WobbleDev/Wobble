/**
 * The Workers table's bulk appliers: one change, one call per selected Worker through
 * the same endpoints the Workers table cells use, and one report whose undo puts every
 * previous value back.
 *
 * The endpoints are injected rather than imported so this module can be tested
 * without a browser or a running core; `data-table-bulk-bar.svelte` wires them
 * to `#lib/client/workers-api.ts` and `refreshWorkers`.
 *
 * Every previous value is read before the first call is made, because the
 * Workers table reloads once the batch lands and the Worker objects handed in are
 * replaced by fresh ones.
 *
 * A batch is sequential, not atomic: a rejected call stops the loop, never runs
 * the calls behind it, and is reported as a partial result. The one reload after
 * the loop runs either way, and an Undo carries what it could not yet restore so
 * a retry never reruns a restoration that already landed.
 */
import type { Language, Worker } from '#lib/domain-vocabulary.ts';
import type {
	AssessmentOption,
	WorkerAttributeDefinition,
	WorkerAttributeValue
} from '#lib/domain-vocabulary.ts';
import { pickAnswer } from '#lib/shared/select-mode.ts';
import { heldCategoryAnswerId, heldTagAnswerIds } from '../answers.ts';
import { ApiError } from '#lib/client/api-error.ts';
import type { DataTableEditReport, DataTableUndoResult } from './data-table-features.ts';
import type { BulkCopy } from './bulk-actions-copy.ts';

export type BulkEndpoints = {
	updateAssessment: (workerId: string, assessment: AssessmentOption) => Promise<void>;
	updateLanguages: (workerId: string, languageIds: string[]) => Promise<void>;
	updateAttribute: (
		workerId: string,
		attributeId: string,
		value: WorkerAttributeValue
	) => Promise<void>;
	/** Removes a Worker outright. There is no restore endpoint to pair with it. */
	deleteWorker: (workerId: string) => Promise<void>;
	/** Reloads the Workers table once a batch has landed, rather than once per Worker. */
	refresh: () => Promise<void>;
};

/** The one direction of a change and the call that takes it back. */
type Step = {
	apply: () => Promise<void>;
	restore: () => Promise<void>;
};

/** How a set of Workers stands on one value: every one holds it, some do, or none does. */
export function bulkValueState(
	workers: readonly Worker[],
	holds: (worker: Worker) => boolean
): 'all' | 'some' | 'none' {
	if (workers.length === 0) return 'none';
	const held = workers.filter(holds).length;
	if (held === 0) return 'none';
	return held === workers.length ? 'all' : 'some';
}

/** The endpoint's own words when it threw an Error, and a plain fallback when it did not. */
function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/** The core's stable code for a failed write (ADR-0024), so the UI can word it. */
function errorCodeOf(error: unknown): string | undefined {
	return error instanceof ApiError ? error.code : undefined;
}

/** The whole-batch summary when everything saved, and an explicit count when it did not. */
function appliedMessage(
	attribute: string,
	applied: number,
	requested: number,
	copy: BulkCopy
): string {
	return applied === requested
		? copy.saved(attribute, requested)
		: copy.savedPartial(attribute, applied, requested);
}

/** The one reload a batch does, kept separate so its failure cannot replace the apply's. */
async function reload(refresh: () => Promise<void>, fallback: string): Promise<string | null> {
	try {
		await refresh();
		return null;
	} catch (error) {
		return messageOf(error, fallback);
	}
}

/**
 * Runs the applies in order and stops at the first rejection. The reload still
 * runs, because a partial batch is exactly when the Workers table most needs to be
 * authoritative again.
 *
 * Applies alone, not steps: a deletion has no restoration to pair with them.
 */
async function runApplies(
	applies: readonly (() => Promise<void>)[],
	refresh: () => Promise<void>,
	fallback: string
): Promise<{ applied: number; applyError: string | null; refreshError: string | null }> {
	let applied = 0;
	let applyError: string | null = null;

	for (const apply of applies) {
		try {
			await apply();
		} catch (error) {
			applyError = messageOf(error, fallback);
			break;
		}
		// Counted only after the response, so Undo never covers an unexecuted step.
		applied += 1;
	}

	return { applied, applyError, refreshError: await reload(refresh, fallback) };
}

/**
 * Builds an Undo over items whose restorations may fail part-way. It is
 * resumable: each call keeps the items it has not restored yet, so pressing
 * Undo again retries only those.
 */
function resumableUndo<T>(
	items: readonly T[],
	restore: (item: T) => Promise<void>,
	refresh: () => Promise<void>,
	fallback: string
): () => Promise<DataTableUndoResult> {
	const remaining = [...items];
	const total = items.length;

	return async () => {
		let restored = 0;
		let error: string | null = null;

		while (remaining.length > 0) {
			const item = remaining[0];
			try {
				await restore(item);
			} catch (cause) {
				error = messageOf(cause, fallback);
				break;
			}
			remaining.shift();
			restored += 1;
		}

		// Refreshed even when a restore failed: the Workers table must show what is true now.
		const refreshError = await reload(refresh, fallback);
		return { restored, total, remaining: remaining.length, error, refreshError };
	};
}

/** One Worker's change: the write, its way back (absent for deletion), and the reload. */
export type SingleEdit = {
	apply: () => Promise<void>;
	/** Absent when the change cannot be taken back, as with deletion. */
	restore?: () => Promise<void>;
	/** Reloads the Workers table. Run after the write, never as part of it. */
	refresh: () => Promise<void>;
	/** The report's message once the write has landed. */
	summary: string;
	/** The error text when the write rejects with something that is not an Error. */
	fallback: string;
};

/**
 * Runs one Worker's change and reports it. Whether it persisted is decided by
 * the write alone: a reload that fails afterwards is reported as a reload
 * failure, with a retry that only reloads, and the Undo for what landed.
 */
export async function runSingleEdit(edit: SingleEdit): Promise<DataTableEditReport> {
	try {
		await edit.apply();
	} catch (error) {
		return {
			message: edit.fallback,
			error: messageOf(error, edit.fallback),
			errorCode: errorCodeOf(error)
		};
	}

	const refreshError = await reload(edit.refresh, edit.fallback);
	const { restore, refresh } = edit;
	const undo = restore
		? resumableUndo([restore], (step) => step(), refresh, edit.fallback)
		: undefined;

	return {
		message: edit.summary,
		...(refreshError ? { refreshError, retryRefresh: () => refresh() } : {}),
		...(undo
			? {
					undo: async () => {
						const result = await undo();
						// A restore that landed but could not be shown still needs a reload-only retry.
						return result.refreshError ? { ...result, retryRefresh: () => refresh() } : result;
					}
				}
			: {})
	};
}

export function createBulkActions(endpoints: BulkEndpoints, copy: BulkCopy) {
	/**
	 * Runs one change for every Worker and hands back the report for it. Both
	 * directions are built before the first call, so the undo closes over the
	 * values the Workers table held when the operator pressed the control.
	 */
	async function batch(
		workers: readonly Worker[],
		change: (worker: Worker) => Step,
		attribute: string,
		fallback: string
	): Promise<DataTableEditReport> {
		const steps = workers.map(change);
		const { applied, applyError, refreshError } = await runApplies(
			steps.map((step) => step.apply),
			endpoints.refresh,
			fallback
		);
		// Only the steps that ran have a previous value worth putting back.
		const done = steps.slice(0, applied);

		return {
			...(applyError ? { error: applyError } : {}),
			...(refreshError ? { refreshError, retryRefresh: () => endpoints.refresh() } : {}),
			message:
				applied === 0 && applyError
					? fallback
					: appliedMessage(attribute, applied, workers.length, copy),
			// Nothing landed, so there is nothing to take back.
			...(done.length > 0
				? {
						undo: resumableUndo(done, (step) => step.restore(), endpoints.refresh, fallback)
					}
				: {})
		};
	}

	return {
		/** Sets one Assessment across the selection. */
		setAssessment(
			workers: readonly Worker[],
			assessment: AssessmentOption
		): Promise<DataTableEditReport> {
			return batch(
				workers,
				(worker) => ({
					apply: () => endpoints.updateAssessment(worker.id, assessment),
					restore: () => endpoints.updateAssessment(worker.id, worker.assessment)
				}),
				copy.assessmentField,
				copy.assessmentFailed(workers.length)
			);
		},

		/** Adds one Language to every selected Worker. */
		addLanguage(workers: readonly Worker[], language: Language): Promise<DataTableEditReport> {
			return batch(
				workers,
				(worker) => ({
					apply: () =>
						endpoints.updateLanguages(worker.id, [...new Set([...worker.languages, language.id])]),
					restore: () => endpoints.updateLanguages(worker.id, [...worker.languages])
				}),
				copy.languagesField,
				copy.languagesFailed(workers.length)
			);
		},

		/** Takes one Language off every selected Worker. */
		removeLanguage(workers: readonly Worker[], language: Language): Promise<DataTableEditReport> {
			return batch(
				workers,
				(worker) => ({
					apply: () =>
						endpoints.updateLanguages(
							worker.id,
							worker.languages.filter((id) => id !== language.id)
						),
					restore: () => endpoints.updateLanguages(worker.id, [...worker.languages])
				}),
				copy.languagesField,
				copy.languagesFailed(workers.length)
			);
		},

		/** Sets the one answer a Category holds across the selection, by answer id; `''` is None. */
		setCategoryValue(
			workers: readonly Worker[],
			attribute: WorkerAttributeDefinition,
			answerId: string
		): Promise<DataTableEditReport> {
			return batch(
				workers,
				(worker) => ({
					apply: () => endpoints.updateAttribute(worker.id, attribute.id, answerId),
					restore: () =>
						endpoints.updateAttribute(
							worker.id,
							attribute.id,
							heldCategoryAnswerId(worker, attribute)
						)
				}),
				attribute.name,
				copy.setFailed(attribute.name, workers.length)
			);
		},

		/** Adds one Tag, by answer id, to every selected Worker that does not already hold it. */
		addTag(
			workers: readonly Worker[],
			attribute: WorkerAttributeDefinition,
			answerId: string
		): Promise<DataTableEditReport> {
			return batch(
				workers,
				(worker) => ({
					apply: () => {
						const held = heldTagAnswerIds(worker, attribute);
						return endpoints.updateAttribute(
							worker.id,
							attribute.id,
							held.includes(answerId) ? held : pickAnswer(attribute, held, answerId)
						);
					},
					restore: () =>
						endpoints.updateAttribute(worker.id, attribute.id, heldTagAnswerIds(worker, attribute))
				}),
				attribute.name,
				copy.changeFailed(attribute.name, workers.length)
			);
		},

		/** Clears every Tag on the selection. */
		clearTags(
			workers: readonly Worker[],
			attribute: WorkerAttributeDefinition
		): Promise<DataTableEditReport> {
			return batch(
				workers,
				(worker) => ({
					apply: () => endpoints.updateAttribute(worker.id, attribute.id, []),
					restore: () =>
						endpoints.updateAttribute(worker.id, attribute.id, heldTagAnswerIds(worker, attribute))
				}),
				attribute.name,
				copy.changeFailed(attribute.name, workers.length)
			);
		},

		/** Takes one Tag, by answer id, off every selected Worker that holds it. */
		removeTag(
			workers: readonly Worker[],
			attribute: WorkerAttributeDefinition,
			answerId: string
		): Promise<DataTableEditReport> {
			return batch(
				workers,
				(worker) => ({
					apply: () =>
						endpoints.updateAttribute(
							worker.id,
							attribute.id,
							heldTagAnswerIds(worker, attribute).filter((id) => id !== answerId)
						),
					restore: () =>
						endpoints.updateAttribute(worker.id, attribute.id, heldTagAnswerIds(worker, attribute))
				}),
				attribute.name,
				copy.changeFailed(attribute.name, workers.length)
			);
		},

		/**
		 * Deletes the selection and reports it as done. There is deliberately no
		 * Undo: the core has no restore endpoint, and recreating a Worker would not
		 * put it back — a delete loses the id, and with it every Relationship that
		 * pointed at it, whether or not the other end survived.
		 *
		 * A batch that stops part-way is reported the same way, with the count of
		 * what actually went; the records it deleted are not offered for recovery.
		 */
		async deleteWorkers(workers: readonly Worker[]): Promise<DataTableEditReport> {
			const fallback = copy.deleteFailed(workers.length);
			const { applied, applyError, refreshError } = await runApplies(
				workers.map((worker) => () => endpoints.deleteWorker(worker.id)),
				endpoints.refresh,
				fallback
			);

			return {
				message:
					applied === workers.length
						? copy.deleted(workers.length)
						: copy.deletedPartial(applied, workers.length),
				...(applyError ? { error: applyError } : {}),
				...(refreshError ? { refreshError, retryRefresh: () => endpoints.refresh() } : {})
			};
		}
	};
}

export type BulkActions = ReturnType<typeof createBulkActions>;
