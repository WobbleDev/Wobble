/**
 * The shape of an Attribute while it is being edited, and the conversions between
 * that draft and the stored definition.
 */
import { m } from '#lib/paraglide/messages.js';
import type { AttributeAnswer, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import type { MergeMark } from './configuration-draft.ts';

export type AttributeType = WorkerAttributeDefinition['kind'];

/** The visible name of an Attribute kind; the stored kind stays `category` or `tag`. */
export function attributeTypeLabel(type: AttributeType): string {
	return type === 'category' ? m.domain_category() : m.domain_tag();
}

/** An answer while it is edited: a folded answer also names the id of the answer it merged into. */
export type AttributeAnswerDraft = AttributeAnswer & MergeMark;

export type AttributeDraft = {
	id: string;
	name: string;
	type: AttributeType;
	/**
	 * The answers as they are edited: each keeps its id, and a new one is minted a UUID. An
	 * answer merged into another carries `mergedInto` until Save.
	 */
	answers: AttributeAnswerDraft[];
	newOption: string;
	newOptionError: string;
	/** Why a removal or merge of a parent answer was refused, until the branch is resolved. */
	removalError: string;
	/** Why a move was refused or needs a different name, until the next edit. */
	moveError: string;
};

export function createAttribute(
	id: string,
	name: string,
	type: AttributeType,
	answers: readonly AttributeAnswerDraft[] = []
): AttributeDraft {
	return {
		id,
		name,
		type,
		answers: answers.map((answer) => ({ ...answer })),
		newOption: '',
		newOptionError: '',
		removalError: '',
		moveError: ''
	};
}

export function fromWorkerAttributeDefinitions(
	attributes: readonly WorkerAttributeDefinition[]
): AttributeDraft[] {
	return attributes.map((attribute) =>
		createAttribute(attribute.id, attribute.name, attribute.kind, attribute.answers)
	);
}

export function toWorkerAttributeDefinition({
	id,
	name,
	type,
	answers
}: AttributeDraft): WorkerAttributeDefinition {
	// A mode only means something while its value has sub-values (ADR 0043), so a childless
	// value is saved without one and a later child starts from the Attribute's default.
	const parents = new Set(
		answers.filter((answer) => !answer.mergedInto && answer.parentId).map((a) => a.parentId)
	);
	return {
		id,
		name: name.trim(),
		kind: type,
		answers: answers.map((answer) => ({
			id: answer.id,
			value: answer.value.trim(),
			...(answer.parentId ? { parentId: answer.parentId } : {}),
			...(answer.mode && parents.has(answer.id) ? { mode: answer.mode } : {}),
			// A generated Short form is left to the core; only an edited one is sent (ADR 0046).
			...(answer.shortFormOrigin === 'edited' && answer.shortForm?.trim()
				? { shortForm: answer.shortForm.trim(), shortFormOrigin: 'edited' as const }
				: {}),
			...(answer.mergedInto ? { mergedInto: answer.mergedInto } : {})
		}))
	};
}

export function toWorkerAttributeDefinitions(
	drafts: readonly AttributeDraft[]
): WorkerAttributeDefinition[] {
	return drafts.map(toWorkerAttributeDefinition);
}
