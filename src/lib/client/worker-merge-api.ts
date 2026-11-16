import type { MergeCommitted } from '#lib/client/generated/MergeCommitted.ts';
import type { MergePreview } from '#lib/client/generated/MergePreview.ts';
import type { MergeUndone } from '#lib/client/generated/MergeUndone.ts';
import { jsonInit, requestJson } from './request-json.ts';

export type { MergeCommitted, MergePreview, MergeUndone };

/** Which Worker's value a merge keeps for one conflict. */
export type MergeChoice = 'survivor' | 'absorbed';

/** One decision per conflict: Worker fields and Attributes, by field name and Attribute id. */
export type MergeDecisions = {
	scalars: Record<string, MergeChoice>;
	attributes: Record<string, MergeChoice>;
};

const mergeRoute = '/api/worker-merge';

/** What merging two Workers would decide and union. The core writes nothing. */
export function previewWorkerMerge(survivorId: string, absorbedId: string): Promise<MergePreview> {
	return requestJson(
		`${mergeRoute}/preview`,
		jsonInit('POST', { survivorId, absorbedId }),
		(status) => `Could not preview the merge (HTTP ${status}).`,
		(value) => value as MergePreview
	);
}

/**
 * Merges the second Worker into the first in one core transaction. `readSet` is the
 * preview's opaque digest; the core refuses (`merge_stale`) when the Workers changed since.
 */
export function mergeWorkers(
	survivorId: string,
	absorbedId: string,
	readSet: string,
	decisions: MergeDecisions
): Promise<MergeCommitted> {
	return requestJson(
		mergeRoute,
		jsonInit('POST', { survivorId, absorbedId, readSet, decisions }),
		(status) => `Could not merge the workers (HTTP ${status}).`,
		(value) => value as MergeCommitted
	);
}

/** Takes the remembered merge back, or refuses with `merge_undo_expired`. */
export function undoWorkerMerge(token: string): Promise<MergeUndone> {
	return requestJson(
		`${mergeRoute}/undo`,
		jsonInit('POST', { token }),
		(status) => `Could not undo the merge (HTTP ${status}).`,
		(value) => value as MergeUndone
	);
}
