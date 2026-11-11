// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type { WorkerGraphLink, WorkerGraphNode } from '../canvas/worker-relationship-map-model.ts';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import {
	answerDisplay,
	bucketLabel,
	buildAdjacency,
	buildBucketTree,
	groupValue,
	isolatedDegrees
} from './graph-analysis.ts';
import {
	answerIdOf,
	answerIdsFixture,
	attributeFixture
} from '#lib/testing/mapping/answer-fixtures.ts';

const department = attributeFixture({
	id: 'dept',
	name: 'Department',
	kind: 'category',
	options: ['Front of House', 'Back of House']
});

const role = attributeFixture({
	id: 'role',
	name: 'Role',
	kind: 'category',
	options: ['Server', 'Cook']
});

/** A bucket's value is its answer id; the expectations name the answer by its text. */
const textOfId = (id: string) => id.replace(/^[^~]*~/, '');

function node(id: string, attributes: Record<string, string> = {}): WorkerGraphNode {
	return {
		id,
		name: id,
		assessment: 'Unassessed',
		attributes: answerIdsFixture(attributes),
		relationshipCount: 0
	};
}

function link(source: string, target: string): WorkerGraphLink {
	return { id: `${source}-${target}`, source, target, value: 1 };
}

function shape(buckets: ReturnType<typeof buildBucketTree>) {
	return buckets.map((bucket) => ({
		value: textOfId(bucket.value),
		label: bucket.label,
		count: bucket.count,
		subGroups: bucket.subGroups.map((subGroup) => ({
			value: textOfId(subGroup.value),
			label: subGroup.label,
			count: subGroup.count
		}))
	}));
}

const workers = [
	node('a', { dept: 'Front of House', role: 'Server' }),
	node('b', { dept: 'Front of House', role: 'Cook' }),
	node('c', { dept: 'Front of House', role: '' }),
	node('d', { dept: 'Back of House', role: 'Server' }),
	node('e', { dept: '', role: 'Server' })
];

describe('bucketLabel', () => {
	it('names a bucket after the answer it holds', () => {
		expect(bucketLabel(answerIdOf('dept', 'Front of House'), department)).toBe('Front of House');
	});

	it('looks the text up from the answer id, so a rename changes the label alone', () => {
		const renamed = {
			...department,
			answers: department.answers?.map((answer) =>
				answer.value === 'Front of House' ? { ...answer, value: 'Front Room' } : answer
			)
		};
		expect(bucketLabel(answerIdOf('dept', 'Front of House'), renamed)).toBe('Front Room');
	});

	it('names a bucket after the question the workers left unanswered', () => {
		expect(bucketLabel('', department)).toBe('No Department');
		expect(bucketLabel('', role)).toBe('No Role');
	});
});

describe('buildBucketTree', () => {
	it('groups nothing when there is no attribute to group by', () => {
		expect(buildBucketTree(workers, undefined, role)).toEqual([]);
	});

	it('counts one bucket per answer, in the order the workers appear', () => {
		expect(shape(buildBucketTree(workers, department, undefined))).toEqual([
			{
				value: 'Front of House',
				label: 'Front of House',
				count: 3,
				subGroups: []
			},
			{
				value: 'Back of House',
				label: 'Back of House',
				count: 1,
				subGroups: []
			},
			{
				value: '',
				label: 'No Department',
				count: 1,
				subGroups: []
			}
		]);
	});

	it('nests a second partition inside each group', () => {
		const buckets = buildBucketTree(workers, department, role);
		const [front, back, unassigned] = shape(buckets);

		expect(front).toEqual({
			value: 'Front of House',
			label: 'Front of House',
			count: 3,
			subGroups: [
				{ value: 'Server', label: 'Server', count: 1 },
				{ value: 'Cook', label: 'Cook', count: 1 },
				{ value: '', label: 'No Role', count: 1 }
			]
		});
		expect(back.subGroups).toEqual([{ value: 'Server', label: 'Server', count: 1 }]);
		expect(unassigned.subGroups).toEqual([{ value: 'Server', label: 'Server', count: 1 }]);
	});

	it('counts the workers with no answer as a bucket of their own', () => {
		const buckets = buildBucketTree([workers[2], workers[4]], department, role);

		expect(shape(buckets)).toEqual([
			{
				value: 'Front of House',
				label: 'Front of House',
				count: 1,
				subGroups: [{ value: '', label: 'No Role', count: 1 }]
			},
			{
				value: '',
				label: 'No Department',
				count: 1,
				subGroups: [{ value: 'Server', label: 'Server', count: 1 }]
			}
		]);
	});

	it('leaves a group with no members out of the tree', () => {
		expect(shape(buildBucketTree([], department, role))).toEqual([]);
	});
});

describe('answerDisplay (ADR 0043)', () => {
	const site: WorkerAttributeDefinition = {
		id: 'site',
		name: 'Site',
		kind: 'category',
		answers: [
			{ id: answerIdOf('site', 'Front of House'), value: 'Front of House', mode: 'multi' },
			{
				id: answerIdOf('site', 'Server'),
				value: 'Server',
				parentId: answerIdOf('site', 'Front of House')
			},
			{
				id: answerIdOf('site', 'Host'),
				value: 'Host',
				parentId: answerIdOf('site', 'Front of House')
			}
		]
	};

	it('reads a list-storing category as the labels of the answers held, in recorded order', () => {
		expect(
			answerDisplay(site, {
				site: [answerIdOf('site', 'Server'), answerIdOf('site', 'Host')]
			})
		).toEqual(['Server', 'Host']);
	});

	it('reads a plain category as the label of its one answer', () => {
		expect(answerDisplay(department, { dept: answerIdOf('dept', 'Front of House') })).toBe(
			'Front of House'
		);
	});
});

describe('isolatedDegrees', () => {
	// a—b—c—d is a chain; a—e hangs off the root.
	const graph = {
		nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => node(id)),
		links: [link('a', 'b'), link('b', 'c'), link('c', 'd'), link('a', 'e')]
	};

	it('returns the direct neighbours as the first degree, in adjacency order', () => {
		const { firstDegree, secondDegree } = isolatedDegrees(buildAdjacency(graph), 'a');

		expect(firstDegree).toEqual(['b', 'e']);
		expect(secondDegree).toEqual(['c']);
	});

	it('keeps the focus worker, and anyone the first degree already covers, out of the second degree', () => {
		const { firstDegree, secondDegree } = isolatedDegrees(buildAdjacency(graph), 'b');

		expect(firstDegree).toEqual(['a', 'c']);
		// a brings e (b is the focus); c brings d. Order follows the first degree.
		expect(secondDegree).toEqual(['e', 'd']);
	});

	it('returns empty degrees for a worker with no relationships', () => {
		const alone = { nodes: [node('a')], links: [] as WorkerGraphLink[] };
		const { firstDegree, secondDegree } = isolatedDegrees(buildAdjacency(alone), 'a');

		expect(firstDegree).toEqual([]);
		expect(secondDegree).toEqual([]);
	});
});

describe('groupValue', () => {
	const location = attributeFixture({
		id: 'loc',
		name: 'Location',
		kind: 'tag',
		options: ['Central', 'Store A']
	});
	const central = answerIdOf(location.id, 'Central');

	it('reads the single region id the layout projects for a Multi-Select Attribute', () => {
		expect(groupValue({ attributes: { loc: central } }, location)).toBe(central);
	});

	it('reads the first held id from a stored list', () => {
		expect(groupValue({ attributes: { loc: [central] } }, location)).toBe(central);
		expect(groupValue({ attributes: { loc: [] } }, location)).toBe('');
		expect(groupValue({ attributes: {} }, undefined)).toBe('');
	});
});
