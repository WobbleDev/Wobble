// @module-tag mapping
import { describe, expect, it } from 'vitest';
import {
	addClause,
	addGroup,
	canAddGroup,
	groupLevel,
	newClause,
	removeRule,
	setClauseField,
	setClauseOperator,
	setClauseValues,
	setGroupMatch,
	starterQuery,
	toggleClauseValue,
	withStarterRule
} from './map-highlight-query-edit.ts';
import type { HighlightGroup } from './map-highlight-query.ts';

describe('newClause', () => {
	it('starts on the Languages field with the any operator and no values', () => {
		expect(newClause()).toMatchObject({
			type: 'clause',
			field: { kind: 'languages' },
			operator: 'any',
			values: []
		});
	});

	it('gives each new clause its own id', () => {
		expect(newClause().id).not.toBe(newClause().id);
	});
});

describe('starterQuery', () => {
	it('is a top group that matches all of one empty clause', () => {
		const query = starterQuery();
		expect(query).toMatchObject({ type: 'group', match: 'all' });
		expect(query.rules).toHaveLength(1);
		expect(query.rules[0]).toMatchObject({ type: 'clause', operator: 'any', values: [] });
	});
});

describe('withStarterRule', () => {
	it('seeds one empty clause into a query with no rules, keeping its id and match', () => {
		const empty: HighlightGroup = { type: 'group', id: 'top', match: 'any', rules: [] };
		const seeded = withStarterRule(empty);
		expect(seeded).toMatchObject({ id: 'top', match: 'any' });
		expect(seeded.rules).toHaveLength(1);
		expect(seeded.rules[0]).toMatchObject({ type: 'clause', operator: 'any', values: [] });
	});

	it('keeps a query that already has a rule as it is', () => {
		const query = starterQuery();
		expect(withStarterRule(query)).toBe(query);
	});
});

/** A three-level query: top 'top', nested 'middle' inside it, and 'deep' inside that. */
function threeLevelQuery(): HighlightGroup {
	return {
		type: 'group',
		id: 'top',
		match: 'all',
		rules: [
			{
				type: 'group',
				id: 'middle',
				match: 'any',
				rules: [
					{
						type: 'group',
						id: 'deep',
						match: 'all',
						rules: [newClause()]
					}
				]
			}
		]
	};
}

describe('groupLevel', () => {
	it('numbers the top group 1 and each nested group one deeper', () => {
		const query = threeLevelQuery();
		expect(groupLevel(query, 'top')).toBe(1);
		expect(groupLevel(query, 'middle')).toBe(2);
		expect(groupLevel(query, 'deep')).toBe(3);
	});

	it('is undefined for an id that is not a group in the query', () => {
		expect(groupLevel(threeLevelQuery(), 'missing')).toBeUndefined();
	});
});

describe('canAddGroup', () => {
	it('allows a nested group inside the top group and the second level only', () => {
		const query = threeLevelQuery();
		expect(canAddGroup(query, 'top')).toBe(true);
		expect(canAddGroup(query, 'middle')).toBe(true);
		expect(canAddGroup(query, 'deep')).toBe(false);
	});

	it('is false for an unknown group id', () => {
		expect(canAddGroup(threeLevelQuery(), 'missing')).toBe(false);
	});
});

describe('addClause', () => {
	it('appends a new clause to the named group', () => {
		const result = addClause(threeLevelQuery(), 'middle');
		const middle = result.rules[0];
		if (middle.type !== 'group') throw new Error('expected a group');
		expect(middle.rules).toHaveLength(2);
		expect(middle.rules[1]).toMatchObject({ type: 'clause', operator: 'any', values: [] });
	});

	it('returns the same query when the group id is unknown', () => {
		const query = threeLevelQuery();
		expect(addClause(query, 'missing')).toBe(query);
	});
});

describe('addGroup', () => {
	it('appends a nested group that matches all of one clause', () => {
		const result = addGroup(threeLevelQuery(), 'top');
		expect(result.rules).toHaveLength(2);
		const added = result.rules[1];
		if (added.type !== 'group') throw new Error('expected a group');
		expect(added.match).toBe('all');
		expect(added.rules).toHaveLength(1);
		expect(added.rules[0]).toMatchObject({ type: 'clause' });
	});

	it('returns the same query when the group is at the deepest level', () => {
		const query = threeLevelQuery();
		expect(addGroup(query, 'deep')).toBe(query);
	});
});

describe('removeRule', () => {
	it('removes a nested group, and everything inside it, by id', () => {
		expect(removeRule(threeLevelQuery(), 'middle').rules).toHaveLength(0);
	});

	it('never removes the top group itself', () => {
		const query = threeLevelQuery();
		expect(removeRule(query, 'top')).toBe(query);
	});

	it('returns the same query when the rule id is unknown', () => {
		const query = threeLevelQuery();
		expect(removeRule(query, 'missing')).toBe(query);
	});
});

/** Top group 'top' holds clause 'c1' (English) and group 'g' (match any) holding clause 'c2' (Spanish). */
function editableQuery(): HighlightGroup {
	return {
		type: 'group',
		id: 'top',
		match: 'all',
		rules: [
			{
				type: 'clause',
				id: 'c1',
				field: { kind: 'languages' },
				operator: 'any',
				values: ['en']
			},
			{
				type: 'group',
				id: 'g',
				match: 'any',
				rules: [
					{
						type: 'clause',
						id: 'c2',
						field: { kind: 'languages' },
						operator: 'any',
						values: ['es']
					}
				]
			}
		]
	};
}

describe('setGroupMatch', () => {
	it('switches a group between match all of and match any of', () => {
		const result = setGroupMatch(editableQuery(), 'g', 'all');
		expect(result.rules[1]).toMatchObject({ id: 'g', match: 'all' });
	});
});

describe('setClauseField', () => {
	it('changing the field resets the operator to any and clears the values', () => {
		const query: HighlightGroup = {
			type: 'group',
			id: 'top',
			match: 'all',
			rules: [
				{
					type: 'clause',
					id: 'c',
					field: { kind: 'languages' },
					operator: 'all',
					values: ['en']
				}
			]
		};
		const result = setClauseField(query, 'c', { kind: 'assessment' });
		expect(result.rules[0]).toMatchObject({
			field: { kind: 'assessment' },
			operator: 'any',
			values: []
		});
	});
});

describe('setClauseOperator', () => {
	it('sets the operator of the named clause', () => {
		const result = setClauseOperator(editableQuery(), 'c1', 'none');
		expect(result.rules[0]).toMatchObject({ id: 'c1', operator: 'none', values: ['en'] });
	});
});

describe('setClauseValues', () => {
	it('replaces the values, dropping duplicates and keeping their order', () => {
		const result = setClauseValues(editableQuery(), 'c1', ['es', 'en', 'es']);
		expect(result.rules[0]).toMatchObject({ values: ['es', 'en'] });
	});
});

describe('toggleClauseValue', () => {
	it('adds a value that is absent and removes one that is present', () => {
		const added = toggleClauseValue(editableQuery(), 'c1', 'fr');
		expect(added.rules[0]).toMatchObject({ values: ['en', 'fr'] });
		const removed = toggleClauseValue(added, 'c1', 'en');
		expect(removed.rules[0]).toMatchObject({ values: ['fr'] });
	});
});

describe('edits with an unknown id', () => {
	it('return the same query object', () => {
		const query = editableQuery();
		expect(setGroupMatch(query, 'missing', 'any')).toBe(query);
		expect(setClauseField(query, 'missing', { kind: 'agitations' })).toBe(query);
		expect(setClauseOperator(query, 'missing', 'none')).toBe(query);
		expect(setClauseValues(query, 'missing', ['en'])).toBe(query);
		expect(toggleClauseValue(query, 'missing', 'en')).toBe(query);
	});
});

describe('immutability', () => {
	it('never mutates the query it is given', () => {
		const query = editableQuery();
		const snapshot = structuredClone(query);
		setGroupMatch(query, 'g', 'all');
		setClauseField(query, 'c1', { kind: 'agitations' });
		setClauseOperator(query, 'c1', 'none');
		setClauseValues(query, 'c1', ['x']);
		toggleClauseValue(query, 'c1', 'fr');
		addClause(query, 'g');
		addGroup(query, 'top');
		removeRule(query, 'c1');
		expect(query).toEqual(snapshot);
	});

	it('keeps unchanged sibling rules as the same objects', () => {
		const query = editableQuery();
		const result = toggleClauseValue(query, 'c2', 'fr');
		expect(result.rules[0]).toBe(query.rules[0]);
		expect(result.rules[1]).not.toBe(query.rules[1]);
	});
});
