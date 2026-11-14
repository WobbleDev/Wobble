import type { DraftReply } from '#lib/client/generated/DraftReply.ts';
import type { MergeCommitted } from '#lib/client/generated/MergeCommitted.ts';
import type { MergePreview } from '#lib/client/generated/MergePreview.ts';
import type { MergeUndone } from '#lib/client/generated/MergeUndone.ts';
import type { WorkerReply } from '#lib/client/generated/WorkerReply.ts';
import type {
	Agitation,
	AttributeAnswer,
	AssessmentOption,
	ConfigurationPreview,
	ConfigurationPreviewAbbreviation,
	ConfigurationResolutions,
	Language,
	Worker,
	WorkerAttributeValue,
	WorkerAttributeValues,
	WorkerImportContact,
	WorkerNote,
	WorkerNoteEdit,
	WorkerNoteInput,
	WorkerTextField,
	WorkerUpdate
} from '#lib/domain-vocabulary.ts';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import {
	decodeAgitation,
	decodeConfigurationPreview,
	decodeAbbreviationSuggestions,
	decodeImportResult,
	type ImportResult,
	decodeLanguage,
	decodeWorker,
	decodeWorkerUpdate,
	isRecord
} from './api-decode.ts';
import { jsonInit, localizedJsonInit, requestJson, requestVoid } from './request-json.ts';

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

/** One accepted CSV row: the source row number the review showed, and the contact it becomes. */
export type ImportRowContact = WorkerImportContact & {
	row: number;
	/** The answers the review chose, by Attribute id, as the Attribute stores them. */
	attributes?: WorkerAttributeValues;
};

/**
 * Creates the accepted rows in one core transaction. `attributeIds` names the Attribute
 * definitions the review saw; the core refuses (`import_stale_vocabulary`) and creates
 * nothing when they changed since. Answers each created id against its source row.
 */
export function importContacts(
	contacts: ImportRowContact[],
	attributeIds: readonly string[]
): Promise<ImportResult> {
	return requestJson(
		'/api/workers',
		jsonInit('POST', { contacts, attributeIds }),
		(status) => `Could not import contacts (HTTP ${status}).`,
		decodeImportResult
	);
}

/** An Attribute answer in a Save payload; `mergedInto` folds it into the surviving answer's id. */
type AttributeAnswerWrite = AttributeAnswer & { mergedInto?: string };

/** An Attribute as the Save payload carries it: its answers, with ids and any merge marker. */
export type AttributeWrite = {
	id: string;
	name: string;
	kind: WorkerAttributeDefinition['kind'];
	options: AttributeAnswerWrite[];
};

/** The Save shapes an Attribute list travels as, so a save and a preview never disagree. */
export function attributeWrites(
	attributes: readonly WorkerAttributeDefinition[]
): AttributeWrite[] {
	return attributes.map((attribute) => ({
		id: attribute.id,
		name: attribute.name,
		kind: attribute.kind,
		options: attribute.answers
	}));
}

/** Saves the Worksite's Attributes; each answer is sent with the id it was minted or kept under. */
export async function saveAttributes(attributes: WorkerAttributeDefinition[]): Promise<void> {
	await requestVoid(
		'/api/attributes',
		localizedJsonInit('PUT', attributeWrites(attributes)),
		(status) => `Could not save attributes (HTTP ${status}).`
	);
}

/** The Save that removes a held leaf answer and carries each holder's resolution. */
export type ConfigurationAttributeSave = {
	attributes: AttributeWrite[];
	/** The preview base; the core refuses a stale one before writing anything. */
	base: string;
	resolutions: ConfigurationResolutions;
};

/**
 * Saves the Attributes together with the explicit resolutions of every affected Worker
 * value and draft surface. One request, one transaction: the preview base is rechecked and
 * a stale, incomplete or invalid plan writes nothing.
 */
export async function saveConfigurationAttributes(save: ConfigurationAttributeSave): Promise<void> {
	await requestVoid(
		'/api/attributes',
		localizedJsonInit('PUT', save),
		(status) => `Could not save attributes (HTTP ${status}).`
	);
}

/** An Agitation in a Save payload; `mergedInto` folds it into the surviving Agitation's id. */
export type AgitationWrite = Agitation & { mergedInto?: string };

/** A Language in a Save payload; `mergedInto` folds it into the surviving Language's id. */
export type LanguageWrite = Language & { mergedInto?: string };

/**
 * The three proposed sets the Configuration preview reconciles, in the Save shapes and
 * with the current merge markers. All three are required; the core refuses a missing one.
 */
export type ConfigurationPreviewRequest = {
	attributes: AttributeWrite[];
	agitations: AgitationWrite[];
	languages: LanguageWrite[];
};

/**
 * Asks the core what a proposed Save all would change. Read-only: the reply is validated
 * like every other untrusted body, and the draft remains the only thing a caller mutates.
 */
export function previewConfiguration(
	request: ConfigurationPreviewRequest
): Promise<ConfigurationPreview> {
	return requestJson(
		'/api/configuration/preview',
		localizedJsonInit('POST', request),
		(status) => `Could not check these changes (HTTP ${status}).`,
		decodeConfigurationPreview
	);
}

/**
 * Asks the core for the Abbreviation each value of a proposed Save would be stored with. Read
 * only and light: no impacts are computed, so it can follow every edit.
 */
export function suggestAbbreviations(
	request: ConfigurationPreviewRequest
): Promise<ConfigurationPreviewAbbreviation[]> {
	return requestJson(
		'/api/configuration/abbreviations',
		localizedJsonInit('POST', request),
		(status) => `Could not suggest Abbreviations (HTTP ${status}).`,
		decodeAbbreviationSuggestions
	);
}

export async function saveAgitations(agitations: AgitationWrite[]): Promise<void> {
	await requestVoid(
		'/api/agitations',
		jsonInit('PUT', agitations),
		(status) => `Could not save agitations (HTTP ${status}).`
	);
}

export async function saveLanguages(languages: LanguageWrite[]): Promise<void> {
	await requestVoid(
		'/api/languages',
		jsonInit('PUT', languages),
		(status) => `Could not save languages (HTTP ${status}).`
	);
}

export async function deleteWorksite(): Promise<void> {
	await requestVoid(
		'/api/worksite',
		{ method: 'DELETE' },
		(status) => `Could not delete the worksite (HTTP ${status}).`
	);
}

export async function saveWorksiteName(name: string): Promise<void> {
	await requestVoid(
		'/api/worksite',
		jsonInit('PUT', { name }),
		(status) => `Could not save the worksite name (HTTP ${status}).`
	);
}

export async function saveWorksiteCommitteeGoal(committeeGoal: number): Promise<void> {
	await requestVoid(
		'/api/worksite',
		jsonInit('PUT', { committeeGoal }),
		(status) => `Could not save the committee coverage goal (HTTP ${status}).`
	);
}

/** Creates the agitation, or returns the worksite's existing agitation with the same text. */
export function createAgitation(text: string): Promise<Agitation> {
	return requestJson(
		'/api/agitations',
		jsonInit('POST', { text }),
		(status) => `Could not add the Agitation (HTTP ${status}).`,
		decodeAgitation
	);
}

/** Creates the language, or returns the worksite's existing language with the same name. */
export function createLanguage(name: string): Promise<Language> {
	return requestJson(
		'/api/languages',
		jsonInit('POST', { name }),
		(status) => `Could not add the language (HTTP ${status}).`,
		decodeLanguage
	);
}

export function updateWorkerLanguages(workerId: string, languageIds: string[]): Promise<void> {
	return patchWorker(
		workerId,
		{ field: 'languages', value: languageIds },
		(status) => `Could not save languages (HTTP ${status}).`
	);
}

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
