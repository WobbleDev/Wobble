import type { WorkerReply } from '#lib/client/generated/WorkerReply.ts';
import type {
	AssessmentOption,
	Worker,
	WorkerAttributeValue,
	WorkerAttributeValues,
	WorkerNote,
	WorkerNoteEdit,
	WorkerNoteInput,
	WorkerTextField
} from '#lib/domain-vocabulary.ts';
import { decodeWorker } from './api-decode.ts';
import { jsonInit, requestJson, requestVoid } from './request-json.ts';

/** Sends a Worker patch; the reply body is not read by any caller. */
async function patchWorker(
	workerId: string,
	payload: unknown,
	fallbackMessage: (status: number) => string
): Promise<void> {
	await requestVoid(
		`/api/workers/${encodeURIComponent(workerId)}`,
		jsonInit('PATCH', payload),
		fallbackMessage
	);
}

export function updateWorkerAttribute(
	workerId: string,
	attributeId: string,
	value: WorkerAttributeValue
): Promise<void> {
	return patchWorker(
		workerId,
		{ attributeId, value },
		(status) => `Could not save attribute (HTTP ${status}).`
	);
}

export function updateWorkerAssessment(
	workerId: string,
	assessment: AssessmentOption
): Promise<void> {
	return patchWorker(
		workerId,
		{ field: 'assessment', value: assessment },
		(status) => `Could not save assessment (HTTP ${status}).`
	);
}

/** Narrows a `{ worker }` write reply to the stored record it carries. */
export function decodeWorkerReply(value: unknown): Worker {
	const reply = value as WorkerReply;
	return decodeWorker(reply.worker);
}

/** Sends one Worker patch whose reply is the stored record. */
function patchWorkerForRecord(
	workerId: string,
	payload: unknown,
	fallbackMessage: (status: number) => string
): Promise<Worker> {
	return requestJson(
		`/api/workers/${encodeURIComponent(workerId)}`,
		jsonInit('PATCH', payload),
		fallbackMessage,
		decodeWorkerReply
	);
}

/**
 * Writes one of the Worker's free-text fields, and answers the stored record.
 * The core validates the value; the reply is untrusted like every other.
 */
export function updateWorkerField(
	workerId: string,
	field: WorkerTextField,
	value: string
): Promise<Worker> {
	return patchWorkerForRecord(
		workerId,
		{ field, value },
		(status) => `Could not save the ${field} (HTTP ${status}).`
	);
}

/**
 * Puts a previous stored value back, which is what a field's Undo sends. Phone uses
 * it because the value it restores may predate the format and the strict patch refuses
 * it; the core accepts a restore verbatim.
 */
export function restoreWorkerField(
	workerId: string,
	field: 'phone',
	value: string
): Promise<Worker> {
	return patchWorkerForRecord(
		workerId,
		{ field, value, action: 'restore' },
		(status) => `Could not put the ${field} back (HTTP ${status}).`
	);
}

/**
 * Adds one Note to the Worker and answers the stored record. The core mints the
 * Note's id and `timestamp`, so only the text is sent.
 */
export function addWorkerNote(workerId: string, note: WorkerNoteInput): Promise<Worker> {
	return patchWorkerForRecord(
		workerId,
		{ field: 'notes', action: 'add', value: note },
		(status) => `Could not add the Note (HTTP ${status}).`
	);
}

/** Rewrites one Note's text in place and answers the stored record. */
export function editWorkerNote(workerId: string, edit: WorkerNoteEdit): Promise<Worker> {
	return patchWorkerForRecord(
		workerId,
		{ field: 'notes', action: 'edit', value: edit },
		(status) => `Could not save the Note (HTTP ${status}).`
	);
}

/** Takes one Note off the Worker by id and answers the stored record. */
export function deleteWorkerNote(workerId: string, noteId: string): Promise<Worker> {
	return patchWorkerForRecord(
		workerId,
		{ field: 'notes', action: 'delete', value: { id: noteId } },
		(status) => `Could not delete the Note (HTTP ${status}).`
	);
}

/**
 * Puts a deleted Note back exactly as it was, which is what its Undo sends: the
 * whole Note, id and written time included, rather than a new one.
 */
export function restoreWorkerNote(workerId: string, note: WorkerNote): Promise<Worker> {
	return patchWorkerForRecord(
		workerId,
		{ field: 'notes', action: 'restore', value: note },
		(status) => `Could not put the note back (HTTP ${status}).`
	);
}

/**
 * Adds one Relationship pair and answers the stored record. The pair is symmetric,
 * so either Worker may be the one named; the core normalizes it.
 */
export function addWorkerRelationship(workerId: string, otherWorkerId: string): Promise<Worker> {
	return patchWorkerForRecord(
		workerId,
		{ field: 'relationships', action: 'add', value: { id: otherWorkerId } },
		(status) => `Could not add the Relationship (HTTP ${status}).`
	);
}

/** Removes one Relationship pair and answers the stored record. */
export function removeWorkerRelationship(workerId: string, otherWorkerId: string): Promise<Worker> {
	return patchWorkerForRecord(
		workerId,
		{ field: 'relationships', action: 'remove', value: { id: otherWorkerId } },
		(status) => `Could not remove the Relationship (HTTP ${status}).`
	);
}

/** Links one worksite Agitation to this Worker and answers the stored record. */
export function assignWorkerAgitation(workerId: string, agitationId: string): Promise<Worker> {
	return patchWorkerForRecord(
		workerId,
		{ field: 'agitations', action: 'assign', value: { id: agitationId } },
		(status) => `Could not add the Agitation (HTTP ${status}).`
	);
}

/**
 * Unlinks one Agitation from this Worker only; the worksite's Agitation and every
 * other Worker's assignment stay (ADR-0004).
 */
export function unassignWorkerAgitation(workerId: string, agitationId: string): Promise<Worker> {
	return patchWorkerForRecord(
		workerId,
		{ field: 'agitations', action: 'unassign', value: { id: agitationId } },
		(status) => `Could not remove the Agitation (HTTP ${status}).`
	);
}

export async function deleteWorker(workerId: string): Promise<void> {
	await requestVoid(
		`/api/workers/${encodeURIComponent(workerId)}`,
		{ method: 'DELETE' },
		(status) => `Could not delete worker (HTTP ${status}).`
	);
}

/**
 * Creates one Worker with the Attributes chosen in the New Worker panel. The body
 * is the whole-record update shape the core already accepts, with empty contact
 * fields and no Notes, Relationships, Agitations or Languages yet.
 */
export async function createWorker(
	name: string,
	attributes: WorkerAttributeValues
): Promise<Worker> {
	return requestJson(
		'/api/workers',
		jsonInit('POST', {
			name,
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes,
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		}),
		(status) => `Could not add worker (HTTP ${status}).`,
		(value) => decodeWorkerReply(value)
	);
}

export function updateWorkerLanguages(workerId: string, languageIds: string[]): Promise<void> {
	return patchWorker(
		workerId,
		{ field: 'languages', value: languageIds },
		(status) => `Could not save languages (HTTP ${status}).`
	);
}
