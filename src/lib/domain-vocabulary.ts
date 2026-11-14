import type { SelectMode } from '#lib/client/generated/SelectMode.ts';
import type { WorkerNote } from '#lib/client/generated/WorkerNote.ts';
import type { WorkerAttributeKind } from '#lib/client/generated/WorkerAttributeKind.ts';
import type { RemovedAnswerHolder } from '#lib/client/generated/RemovedAnswerHolder.ts';
import type { CardinalitySurface } from '#lib/client/generated/CardinalitySurface.ts';

import type { AbbreviationOrigin } from '#lib/shared/abbreviation.ts';

/** A Worker's answer to one Attribute, as the answer id(s) it holds (ADR 0030). */
export type WorkerAttributeValue = string | string[];
export type WorkerAttributeValues = Record<string, WorkerAttributeValue>;

/** Whether a Worker holds one branch or several of a group of values (ADR 0043). */
export type { SelectMode } from '#lib/client/generated/SelectMode.ts';

/**
 * One Attribute answer as the UI sees it: its stable id (ADR 0030) and its label. An answer
 * with sub-values may carry its own `mode` for them; without one it follows the Attribute.
 */
export type AttributeAnswer = {
	id: string;
	value: string;
	parentId?: string;
	mode?: SelectMode;
	/**
	 * The stored Abbreviation (ADR 0046) and how it came to be. Both come from the core with
	 * every saved value; a value not yet saved has neither.
	 */
	abbreviation?: string;
	abbreviationOrigin?: AbbreviationOrigin;
};

export const assessmentOptions = [
	'Unassessed',
	'Leader',
	'Activist',
	'Supporter',
	'Disengaged',
	'Hostile'
] as const;

export type AssessmentOption = (typeof assessmentOptions)[number];

/** The assessments a Worker can be placed in, in scale order: every option but Unassessed. */
export const assessedOptions = assessmentOptions.filter(
	(option): option is Exclude<AssessmentOption, 'Unassessed'> => option !== 'Unassessed'
);

export type { WorkerNote } from '#lib/client/generated/WorkerNote.ts';

export type { Agitation } from '#lib/client/generated/Agitation.ts';

export type { Language } from '#lib/client/generated/Language.ts';

export type { Worksite } from '#lib/client/generated/Worksite.ts';

export type { SavedView } from '#lib/client/generated/SavedView.ts';
export type { SavedViewKind } from '#lib/client/generated/SavedViewKind.ts';
export type { SavedViewSnapshot } from '#lib/client/generated/SavedViewSnapshot.ts';
export type { SavedViewWorkers } from '#lib/client/generated/SavedViewWorkers.ts';
export type { SavedViewMapping } from '#lib/client/generated/SavedViewMapping.ts';
export type { SavedViewPopulation } from '#lib/client/generated/SavedViewPopulation.ts';

/** The Committee coverage goal: workers per Leader, a whole number in these bounds. */
export const committeeGoalMinimum = 1;
export const committeeGoalMaximum = 100;

export type Worker = {
	id: string;
	name: string;
	email: string;
	phone: string;
	assessment: AssessmentOption;
	/** Each Attribute's answer id(s): a Single-Select one id (`''` for none), a Multi-Select list. */
	attributes: WorkerAttributeValues;
	agitations: string[];
	languages: string[];
	relationships: string[];
	notes: WorkerNote[];
};

export type WorkerUpdate = Omit<Worker, 'id'>;

/**
 * The Worker's free-text fields, which the record panel writes one at a time. The one
 * list of them on this side of the client boundary (Rust's `WorkerTextField` is the other).
 */
export const workerTextFields = ['name', 'email', 'phone'] as const;
export type WorkerTextField = (typeof workerTextFields)[number];

/** What a caller sends to add a Note: the core mints the id, `timestamp` and `editedAt`. */
export type WorkerNoteInput = Pick<WorkerNote, 'text'>;

/**
 * An in-place Note edit. `editedAt` is sent only by an Undo, to put back the
 * earlier edit time exactly (`null` for a Note never edited before).
 */
export type WorkerNoteEdit = WorkerNoteInput & { id: string; editedAt?: string | null };

export type WorkerImportContact = Pick<Worker, 'name'> & Partial<Pick<Worker, 'email' | 'phone'>>;

export type { WorkerAttributeKind } from '#lib/client/generated/WorkerAttributeKind.ts';

export type WorkerAttributeDefinition = {
	id: string;
	name: string;
	kind: WorkerAttributeKind;
	/** The answers the Attribute accepts, in list order, each with its stable id (ADR 0030). */
	answers: AttributeAnswer[];
};

type AttributeHolder = { attributes: WorkerAttributeValues };

/**
 * Reads the one answer a Category holds, refusing anything that is not a string.
 * The holder is `{ attributes }`, so a Worker and a WorkerUpdate both satisfy it.
 */
export function categoryValue(holder: AttributeHolder, attributeId: string): string {
	const value = holder.attributes[attributeId];
	if (typeof value !== 'string') {
		throw new Error(`Category value for "${attributeId}" is invalid.`);
	}
	return value;
}

/** Reads the answers a Tag holds, refusing anything that is not an array. */
export function tagValues(holder: AttributeHolder, attributeId: string): string[] {
	const value = holder.attributes[attributeId];
	if (!Array.isArray(value)) {
		throw new Error(`Tag values for "${attributeId}" are invalid.`);
	}
	return value;
}

/**
 * The Configuration preview contract (product gap 12): a read-only report of what a
 * proposed Save all would change. The core owns the arithmetic and the stable ids; the UI
 * resolves current labels from those ids.
 */
export type { ConfigurationPreviewEntity } from '#lib/client/generated/ConfigurationPreviewEntity.ts';

export type { ConfigurationPreviewOperation } from '#lib/client/generated/ConfigurationPreviewOperation.ts';

export type { ConfigurationPreviewChange } from '#lib/client/generated/ConfigurationPreviewChange.ts';

export type { ConfigurationPreviewTotals } from '#lib/client/generated/ConfigurationPreviewTotals.ts';

export type { ConfigurationPreviewMoveHolder } from '#lib/client/generated/ConfigurationPreviewMoveHolder.ts';

export type { ConfigurationPreviewMove } from '#lib/client/generated/ConfigurationPreviewMove.ts';

export type { AttributeMoveHolder } from '#lib/client/generated/AttributeMoveHolder.ts';

export type { AttributeMoveImpact } from '#lib/client/generated/AttributeMoveImpact.ts';

/** One reviewed Attribute move: naming it acknowledges that its lost values leave the source. */
export type AttributeMoveResolution = {
	sourceAttributeId: string;
	answerId: string;
};

export type { RemovedAnswerReplacement } from '#lib/client/generated/RemovedAnswerReplacement.ts';

export type { RemovedAnswerHolder } from '#lib/client/generated/RemovedAnswerHolder.ts';

export type { RemovedAnswerImpact } from '#lib/client/generated/RemovedAnswerImpact.ts';

/** One holder of an entire removed Attribute; the same holder shape as a removed answer. */
export type RemovedAttributeHolder = RemovedAnswerHolder;

export type { RemovedAttributeImpact } from '#lib/client/generated/RemovedAttributeImpact.ts';

export type { CardinalitySurface } from '#lib/client/generated/CardinalitySurface.ts';

export type { ConfigurationPreviewCardinalityHolder } from '#lib/client/generated/ConfigurationPreviewCardinalityHolder.ts';

export type { ConfigurationPreviewCardinality } from '#lib/client/generated/ConfigurationPreviewCardinality.ts';

export type { ConfigurationPreviewModeHolder } from '#lib/client/generated/ConfigurationPreviewModeHolder.ts';

export type { ConfigurationPreviewModeChange } from '#lib/client/generated/ConfigurationPreviewModeChange.ts';

/** The acknowledgement of one Attribute's select-mode change that trims held answers. */
export type ModeChangeResolution = {
	attributeId: string;
};

export type { ConfigurationPreview } from '#lib/client/generated/ConfigurationPreview.ts';

export type { ConfigurationPreviewAbbreviation } from '#lib/client/generated/ConfigurationPreviewAbbreviation.ts';

/** One holder's explicit resolution in a Configuration Save. */
export type RemovedAnswerHolderResolution = {
	workerId: string;
	/** For a Worker draft holder: the unfinished update (`draft`) or its base. */
	surface?: 'draft' | 'base';
	/** The kept answer to replace the removed one with; absent means no answer. */
	replacement?: string;
};

export type RemovedAnswerResolution = {
	attributeId: string;
	answerId: string;
	holders: RemovedAnswerHolderResolution[];
};

/** The explicit acknowledgement of one removed Attribute. */
export type RemovedAttributeResolution = {
	attributeId: string;
};

/** One surface's explicit choice: the single answer it keeps, or no answer at all. */
export type CardinalityHolderResolution = {
	workerId: string;
	surface: CardinalitySurface;
	/** `null` is the explicit no-answer resolution. */
	retained: string | null;
};

export type CardinalityResolution = {
	attributeId: string;
	holders: CardinalityHolderResolution[];
};

/** The Save's explicit resolutions for removed answers, Attributes and the answers a
 * Worker cardinality change would otherwise discard. */
export type ConfigurationResolutions = {
	removedAnswers: RemovedAnswerResolution[];
	removedAttributes: RemovedAttributeResolution[];
	cardinality: CardinalityResolution[];
	/** Every lossy Attribute move the organizer reviewed; the core refuses one left out. */
	attributeMoves: AttributeMoveResolution[];
	/** Every Attribute whose select-mode change trims held answers; the core refuses one left out. */
	modeChanges: ModeChangeResolution[];
};

/** The empty answer for one kind: a blank Category, or a Tag with nothing chosen. */
export function emptyValue(kind: WorkerAttributeKind): WorkerAttributeValue {
	return kind === 'category' ? '' : [];
}
