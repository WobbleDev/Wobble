/**
 * The selected Worker's draft in the record panel: what each open editor holds now,
 * what a stored draft reopens, and the restored-draft message. One per panel.
 */
import { getContext, setContext } from 'svelte';
import type {
	Worker,
	WorkerAttributeDefinition,
	WorkerAttributeValue
} from '#lib/domain-vocabulary.ts';
import {
	deleteWorkerDraft,
	getWorkerDraft,
	type PendingNoteDraft
} from '#lib/client/workers-api.ts';
import {
	draftBaseChanged,
	draftDifferences,
	type DraftDifference,
	hasOpenEditors,
	noEditors,
	readPanelDraft,
	type OpenEditors,
	type PanelTextField
} from './panel-draft.ts';

const KEY = Symbol('panel-draft');

export class PanelDraftState {
	/** What the open editors hold now. */
	open = $state<OpenEditors>(noEditors());
	/** What a stored draft asks editors to reopen with, read once when they mount. */
	restored = $state<OpenEditors>(noEditors());
	restoredAt = $state<string | null>(null);
	baseChanged = $state(false);
	/** Where a restored draft and the saved record now disagree; shown when the base changed. */
	differences = $state<DraftDifference[]>([]);
	/** Whether open input is unsaved, and whether the core holds it as a draft yet. */
	status = $state<'idle' | 'unsaved' | 'stored'>('idle');
	/** False while the selected Worker's stored draft is being read. The record shows
	 *  regardless; this only holds back saving a new draft until the stored one is known. */
	ready = $state(false);
	/** Bumped when a stored draft arrives, so the sections remount with its editors open. */
	restoreRevision = $state(0);
	/** Whether the core holds a draft for `workerId`. Not reactive on purpose. */
	stored = false;
	workerId: string | null = null;

	async load(worker: Worker | null, attributes: readonly WorkerAttributeDefinition[]) {
		const id = worker?.id ?? null;
		this.workerId = id;
		this.open = noEditors();
		this.restored = noEditors();
		this.restoredAt = null;
		this.baseChanged = false;
		this.differences = [];
		this.status = 'idle';
		this.stored = false;
		this.ready = false;
		if (!worker || id === null) {
			this.ready = true;
			return;
		}
		let draft = null;
		try {
			draft = await getWorkerDraft(id);
		} catch {
			// A draft that cannot be read must not stop the record from showing.
		}
		if (this.workerId !== id) return;
		if (draft) {
			const reopen = readPanelDraft(draft);
			if (hasOpenEditors(reopen)) {
				this.restored = reopen;
				this.restoreRevision += 1;
				this.restoredAt = draft.updatedAt;
				this.baseChanged = draftBaseChanged(draft, worker, attributes);
				this.differences = this.baseChanged ? draftDifferences(draft, worker) : [];
				this.status = 'stored';
				this.stored = true;
			} else {
				void deleteWorkerDraft(id);
			}
		}
		this.ready = true;
	}

	setField(field: PanelTextField, value: string | undefined) {
		if (value === undefined) delete this.open[field];
		else this.open[field] = value;
	}

	setComposer(value: PendingNoteDraft | undefined) {
		if (value === undefined) delete this.open.composer;
		else this.open.composer = value;
	}

	setNoteEdit(noteId: string, value: PendingNoteDraft | undefined) {
		if (value === undefined) delete this.open.noteEdits[noteId];
		else this.open.noteEdits[noteId] = value;
	}

	/** Records the choice an open Attribute editor holds, or closes it. */
	setAttribute(attributeId: string, value: WorkerAttributeValue | undefined) {
		if (value === undefined) delete this.open.attributes[attributeId];
		else this.open.attributes[attributeId] = Array.isArray(value) ? [...value] : value;
	}

	/** "Discard them": forget the stored draft and close what it reopened. */
	async discard() {
		const id = this.workerId;
		this.restored = noEditors();
		this.restoredAt = null;
		this.baseChanged = false;
		this.differences = [];
		this.status = 'idle';
		this.stored = false;
		if (id) await deleteWorkerDraft(id);
	}
}

export function setPanelDraft(state: PanelDraftState): PanelDraftState {
	return setContext(KEY, state);
}

export function getPanelDraft(): PanelDraftState {
	const state = getContext<PanelDraftState | undefined>(KEY);
	if (!state) throw new Error('getPanelDraft() called outside the record panel.');
	return state;
}
