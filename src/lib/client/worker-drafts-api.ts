import type { DraftReply } from '#lib/client/generated/DraftReply.ts';
import type { WorkerUpdate } from '#lib/domain-vocabulary.ts';
import { decodeWorkerUpdate, isRecord } from './api-decode.ts';
import { jsonInit, requestJson, requestVoid } from './request-json.ts';

/** The note composer's un-added state, carried with a draft. */
export type PendingNoteDraft = { text: string };

/** The Worker draft the core stores (ADR-0023). updatedAt is the core's own stamp. */
export type WorkerDraft = {
	update: WorkerUpdate;
	pendingNote: PendingNoteDraft;
	base: WorkerUpdate | null;
	updatedAt: string;
};

/** The part a caller sends; the core stamps updatedAt. */
export type WorkerDraftInput = {
	update: WorkerUpdate;
	pendingNote: PendingNoteDraft;
	base: WorkerUpdate | null;
};

function decodeDraftUpdate(value: unknown): WorkerUpdate {
	return decodeWorkerUpdate(value);
}

export function decodeDraft(value: unknown): WorkerDraft | null {
	const draft = value as DraftReply['draft'] | undefined;
	if (draft === null || draft === undefined) return null;
	return {
		update: decodeDraftUpdate(draft.update),
		pendingNote: { text: draft.pendingNote.text },
		base: draft.base === null ? null : decodeDraftUpdate(draft.base),
		updatedAt: draft.updatedAt
	};
}

/** The stored draft for one Worker (or the sentinel "new"), or null. */
export function getWorkerDraft(workerId: string): Promise<WorkerDraft | null> {
	return requestJson(
		`/api/worker-drafts/${encodeURIComponent(workerId)}`,
		{ method: 'GET' },
		(status) => `Could not load the draft (HTTP ${status}).`,
		(value) => decodeDraft(isRecord(value) ? value.draft : undefined)
	);
}

/** Writes (or replaces) one Worker's draft. */
export function saveWorkerDraft(workerId: string, draft: WorkerDraftInput): Promise<void> {
	return requestVoid(
		`/api/worker-drafts/${encodeURIComponent(workerId)}`,
		jsonInit('PUT', draft),
		(status) => `Could not save the draft (HTTP ${status}).`
	);
}

/** Forgets one Worker's draft. */
export function deleteWorkerDraft(workerId: string): Promise<void> {
	return requestVoid(
		`/api/worker-drafts/${encodeURIComponent(workerId)}`,
		{ method: 'DELETE' },
		(status) => `Could not discard the draft (HTTP ${status}).`
	);
}
