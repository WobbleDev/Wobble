/**
 * The Worker merge dialog's behaviour: choose the surviving Worker, load the core's
 * preview, collect one decision per conflict, commit, and hand back an Undo for the one
 * recent merge the core remembers.
 *
 * The core owns every rule; this model only sequences the calls. The preview's `readSet`
 * is an opaque token sent back unchanged. A `merge_stale` refusal reloads the preview and
 * drops the decisions made against the old one.
 */
import { ApiError } from '#lib/client/api-error.ts';
import type {
	MergeChoice,
	MergeCommitted,
	MergeDecisions,
	MergePreview,
	MergeUndone
} from '#lib/client/workers-api.ts';
import type { Worker } from '#lib/domain-vocabulary.ts';
import type { DataTableUndoResult } from '../data-table/data-table-features.ts';

export type MergeHost = {
	preview: (survivorId: string, absorbedId: string) => Promise<MergePreview>;
	merge: (
		survivorId: string,
		absorbedId: string,
		readSet: string,
		decisions: MergeDecisions
	) => Promise<MergeCommitted>;
	undo: (token: string) => Promise<MergeUndone>;
	refresh: () => Promise<void>;
	copy: {
		failed: string;
		stale: string;
		undoExpired: string;
		undoFailed: string;
		reloadFailed: string;
	};
};

/** What a finished merge hands the table: which Workers, and how to take it back. */
export type MergeResult = {
	survivorId: string;
	absorbedId: string;
	undo: () => Promise<DataTableUndoResult>;
};

export function createMergeModel(host: MergeHost, workers: readonly [Worker, Worker]) {
	let survivorId = $state<string | null>(null);
	let preview = $state<MergePreview | null>(null);
	let loading = $state(false);
	let committing = $state(false);
	let errorMessage = $state('');
	let scalars = $state<Record<string, MergeChoice>>({});
	let attributes = $state<Record<string, MergeChoice>>({});
	/** Guards a slow preview from landing after the survivor changed. */
	let generation = 0;

	const absorbedId = $derived(
		survivorId === null ? null : (workers.find((worker) => worker.id !== survivorId)?.id ?? null)
	);
	const blockedDrafts = $derived(preview?.blockedDrafts ?? []);
	const undecided = $derived(
		(preview?.scalarConflicts ?? []).some((conflict) => !(conflict.field in scalars)) ||
			(preview?.attributeConflicts ?? []).some((conflict) => !(conflict.attributeId in attributes))
	);
	const canMerge = $derived(
		preview !== null && !loading && !committing && blockedDrafts.length === 0 && !undecided
	);

	async function load(survivor: string, absorbed: string): Promise<void> {
		const mine = ++generation;
		loading = true;
		preview = null;
		scalars = {};
		attributes = {};
		try {
			const loaded = await host.preview(survivor, absorbed);
			if (mine === generation) preview = loaded;
		} catch (error) {
			if (mine === generation) errorMessage = messageOf(error, host.copy.failed);
		} finally {
			if (mine === generation) loading = false;
		}
	}

	function messageOf(error: unknown, fallback: string): string {
		return error instanceof Error && error.message ? error.message : fallback;
	}

	function takeBack(token: string): () => Promise<DataTableUndoResult> {
		let done = false;
		return async () => {
			let error: string | null = null;
			if (!done) {
				try {
					await host.undo(token);
					done = true;
				} catch (cause) {
					// The core spends the token on any refusal, so a retry cannot succeed.
					done = true;
					error =
						cause instanceof ApiError && cause.code === 'merge_undo_expired'
							? host.copy.undoExpired
							: messageOf(cause, host.copy.undoFailed);
				}
			}
			let refreshError: string | null = null;
			try {
				await host.refresh();
			} catch {
				refreshError = host.copy.reloadFailed;
			}
			return {
				restored: error ? 0 : 1,
				total: 1,
				remaining: 0,
				error,
				refreshError
			};
		};
	}

	return {
		workers,
		get survivorId() {
			return survivorId;
		},
		get absorbedId() {
			return absorbedId;
		},
		get preview() {
			return preview;
		},
		get loading() {
			return loading;
		},
		get committing() {
			return committing;
		},
		get errorMessage() {
			return errorMessage;
		},
		get blockedDrafts() {
			return blockedDrafts;
		},
		get canMerge() {
			return canMerge;
		},
		scalarChoice: (field: string): MergeChoice | undefined => scalars[field],
		attributeChoice: (attributeId: string): MergeChoice | undefined => attributes[attributeId],
		decideScalar(field: string, choice: MergeChoice) {
			scalars[field] = choice;
		},
		decideAttribute(attributeId: string, choice: MergeChoice) {
			attributes[attributeId] = choice;
		},
		/** Picks the surviving Worker, which loads the preview for that direction. */
		async chooseSurvivor(id: string): Promise<void> {
			const other = workers.find((worker) => worker.id !== id);
			if (!other || !workers.some((worker) => worker.id === id)) return;
			survivorId = id;
			errorMessage = '';
			await load(id, other.id);
		},
		/** Commits the merge. Answers the result, or null with `errorMessage` set. */
		async commit(): Promise<MergeResult | null> {
			if (!canMerge || preview === null || survivorId === null || absorbedId === null) {
				return null;
			}
			committing = true;
			errorMessage = '';
			const survivor = survivorId;
			const absorbed = absorbedId;
			try {
				const committed = await host.merge(survivor, absorbed, preview.readSet, {
					scalars: { ...scalars },
					attributes: { ...attributes }
				});
				try {
					await host.refresh();
				} catch {
					// The merge landed; the table catches up on the next load.
				}
				return {
					survivorId: survivor,
					absorbedId: absorbed,
					undo: takeBack(committed.undoToken)
				};
			} catch (error) {
				if (error instanceof ApiError && error.code === 'merge_stale') {
					await load(survivor, absorbed);
					errorMessage = host.copy.stale;
				} else {
					errorMessage = messageOf(error, host.copy.failed);
				}
				return null;
			} finally {
				committing = false;
			}
		}
	};
}

export type MergeModel = ReturnType<typeof createMergeModel>;
