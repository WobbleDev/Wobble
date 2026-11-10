/**
 * The unsaved Configuration draft: what counts as dirty, what is valid, and what a
 * save would send. Pure — no state and no requests.
 */
import { committeeTargetMaximum, committeeTargetMinimum } from '#lib/domain-vocabulary.ts';
import type { Agitation, Language, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { toWorkerAttributeDefinitions, type AttributeDraft } from './attribute-draft.ts';
import { m } from '#lib/paraglide/messages.js';
import { normalizeForMatch } from '#lib/shared/text.ts';
import { isAttributeValid } from './attribute-validation.ts';

/** The label field of a value list: Agitations use `text`, Languages use `name`, Attribute answers `value`. */
export type ValueLabelKey = 'text' | 'name' | 'value';

/**
 * One entry of an edited value list. A folded entry keeps its id and gets `mergedInto` set to
 * the surviving entry's id; it stays in the draft (and in the Save payload) until Save.
 */
export type MergeMark = { mergedInto?: string };

export type ValueEntry<K extends ValueLabelKey> = { id: string } & MergeMark & Record<K, string>;

/** Result of checking proposed label text against the rest of its list. */
export type ValueTextCheck =
	{ status: 'ok' } | { status: 'blank' } | { status: 'duplicate'; survivorId: string };

/** Everything the configuration editor's dirty and save decisions read, as plain values. */
export type ConfigurationDraft = {
	worksiteName: string;
	savedWorksiteName: string;
	draftCommitteeTarget: string;
	savedCommitteeTarget: number;
	draftAttributes: readonly AttributeDraft[];
	savedConfiguration: readonly WorkerAttributeDefinition[];
	draftAgitations: readonly ValueEntry<'text'>[];
	savedAgitations: readonly Agitation[];
	draftLanguages: readonly ValueEntry<'name'>[];
	savedLanguages: readonly Language[];
	addFormOpen: boolean;
	newAgitationText: string;
	newLanguageName: string;
};

export type ConfigurationDirtyState = {
	name: boolean;
	committeeTarget: boolean;
	attributes: boolean;
	agitations: boolean;
	languages: boolean;
	/** Human labels for the dirty sections, in the order they are shown. */
	sections: string[];
};

/** The error shown for a raw committee coverage target field, or an empty string when it is valid. */
export function getCommitteeTargetError(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return m.configuration_committee_required();
	if (!/^\d+$/.test(trimmed)) return m.configuration_committee_whole_number();

	const target = Number(trimmed);
	if (target < committeeTargetMinimum || target > committeeTargetMaximum) {
		return m.configuration_committee_whole_number();
	}

	return '';
}

/** The draft's attributes in saved shape, shared so the dirty check and save plan stay in lockstep. */
function currentConfiguration(draft: ConfigurationDraft): WorkerAttributeDefinition[] {
	return toWorkerAttributeDefinitions(draft.draftAttributes);
}

/** The entries that still exist after Save: folded entries are gone, and only what remains is kept. */
export function visibleValues<T extends { id: string } & MergeMark>(list: readonly T[]): T[] {
	return list.filter((entry) => !entry.mergedInto);
}

/**
 * The visible entry, other than `id` itself, whose label matches `text` case-insensitively
 * after trimming. Folded entries never match: their text no longer names anything.
 */
export function findDuplicateValue<K extends ValueLabelKey, T extends ValueEntry<K>>(
	list: readonly T[],
	key: K,
	id: string | null,
	text: string
): T | undefined {
	const wanted = normalizeForMatch(text);
	return visibleValues(list).find(
		(entry) => entry.id !== id && normalizeForMatch(entry[key]) === wanted
	);
}

/** Whether proposed text can be applied to an entry, or would fold into another one. */
export function checkValueText<K extends ValueLabelKey, T extends ValueEntry<K>>(
	list: readonly T[],
	key: K,
	id: string | null,
	text: string
): ValueTextCheck {
	if (!text.trim()) return { status: 'blank' };
	const match = findDuplicateValue(list, key, id, text);
	return match ? { status: 'duplicate', survivorId: match.id } : { status: 'ok' };
}

/** Renames the entry with this id. Blank or duplicate text leaves the list unchanged. */
export function renameValue<K extends ValueLabelKey, T extends ValueEntry<K>>(
	list: readonly T[],
	key: K,
	id: string,
	text: string
): T[] {
	if (checkValueText(list, key, id, text).status !== 'ok') return [...list];
	const label = text.trim();
	return list.map((entry) => (entry.id === id ? { ...entry, [key]: label } : entry));
}

/**
 * Folds the entry `foldedId` into the visible entry `survivorId`. The folded entry stays in the
 * list marked with `mergedInto` so Save can remap its Workers; the survivor keeps its position.
 */
export function mergeValue<T extends { id: string } & MergeMark>(
	list: readonly T[],
	foldedId: string,
	survivorId: string
): T[] {
	const visibleIds = new Set(visibleValues(list).map((entry) => entry.id));
	if (foldedId === survivorId || !visibleIds.has(foldedId) || !visibleIds.has(survivorId)) {
		return [...list];
	}
	return list.map((entry) =>
		entry.id === foldedId ? { ...entry, mergedInto: survivorId } : entry
	);
}

/**
 * Removes the entry with this id, and any entry folded into it: removing a survivor removes what
 * was merged into it. Removal is what Save reads as "omit the entry".
 */
export function removeValue<T extends { id: string } & MergeMark>(
	list: readonly T[],
	id: string
): T[] {
	return list.filter((entry) => entry.id !== id && entry.mergedInto !== id);
}

/**
 * Moves the entry with this id one place up or down. Ids, labels and parent links stay
 * put; only the configured order changes. The ends and an unknown id leave the list as is.
 */
export function moveValue<T extends { id: string }>(
	list: readonly T[],
	id: string,
	direction: -1 | 1
): T[] {
	const index = list.findIndex((entry) => entry.id === id);
	const next = index + direction;
	if (index < 0 || next < 0 || next >= list.length) return [...list];
	const moved = [...list];
	[moved[index], moved[next]] = [moved[next], moved[index]];
	return moved;
}

/** Exchanges the labels of two visible entries by identity; ids and positions stay put. */
export function swapValues<K extends ValueLabelKey, T extends ValueEntry<K>>(
	list: readonly T[],
	key: K,
	firstId: string,
	secondId: string
): T[] {
	const first = visibleValues(list).find((entry) => entry.id === firstId);
	const second = visibleValues(list).find((entry) => entry.id === secondId);
	if (!first || !second || first.id === second.id) return [...list];
	const firstLabel = first[key];
	const secondLabel = second[key];
	return list.map((entry) => {
		if (entry.id === firstId) return { ...entry, [key]: secondLabel };
		if (entry.id === secondId) return { ...entry, [key]: firstLabel };
		return entry;
	});
}

/** Whether a value list differs from its saved form, comparing ids, labels and merges. */
function valuesChanged<K extends ValueLabelKey>(
	draft: readonly ValueEntry<K>[],
	saved: readonly ValueEntry<K>[],
	key: K
): boolean {
	const shape = (list: readonly ValueEntry<K>[]) =>
		list.map((entry) => [entry.id, entry[key], entry.mergedInto ?? null]);
	return JSON.stringify(shape(draft)) !== JSON.stringify(shape(saved));
}

/** Which sections differ from what was last saved, and the labels used to report them. */
export function getDirtyState(draft: ConfigurationDraft): ConfigurationDirtyState {
	const name = draft.worksiteName.trim() !== draft.savedWorksiteName;
	const committeeTarget = draft.draftCommitteeTarget.trim() !== String(draft.savedCommitteeTarget);
	const attributes =
		JSON.stringify(currentConfiguration(draft)) !== JSON.stringify(draft.savedConfiguration);
	const agitations = valuesChanged(draft.draftAgitations, draft.savedAgitations, 'text');
	const languages = valuesChanged(draft.draftLanguages, draft.savedLanguages, 'name');

	return {
		name,
		committeeTarget,
		attributes,
		agitations,
		languages,
		sections: [
			name ? String(m.configuration_dirty_worksite_name()) : '',
			committeeTarget ? String(m.configuration_dirty_committee_target()) : '',
			attributes
				? String(m.configuration_dirty_attributes({ count: draft.draftAttributes.length }))
				: '',
			agitations ? String(m.configuration_dirty_agitations()) : '',
			languages ? String(m.configuration_dirty_languages()) : ''
		].filter((section) => section !== '')
	};
}

/** Whether the attribute editor can be persisted: no half-finished form, every attribute valid. */
export function canPersistAttributes(draft: ConfigurationDraft): boolean {
	return (
		!draft.addFormOpen &&
		draft.draftAttributes.every((attribute) => isAttributeValid(attribute, draft.draftAttributes))
	);
}

/** Why the attribute editor cannot be persisted, naming the attribute; empty when it can. */
export function attributeSaveBlockReason(draft: ConfigurationDraft): string {
	if (draft.addFormOpen) return String(m.configuration_save_blocked_add_form());
	for (const attribute of draft.draftAttributes) {
		if (isAttributeValid(attribute, draft.draftAttributes)) continue;
		const name = attribute.name.trim() || String(m.configuration_save_blocked_unnamed());
		if (attribute.newOption.trim() || attribute.newOptionError) {
			return String(m.configuration_save_blocked_option({ attribute: name }));
		}
		return String(m.configuration_save_blocked_invalid({ attribute: name }));
	}
	return '';
}

/** Whether anything is pending: a dirty section or an unfinished add form. */
export function hasUnsavedDraft(draft: ConfigurationDraft): boolean {
	const dirty = getDirtyState(draft);
	return (
		dirty.name ||
		dirty.committeeTarget ||
		dirty.attributes ||
		dirty.agitations ||
		dirty.languages ||
		draft.addFormOpen ||
		draft.draftAttributes.some((attribute) => Boolean(attribute.newOption.trim())) ||
		Boolean(draft.newAgitationText.trim()) ||
		Boolean(draft.newLanguageName.trim())
	);
}

/** A dirty worksite name may only be saved when it is not empty. */
export function canSaveWorksiteName(draft: ConfigurationDraft): boolean {
	return !getDirtyState(draft).name || Boolean(draft.worksiteName.trim());
}

/** A dirty committee target may only be saved when it is a whole number from 1 to 100. */
function canSaveCommitteeTarget(draft: ConfigurationDraft): boolean {
	return (
		!getDirtyState(draft).committeeTarget || !getCommitteeTargetError(draft.draftCommitteeTarget)
	);
}

/** Whether "Save all" may run: something is dirty and nothing invalid is in the way. */
export function canSave(draft: ConfigurationDraft): boolean {
	const dirty = getDirtyState(draft);
	return (
		dirty.sections.length > 0 &&
		(!dirty.attributes || canPersistAttributes(draft)) &&
		canSaveWorksiteName(draft) &&
		canSaveCommitteeTarget(draft)
	);
}

export type ConfigurationSavePlan = {
	worksiteName: { dirty: boolean; snapshot: string };
	committeeTarget: { dirty: boolean; snapshot: number };
	attributes: { dirty: boolean; snapshot: WorkerAttributeDefinition[] };
	agitations: { dirty: boolean; snapshot: ValueEntry<'text'>[] };
	languages: { dirty: boolean; snapshot: ValueEntry<'name'>[] };
};

/**
 * Plans a "Save all" run: which sections to send and the frozen snapshots to send.
 * The snapshots are fresh copies, so edits made while a save is in flight stay dirty.
 */
export function planConfigurationSave(draft: ConfigurationDraft): ConfigurationSavePlan {
	const dirty = getDirtyState(draft);

	return {
		worksiteName: { dirty: dirty.name, snapshot: draft.worksiteName.trim() },
		committeeTarget: {
			dirty: dirty.committeeTarget,
			snapshot: Number(draft.draftCommitteeTarget.trim())
		},
		attributes: {
			dirty: dirty.attributes,
			snapshot: currentConfiguration(draft)
		},
		agitations: {
			dirty: dirty.agitations,
			snapshot: draft.draftAgitations.map((agitation) => ({ ...agitation }))
		},
		languages: {
			dirty: dirty.languages,
			snapshot: draft.draftLanguages.map((language) => ({ ...language }))
		}
	};
}
