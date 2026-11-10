// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import type { HighlightVocabulary } from './map-highlight-query-codec.ts';
import {
	describeHighlightQuery,
	highlightFieldKey,
	highlightFieldOptions,
	highlightOperatorLabel,
	highlightOperatorOptions,
	highlightValueOptions
} from './map-highlight-fields.ts';
import type {
	HighlightField,
	HighlightGroup,
	HighlightMatch,
	HighlightOperator,
	HighlightRule
} from './map-highlight-query.ts';

const role: WorkerAttributeDefinition = {
	id: 'role',
	name: 'Job',
	kind: 'category',
	answers: [
		{ id: 'front', value: 'Front of house' },
		{ id: 'server', value: 'Server', parentId: 'front' },
		{ id: 'floor', value: 'Floor Server', parentId: 'server' },
		{ id: 'bartender', value: 'Bartender', parentId: 'front' },
		{ id: 'cook', value: 'Cook' }
	]
};

const skills: WorkerAttributeDefinition = {
	id: 'skills',
	name: 'Skills',
	kind: 'tag',
	answers: [
		{ id: 'cpr', value: 'CPR' },
		{ id: 'first-aid', value: 'First aid' }
	]
};

const vocabulary: HighlightVocabulary = {
	attributes: [role, skills],
	languages: [
		{ id: 'en', name: 'English' },
		{ id: 'es', name: 'Spanish' }
	],
	agitations: [
		{ id: 'pay', text: 'Pay' },
		{ id: 'hours', text: 'Hours' }
	]
};

const roleField: HighlightField = { kind: 'attribute', attributeId: 'role' };
const skillsField: HighlightField = { kind: 'attribute', attributeId: 'skills' };
const languagesField: HighlightField = { kind: 'languages' };

describe('highlightOperatorLabel', () => {
	it.each([
		{
			kind: 'Single-Select Attribute',
			field: roleField,
			any: 'is one of',
			all: 'has all of',
			none: 'is none of'
		},
		{
			kind: 'Assessment',
			field: { kind: 'assessment' } as HighlightField,
			any: 'is one of',
			all: 'has all of',
			none: 'is none of'
		},
		{
			kind: 'Multi-Select Attribute',
			field: skillsField,
			any: 'has any of',
			all: 'has all of',
			none: 'has none of'
		},
		{
			kind: 'Languages',
			field: languagesField,
			any: 'has any of',
			all: 'has all of',
			none: 'has none of'
		},
		{
			kind: 'Agitations',
			field: { kind: 'agitations' } as HighlightField,
			any: 'has any of',
			all: 'has all of',
			none: 'has none of'
		}
	])('words the operators for $kind', ({ field, any, all, none }) => {
		expect(highlightOperatorLabel(field, vocabulary, 'any')).toBe(any);
		expect(highlightOperatorLabel(field, vocabulary, 'all')).toBe(all);
		expect(highlightOperatorLabel(field, vocabulary, 'none')).toBe(none);
	});
});

describe('highlightOperatorOptions', () => {
	it('offers has any of, has all of and has none of for a field that can hold several values', () => {
		expect(highlightOperatorOptions(skillsField, vocabulary)).toEqual([
			{ value: 'any', label: 'has any of' },
			{ value: 'all', label: 'has all of' },
			{ value: 'none', label: 'has none of' }
		]);
	});

	it('offers is one of and is none of for a field that holds one value', () => {
		expect(highlightOperatorOptions(roleField, vocabulary)).toEqual([
			{ value: 'any', label: 'is one of' },
			{ value: 'none', label: 'is none of' }
		]);
	});

	it('keeps has all of between the two when a held all is stored on a field that holds one value', () => {
		expect(highlightOperatorOptions(roleField, vocabulary, 'all')).toEqual([
			{ value: 'any', label: 'is one of' },
			{ value: 'all', label: 'has all of' },
			{ value: 'none', label: 'is none of' }
		]);
	});
});

function clause(
	id: string,
	field: HighlightField,
	operator: HighlightOperator,
	values: string[]
): HighlightRule {
	return { type: 'clause', id, field, operator, values };
}

function group(id: string, match: HighlightMatch, rules: HighlightRule[]): HighlightGroup {
	return { type: 'group', id, match, rules };
}

describe('describeHighlightQuery', () => {
	it('reads one complete clause with a single value as its field, operator label and value', () => {
		const query = group('top', 'all', [clause('c1', roleField, 'any', ['server'])]);
		expect(describeHighlightQuery(query, vocabulary)).toBe('Job is one of Server');
	});

	it('joins rules with "and" under a Match all group, listing several values', () => {
		const query = group('top', 'all', [
			clause('c1', roleField, 'any', ['server', 'bartender']),
			clause('c2', languagesField, 'all', ['en', 'es'])
		]);
		expect(describeHighlightQuery(query, vocabulary)).toBe(
			'Job is one of Server, Bartender and Languages has all of English, Spanish'
		);
	});

	it('joins rules with "or" under a Match any group, and reads none of', () => {
		const query = group('top', 'any', [
			clause('c1', roleField, 'any', ['server']),
			clause('c2', languagesField, 'none', ['es'])
		]);
		expect(describeHighlightQuery(query, vocabulary)).toBe(
			'Job is one of Server or Languages has none of Spanish'
		);
	});

	it('wraps each nested group in parentheses and leaves the top group bare', () => {
		const query = group('top', 'any', [
			group('g1', 'all', [
				clause('c1', roleField, 'any', ['server']),
				clause('c2', languagesField, 'any', ['es'])
			]),
			group('g2', 'all', [
				clause('c3', roleField, 'any', ['bartender']),
				clause('c4', languagesField, 'all', ['en', 'es'])
			])
		]);
		expect(describeHighlightQuery(query, vocabulary)).toBe(
			'(Job is one of Server and Languages has any of Spanish) or (Job is one of Bartender and Languages has all of English, Spanish)'
		);
	});

	it('skips incomplete rules and groups', () => {
		const query = group('top', 'all', [
			clause('c1', roleField, 'any', []),
			group('g1', 'all', [clause('c2', roleField, 'any', [])]),
			clause('c3', languagesField, 'any', ['es'])
		]);
		expect(describeHighlightQuery(query, vocabulary)).toBe('Languages has any of Spanish');
	});

	it('is empty when no rule is complete', () => {
		expect(describeHighlightQuery(group('top', 'all', []), vocabulary)).toBe('');
		expect(
			describeHighlightQuery(group('top', 'all', [clause('c1', roleField, 'any', [])]), vocabulary)
		).toBe('');
	});

	it('skips a value that no longer exists', () => {
		const query = group('top', 'all', [
			clause('c1', roleField, 'any', ['server', 'deleted']),
			clause('c2', languagesField, 'any', ['deleted'])
		]);
		expect(describeHighlightQuery(query, vocabulary)).toBe('Job is one of Server');
	});

	it('lists Languages by name, all at depth 0', () => {
		expect(highlightValueOptions({ kind: 'languages' }, vocabulary)).toEqual([
			{ id: 'en', label: 'English', depth: 0 },
			{ id: 'es', label: 'Spanish', depth: 0 }
		]);
	});

	it('lists Agitations by their text, all at depth 0', () => {
		expect(highlightValueOptions({ kind: 'agitations' }, vocabulary)).toEqual([
			{ id: 'pay', label: 'Pay', depth: 0 },
			{ id: 'hours', label: 'Hours', depth: 0 }
		]);
	});

	it('lists Assessment with every option, all at depth 0', () => {
		expect(highlightValueOptions({ kind: 'assessment' }, vocabulary)).toEqual([
			{ id: 'Unassessed', label: 'Unassessed', depth: 0 },
			{ id: 'Leader', label: 'Leader', depth: 0 },
			{ id: 'Activist', label: 'Activist', depth: 0 },
			{ id: 'Supporter', label: 'Supporter', depth: 0 },
			{ id: 'Disengaged', label: 'Disengaged', depth: 0 },
			{ id: 'Hostile', label: 'Hostile', depth: 0 }
		]);
	});

	it('lists an Attribute as a hierarchy: each parent before its children, with depth', () => {
		expect(highlightValueOptions({ kind: 'attribute', attributeId: 'role' }, vocabulary)).toEqual([
			{ id: 'front', label: 'Front of house', depth: 0 },
			{ id: 'server', label: 'Server', depth: 1 },
			{ id: 'floor', label: 'Floor Server', depth: 2 },
			{ id: 'bartender', label: 'Bartender', depth: 1 },
			{ id: 'cook', label: 'Cook', depth: 0 }
		]);
	});
});

describe('depth-five Attribute answers', () => {
	const chain: WorkerAttributeDefinition = {
		id: 'chain',
		name: 'Depth',
		kind: 'category',
		answers: [
			{ id: 'l1', value: 'Level 1' },
			{ id: 'l2', value: 'Level 2', parentId: 'l1' },
			{ id: 'l3', value: 'Level 3', parentId: 'l2' },
			{ id: 'l4', value: 'Level 4', parentId: 'l3' },
			{ id: 'l5', value: 'Level 5', parentId: 'l4' }
		]
	};
	const chainVocabulary: HighlightVocabulary = {
		attributes: [chain],
		languages: [],
		agitations: []
	};
	const chainField: HighlightField = { kind: 'attribute', attributeId: 'chain' };

	it('lists all five levels in order, each one level deeper than its parent', () => {
		expect(highlightValueOptions(chainField, chainVocabulary)).toEqual([
			{ id: 'l1', label: 'Level 1', depth: 0 },
			{ id: 'l2', label: 'Level 2', depth: 1 },
			{ id: 'l3', label: 'Level 3', depth: 2 },
			{ id: 'l4', label: 'Level 4', depth: 3 },
			{ id: 'l5', label: 'Level 5', depth: 4 }
		]);
	});

	it('reads a rule on the deepest answer by its own label', () => {
		const query = group('top', 'all', [clause('c1', chainField, 'any', ['l5'])]);

		expect(describeHighlightQuery(query, chainVocabulary)).toBe('Depth is one of Level 5');
	});
});

describe('highlightFieldOptions', () => {
	it('offers every Attribute in order, then Languages, Agitations and Assessment', () => {
		expect(highlightFieldOptions(vocabulary)).toEqual([
			{ key: 'a:role', label: 'Job', field: { kind: 'attribute', attributeId: 'role' } },
			{ key: 'a:skills', label: 'Skills', field: { kind: 'attribute', attributeId: 'skills' } },
			{ key: 'languages', label: 'Languages', field: { kind: 'languages' } },
			{ key: 'agitations', label: 'Agitations', field: { kind: 'agitations' } },
			{ key: 'assessment', label: 'Assessment', field: { kind: 'assessment' } }
		]);
	});
});

describe('highlightFieldKey', () => {
	it('gives each field a stable select value', () => {
		expect(highlightFieldKey({ kind: 'attribute', attributeId: 'role' })).toBe('a:role');
		expect(highlightFieldKey({ kind: 'languages' })).toBe('languages');
		expect(highlightFieldKey({ kind: 'agitations' })).toBe('agitations');
		expect(highlightFieldKey({ kind: 'assessment' })).toBe('assessment');
	});
});
