import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { canHoldSeveral } from '#lib/shared/select-mode.ts';
import { answerIsInSubtree, heldAnswerIds } from '#lib/shared/worker-population.ts';

export type HighlightField =
	| { kind: 'attribute'; attributeId: string }
	| { kind: 'languages' }
	| { kind: 'agitations' }
	| { kind: 'assessment' };

export type HighlightOperator = 'any' | 'all' | 'none';

export type HighlightClause = {
	type: 'clause';
	id: string;
	field: HighlightField;
	operator: HighlightOperator;
	values: string[];
};

/** Match all of (AND) or Match any of (OR) over a group's rules. */
export type HighlightMatch = 'all' | 'any';

export type HighlightGroup = {
	type: 'group';
	id: string;
	match: HighlightMatch;
	rules: HighlightRule[];
};

export type HighlightRule = HighlightClause | HighlightGroup;

export const maxHighlightDepth = 3;

/** The fields a Worker is read through. Only these are needed to evaluate a query. */
export type HighlightWorker = Pick<
	Worker,
	'id' | 'assessment' | 'attributes' | 'agitations' | 'languages'
>;

/** The nesting depth of a group: the top group with no nested group is 1. */
export function groupDepth(group: HighlightGroup): number {
	let deepest = 0;
	for (const rule of group.rules) {
		if (rule.type === 'group') deepest = Math.max(deepest, groupDepth(rule));
	}
	return deepest + 1;
}

/**
 * Whether the builder offers the 'all' operator for a field. A Worker holds only one
 * value of a Single-Select Attribute with no Multi-Select group beneath it, or of
 * Assessment, so 'all' is hidden there; any Attribute that can hold several values at
 * some level, Languages and Agitations can hold several values.
 */
export function canOfferAll(
	field: HighlightField,
	attributes: readonly WorkerAttributeDefinition[]
): boolean {
	if (field.kind === 'assessment') return false;
	if (field.kind !== 'attribute') return true;
	const attribute = findAttribute(attributes, field.attributeId);
	return attribute !== undefined && canHoldSeveral(attribute);
}

function findAttribute(
	attributes: readonly WorkerAttributeDefinition[],
	attributeId: string
): WorkerAttributeDefinition | undefined {
	return attributes.find((attribute) => attribute.id === attributeId);
}

/**
 * A clause is complete with at least one value and, for an Attribute, a configured
 * Attribute. A group is complete with at least one complete rule. Incomplete rules are
 * ignored everywhere, so they are neither true nor false.
 */
function isComplete(
	rule: HighlightRule,
	attributes: readonly WorkerAttributeDefinition[]
): boolean {
	if (rule.type === 'group') return rule.rules.some((child) => isComplete(child, attributes));
	if (rule.values.length === 0) return false;
	if (rule.field.kind !== 'attribute') return true;
	return findAttribute(attributes, rule.field.attributeId) !== undefined;
}

/** The value ids a Worker holds for a field, as its own records give them. */
function heldValues(
	worker: HighlightWorker,
	field: HighlightField,
	attributes: readonly WorkerAttributeDefinition[]
): string[] {
	if (field.kind === 'languages') return worker.languages;
	if (field.kind === 'agitations') return worker.agitations;
	if (field.kind === 'assessment') return [worker.assessment];
	const attribute = findAttribute(attributes, field.attributeId);
	return attribute ? heldAnswerIds(worker, attribute) : [];
}

/** Whether a held value satisfies a selected value; a parent includes its descendants. */
function valueHolds(
	field: HighlightField,
	attributes: readonly WorkerAttributeDefinition[],
	selected: string,
	held: string
): boolean {
	if (field.kind !== 'attribute') return selected === held;
	const attribute = findAttribute(attributes, field.attributeId);
	if (!attribute) return false;
	return answerIsInSubtree(attribute.answers, selected, held);
}

function clauseHolds(
	worker: HighlightWorker,
	clause: HighlightClause,
	attributes: readonly WorkerAttributeDefinition[]
): boolean {
	const held = heldValues(worker, clause.field, attributes);
	const holdsSelected = (selected: string) =>
		held.some((heldValue) => valueHolds(clause.field, attributes, selected, heldValue));
	if (clause.operator === 'any') return clause.values.some(holdsSelected);
	if (clause.operator === 'all') return clause.values.every(holdsSelected);
	return !clause.values.some(holdsSelected);
}

function ruleHolds(
	worker: HighlightWorker,
	rule: HighlightRule,
	attributes: readonly WorkerAttributeDefinition[]
): boolean {
	return rule.type === 'clause'
		? clauseHolds(worker, rule, attributes)
		: groupHolds(worker, rule, attributes);
}

function groupHolds(
	worker: HighlightWorker,
	group: HighlightGroup,
	attributes: readonly WorkerAttributeDefinition[]
): boolean {
	const complete = group.rules.filter((rule) => isComplete(rule, attributes));
	const holds = (rule: HighlightRule) => ruleHolds(worker, rule, attributes);
	return group.match === 'all' ? complete.every(holds) : complete.some(holds);
}

/**
 * The ids of the Workers a query selects, or undefined when no rule is complete, in
 * which case nothing is faded.
 */
export function evaluateHighlightQuery(
	query: HighlightGroup,
	workers: readonly HighlightWorker[],
	attributes: readonly WorkerAttributeDefinition[]
): Set<string> | undefined {
	if (!isComplete(query, attributes)) return undefined;
	return new Set(
		workers.filter((worker) => groupHolds(worker, query, attributes)).map((worker) => worker.id)
	);
}
