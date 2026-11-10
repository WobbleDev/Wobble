/**
 * The record panel's unsaved typing, as the Worker draft the core stores (ADR-0023),
 * and back. A draft is the current record with the open editors' text and Attribute
 * choices applied (`update`), the Note composer (`pendingNote`), and the record it was
 * taken from (`base`). Which editors to reopen is read back by comparing `update` with
 * `base`.
 */
import {
	workerTextFields,
	type Worker,
	type WorkerAttributeDefinition,
	type WorkerAttributeValue,
	type WorkerTextField
} from '#lib/domain-vocabulary.ts';
import type { PendingNoteDraft, WorkerDraft, WorkerDraftInput } from '#lib/client/workers-api.ts';
import { toWorkerUpdate } from '../worker-update.ts';

export type PanelTextField = WorkerTextField;

/** What each open panel editor holds, as typed. Absent = closed. */
export type OpenEditors = {
	[field in PanelTextField]?: string;
} & {
	composer?: PendingNoteDraft;
	/** Open Note edits, by Note id. */
	noteEdits: Record<string, PendingNoteDraft>;
	/** Open Attribute editors, by Attribute id: the choice not yet saved. */
	attributes: Record<string, WorkerAttributeValue>;
};

export function noEditors(): OpenEditors {
	return { noteEdits: {}, attributes: {} };
}

/** Two Attribute readings, treating a Multi-Select as a set: order never makes input unsaved. */
export function sameAttributeValue(
	first: WorkerAttributeValue | undefined,
	second: WorkerAttributeValue | undefined
): boolean {
	if (Array.isArray(first) || Array.isArray(second)) {
		if (!Array.isArray(first) || !Array.isArray(second)) return false;
		if (first.length !== second.length) return false;
		const values = new Set(second);
		return first.every((value) => values.has(value));
	}
	return (first ?? '') === (second ?? '');
}

/** A reading the caller owns: a Multi-Select list is copied, a Single-Select is a string. */
export function copyAttributeValue(value: WorkerAttributeValue): WorkerAttributeValue {
	return Array.isArray(value) ? [...value] : value;
}

/** True when some open editor holds something the record does not. */
export function hasUnsavedInput(worker: Worker, open: OpenEditors): boolean {
	for (const field of workerTextFields) {
		const value = open[field];
		if (value !== undefined && value.trim() !== worker[field]) return true;
	}
	for (const [attributeId, value] of Object.entries(open.attributes)) {
		if (!sameAttributeValue(value, worker.attributes[attributeId])) return true;
	}
	if (open.composer && open.composer.text.trim() !== '') return true;
	return worker.notes.some((note) => {
		const edit = open.noteEdits[note.id];
		return edit !== undefined && edit.text.trim() !== note.text;
	});
}

export function buildPanelDraft(
	worker: Worker,
	attributes: readonly WorkerAttributeDefinition[],
	open: OpenEditors
): WorkerDraftInput {
	const base = toWorkerUpdate(worker, attributes);
	const update = {
		...toWorkerUpdate(worker, attributes),
		...Object.fromEntries(workerTextFields.map((field) => [field, open[field] ?? base[field]])),
		attributes: {
			...base.attributes,
			...Object.fromEntries(
				Object.entries(open.attributes).map(([attributeId, value]) => [
					attributeId,
					copyAttributeValue(value)
				])
			)
		},
		notes: base.notes.map((note) => {
			const edit = open.noteEdits[note.id];
			return edit ? { ...note, text: edit.text } : note;
		})
	};
	return {
		update,
		pendingNote: open.composer ?? { text: '' },
		base
	};
}

/** Which editors a stored draft reopens, and with what. */
export function readPanelDraft(stored: WorkerDraft): OpenEditors {
	const open = noEditors();
	const { update, base } = stored;
	if (!base) return open;
	for (const field of workerTextFields) {
		if (update[field] !== base[field]) open[field] = update[field];
	}
	for (const [attributeId, value] of Object.entries(update.attributes)) {
		if (!sameAttributeValue(value, base.attributes[attributeId])) {
			open.attributes[attributeId] = copyAttributeValue(value);
		}
	}
	if (stored.pendingNote.text.trim() !== '') open.composer = { ...stored.pendingNote };
	for (const note of update.notes) {
		const before = base.notes.find((candidate) => candidate.id === note.id);
		if (before && note.text !== before.text) {
			open.noteEdits[note.id] = { text: note.text };
		}
	}
	return open;
}

export function hasOpenEditors(open: OpenEditors): boolean {
	return (
		workerTextFields.some((field) => open[field] !== undefined) ||
		open.composer !== undefined ||
		Object.keys(open.noteEdits).length > 0 ||
		Object.keys(open.attributes).length > 0
	);
}

/** Whether the record moved on after the draft was taken. Key order is ignored. */
export function draftBaseChanged(
	stored: WorkerDraft,
	worker: Worker,
	attributes: readonly WorkerAttributeDefinition[]
): boolean {
	const now = JSON.parse(JSON.stringify(toWorkerUpdate(worker, attributes)));
	return stableJson(stored.base) !== stableJson(now);
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) =>
		inner && typeof inner === 'object' && !Array.isArray(inner)
			? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
			: inner
	);
}

/** One free-text field where the stored draft and the record as saved now disagree. */
export type DraftDifference = { field: PanelTextField; saved: string; draft: string };

/** The text fields a stored draft would change on the record as saved now. */
export function draftDifferences(stored: WorkerDraft, worker: Worker): DraftDifference[] {
	return workerTextFields
		.filter((field) => stored.update[field] !== worker[field])
		.map((field) => ({ field, saved: worker[field], draft: stored.update[field] }));
}
