// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import {
	canOfferAll,
	evaluateHighlightQuery,
	groupDepth,
	type HighlightClause,
	type HighlightField,
	type HighlightGroup,
	type HighlightRule,
	type HighlightWorker
} from './map-highlight-query.ts';

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

const site: WorkerAttributeDefinition = {
	id: 'site',
	name: 'Site',
	kind: 'tag',
	answers: [
		{ id: 'north', value: 'North' },
		{ id: 'south', value: 'South' }
	]
};

const attributes = [role, skills, site];

function worker(id: string, fields: Partial<HighlightWorker> = {}): HighlightWorker {
	return {
		id,
		assessment: 'Unassessed',
		attributes: {},
		agitations: [],
		languages: [],
		...fields
	};
}

function roleClause(
	id: string,
	operator: HighlightClause['operator'],
	values: string[]
): HighlightClause {
	return {
		type: 'clause',
		id,
		field: { kind: 'attribute', attributeId: 'role' },
		operator,
		values
	};
}

function languageClause(
	id: string,
	operator: HighlightClause['operator'],
	values: string[]
): HighlightClause {
	return { type: 'clause', id, field: { kind: 'languages' }, operator, values };
}

function group(id: string, match: HighlightGroup['match'], rules: HighlightRule[]): HighlightGroup {
	return { type: 'group', id, match, rules };
}

function clauseOn(
	id: string,
	field: HighlightField,
	operator: HighlightClause['operator'],
	values: string[]
): HighlightClause {
	return { type: 'clause', id, field, operator, values };
}

// Six Workers covering the cases the builder must tell apart.
const ana = worker('ana', { attributes: { role: 'server' }, languages: ['en', 'es'] });
const ben = worker('ben', { attributes: { role: 'bartender' }, languages: ['en', 'es'] });
const cy = worker('cy', { attributes: { role: 'cook' }, languages: ['en'] });
const dee = worker('dee', { attributes: { role: 'server' }, languages: ['es'] });
const eli = worker('eli', { attributes: { role: 'bartender' } });
const fay = worker('fay', { attributes: { role: '' }, languages: ['en', 'es'] });
const everyone = [ana, ben, cy, dee, eli, fay];

describe('evaluateHighlightQuery', () => {
	it('any of two Role values selects the Workers holding either', () => {
		const query = group('top', 'all', [roleClause('c1', 'any', ['server', 'bartender'])]);

		expect(evaluateHighlightQuery(query, everyone, attributes)).toEqual(
			new Set(['ana', 'ben', 'dee', 'eli'])
		);
	});

	it('Servers and Bartenders who hold both English and Spanish drops the one-language Workers', () => {
		const query = group('top', 'all', [
			roleClause('c1', 'any', ['server', 'bartender']),
			languageClause('c2', 'all', ['en', 'es'])
		]);

		expect(evaluateHighlightQuery(query, everyone, attributes)).toEqual(new Set(['ana', 'ben']));
	});

	it('a nested query selects Servers who speak Spanish or Bartenders who speak both', () => {
		const servingSpanish = group('g1', 'all', [
			roleClause('c1', 'any', ['server']),
			languageClause('c2', 'any', ['es'])
		]);
		const bilingualBartenders = group('g2', 'all', [
			roleClause('c3', 'any', ['bartender']),
			languageClause('c4', 'all', ['en', 'es'])
		]);
		const query = group('top', 'any', [servingSpanish, bilingualBartenders]);

		expect(evaluateHighlightQuery(query, everyone, attributes)).toEqual(
			new Set(['ana', 'dee', 'ben'])
		);
	});

	it('none of a value includes Workers with no value recorded', () => {
		const query = group('top', 'all', [roleClause('c1', 'none', ['cook'])]);

		expect(evaluateHighlightQuery(query, everyone, attributes)).toEqual(
			new Set(['ana', 'ben', 'dee', 'eli', 'fay'])
		);
	});

	it('an incomplete clause is ignored rather than treated as false', () => {
		const query = group('top', 'all', [
			roleClause('c1', 'any', []),
			roleClause('c2', 'any', ['server'])
		]);

		expect(evaluateHighlightQuery(query, everyone, attributes)).toEqual(new Set(['ana', 'dee']));
	});

	it('a group whose rules are all incomplete is ignored, not treated as false', () => {
		const emptyGroup = group('g1', 'any', [roleClause('c1', 'any', [])]);
		const query = group('top', 'all', [emptyGroup, roleClause('c2', 'any', ['cook'])]);

		expect(evaluateHighlightQuery(query, everyone, attributes)).toEqual(new Set(['cy']));
	});

	it('a query with no complete rule is undefined so nothing is faded', () => {
		expect(evaluateHighlightQuery(group('top', 'all', []), everyone, attributes)).toBeUndefined();
		const onlyIncomplete = group('top', 'all', [roleClause('c1', 'any', [])]);
		expect(evaluateHighlightQuery(onlyIncomplete, everyone, attributes)).toBeUndefined();
	});

	it('a complete query that matches nobody returns an empty set', () => {
		const query = group('top', 'all', [roleClause('c1', 'any', ['cook'])]);

		expect(evaluateHighlightQuery(query, [ana, dee], attributes)).toEqual(new Set());
	});

	it('a parent value counts a Worker who holds one of its descendants', () => {
		const query = group('top', 'all', [roleClause('c1', 'any', ['front'])]);

		expect(evaluateHighlightQuery(query, everyone, attributes)).toEqual(
			new Set(['ana', 'ben', 'dee', 'eli'])
		);
	});

	it('a clause on an Attribute that is no longer configured is ignored', () => {
		const missing = clauseOn('c1', { kind: 'attribute', attributeId: 'retired' }, 'any', ['x']);
		const query = group('top', 'all', [missing, roleClause('c2', 'any', ['cook'])]);

		expect(evaluateHighlightQuery(query, everyone, attributes)).toEqual(new Set(['cy']));
	});

	it("a Multi-Select value is read across all of a Worker's selections", () => {
		const travelling = worker('travelling', { attributes: { site: ['north', 'south'] } });
		const northOnly = worker('north-only', { attributes: { site: ['north'] } });
		const unplaced = worker('unplaced', { attributes: { site: [] } });
		const workers = [travelling, northOnly, unplaced];

		const anyNorth = group('top', 'all', [
			clauseOn('c1', { kind: 'attribute', attributeId: 'site' }, 'any', ['north'])
		]);
		expect(evaluateHighlightQuery(anyNorth, workers, attributes)).toEqual(
			new Set(['travelling', 'north-only'])
		);

		const bothSites = group('top', 'all', [
			clauseOn('c2', { kind: 'attribute', attributeId: 'site' }, 'all', ['north', 'south'])
		]);
		expect(evaluateHighlightQuery(bothSites, workers, attributes)).toEqual(new Set(['travelling']));

		const noSouth = group('top', 'all', [
			clauseOn('c3', { kind: 'attribute', attributeId: 'site' }, 'none', ['south'])
		]);
		expect(evaluateHighlightQuery(noSouth, workers, attributes)).toEqual(
			new Set(['north-only', 'unplaced'])
		);
	});

	it('evaluates different Attributes independently, whichever values a Worker holds', () => {
		const travellingFirstAider = worker('ada', {
			attributes: { site: ['north', 'south'], skills: ['cpr', 'first-aid'] }
		});
		const northOnly = worker('bea', { attributes: { site: ['north'], skills: ['first-aid'] } });
		const firstAidOnly = worker('cy', { attributes: { site: ['south'], skills: ['cpr'] } });
		const bothAtNorth = worker('dee', { attributes: { site: ['north'], skills: ['cpr'] } });
		const query = group('top', 'all', [
			clauseOn('c1', { kind: 'attribute', attributeId: 'site' }, 'any', ['north']),
			clauseOn('c2', { kind: 'attribute', attributeId: 'skills' }, 'any', ['cpr'])
		]);

		// North and CPR are separate Attribute predicates: Ada holds both, Bea only
		// North, Cy only CPR, and Dee both.
		expect(
			evaluateHighlightQuery(
				query,
				[travellingFirstAider, northOnly, firstAidOnly, bothAtNorth],
				attributes
			)
		).toEqual(new Set(['ada', 'dee']));
	});

	it('a parent value of a Multi-Select Attribute includes every descendant held', () => {
		const areas: WorkerAttributeDefinition = {
			id: 'areas',
			name: 'Areas',
			kind: 'tag',
			answers: [
				{ id: 'north', value: 'North' },
				{ id: 'north-store', value: 'North Store', parentId: 'north' },
				{ id: 'south', value: 'South' }
			]
		};
		const vocabulary = [...attributes, areas];
		const descendant = worker('descendant', { attributes: { areas: ['north-store'] } });
		const sibling = worker('sibling', { attributes: { areas: ['south'] } });
		const parentHolder = worker('parent-holder', { attributes: { areas: ['north'] } });
		const query = group('top', 'all', [
			clauseOn('c1', { kind: 'attribute', attributeId: 'areas' }, 'any', ['north'])
		]);

		expect(evaluateHighlightQuery(query, [descendant, sibling, parentHolder], vocabulary)).toEqual(
			new Set(['descendant', 'parent-holder'])
		);
	});

	it('all of several Multi-Select values needs each value to be held', () => {
		const firstAider = worker('first-aider', { attributes: { skills: ['cpr'] } });
		const trained = worker('trained', { attributes: { skills: ['cpr', 'first-aid'] } });
		const query = group('top', 'all', [
			clauseOn('c1', { kind: 'attribute', attributeId: 'skills' }, 'all', ['cpr', 'first-aid'])
		]);

		expect(evaluateHighlightQuery(query, [firstAider, trained], attributes)).toEqual(
			new Set(['trained'])
		);
	});

	it('an assessment clause matches the Workers placed in any listed assessment', () => {
		const leader = worker('leader', { assessment: 'Leader' });
		const activist = worker('activist', { assessment: 'Activist' });
		const supporter = worker('supporter', { assessment: 'Supporter' });
		const query = group('top', 'all', [
			clauseOn('c1', { kind: 'assessment' }, 'any', ['Leader', 'Activist'])
		]);

		expect(evaluateHighlightQuery(query, [leader, activist, supporter], attributes)).toEqual(
			new Set(['leader', 'activist'])
		);
	});
});

describe('depth-five answers', () => {
	const chain: WorkerAttributeDefinition = {
		id: 'chain',
		name: 'Chain',
		kind: 'category',
		answers: [
			{ id: 'l1', value: 'Level 1' },
			{ id: 'l2', value: 'Level 2', parentId: 'l1' },
			{ id: 'l3', value: 'Level 3', parentId: 'l2' },
			{ id: 'l4', value: 'Level 4', parentId: 'l3' },
			{ id: 'l5', value: 'Level 5', parentId: 'l4' }
		]
	};
	const chainAttributes = [chain];
	const chainField: HighlightField = { kind: 'attribute', attributeId: 'chain' };
	const holdsL5 = worker('holds-l5', { attributes: { chain: 'l5' } });
	const holdsL2 = worker('holds-l2', { attributes: { chain: 'l2' } });
	const holdsL1 = worker('holds-l1', { attributes: { chain: 'l1' } });
	const chainWorkers = [holdsL5, holdsL2, holdsL1];

	it('a selected ancestor at any depth matches a Worker holding the depth-five answer', () => {
		expect(
			evaluateHighlightQuery(
				group('top', 'all', [clauseOn('c1', chainField, 'any', ['l2'])]),
				chainWorkers,
				chainAttributes
			)
		).toEqual(new Set(['holds-l5', 'holds-l2']));
		expect(
			evaluateHighlightQuery(
				group('top', 'all', [clauseOn('c1', chainField, 'any', ['l3'])]),
				chainWorkers,
				chainAttributes
			)
		).toEqual(new Set(['holds-l5']));
		expect(
			evaluateHighlightQuery(
				group('top', 'all', [clauseOn('c1', chainField, 'any', ['l1'])]),
				chainWorkers,
				chainAttributes
			)
		).toEqual(new Set(['holds-l5', 'holds-l2', 'holds-l1']));
	});

	it('selecting the depth-five answer itself matches only the Workers holding it', () => {
		expect(
			evaluateHighlightQuery(
				group('top', 'all', [clauseOn('c1', chainField, 'any', ['l5'])]),
				chainWorkers,
				chainAttributes
			)
		).toEqual(new Set(['holds-l5']));
		expect(
			evaluateHighlightQuery(
				group('top', 'all', [clauseOn('c1', chainField, 'none', ['l5'])]),
				chainWorkers,
				chainAttributes
			)
		).toEqual(new Set(['holds-l2', 'holds-l1']));
	});
});

describe('groupDepth', () => {
	it('a top group with no nested group has depth 1', () => {
		expect(groupDepth(group('top', 'all', [roleClause('c1', 'any', ['cook'])]))).toBe(1);
	});

	it('a group containing one nested group has depth 2', () => {
		const nested = group('g1', 'any', [roleClause('c1', 'any', ['cook'])]);

		expect(groupDepth(group('top', 'all', [nested]))).toBe(2);
	});

	it('a group nested two levels deep has depth 3', () => {
		const deepest = group('g2', 'any', [roleClause('c1', 'any', ['cook'])]);
		const middle = group('g1', 'all', [deepest]);

		expect(groupDepth(group('top', 'all', [middle]))).toBe(3);
	});
});

describe('canOfferAll with a Multi-Select group (ADR 0043)', () => {
	const department: WorkerAttributeDefinition = {
		id: 'department',
		name: 'Department',
		kind: 'category',
		answers: [
			{ id: 'foh', value: 'Front of House', mode: 'multi' },
			{ id: 'server', value: 'Server', parentId: 'foh' },
			{ id: 'host', value: 'Host', parentId: 'foh' }
		]
	};

	it('is offered for a category whose explicitly multi answer has sub-values', () => {
		expect(
			canOfferAll({ kind: 'attribute', attributeId: 'department' }, [...attributes, department])
		).toBe(true);
	});

	it('is hidden for a category with no Multi-Select group', () => {
		const plain: WorkerAttributeDefinition = {
			...department,
			answers: [
				{ id: 'foh', value: 'Front of House' },
				{ id: 'server', value: 'Server', parentId: 'foh' }
			]
		};

		expect(canOfferAll({ kind: 'attribute', attributeId: 'department' }, [plain])).toBe(false);
	});
});

describe('canOfferAll', () => {
	it('is hidden for a Single-Select Attribute', () => {
		expect(canOfferAll({ kind: 'attribute', attributeId: 'role' }, attributes)).toBe(false);
	});

	it('is offered for a Multi-Select Attribute', () => {
		expect(canOfferAll({ kind: 'attribute', attributeId: 'skills' }, attributes)).toBe(true);
		expect(canOfferAll({ kind: 'attribute', attributeId: 'site' }, attributes)).toBe(true);
	});

	it('is offered for Languages and Agitations but hidden for Assessment', () => {
		expect(canOfferAll({ kind: 'languages' }, attributes)).toBe(true);
		expect(canOfferAll({ kind: 'agitations' }, attributes)).toBe(true);
		expect(canOfferAll({ kind: 'assessment' }, attributes)).toBe(false);
	});

	it('is false for an Attribute that is not configured', () => {
		expect(canOfferAll({ kind: 'attribute', attributeId: 'retired' }, attributes)).toBe(false);
	});
});
