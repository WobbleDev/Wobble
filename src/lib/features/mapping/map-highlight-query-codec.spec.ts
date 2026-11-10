// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import {
	decodeHighlightQuery,
	emptyHighlightQuery,
	encodeHighlightQuery,
	legacyLanguageQuery,
	newRuleId,
	pruneHighlightQuery,
	type HighlightVocabulary
} from './map-highlight-query-codec.ts';
import type { HighlightClause, HighlightGroup, HighlightRule } from './map-highlight-query.ts';

const role: WorkerAttributeDefinition = {
	id: 'role',
	name: 'Role',
	kind: 'category',
	answers: [
		{ id: 'front', value: 'Front of house' },
		{ id: 'server', value: 'Server', parentId: 'front' },
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
	agitations: [{ id: 'pay', text: 'Pay' }]
};

function clause(
	field: HighlightClause['field'],
	operator: HighlightClause['operator'],
	values: string[]
): HighlightClause {
	return { type: 'clause', id: newRuleId(), field, operator, values };
}

function group(match: HighlightGroup['match'], rules: HighlightRule[]): HighlightGroup {
	return { type: 'group', id: newRuleId(), match, rules };
}

describe('encodeHighlightQuery', () => {
	it('encodes an empty query as an empty string', () => {
		expect(encodeHighlightQuery(emptyHighlightQuery())).toBe('');
	});

	it('writes a clause in the version 1 wire format', () => {
		const query = group('all', [
			clause({ kind: 'attribute', attributeId: 'role' }, 'any', ['server'])
		]);
		expect(encodeHighlightQuery(query)).toBe(
			'{"v":1,"m":"all","r":[{"f":"a:role","o":"any","v":["server"]}]}'
		);
	});

	it('omits empty clauses and empty groups, and writes nested groups', () => {
		const query = group('all', [
			clause({ kind: 'attribute', attributeId: 'role' }, 'any', []),
			group('any', [clause({ kind: 'languages' }, 'any', ['en'])]),
			group('any', [clause({ kind: 'attribute', attributeId: 'role' }, 'any', [])])
		]);
		expect(encodeHighlightQuery(query)).toBe(
			'{"v":1,"m":"all","r":[{"m":"any","r":[{"f":"l","o":"any","v":["en"]}]}]}'
		);
	});
});

describe('decodeHighlightQuery', () => {
	it('reads back a nested query it wrote, so encoding round-trips', () => {
		const text =
			'{"v":1,"m":"all","r":[{"f":"a:role","o":"any","v":["server","bartender"]},{"m":"any","r":[{"f":"l","o":"all","v":["en","es"]},{"f":"a:skills","o":"none","v":["cpr"]}]}]}';
		expect(encodeHighlightQuery(decodeHighlightQuery(text, vocabulary))).toBe(text);
	});

	it('treats malformed JSON as an empty query', () => {
		expect(encodeHighlightQuery(decodeHighlightQuery('{"v":1,"m":"all"', vocabulary))).toBe('');
	});

	it('treats a non-object or another version as an empty query', () => {
		for (const text of ['null', '[]', '"text"', '42']) {
			expect(encodeHighlightQuery(decodeHighlightQuery(text, vocabulary))).toBe('');
		}
		const version2 = '{"v":2,"m":"all","r":[{"f":"l","o":"any","v":["en"]}]}';
		expect(encodeHighlightQuery(decodeHighlightQuery(version2, vocabulary))).toBe('');
	});

	it('drops clauses with an unknown attribute, field key or operator', () => {
		const text =
			'{"v":1,"m":"all","r":[{"f":"a:ghost","o":"any","v":["x"]},{"f":"l","o":"bogus","v":["en"]},{"f":"zz","o":"any","v":["en"]},{"f":"l","o":"any","v":["en"]}]}';
		expect(encodeHighlightQuery(decodeHighlightQuery(text, vocabulary))).toBe(
			'{"v":1,"m":"all","r":[{"f":"l","o":"any","v":["en"]}]}'
		);
	});

	it('keeps only the known values of each field', () => {
		const text =
			'{"v":1,"m":"all","r":[{"f":"l","o":"any","v":["en","fr",3]},{"f":"g","o":"any","v":["zz"]},{"f":"s","o":"any","v":["Wizard","Leader"]},{"f":"a:role","o":"any","v":["ghost-role","server"]}]}';
		expect(encodeHighlightQuery(decodeHighlightQuery(text, vocabulary))).toBe(
			'{"v":1,"m":"all","r":[{"f":"l","o":"any","v":["en"]},{"f":"s","o":"any","v":["Leader"]},{"f":"a:role","o":"any","v":["server"]}]}'
		);
	});

	it('changes all of to any of on a Single-Select Attribute, and keeps it on a Multi-Select one', () => {
		const text =
			'{"v":1,"m":"all","r":[{"f":"a:role","o":"all","v":["server"]},{"f":"a:skills","o":"all","v":["cpr"]}]}';
		expect(encodeHighlightQuery(decodeHighlightQuery(text, vocabulary))).toBe(
			'{"v":1,"m":"all","r":[{"f":"a:role","o":"any","v":["server"]},{"f":"a:skills","o":"all","v":["cpr"]}]}'
		);
	});

	it('removes repeated values within one clause', () => {
		const text = '{"v":1,"m":"all","r":[{"f":"l","o":"any","v":["en","en"]}]}';
		expect(encodeHighlightQuery(decodeHighlightQuery(text, vocabulary))).toBe(
			'{"v":1,"m":"all","r":[{"f":"l","o":"any","v":["en"]}]}'
		);
	});

	it('truncates groups nested deeper than three levels', () => {
		const text =
			'{"v":1,"m":"all","r":[{"f":"l","o":"any","v":["en"]},{"m":"any","r":[{"m":"all","r":[{"f":"l","o":"any","v":["es"]},{"m":"any","r":[{"f":"l","o":"any","v":["en"]}]}]}]}]}';
		expect(encodeHighlightQuery(decodeHighlightQuery(text, vocabulary))).toBe(
			'{"v":1,"m":"all","r":[{"f":"l","o":"any","v":["en"]},{"m":"any","r":[{"m":"all","r":[{"f":"l","o":"any","v":["es"]}]}]}]}'
		);
	});

	it('returns an empty query for a null or undefined text', () => {
		expect(encodeHighlightQuery(decodeHighlightQuery(null, vocabulary))).toBe('');
		expect(encodeHighlightQuery(decodeHighlightQuery(undefined, vocabulary))).toBe('');
	});
});

describe('legacyLanguageQuery', () => {
	it('reads the old lang parameter as one language clause, or nothing when unknown or blank', () => {
		expect(encodeHighlightQuery(legacyLanguageQuery('es', vocabulary))).toBe(
			'{"v":1,"m":"all","r":[{"f":"l","o":"any","v":["es"]}]}'
		);
		for (const languageId of ['fr', '', '   ', null, undefined]) {
			expect(encodeHighlightQuery(legacyLanguageQuery(languageId, vocabulary))).toBe('');
		}
	});
});

describe('pruneHighlightQuery', () => {
	const text =
		'{"v":1,"m":"all","r":[{"f":"l","o":"any","v":["en","es"]},{"f":"a:role","o":"any","v":["server"]}]}';

	it('returns the same object when nothing in the query was deleted', () => {
		const query = decodeHighlightQuery(text, vocabulary);
		expect(pruneHighlightQuery(query, vocabulary)).toBe(query);
	});

	it('drops a deleted language value and a deleted attribute, keeping the ids of what remains', () => {
		const query = decodeHighlightQuery(text, vocabulary);
		const afterDeletions = {
			attributes: [skills],
			languages: [{ id: 'en', name: 'English' }],
			agitations: vocabulary.agitations
		};
		const pruned = pruneHighlightQuery(query, afterDeletions);
		expect(encodeHighlightQuery(pruned)).toBe(
			'{"v":1,"m":"all","r":[{"f":"l","o":"any","v":["en"]}]}'
		);
		expect(pruned.rules[0].id).toBe(query.rules[0].id);
		expect(encodeHighlightQuery(query)).toBe(text);
	});
});

describe('decodeHighlightQuery ids', () => {
	it('generates new rule ids on each decode and never serialises them', () => {
		const text = '{"v":1,"m":"all","r":[{"f":"l","o":"any","v":["en"]}]}';
		const first = decodeHighlightQuery(text, vocabulary);
		const second = decodeHighlightQuery(text, vocabulary);
		expect(first.rules[0].id).not.toBe(second.rules[0].id);
		expect(encodeHighlightQuery(first)).not.toContain(first.rules[0].id);
	});
});
