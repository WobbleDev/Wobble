import { describe, expect, it } from 'vitest';
import { worker } from '../../testing/builders.ts';
import {
	assessmentCounts,
	contextualGroupReadings,
	coverageReading,
	supportReading
} from './support-summary.ts';
import { assessmentBreakdown, populationOf } from './overview-readings.ts';
import type { AssessmentOption } from '#lib/domain-vocabulary.ts';

const w = (id: string, assessment: AssessmentOption, dept = 'a') =>
	worker({ id, name: id, assessment, attributes: { dept } });

describe('assessmentBreakdown', () => {
	it('lists every level in order, zeros included, summing to the population', () => {
		const counts = assessmentCounts([w('1', 'Leader'), w('2', 'Leader'), w('3', 'Unassessed')]);
		const rows = assessmentBreakdown(counts);
		expect(rows.map((row) => row.option)).toEqual([
			'Leader',
			'Activist',
			'Supporter',
			'Disengaged',
			'Hostile',
			'Unassessed'
		]);
		expect(rows.map((row) => row.count)).toEqual([2, 0, 0, 0, 0, 1]);
	});
});

describe('pinned denominators', () => {
	const everyone = [
		w('1', 'Leader'),
		w('2', 'Supporter'),
		w('3', 'Unassessed'),
		w('4', 'Hostile', 'b'),
		w('5', 'Leader', 'b'),
		w('6', 'Unassessed', 'b'),
		w('7', 'Unassessed', 'b')
	];
	it('keeps the Worksite denominator, rounding and Leader units', () => {
		expect(supportReading(everyone)).toEqual({ support: 3, total: 7, rate: 3 / 7 });
		expect(coverageReading(everyone, 5)).toEqual({ leaders: 2, needed: 2, gap: 0 });
		expect(coverageReading(everyone, 3)).toEqual({ leaders: 2, needed: 3, gap: -1 });
	});
	it('keeps each group its own denominator', () => {
		const groups = contextualGroupReadings(
			{ workers: everyone },
			{
				id: 'dept',
				name: 'Dept',
				kind: 'category',
				answers: [
					{ id: 'a', value: 'A' },
					{ id: 'b', value: 'B' }
				]
			},
			5
		);
		const byId = Object.fromEntries(groups.map((g) => [g.answerId, g]));
		expect(byId.a).toMatchObject({ total: 3, support: 2, leaders: 1, needed: 1 });
		expect(byId.b).toMatchObject({ total: 4, support: 1, leaders: 1, needed: 1 });
	});
});

describe('populationOf', () => {
	it('names the Worksite or the group', () => {
		expect(populationOf()).toEqual({ kind: 'worksite' });
		expect(populationOf('Packing')).toEqual({ kind: 'filter', name: 'Packing' });
	});
});
