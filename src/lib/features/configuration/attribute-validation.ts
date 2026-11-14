/**
 * The rules one Attribute has to satisfy: it needs a name, and its options must not
 * repeat among siblings. Two answers with the same label under different parents are
 * different paths and both stay valid.
 */
import { m } from '#lib/paraglide/messages.js';
import { normalizeForMatch } from '#lib/shared/text.ts';
import type { AttributeAnswerDraft, AttributeDraft } from './attribute-draft.ts';
import { abbreviationTooLong } from './abbreviation-draft.ts';

export function getAttributeNameError(
	name: string,
	attributes: readonly AttributeDraft[],
	excludedId?: string
) {
	const normalizedName = normalizeForMatch(name);
	if (!normalizedName) return m.configuration_attribute_name_required();
	if (
		attributes.some(
			(attribute) =>
				attribute.id !== excludedId && normalizeForMatch(attribute.name) === normalizedName
		)
	) {
		return m.configuration_attribute_name_exists();
	}
	return '';
}

/** The visible answer a proposed label would collide with under the same parent. */
export function findDuplicateSiblingOption(
	attribute: AttributeDraft,
	excludedOptionId: string | undefined,
	value: string,
	parentId?: string
): AttributeAnswerDraft | undefined {
	const normalizedValue = normalizeForMatch(value);
	if (!normalizedValue) return undefined;
	const wantedParent = parentId ?? '';

	return attribute.answers.find(
		(candidate) =>
			!candidate.mergedInto &&
			candidate.id !== excludedOptionId &&
			(candidate.parentId ?? '') === wantedParent &&
			normalizeForMatch(candidate.value) === normalizedValue
	);
}

export function hasDuplicateOptionValue(
	attribute: AttributeDraft,
	value: string,
	excludedOptionId?: string,
	parentId?: string
) {
	return Boolean(findDuplicateSiblingOption(attribute, excludedOptionId, value, parentId));
}

/** Whether an answer is the root itself or one of its descendants in this Attribute. */
export function isAnswerInSubtree(
	answers: readonly AttributeAnswerDraft[],
	answerId: string,
	rootId: string
): boolean {
	const seen = new Set<string>();
	let current = answers.find((candidate) => candidate.id === answerId);
	while (current) {
		if (current.id === rootId) return true;
		if (seen.has(current.id)) return false;
		seen.add(current.id);
		const parentId = current.parentId;
		current = parentId ? answers.find((candidate) => candidate.id === parentId) : undefined;
	}
	return false;
}

/** Whether a visible answer is a parent of another one, so removing or folding it needs a plan. */
export function hasChildAnswers(attribute: AttributeDraft, answerId: string) {
	return attribute.answers.some(
		(candidate) => !candidate.mergedInto && candidate.parentId === answerId
	);
}

export function getAttributeOptionError(attribute: AttributeDraft, option: AttributeAnswerDraft) {
	if (!option.value.trim()) return m.configuration_enter_option();
	if (hasDuplicateOptionValue(attribute, option.value, option.id, option.parentId)) {
		return m.configuration_options_unique();
	}
	return '';
}

export function isAttributeValid(attribute: AttributeDraft, attributes: readonly AttributeDraft[]) {
	return (
		!getAttributeNameError(attribute.name, attributes, attribute.id) &&
		attribute.answers.every(
			(option) =>
				option.mergedInto ||
				(!getAttributeOptionError(attribute, option) && !abbreviationTooLong(option))
		) &&
		!attribute.newOption.trim() &&
		!attribute.newOptionError
	);
}
