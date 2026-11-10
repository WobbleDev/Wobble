import { assessmentOptions } from '#lib/domain-vocabulary.ts';
import { assessmentLabel } from '#lib/i18n/assessment.ts';
import { m } from '#lib/paraglide/messages.js';
import type { HighlightVocabulary } from './map-highlight-query-codec.ts';
import {
	canOfferAll,
	type HighlightClause,
	type HighlightField,
	type HighlightGroup,
	type HighlightOperator
} from './map-highlight-query.ts';

export type HighlightFieldOption = { key: string; label: string; field: HighlightField };
export type HighlightValueOption = { id: string; label: string; depth: number };

/** A stable select value for a field: 'a:<attributeId>' for an Attribute, else its name. */
export function highlightFieldKey(field: HighlightField): string {
	if (field.kind === 'attribute') return `a:${field.attributeId}`;
	return field.kind;
}

/**
 * The values a field can select. An Attribute's values are a hierarchy: each parent comes
 * before its children (in configured order), and depth counts the levels above a value.
 */
export function highlightValueOptions(
	field: HighlightField,
	vocabulary: HighlightVocabulary
): HighlightValueOption[] {
	if (field.kind === 'languages') {
		return vocabulary.languages.map((language) => ({
			id: language.id,
			label: language.name,
			depth: 0
		}));
	}
	if (field.kind === 'agitations') {
		return vocabulary.agitations.map((agitation) => ({
			id: agitation.id,
			label: agitation.text,
			depth: 0
		}));
	}
	if (field.kind === 'assessment') {
		return assessmentOptions.map((option) => ({
			id: option,
			label: assessmentLabel(option),
			depth: 0
		}));
	}
	if (field.kind !== 'attribute') return [];
	const attribute = vocabulary.attributes.find((candidate) => candidate.id === field.attributeId);
	if (!attribute) return [];
	const answers = attribute.answers;
	const known = new Set(answers.map((answer) => answer.id));
	const options: HighlightValueOption[] = [];
	const visited = new Set<string>();

	function visit(parentId: string | undefined, depth: number): void {
		for (const answer of answers) {
			const isRoot = !answer.parentId || !known.has(answer.parentId);
			const matches = parentId === undefined ? isRoot : answer.parentId === parentId;
			if (!matches || visited.has(answer.id)) continue;
			visited.add(answer.id);
			options.push({ id: answer.id, label: answer.value, depth });
			visit(answer.id, depth + 1);
		}
	}

	visit(undefined, 0);
	return options;
}

/**
 * The label for an operator on a field, worded by what the field can hold: 'has' when the
 * Worker can hold several values, 'is' when it holds one. Used by the clause select and the
 * summary so the wording cannot drift.
 */
export function highlightOperatorLabel(
	field: HighlightField,
	vocabulary: HighlightVocabulary,
	operator: HighlightOperator
): string {
	const offersAll = canOfferAll(field, vocabulary.attributes);
	if (operator === 'all') return m.mapping_highlight_operator_has_all();
	if (operator === 'any') {
		return offersAll
			? m.mapping_highlight_operator_has_any()
			: m.mapping_highlight_operator_is_one();
	}
	return offersAll
		? m.mapping_highlight_operator_has_none()
		: m.mapping_highlight_operator_is_none();
}

/**
 * The operators a clause's select offers for a field. 'all' is hidden where a Worker holds
 * one value, unless the stored operator is already 'all' (held), so it stays visible.
 */
export function highlightOperatorOptions(
	field: HighlightField,
	vocabulary: HighlightVocabulary,
	held?: HighlightOperator
): { value: HighlightOperator; label: string }[] {
	const operators: HighlightOperator[] =
		canOfferAll(field, vocabulary.attributes) || held === 'all'
			? ['any', 'all', 'none']
			: ['any', 'none'];
	return operators.map((value) => ({
		value,
		label: highlightOperatorLabel(field, vocabulary, value)
	}));
}

/** A clause reads as '<Field> <operator label> <value labels>', or undefined when incomplete. */
function describeClause(
	clause: HighlightClause,
	vocabulary: HighlightVocabulary
): string | undefined {
	const fieldKey = highlightFieldKey(clause.field);
	const fieldLabel = highlightFieldOptions(vocabulary).find(
		(option) => option.key === fieldKey
	)?.label;
	const valueLabels = highlightValueOptions(clause.field, vocabulary);
	const labels: string[] = [];
	for (const id of clause.values) {
		const option = valueLabels.find((value) => value.id === id);
		if (option) labels.push(option.label);
	}
	if (fieldLabel === undefined || labels.length === 0) return undefined;
	const operatorLabel = highlightOperatorLabel(clause.field, vocabulary, clause.operator);
	return `${fieldLabel} ${operatorLabel} ${labels.join(', ')}`;
}

/** A group joins its complete rules; a nested group is wrapped in parentheses. */
function describeGroup(
	group: HighlightGroup,
	vocabulary: HighlightVocabulary,
	nested: boolean
): string | undefined {
	const parts: string[] = [];
	for (const rule of group.rules) {
		const text =
			rule.type === 'clause'
				? describeClause(rule, vocabulary)
				: describeGroup(rule, vocabulary, true);
		if (text !== undefined) parts.push(text);
	}
	if (parts.length === 0) return undefined;
	const text = parts.join(group.match === 'all' ? ' and ' : ' or ');
	return nested ? `(${text})` : text;
}

/** A plain-language summary of the complete rules in a query; '' when there are none. */
export function describeHighlightQuery(
	query: HighlightGroup,
	vocabulary: HighlightVocabulary
): string {
	return describeGroup(query, vocabulary, false) ?? '';
}

/** Every field a clause may use, in the order the builder lists them. */
export function highlightFieldOptions(vocabulary: HighlightVocabulary): HighlightFieldOption[] {
	const attributes: HighlightFieldOption[] = vocabulary.attributes.map((attribute) => {
		const field: HighlightField = { kind: 'attribute', attributeId: attribute.id };
		return { key: highlightFieldKey(field), label: attribute.name, field };
	});
	const fixed: HighlightFieldOption[] = [
		{ key: 'languages', label: m.domain_languages(), field: { kind: 'languages' } },
		{ key: 'agitations', label: m.domain_agitations(), field: { kind: 'agitations' } },
		{ key: 'assessment', label: m.mapping_table_assessment(), field: { kind: 'assessment' } }
	];
	return [...attributes, ...fixed];
}
