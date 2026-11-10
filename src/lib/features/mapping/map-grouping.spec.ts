// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type {
	AttributeAnswer,
	Worker,
	WorkerAttributeDefinition,
	WorkerAttributeValues
} from '#lib/domain-vocabulary.ts';
import { normalizeExpansion, remainderIdentity } from '#lib/shared/answer-hierarchy.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import { selectWorkerPopulation } from '#lib/shared/worker-population.ts';
import {
	attemptExpansion,
	projectLayoutInput,
	readGrouping,
	type GroupingInput,
	type GroupingReading
} from './map-grouping.ts';
import type { WorkerGraphNode } from './worker-relationship-map-model.ts';
import { answerIdOf, answerIdsFixture } from './answer-fixtures.ts';

type Option = { value: string; parent?: string };

function definition(
	id: string,
	name: string,
	kind: WorkerAttributeDefinition['kind'],
	options: Option[]
): WorkerAttributeDefinition {
	const answers: AttributeAnswer[] = options.map((option) => ({
		id: answerIdOf(id, option.value),
		value: option.value,
		...(option.parent ? { parentId: answerIdOf(id, option.parent) } : {})
	}));
	return { id, name, kind, answers };
}

const worker = (id: string, name: string, attributes: WorkerAttributeValues) =>
	baseWorker({ id, name, attributes });

function nodeOf(person: Worker): WorkerGraphNode {
	return {
		id: person.id,
		name: person.name,
		assessment: person.assessment,
		attributes: { ...person.attributes },
		relationshipCount: 0
	};
}

function groupingInput(
	people: readonly Worker[],
	attributes: readonly WorkerAttributeDefinition[],
	options: { filters?: GroupingInput['filters'] } = {}
): GroupingInput {
	return {
		nodes: people.map(nodeOf),
		workers: people,
		attributes,
		filters: options.filters
	};
}

function available(reading: GroupingReading) {
	if (reading.status !== 'available') throw new Error('expected an available Grouping');
	return reading;
}

const loc = definition('loc', 'Location', 'tag', [
	{ value: 'Central' },
	{ value: 'Store A', parent: 'Central' },
	{ value: 'Store B', parent: 'Central' }
]);
const job = definition('job', 'Job', 'tag', [{ value: 'Cashier' }, { value: 'Stocker' }]);
const shift = definition('shift', 'Shift', 'tag', [{ value: 'Days' }, { value: 'Nights' }]);
const dept = definition('dept', 'Department', 'category', [
	{ value: 'Ops' },
	{ value: 'Packing', parent: 'Ops' }
]);
const attributes = [loc, job, shift, dept];

const answer = (attribute: WorkerAttributeDefinition, value: string) =>
	answerIdOf(attribute.id, value);

const alex = worker(
	'alex',
	'Alex',
	answerIdsFixture({
		loc: ['Store A', 'Store B'],
		job: ['Cashier', 'Stocker'],
		shift: ['Days', 'Nights'],
		dept: 'Packing'
	})
);
const blair = worker(
	'blair',
	'Blair',
	answerIdsFixture({ loc: ['Store A', 'Store B'], job: ['Cashier', 'Stocker'] })
);
const casey = worker('casey', 'Casey', answerIdsFixture({ loc: ['Central'] }));
const drew = worker('drew', 'Drew', answerIdsFixture({ loc: ['Store A'] }));
const erin = worker('erin', 'Erin', answerIdsFixture({ loc: ['Central', 'Store A'] }));
const frankie = worker('frankie', 'Frankie', answerIdsFixture({ loc: ['Store B'] }));
const gray = worker('gray', 'Gray', {});
const hana = worker('hana', 'Hana', answerIdsFixture({ loc: ['Store A'], job: ['Cashier'] }));

describe('readGrouping at the root frontier', () => {
	it('collapses several held values in one displayed ancestor into one region', () => {
		const reading = available(
			readGrouping(groupingInput([alex, blair, casey, drew, erin], attributes), 'loc')
		);

		expect(reading.regions.map(({ key }) => key)).toEqual([
			answer(loc, 'Central'),
			answer(loc, 'Store A')
		]);
		expect(reading.regionOf.get('alex')).toEqual({ group: answer(loc, 'Central') });
		expect(reading.regionOf.get('blair')).toEqual({ group: answer(loc, 'Central') });
		expect(reading.regionOf.get('casey')).toEqual({ group: answer(loc, 'Central') });
		expect(reading.regionOf.get('erin')).toEqual({ group: answer(loc, 'Central') });
		expect(reading.regionOf.get('drew')).toEqual({ group: answer(loc, 'Store A') });
		expect(reading.membersOf.get(answer(loc, 'Central'))).toEqual([
			'alex',
			'blair',
			'casey',
			'erin'
		]);
		expect(reading.counts.get(answer(loc, 'Central'))).toBe(4);
	});

	it('refuses a Grouping when a Worker holds values in two regions', () => {
		const reading = readGrouping(groupingInput([alex, blair, frankie], attributes), 'job');

		expect(reading.status).toBe('unavailable');
		if (reading.status !== 'unavailable') return;
		expect(reading.reason).toEqual({
			code: 'multiple-regions',
			attributeId: job.id,
			workers: [
				{ workerId: 'alex', keys: [answer(job, 'Cashier'), answer(job, 'Stocker')] },
				{ workerId: 'blair', keys: [answer(job, 'Cashier'), answer(job, 'Stocker')] }
			]
		});
		expect(reading.ambiguous.get('alex')).toEqual([
			{ group: answer(job, 'Cashier') },
			{ group: answer(job, 'Stocker') }
		]);
	});

	it('keeps a Worker whose values all sit under one branch in one region', () => {
		const reading = available(readGrouping(groupingInput([alex, blair], attributes), 'loc'));

		expect(reading.regions.map(({ key }) => key)).toEqual([answer(loc, 'Central')]);
		expect(reading.counts.get(answer(loc, 'Central'))).toBe(2);
	});

	it('keeps a real answer and the no-value reading as distinct identities', () => {
		const colliding = definition('loc2', 'Location', 'tag', [
			{ value: 'No Location' },
			{ value: 'Central' }
		]);
		const literal = worker('literal', 'Literal', answerIdsFixture({ loc2: ['No Location'] }));
		const missing = worker('missing', 'Missing', {});
		const reading = available(readGrouping(groupingInput([literal, missing], [colliding]), 'loc2'));

		expect(reading.regions.map(({ key }) => key)).toEqual(['', answer(colliding, 'No Location')]);
		expect(reading.regions[0]).toMatchObject({
			identity: 'no-value',
			label: 'No Location',
			// A real answer reads the same, so the system reading explains itself.
			description: 'No selection',
			outlined: false
		});
		expect(reading.regions[1]).toMatchObject({
			identity: 'answer',
			label: 'No Location',
			description: null,
			outlined: true
		});
		expect(reading.regionOf.get('literal')).toEqual({ group: answer(colliding, 'No Location') });
		expect(reading.regionOf.get('missing')).toEqual({ group: '' });
	});

	it('keeps a single held value as its own region, even inside a hierarchy', () => {
		const person = worker('noor', 'Noor', answerIdsFixture({ dept: 'Packing' }));
		const reading = available(readGrouping(groupingInput([person], attributes), 'dept'));

		expect(reading.regions).toEqual([
			{
				key: answer(dept, 'Packing'),
				identity: 'answer',
				label: 'Packing',
				description: null,
				outlined: true
			}
		]);
		expect(reading.regionOf.get('noor')).toEqual({ group: answer(dept, 'Packing') });
	});

	it('names a Worker with no answer by the no-value region', () => {
		const person = worker('zoe', 'Zoe', {});
		const reading = available(readGrouping(groupingInput([person], attributes), 'dept'));

		expect(reading.regions[0]).toMatchObject({
			key: '',
			identity: 'no-value',
			label: 'No Department',
			description: null,
			outlined: false
		});
	});

	it('is vacuously available with no displayed Workers and no system region', () => {
		const reading = available(readGrouping(groupingInput([], attributes), 'job'));

		expect(reading.regions).toEqual([]);
		expect(reading.regionOf.size).toBe(0);
		expect(reading.membersOf.size).toBe(0);
		expect(reading.counts.size).toBe(0);
	});
});

describe('Grouping refusals', () => {
	it('refuses a value id the current definition no longer holds', () => {
		const person = worker('gone', 'Gone', { loc: ['loc~removed'] });
		const reading = readGrouping(groupingInput([person], attributes), 'loc');

		expect(reading.status).toBe('unavailable');
		if (reading.status !== 'unavailable') return;
		expect(reading.reason).toEqual({
			code: 'unresolved-answer',
			attributeId: loc.id,
			answerIds: ['loc~removed'],
			workerIds: ['gone']
		});
	});
});

describe('narrowing guidance', () => {
	it('is computed only when asked for, so listing choices stays cheap', () => {
		const input = groupingInput([alex, blair], attributes);
		const bare = readGrouping(input, 'job');
		const guided = readGrouping(input, 'job', { guidance: true });

		expect(bare.status).toBe('unavailable');
		expect(guided.status).toBe('unavailable');
		if (bare.status !== 'unavailable' || guided.status !== 'unavailable') return;
		expect(bare.suggestions).toEqual([]);
		expect(guided.suggestions.length).toBeGreaterThan(0);
	});

	it('ranks filters that strictly reduce the ambiguity, capped at three', () => {
		const reading = readGrouping(groupingInput([alex, blair], attributes), 'job', {
			guidance: true
		});
		if (reading.status !== 'unavailable') throw new Error('expected a refusal');

		expect(reading.suggestions).toEqual([
			{ attributeId: shift.id, answerIds: [answer(shift, 'Days')], missing: false, resolves: 1 },
			{ attributeId: shift.id, answerIds: [answer(shift, 'Nights')], missing: false, resolves: 1 },
			{ attributeId: shift.id, answerIds: [''], missing: true, resolves: 1 }
		]);
	});

	it('offers a no-answer reading as a narrowing filter', () => {
		const reading = readGrouping(groupingInput([alex, blair], attributes), 'job', {
			guidance: true
		});
		if (reading.status !== 'unavailable') throw new Error('expected a refusal');

		expect(reading.suggestions).toEqual(
			expect.arrayContaining([
				{ attributeId: shift.id, answerIds: [''], missing: true, resolves: 1 }
			])
		);
	});

	it('narrows the population with the shared selector without narrowing a held value', () => {
		const input = groupingInput([alex, blair, frankie], attributes);
		const filters = {
			answers: new Map([[loc.id, [answer(loc, 'Store B')]]])
		};
		const projection = selectWorkerPopulation(input.workers, input.attributes, filters);
		expect(projection.workers.map(({ id }) => id)).toEqual(['alex', 'blair', 'frankie']);

		const narrowed = groupingInput(
			input.workers.filter(({ id }) => projection.workers.some((worker) => worker.id === id)),
			attributes,
			{ filters }
		);
		const reading = readGrouping(narrowed, 'job');

		// The filter keeps Alex and Blair, but each still holds both jobs: a contextual
		// condition selects Workers, it never hides one of their answers (AC11).
		expect(reading.status).toBe('unavailable');
		if (reading.status !== 'unavailable') return;
		expect(reading.reason.code).toBe('multiple-regions');
		expect(reading.ambiguous.get('alex')).toEqual([
			{ group: answer(job, 'Cashier') },
			{ group: answer(job, 'Stocker') }
		]);
		expect(reading.ambiguous.has('frankie')).toBe(false);
	});
});

describe('projectLayoutInput', () => {
	it('projects one region key per displayed Worker without touching the graph', () => {
		const people = [frankie, gray, hana];
		const originalNodes = people.map(nodeOf);
		const input: GroupingInput = {
			nodes: originalNodes,
			workers: people,
			attributes
		};
		const reading = available(readGrouping(input, 'job'));
		const projected = projectLayoutInput(originalNodes, reading, job);

		expect(projected.nodes.map(({ id }) => id)).toEqual(['frankie', 'gray', 'hana']);
		expect(projected.nodes.map((node) => node.attributes[job.id])).toEqual([
			'',
			'',
			answer(job, 'Cashier')
		]);
		expect(projected.groupingAttribute.id).toBe(job.id);
		expect(projected.groupingAttribute.name).toBe('Job');
		expect(projected.groupingAttribute.answers.map(({ id }) => id)).toEqual([
			answer(job, 'Cashier')
		]);
		expect(projected.groupingAttribute.answers.map(({ value }) => value)).toEqual(['Cashier']);
		// Non-grouping attributes and the original nodes are untouched.
		expect(projected.nodes[0].attributes[loc.id]).toBe(originalNodes[0].attributes[loc.id]);
		expect(originalNodes[0].attributes[job.id]).toBeUndefined();
	});

	it('leaves the no-value region to the Attribute name instead of a synthetic value', () => {
		const person = worker('zoe', 'Zoe', {});
		const reading = available(readGrouping(groupingInput([person], attributes), 'dept'));
		const projected = projectLayoutInput([nodeOf(person)], reading, dept);

		// An empty-id answer would collide with itself in bucketDescription; the drawn
		// label still comes from the Attribute's current name through bucketLabel.
		expect(projected.groupingAttribute.answers).toEqual([]);
		expect(projected.nodes[0].attributes[dept.id]).toBe('');
	});
});

describe('paired Sub-grouping', () => {
	it('keeps the primary Grouping available while a Multi-Select secondary refuses the Sub-grouping', () => {
		const reading = available(
			readGrouping(groupingInput([alex, blair, frankie], attributes), 'loc', {
				subAttributeId: job.id
			})
		);

		// The primary partition is exactly what it was without the secondary question.
		expect(reading.regions.map(({ key }) => key)).toEqual([
			answer(loc, 'Central'),
			answer(loc, 'Store B')
		]);
		expect(reading.regionOf.get('alex')).toEqual({ group: answer(loc, 'Central') });

		const sub = reading.subGrouping;
		expect(sub?.status).toBe('unavailable');
		if (sub?.status !== 'unavailable') return;
		expect(sub.reason).toEqual({
			code: 'paired-regions-differ',
			attributeId: loc.id,
			subAttributeId: job.id,
			workers: [
				{
					workerId: 'alex',
					pairs: [
						[answer(loc, 'Central'), answer(job, 'Cashier')],
						[answer(loc, 'Central'), answer(job, 'Stocker')]
					]
				},
				{
					workerId: 'blair',
					pairs: [
						[answer(loc, 'Central'), answer(job, 'Cashier')],
						[answer(loc, 'Central'), answer(job, 'Stocker')]
					]
				}
			]
		});
	});

	it('pairs a Worker’s own primary and secondary regions', () => {
		const dana = worker(
			'dana',
			'Dana',
			answerIdsFixture({ job: ['Cashier'], loc: ['Store A', 'Store B'] })
		);
		const reading = available(
			readGrouping(groupingInput([dana], attributes), 'job', { subAttributeId: loc.id })
		);

		expect(reading.regionOf.get('dana')).toEqual({
			group: answer(job, 'Cashier'),
			subGroup: answer(loc, 'Central')
		});
		const sub = reading.subGrouping;
		expect(sub?.status).toBe('available');
		if (sub?.status !== 'available') return;
		expect(sub.regions.map(({ key }) => key)).toEqual([answer(loc, 'Central')]);
		expect(sub.regionOf.get('dana')).toBe(answer(loc, 'Central'));
	});

	it('collapses a parent and a child held in the same branch into one pair', () => {
		const dana = worker(
			'dana',
			'Dana',
			answerIdsFixture({ job: ['Cashier'], loc: ['Central', 'Store A'] })
		);
		const reading = available(
			readGrouping(groupingInput([dana], attributes), 'job', { subAttributeId: loc.id })
		);

		const sub = reading.subGrouping;
		expect(sub?.status).toBe('available');
		if (sub?.status !== 'available') return;
		expect(sub.regions.map(({ key }) => key)).toEqual([answer(loc, 'Central')]);
		expect(sub.regionOf.get('dana')).toBe(answer(loc, 'Central'));
	});

	it('keeps a Worker no-value secondary distinct from a real answer', () => {
		const reading = available(
			readGrouping(groupingInput([frankie, hana], attributes), 'loc', {
				subAttributeId: job.id
			})
		);

		const sub = reading.subGrouping;
		expect(sub?.status).toBe('available');
		if (sub?.status !== 'available') return;
		expect(sub.regions.map(({ key }) => key)).toEqual(['', answer(job, 'Cashier')]);
		expect(sub.regions[0]).toMatchObject({
			identity: 'no-value',
			label: 'No Job',
			outlined: false
		});
		expect(sub.regionOf.get('frankie')).toBe('');
		expect(sub.regionOf.get('hana')).toBe(answer(job, 'Cashier'));
	});

	it('names a Worker no-value on both questions from each question', () => {
		const person = worker('nobody', 'Nobody', {});
		const reading = available(
			readGrouping(groupingInput([person], attributes), 'job', { subAttributeId: dept.id })
		);

		const sub = reading.subGrouping;
		expect(sub?.status).toBe('available');
		if (sub?.status !== 'available') return;
		expect(sub.regions[0]).toMatchObject({
			key: '',
			identity: 'no-value',
			label: 'No Department',
			outlined: false
		});
		expect(reading.regionOf.get('nobody')).toEqual({
			group: '',
			subGroup: ''
		});
	});

	it('keeps Worker-only Sub-grouping intact, including its no-value region and order', () => {
		const team = definition('team', 'Team', 'category', [{ value: 'Alpha' }, { value: 'Beta' }]);
		const localAttributes = [...attributes, team];
		const t1 = worker('t1', 'T1', answerIdsFixture({ dept: 'Packing', team: 'Beta' }));
		const t2 = worker('t2', 'T2', answerIdsFixture({ dept: 'Ops', team: 'Alpha' }));
		const t3 = worker('t3', 'T3', answerIdsFixture({ dept: 'Ops' }));
		const reading = available(
			readGrouping(groupingInput([t1, t2, t3], localAttributes), 'dept', {
				subAttributeId: team.id
			})
		);

		const sub = reading.subGrouping;
		expect(sub?.status).toBe('available');
		if (sub?.status !== 'available') return;
		expect(sub.regions.map(({ key }) => key)).toEqual([
			'',
			answer(team, 'Alpha'),
			answer(team, 'Beta')
		]);
		expect(sub.regions[0]).toMatchObject({ label: 'No Team', outlined: false });
		expect(sub.regionOf.get('t3')).toBe('');
		expect(sub.regionOf.get('t2')).toBe(answer(team, 'Alpha'));
		expect(sub.regionOf.get('t1')).toBe(answer(team, 'Beta'));
	});

	it('refuses a secondary value id the current definition no longer holds', () => {
		const person = worker('missing', 'Missing', {
			loc: [answer(loc, 'Store A')],
			job: ['job~removed']
		});
		const reading = available(
			readGrouping(groupingInput([person], attributes), 'loc', { subAttributeId: job.id })
		);
		const sub = reading.subGrouping;
		expect(sub?.status).toBe('unavailable');
		if (sub?.status !== 'unavailable') return;
		expect(sub.reason).toEqual({
			code: 'unresolved-answer',
			attributeId: loc.id,
			subAttributeId: job.id,
			answerIds: ['job~removed'],
			workerIds: ['missing']
		});
	});

	it('suggests a narrowing filter that removes another ambiguous Worker', () => {
		const reading = readGrouping(groupingInput([alex, blair, frankie], attributes), 'loc', {
			subAttributeId: job.id,
			guidance: true
		});
		expect(reading.status).toBe('available');
		if (reading.status !== 'available') return;
		const sub = reading.subGrouping;
		expect(sub?.status).toBe('unavailable');
		if (sub?.status !== 'unavailable') return;
		expect(sub.suggestions).toEqual(
			expect.arrayContaining([
				{ attributeId: shift.id, answerIds: [answer(shift, 'Days')], missing: false, resolves: 1 }
			])
		);
	});

	it('leaves the Sub-grouping off when none was asked for', () => {
		const reading = available(readGrouping(groupingInput([alex, blair], attributes), 'loc'));
		expect(reading.subGrouping).toBeUndefined();
	});

	it('projects the paired secondary keys for the solver without touching the graph', () => {
		const people = [alex, blair, frankie];
		const input = groupingInput(people, attributes);
		const reading = available(readGrouping(input, 'loc', { subAttributeId: dept.id }));
		const projected = projectLayoutInput(input.nodes, reading, loc, dept);

		expect(projected.nodes.map((node) => node.attributes[loc.id])).toEqual([
			answer(loc, 'Central'),
			answer(loc, 'Central'),
			answer(loc, 'Store B')
		]);
		expect(projected.nodes.map((node) => node.attributes[dept.id])).toEqual([
			answer(dept, 'Packing'),
			'',
			''
		]);
		const subAttribute = projected.subGroupingAttribute;
		expect(subAttribute?.id).toBe(dept.id);
		expect(subAttribute?.answers.map(({ id }) => id)).toEqual([answer(dept, 'Packing')]);
		expect(subAttribute?.answers.map(({ value }) => value)).toEqual(['Packing']);

		// The graph nodes and links are the same nodes with projected values only.
		expect(projected.nodes.map(({ id }) => id)).toEqual(input.nodes.map(({ id }) => id));
		expect(projected.nodes[0]).not.toBe(input.nodes[0]);
		expect(input.nodes[0].attributes[dept.id]).toBe(answer(dept, 'Packing'));
		expect(input.nodes[1].attributes[dept.id]).toBeUndefined();
	});

	it('projects no secondary definition while the pairing is refused', () => {
		const people = [alex, blair, frankie];
		const input = groupingInput(people, attributes);
		const reading = available(readGrouping(input, 'loc', { subAttributeId: job.id }));
		const projected = projectLayoutInput(input.nodes, reading, loc, job);

		expect(projected.subGroupingAttribute).toBeUndefined();
		// The pair is refused, so the held values are passed through untouched.
		expect(projected.nodes.map((node) => node.attributes[job.id])).toEqual([
			[answer(job, 'Cashier'), answer(job, 'Stocker')],
			[answer(job, 'Cashier'), answer(job, 'Stocker')],
			undefined
		]);
	});
});

describe('branch expansion', () => {
	const central = answer(loc, 'Central');
	const storeA = answer(loc, 'Store A');
	const storeB = answer(loc, 'Store B');
	const remainderCentral = remainderIdentity(loc.id, central);

	it('replaces an occupied branch with its children and an occupied exact remainder', () => {
		const reading = available(
			readGrouping(groupingInput([casey, drew, frankie], attributes), 'loc', {
				expandedIds: [central]
			})
		);

		// Pre-order children, then the branch's direct-parent remainder.
		expect(reading.regions.map(({ key }) => key)).toEqual([storeA, storeB, remainderCentral]);
		expect(reading.regions.map(({ identity }) => identity)).toEqual([
			'answer',
			'answer',
			'remainder'
		]);
		expect(reading.regions[2]).toEqual({
			key: remainderCentral,
			identity: 'remainder',
			label: 'Central',
			description: 'this group only',
			outlined: false
		});
		expect(reading.regionOf.get('casey')).toEqual({ group: remainderCentral });
		expect(reading.regionOf.get('drew')).toEqual({ group: storeA });
		expect(reading.regionOf.get('frankie')).toEqual({ group: storeB });
		expect(reading.membersOf.get(remainderCentral)).toEqual(['casey']);
		expect(reading.counts.get(remainderCentral)).toBe(1);
	});

	it('keeps a direct-parent remainder distinct from an entirely missing value', () => {
		const nadia = worker('nadia', 'Nadia', answerIdsFixture({ job: ['Cashier'] }));
		const reading = available(
			readGrouping(groupingInput([casey, nadia], attributes), 'loc', { expandedIds: [central] })
		);

		expect(reading.regions.map(({ key }) => key)).toEqual(['', remainderCentral]);
		expect(reading.regions[0]).toMatchObject({
			identity: 'no-value',
			label: 'No Location'
		});
		expect(reading.regionOf.get('nadia')).toEqual({ group: '' });
	});

	it('refuses an attempted expansion that would put a displayed Worker in two regions', () => {
		const input = groupingInput([alex, blair, casey, drew, erin, frankie], attributes);
		const attempt = attemptExpansion(input, 'loc', [], central);

		expect(attempt.status).toBe('refused');
		if (attempt.status !== 'refused') return;
		expect(attempt.reason).toEqual({
			code: 'expansion-breaks-partition',
			attributeId: loc.id,
			branchId: central,
			workers: [
				{ workerId: 'alex', keys: [storeA, storeB] },
				{ workerId: 'blair', keys: [storeA, storeB] },
				{ workerId: 'erin', keys: [remainderCentral, storeA] }
			]
		});

		// The valid coarser view is still the reading of the unexpanded detail.
		const coarse = available(readGrouping(input, 'loc'));
		expect(coarse.regions.map(({ key }) => key)).toEqual([central, storeA, storeB]);
		expect(coarse.regionOf.get('erin')).toEqual({ group: central });
	});

	it('commits only when the candidate detail still partitions, closing over ancestors', () => {
		const deep = definition('deep', 'Deep Location', 'tag', [
			{ value: 'Central' },
			{ value: 'Store A', parent: 'Central' },
			{ value: 'Packing', parent: 'Store A' }
		]);
		const deepCentral = answerIdOf('deep', 'Central');
		const deepStoreA = answerIdOf('deep', 'Store A');
		const packing = answerIdOf('deep', 'Packing');
		const packer = worker('packer', 'Packer', { [deep.id]: [packing] });
		const split = worker('split', 'Split', { [deep.id]: [deepStoreA, packing] });

		// An unexpanded branch includes its descendants at uneven depth.
		const atStoreA = available(
			readGrouping(groupingInput([packer], [deep]), 'deep', { expandedIds: [deepCentral] })
		);
		expect(atStoreA.regionOf.get('packer')).toEqual({ group: deepStoreA });
		expect(atStoreA.regions.map(({ key }) => key)).toEqual([deepStoreA]);

		// The attempt adds the ancestors the deeper branch needs, then reads the candidate.
		const attempt = attemptExpansion(
			groupingInput([packer, split], [deep]),
			'deep',
			[deepStoreA],
			deepStoreA
		);
		expect(attempt.status).toBe('refused');
		if (attempt.status === 'refused') {
			expect(attempt.reason.branchId).toBe(deepStoreA);
			expect(attempt.reason.workers).toEqual([
				{ workerId: 'split', keys: [remainderIdentity(deep.id, deepStoreA), packing] }
			]);
		}

		const alone = attemptExpansion(groupingInput([packer], [deep]), 'deep', [], deepStoreA);
		expect(alone).toMatchObject({
			status: 'available',
			expandedIds: [deepCentral, deepStoreA]
		});
	});

	it('adds no detail for a leaf, an unknown branch or a foreign Attribute id', () => {
		const input = groupingInput([casey, drew], attributes);
		for (const branchId of [storeA, 'loc~gone']) {
			const attempt = attemptExpansion(input, 'loc', [], branchId);
			expect(attempt.status).toBe('available');
			if (attempt.status !== 'available') return;
			expect(attempt.expandedIds).toEqual([]);
			expect(attempt.reading.regions.map(({ key }) => key)).toEqual([central, storeA]);
		}
		expect(normalizeExpansion(loc, ['job~Cashier', storeA])).toEqual([]);
	});

	it('normalizes a restored stale detail to the branches the configuration honours', () => {
		// A leaf, a removed answer and a foreign id drop silently; the valid branch stays.
		const reading = available(
			readGrouping(groupingInput([casey, drew], attributes), 'loc', {
				expandedIds: [storeA, 'gone', 'job~Cashier']
			})
		);
		expect(reading.regions.map(({ key }) => key)).toEqual([central, storeA]);
	});

	it('expands primary and secondary branches independently', () => {
		const org = definition('org', 'Org', 'category', [
			{ value: 'All' },
			{ value: 'Front', parent: 'All' },
			{ value: 'Back', parent: 'All' }
		]);
		const orgAll = answerIdOf('org', 'All');
		const orgFront = answerIdOf('org', 'Front');
		const orgBack = answerIdOf('org', 'Back');
		const o1 = worker('o1', 'O1', answerIdsFixture({ loc: ['Store A'], org: 'Back' }));
		const o2 = worker('o2', 'O2', answerIdsFixture({ loc: ['Store A'], org: 'Front' }));
		const o3 = worker('o3', 'O3', answerIdsFixture({ loc: ['Store A'], org: 'All' }));
		const localAttributes = [...attributes, org];

		const reading = available(
			readGrouping(groupingInput([o1, o2, o3], localAttributes), 'loc', {
				subAttributeId: org.id,
				expandedIds: [central],
				expandedSubIds: [orgAll]
			})
		);

		// The primary detail is the expanded Location, unaffected by the secondary detail.
		expect(reading.regions.map(({ key }) => key)).toEqual([storeA]);

		const sub = reading.subGrouping;
		expect(sub?.status).toBe('available');
		if (sub?.status !== 'available') return;
		expect(sub.regions.map(({ key }) => key)).toEqual([
			orgFront,
			orgBack,
			remainderIdentity(org.id, orgAll)
		]);
		expect(sub.regions[2]).toMatchObject({
			identity: 'remainder',
			label: 'All',
			description: 'this group only',
			outlined: false
		});
		expect(sub.regionOf.get('o1')).toBe(orgBack);
		expect(sub.regionOf.get('o2')).toBe(orgFront);
		expect(sub.regionOf.get('o3')).toBe(remainderIdentity(org.id, orgAll));
	});

	it('keeps branch identity, membership and configured order across a label rename', () => {
		const renamed = {
			...loc,
			answers: loc.answers.map((entry) =>
				entry.id === storeA ? { ...entry, value: 'Zeta' } : entry
			)
		};
		const before = available(
			readGrouping(groupingInput([casey, drew, frankie], attributes), 'loc', {
				expandedIds: [central]
			})
		);
		const after = available(
			readGrouping(groupingInput([casey, drew, frankie], [renamed, job, shift, dept]), 'loc', {
				expandedIds: [central]
			})
		);

		expect(after.regions.map(({ key }) => key)).toEqual([storeA, storeB, remainderCentral]);
		expect(after.regions.map(({ key }) => key)).toEqual(before.regions.map(({ key }) => key));
		expect(after.regions[0].label).toBe('Zeta');
		expect(after.regions[2]).toMatchObject({
			label: 'Central',
			description: 'this group only'
		});
		expect(after.regionOf).toEqual(before.regionOf);
		expect(after.membersOf).toEqual(before.membersOf);
		expect(after.counts).toEqual(before.counts);
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
	const holdsL5 = worker('five', 'Five', { chain: 'l5' });

	it('groups a Worker holding a depth-five answer under that answer at the root', () => {
		const reading = available(readGrouping(groupingInput([holdsL5], [chain]), 'chain'));

		expect(reading.regions).toEqual([
			{ key: 'l5', identity: 'answer', label: 'Level 5', description: null, outlined: true }
		]);
		expect(reading.regionOf.get('five')).toEqual({ group: 'l5' });
	});

	it('reads the depth-five answer as the direct child of its expanded ancestor', () => {
		const reading = available(
			readGrouping(groupingInput([holdsL5], [chain]), 'chain', { expandedIds: ['l1'] })
		);

		expect(reading.regions.map(({ key }) => key)).toEqual(['l2']);
		expect(reading.regionOf.get('five')).toEqual({ group: 'l2' });
	});

	it('reaches the depth-five answer its own region once every ancestor is expanded', () => {
		const reading = available(
			readGrouping(groupingInput([holdsL5], [chain]), 'chain', {
				expandedIds: ['l1', 'l2', 'l3', 'l4']
			})
		);

		expect(reading.regions.map(({ key }) => key)).toEqual(['l5']);
		expect(reading.regionOf.get('five')).toEqual({ group: 'l5' });
	});

	it('commits every ancestor of the deepest branch when that branch is expanded', () => {
		const attempt = attemptExpansion(groupingInput([holdsL5], [chain]), 'chain', [], 'l4');

		expect(attempt).toMatchObject({ status: 'available', expandedIds: ['l1', 'l2', 'l3', 'l4'] });
	});

	it('pairs a depth-five secondary answer with the primary region of each Worker', () => {
		const deepCashier = worker('deep-cashier', 'Deep', {
			...answerIdsFixture({ job: ['Cashier'] }),
			chain: 'l5'
		});
		const shallowCashier = worker('shallow-cashier', 'Shallow', {
			...answerIdsFixture({ job: ['Cashier'] }),
			chain: 'l2'
		});
		const reading = available(
			readGrouping(groupingInput([deepCashier, shallowCashier], [chain, job]), 'job', {
				subAttributeId: 'chain'
			})
		);

		expect(reading.regionOf.get('deep-cashier')).toEqual({
			group: answer(job, 'Cashier'),
			subGroup: 'l5'
		});
		expect(reading.regionOf.get('shallow-cashier')).toEqual({
			group: answer(job, 'Cashier'),
			subGroup: 'l2'
		});
		const sub = reading.subGrouping;
		expect(sub?.status).toBe('available');
		if (sub?.status !== 'available') return;
		expect(sub.regions.map(({ key }) => key)).toEqual(['l2', 'l5']);
	});
});

describe('E2 mapping grouping and views (e2e migration)', () => {
	it('collapses the ticket-07 Location population into one displayed ancestor per Worker', () => {
		// e2e/mapping-grouping-eligibility.spec.ts › @ticket-07 Location collapses several held values into one displayed ancestor, one node and one row each.
		const reading = available(
			readGrouping(
				groupingInput([alex, blair, casey, drew, erin, frankie, gray, hana], attributes),
				'loc'
			)
		);

		expect(reading.status).toBe('available');
		expect([...reading.regions.map(({ key }) => key)].sort()).toEqual(
			['', answer(loc, 'Central'), answer(loc, 'Store A'), answer(loc, 'Store B')].sort()
		);
		expect(reading.regionOf.get('alex')).toEqual({ group: answer(loc, 'Central') });
		expect(reading.regionOf.get('blair')).toEqual({ group: answer(loc, 'Central') });
		expect(reading.regionOf.get('casey')).toEqual({ group: answer(loc, 'Central') });
		expect(reading.regionOf.get('erin')).toEqual({ group: answer(loc, 'Central') });
		expect(reading.regionOf.get('drew')).toEqual({ group: answer(loc, 'Store A') });
		expect(reading.regionOf.get('hana')).toEqual({ group: answer(loc, 'Store A') });
		expect(reading.regionOf.get('frankie')).toEqual({ group: answer(loc, 'Store B') });
		expect(reading.regionOf.get('gray')).toEqual({ group: '' });
		expect(reading.membersOf.get(answer(loc, 'Central'))).toEqual([
			'alex',
			'blair',
			'casey',
			'erin'
		]);
		expect(reading.counts.get(answer(loc, 'Central'))).toBe(4);
		expect(reading.counts.get(answer(loc, 'Store A'))).toBe(2);
		expect(reading.counts.get(answer(loc, 'Store B'))).toBe(1);
		expect(reading.counts.get('')).toBe(1);
		expect(reading.regions.find((region) => region.key === '')).toMatchObject({
			identity: 'no-value',
			label: 'No Location',
			description: null,
			outlined: false
		});
	});

	it('keeps a missing Job value and a real Unknown Job answer as distinct identities', () => {
		// e2e/mapping-grouping-eligibility.spec.ts › @ticket-07 a missing value and a real colliding label keep distinct identities.
		const jobWithUnknown = definition('job-e2e', 'Job', 'tag', [
			{ value: 'Cashier' },
			{ value: 'Stocker' },
			{ value: 'Unknown Job' }
		]);
		const unknown = answerIdOf('job-e2e', 'Unknown Job');
		const frankieNoJob = worker('frankie', 'Frankie', answerIdsFixture({ loc: ['Store B'] }));
		const grayNoJob = worker('gray', 'Gray', {});
		const hanaUnknown = worker(
			'hana',
			'Hana',
			answerIdsFixture({ loc: ['Store A'], 'job-e2e': ['Unknown Job'] })
		);
		const reading = available(
			readGrouping(
				groupingInput([frankieNoJob, grayNoJob, hanaUnknown], [jobWithUnknown]),
				'job-e2e'
			)
		);

		expect([...reading.regions.map(({ key }) => key)].sort()).toEqual(['', unknown].sort());
		expect(reading.regionOf.get('frankie')).toEqual({ group: '' });
		expect(reading.regionOf.get('gray')).toEqual({ group: '' });
		expect(reading.regionOf.get('hana')).toEqual({ group: unknown });
		expect(reading.counts.get('')).toBe(2);
		expect(reading.counts.get(unknown)).toBe(1);
		expect(reading.regions.find((region) => region.key === '')).toMatchObject({
			identity: 'no-value',
			label: 'No Job',
			description: null,
			outlined: false
		});
		expect(reading.regions.find((region) => region.key === unknown)).toMatchObject({
			identity: 'answer',
			label: 'Unknown Job',
			description: null,
			outlined: true
		});
	});

	it('pairs one held primary value with one held secondary value for a singly-held Worker', () => {
		// e2e/mapping-sub-grouping.spec.ts › @ticket-07 a Worker holding one value per question is available, deduplicated to one pair.
		const dana = worker(
			'dana',
			'Dana',
			answerIdsFixture({ loc: ['Store A'], job: ['Cashier'], shift: ['Days', 'Nights'] })
		);
		const reading = available(
			readGrouping(groupingInput([dana, casey], attributes), 'loc', { subAttributeId: job.id })
		);

		expect(reading.regionOf.get('dana')).toEqual({
			group: answer(loc, 'Store A'),
			subGroup: answer(job, 'Cashier')
		});
		expect(reading.regionOf.get('casey')).toEqual({
			group: answer(loc, 'Central'),
			subGroup: ''
		});
		const sub = reading.subGrouping;
		expect(sub?.status).toBe('available');
		if (sub?.status !== 'available') return;
		expect([...sub.regions.map(({ key }) => key)].sort()).toEqual(
			['', answer(job, 'Cashier')].sort()
		);
		expect(sub.regionOf.get('dana')).toBe(answer(job, 'Cashier'));
		expect(sub.regionOf.get('casey')).toBe('');
	});

	it('reads a missing secondary value by the current Attribute name for either cardinality', () => {
		// e2e/mapping-sub-grouping.spec.ts › @ticket-07 a missing secondary value reads by the current Attribute name.
		const reading = available(
			readGrouping(groupingInput([frankie, gray], attributes), 'loc', { subAttributeId: job.id })
		);

		expect(reading.regionOf.get('frankie')).toEqual({
			group: answer(loc, 'Store B'),
			subGroup: ''
		});
		expect(reading.regionOf.get('gray')).toEqual({ group: '', subGroup: '' });
		const sub = reading.subGrouping;
		expect(sub?.status).toBe('available');
		if (sub?.status !== 'available') return;
		expect(sub.regions.map(({ key }) => key)).toEqual(['']);
		expect(sub.regions[0]).toMatchObject({
			identity: 'no-value',
			label: 'No Job',
			description: null,
			outlined: false
		});
	});
});
