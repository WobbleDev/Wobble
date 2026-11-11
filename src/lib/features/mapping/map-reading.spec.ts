// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { assessmentCounts, regionCounts, supportReading } from './map-reading.ts';
import type { WorkerGraphNode } from './canvas/worker-relationship-map-model.ts';
import {
	answerIdOf,
	answerIdsFixture,
	attributeFixture
} from '#lib/testing/mapping/answer-fixtures.ts';

const workers = [
	{ assessment: 'Leader' as const },
	{ assessment: 'Leader' as const },
	{ assessment: 'Activist' as const },
	{ assessment: 'Supporter' as const },
	{ assessment: 'Disengaged' as const },
	{ assessment: 'Hostile' as const },
	{ assessment: 'Unassessed' as const },
	{ assessment: 'Unassessed' as const }
];

describe('assessmentCounts', () => {
	it('counts every Assessment including Unassessed', () => {
		expect(assessmentCounts(workers)).toEqual({
			Leader: 2,
			Activist: 1,
			Supporter: 1,
			Disengaged: 1,
			Hostile: 1,
			Unassessed: 2
		});
	});

	it('returns no keys for no workers', () => {
		expect(assessmentCounts([])).toEqual({});
	});
});

describe('supportReading', () => {
	it('reads Support as Leader, Activist and Supporter against every worker', () => {
		expect(supportReading(workers)).toEqual({
			total: 8,
			support: 4,
			unassessed: 2,
			other: 2
		});
	});

	it('keeps Unassessed out of both Support and other', () => {
		expect(supportReading([{ assessment: 'Unassessed' }])).toEqual({
			total: 1,
			support: 0,
			unassessed: 1,
			other: 0
		});
	});

	it('reads an empty worksite as all zeroes', () => {
		expect(supportReading([])).toEqual({ total: 0, support: 0, unassessed: 0, other: 0 });
	});
});

function node(
	id: string,
	assessment: WorkerGraphNode['assessment'],
	department: string
): WorkerGraphNode {
	return {
		id,
		name: id,
		assessment,
		attributes: answerIdsFixture({ dept: department }),
		relationshipCount: 0
	};
}

const department = attributeFixture({
	id: 'dept',
	name: 'Department',
	kind: 'category' as const,
	options: ['Kitchen', 'Floor']
});

describe('regionCounts', () => {
	const nodes = [
		node('a', 'Leader', 'Kitchen'),
		node('b', 'Supporter', 'Kitchen'),
		node('c', 'Hostile', 'Floor'),
		node('d', 'Unassessed', 'Floor')
	];

	it('counts the members of each region', () => {
		const counts = regionCounts(nodes, department, undefined);
		expect(counts.get(answerIdOf('dept', 'Kitchen'))).toBe(2);
		expect(counts.get(answerIdOf('dept', 'Floor'))).toBe(2);
	});

	it('counts the members of each sub-region', () => {
		const sub = attributeFixture({
			id: 'role',
			name: 'Role',
			kind: 'category' as const,
			options: ['x', 'y']
		});
		const withRole = [
			{
				...node('a', 'Leader', 'Kitchen'),
				attributes: answerIdsFixture({ dept: 'Kitchen', role: 'x' })
			},
			{
				...node('b', 'Leader', 'Kitchen'),
				attributes: answerIdsFixture({ dept: 'Kitchen', role: 'y' })
			},
			{
				...node('c', 'Leader', 'Kitchen'),
				attributes: answerIdsFixture({ dept: 'Kitchen', role: 'y' })
			}
		];
		const counts = regionCounts(withRole, department, sub);
		expect(counts.get(answerIdOf('dept', 'Kitchen'))).toBe(3);
		expect([...counts.values()].sort()).toEqual([1, 2, 3]);
	});

	it('counts the Unanswered region like any other', () => {
		const counts = regionCounts([node('a', 'Leader', '')], department, undefined);
		expect(counts.get('__unassigned')).toBe(1);
	});

	it('counts nothing without a grouping', () => {
		expect(regionCounts(nodes, undefined, undefined).size).toBe(0);
	});
});
