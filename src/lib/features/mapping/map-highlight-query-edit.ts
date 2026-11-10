import { newRuleId } from './map-highlight-query-codec.ts';
import {
	maxHighlightDepth,
	type HighlightClause,
	type HighlightField,
	type HighlightGroup,
	type HighlightMatch,
	type HighlightOperator,
	type HighlightRule
} from './map-highlight-query.ts';

export function newClause(): HighlightClause {
	return {
		type: 'clause',
		id: newRuleId(),
		field: { kind: 'languages' },
		operator: 'any',
		values: []
	};
}

function newGroup(): HighlightGroup {
	return { type: 'group', id: newRuleId(), match: 'all', rules: [newClause()] };
}

export function starterQuery(): HighlightGroup {
	return newGroup();
}

export function withStarterRule(query: HighlightGroup): HighlightGroup {
	if (query.rules.length > 0) return query;
	return { ...query, rules: [newClause()] };
}

function levelWithin(group: HighlightGroup, groupId: string, level: number): number | undefined {
	if (group.id === groupId) return level;
	for (const rule of group.rules) {
		if (rule.type !== 'group') continue;
		const found = levelWithin(rule, groupId, level + 1);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** The nesting level of a group: the top group is 1. Undefined when the id is not a group here. */
export function groupLevel(query: HighlightGroup, groupId: string): number | undefined {
	return levelWithin(query, groupId, 1);
}

export function canAddGroup(query: HighlightGroup, groupId: string): boolean {
	const level = groupLevel(query, groupId);
	return level !== undefined && level < maxHighlightDepth;
}

type RuleEdit = (rule: HighlightRule) => HighlightRule | undefined;

/**
 * Edits the rule with this id wherever it sits below the group. Returns the same group when
 * nothing changed, and rebuilds only the path of groups down to the edited rule.
 */
function editRuleWithin(group: HighlightGroup, ruleId: string, edit: RuleEdit): HighlightGroup {
	let changed = false;
	const rules: HighlightRule[] = [];
	for (const rule of group.rules) {
		let next: HighlightRule | undefined = rule;
		if (rule.id === ruleId) next = edit(rule);
		else if (rule.type === 'group') next = editRuleWithin(rule, ruleId, edit);
		if (next !== rule) changed = true;
		if (next) rules.push(next);
	}
	return changed ? { ...group, rules } : group;
}

/** Edits a group by id, the top group included. */
function editGroup(
	query: HighlightGroup,
	groupId: string,
	edit: (group: HighlightGroup) => HighlightGroup
): HighlightGroup {
	if (query.id === groupId) return edit(query);
	return editRuleWithin(query, groupId, (rule) => (rule.type === 'group' ? edit(rule) : rule));
}

export function addClause(query: HighlightGroup, groupId: string): HighlightGroup {
	return editGroup(query, groupId, (group) => ({
		...group,
		rules: [...group.rules, newClause()]
	}));
}

export function addGroup(query: HighlightGroup, groupId: string): HighlightGroup {
	if (!canAddGroup(query, groupId)) return query;
	return editGroup(query, groupId, (group) => ({
		...group,
		rules: [...group.rules, newGroup()]
	}));
}

export function removeRule(query: HighlightGroup, ruleId: string): HighlightGroup {
	if (query.id === ruleId) return query;
	return editRuleWithin(query, ruleId, () => undefined);
}

function editClause(
	query: HighlightGroup,
	clauseId: string,
	edit: (clause: HighlightClause) => HighlightClause
): HighlightGroup {
	return editRuleWithin(query, clauseId, (rule) => (rule.type === 'clause' ? edit(rule) : rule));
}

export function setGroupMatch(
	query: HighlightGroup,
	groupId: string,
	match: HighlightMatch
): HighlightGroup {
	return editGroup(query, groupId, (group) =>
		group.match === match ? group : { ...group, match }
	);
}

export function setClauseField(
	query: HighlightGroup,
	clauseId: string,
	field: HighlightField
): HighlightGroup {
	return editClause(query, clauseId, (clause) => ({
		...clause,
		field,
		operator: 'any',
		values: []
	}));
}

export function setClauseOperator(
	query: HighlightGroup,
	clauseId: string,
	operator: HighlightOperator
): HighlightGroup {
	return editClause(query, clauseId, (clause) => ({ ...clause, operator }));
}

export function setClauseValues(
	query: HighlightGroup,
	clauseId: string,
	values: string[]
): HighlightGroup {
	return editClause(query, clauseId, (clause) => ({ ...clause, values: [...new Set(values)] }));
}

export function toggleClauseValue(
	query: HighlightGroup,
	clauseId: string,
	value: string
): HighlightGroup {
	return editClause(query, clauseId, (clause) => ({
		...clause,
		values: clause.values.includes(value)
			? clause.values.filter((held) => held !== value)
			: [...clause.values, value]
	}));
}
