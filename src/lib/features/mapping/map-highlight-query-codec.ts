import {
	assessmentOptions,
	type Agitation,
	type Language,
	type WorkerAttributeDefinition
} from '#lib/domain-vocabulary.ts';
import {
	canOfferAll,
	maxHighlightDepth,
	type HighlightClause,
	type HighlightField,
	type HighlightGroup,
	type HighlightMatch,
	type HighlightOperator,
	type HighlightRule
} from './map-highlight-query.ts';

export type HighlightVocabulary = {
	attributes: readonly WorkerAttributeDefinition[];
	languages: readonly Language[];
	agitations: readonly Agitation[];
};

let ruleCounter = 0;

/** A rule id unique within this session. Ids are never serialised. */
export function newRuleId(): string {
	ruleCounter += 1;
	return `r${ruleCounter}`;
}

export function emptyHighlightQuery(): HighlightGroup {
	return { type: 'group', id: newRuleId(), match: 'all', rules: [] };
}

function fieldKey(field: HighlightField): string {
	if (field.kind === 'attribute') return `a:${field.attributeId}`;
	if (field.kind === 'languages') return 'l';
	if (field.kind === 'agitations') return 'g';
	return 's';
}

type WireRule =
	{ f: string; o: HighlightOperator; v: string[] } | { m: HighlightMatch; r: WireRule[] };

function encodeRules(rules: readonly HighlightRule[]): WireRule[] {
	const wire: WireRule[] = [];
	for (const rule of rules) {
		if (rule.type === 'clause') {
			if (rule.values.length > 0) {
				wire.push({ f: fieldKey(rule.field), o: rule.operator, v: [...rule.values] });
			}
			continue;
		}
		const nested = encodeRules(rule.rules);
		if (nested.length > 0) wire.push({ m: rule.match, r: nested });
	}
	return wire;
}

export function encodeHighlightQuery(query: HighlightGroup): string {
	const rules = encodeRules(query.rules);
	if (rules.length === 0) return '';
	return JSON.stringify({ v: 1, m: query.match, r: rules });
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveField(key: unknown, vocabulary: HighlightVocabulary): HighlightField | undefined {
	if (key === 'l') return { kind: 'languages' };
	if (key === 'g') return { kind: 'agitations' };
	if (key === 's') return { kind: 'assessment' };
	if (typeof key !== 'string' || !key.startsWith('a:')) return undefined;
	const attributeId = key.slice(2);
	if (!vocabulary.attributes.some((attribute) => attribute.id === attributeId)) return undefined;
	return { kind: 'attribute', attributeId };
}

function isKnownValue(
	field: HighlightField,
	value: string,
	vocabulary: HighlightVocabulary
): boolean {
	if (field.kind === 'languages')
		return vocabulary.languages.some((language) => language.id === value);
	if (field.kind === 'agitations')
		return vocabulary.agitations.some((agitation) => agitation.id === value);
	if (field.kind === 'assessment') return (assessmentOptions as readonly string[]).includes(value);
	const attribute = vocabulary.attributes.find((item) => item.id === field.attributeId);
	return attribute?.answers.some((entry) => entry.id === value) ?? false;
}

function decodeClause(raw: Dict, vocabulary: HighlightVocabulary): HighlightClause | undefined {
	const field = resolveField(raw.f, vocabulary);
	if (!field) return undefined;
	const operator = raw.o;
	if (operator !== 'any' && operator !== 'all' && operator !== 'none') return undefined;
	if (!Array.isArray(raw.v)) return undefined;
	const values: string[] = [];
	for (const value of raw.v) {
		if (typeof value === 'string' && isKnownValue(field, value, vocabulary)) values.push(value);
	}
	if (values.length === 0 && raw.v.length > 0) return undefined;
	const offersAll = canOfferAll(field, vocabulary.attributes);
	return {
		type: 'clause',
		id: newRuleId(),
		field,
		operator: operator === 'all' && !offersAll ? 'any' : operator,
		values: [...new Set(values)]
	};
}

function decodeRules(
	raw: unknown,
	depth: number,
	vocabulary: HighlightVocabulary
): HighlightRule[] {
	if (!Array.isArray(raw)) return [];
	const rules: HighlightRule[] = [];
	for (const item of raw) {
		if (!isDict(item)) continue;
		if ('f' in item) {
			const clause = decodeClause(item, vocabulary);
			if (clause) rules.push(clause);
			continue;
		}
		if (depth + 1 > maxHighlightDepth) continue;
		const nested = decodeRules(item.r, depth + 1, vocabulary);
		if (nested.length === 0) continue;
		rules.push({
			type: 'group',
			id: newRuleId(),
			match: item.m === 'any' ? 'any' : 'all',
			rules: nested
		});
	}
	return rules;
}

export function decodeHighlightQuery(
	text: string | null | undefined,
	vocabulary: HighlightVocabulary
): HighlightGroup {
	if (typeof text !== 'string') return emptyHighlightQuery();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return emptyHighlightQuery();
	}
	if (!isDict(parsed) || parsed.v !== 1) return emptyHighlightQuery();
	return {
		type: 'group',
		id: newRuleId(),
		match: parsed.m === 'any' ? 'any' : 'all',
		rules: decodeRules(parsed.r, 1, vocabulary)
	};
}

export function legacyLanguageQuery(
	languageId: string | null | undefined,
	vocabulary: HighlightVocabulary
): HighlightGroup {
	if (typeof languageId !== 'string' || languageId.trim() === '') return emptyHighlightQuery();
	if (!vocabulary.languages.some((language) => language.id === languageId)) {
		return emptyHighlightQuery();
	}
	return {
		type: 'group',
		id: newRuleId(),
		match: 'all',
		rules: [
			{
				type: 'clause',
				id: newRuleId(),
				field: { kind: 'languages' },
				operator: 'any',
				values: [languageId]
			}
		]
	};
}

function pruneRule(
	rule: HighlightRule,
	vocabulary: HighlightVocabulary
): HighlightRule | undefined {
	if (rule.type === 'group') {
		const rules = pruneRules(rule.rules, vocabulary);
		if (rules === rule.rules) return rule;
		return rules.length === 0 ? undefined : { ...rule, rules };
	}
	const field = rule.field;
	if (
		field.kind === 'attribute' &&
		!vocabulary.attributes.some((attribute) => attribute.id === field.attributeId)
	) {
		return undefined;
	}
	const values = rule.values.filter((value) => isKnownValue(field, value, vocabulary));
	const operator =
		rule.operator === 'all' && !canOfferAll(field, vocabulary.attributes) ? 'any' : rule.operator;
	if (values.length === rule.values.length && operator === rule.operator) return rule;
	return { ...rule, operator, values };
}

function pruneRules(rules: HighlightRule[], vocabulary: HighlightVocabulary): HighlightRule[] {
	const kept: HighlightRule[] = [];
	let changed = false;
	for (const rule of rules) {
		const pruned = pruneRule(rule, vocabulary);
		if (pruned !== rule) changed = true;
		if (pruned) kept.push(pruned);
	}
	return changed ? kept : rules;
}

/** Drops what the vocabulary no longer holds. Returns the same object when nothing changed. */
export function pruneHighlightQuery(
	query: HighlightGroup,
	vocabulary: HighlightVocabulary
): HighlightGroup {
	const rules = pruneRules(query.rules, vocabulary);
	return rules === query.rules ? query : { ...query, rules };
}
