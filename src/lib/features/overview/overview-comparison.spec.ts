import { describe, expect, it } from 'vitest';
import { worker } from '../../testing/builders.ts';
import type { AssessmentOption, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { agitationGroupMatrix, contextualGroupReadings } from './support-summary.ts';
import { compareGroups, figure, frontierId, frontierKey } from './overview-comparison.ts';

const attribute: WorkerAttributeDefinition = {
	id: 'dept',
	name: 'Dept',
	kind: 'category',
	answers: [
		{ id: 'a', value: 'A' },
		{ id: 'b', value: 'B' },
		{ id: 'c', value: 'C' }
	]
};
const agitations = [
	{ id: 'pay', text: 'Pay' },
	{ id: 'hours', text: 'Hours' },
	{ id: 'safety', text: 'Safety' }
];
const w = (id: string, assessment: AssessmentOption, dept: string, held: string[] = []) =>
	worker({ id, name: id, assessment, attributes: dept ? { dept } : {}, agitations: held });

// Worksite of 9: A has 3 (1 Leader, 1 Supporter, 1 Unassessed), B has 4, nobody in C,
// and 2 Workers hold no Dept (the no-value group).
const everyone = [
	w('1', 'Leader', 'a', ['pay']),
	w('2', 'Supporter', 'a', ['pay', 'hours']),
	w('3', 'Unassessed', 'a'),
	w('4', 'Hostile', 'b', ['hours']),
	w('5', 'Leader', 'b'),
	w('6', 'Unassessed', 'b'),
	w('7', 'Unassessed', 'b'),
	w('8', 'Activist', ''),
	w('9', 'Unassessed', '')
];
const groups = contextualGroupReadings({ workers: everyone }, attribute, 2);
const matrix = agitationGroupMatrix({ workers: everyone }, agitations, attribute);
const input = { groups, matrix, worksiteTotal: everyone.length };
const key = (answerId: string, extra = {}) =>
	frontierKey({ attributeId: 'dept', answerId, ...extra });

describe('frontier keys', () => {
	it('names a region frontier:<frontierId> independent of order', () => {
		expect(frontierId({ attributeId: 'dept', answerId: 'a' })).toBe('dept/a');
		expect(key('a')).toBe('frontier:dept/a');
	});
	it('keeps answer, exact remainder and no-value distinct', () => {
		const keys = [key('a'), key('a', { remainder: true }), key('', { noValue: true })];
		expect(new Set(keys).size).toBe(3);
		expect(keys[1]).toBe('frontier:dept/#self:dept:a');
		expect(keys[2]).toBe('frontier:dept/#none');
	});
	it('resolves the same key in both readings despite different row orders', () => {
		const supportOrder = groups.map(frontierKey);
		const matrixOrder = matrix.rows.map(frontierKey);
		expect([...supportOrder].sort()).toEqual([...matrixOrder].sort());
	});
});

describe('compareGroups (pinned denominators)', () => {
	const result = compareGroups(input, key('a'), key('b'))!;
	const [a, b] = result.columns;

	it('shares Workers against the labeled Worksite population', () => {
		expect(a.workers).toEqual({ count: 3, of: 9, population: { kind: 'worksite' }, share: 3 / 9 });
		expect(b.workers).toMatchObject({ count: 4, of: 9 });
	});
	it('reads support, assessed coverage and levels against the group', () => {
		const own = { kind: 'filter', name: 'A' };
		expect(a.support).toEqual({ count: 2, of: 3, population: own, share: 2 / 3 });
		expect(a.assessed).toEqual({ count: 2, of: 3, population: own, share: 2 / 3 });
		expect(b.assessed).toMatchObject({ count: 2, of: 4 });
		expect(a.leaders).toEqual({ leaders: 1, needed: 2 });
		expect(a.levels.map((l) => l.figure.count)).toEqual([1, 0, 1, 0, 0, 1]);
		expect(a.levels.every((l) => l.figure.of === 3)).toBe(true);
	});
	it('lists Agitations held in either group with the group as denominator', () => {
		expect(result.agitations.map((x) => x.id)).toEqual(['pay', 'hours']);
		expect(a.agitations.map((f) => [f.count, f.of])).toEqual([
			[2, 3],
			[1, 3]
		]);
		expect(b.agitations.map((f) => [f.count, f.of])).toEqual([
			[0, 4],
			[1, 4]
		]);
	});
	it('keeps the no-value group as itself with its own denominator', () => {
		const none = compareGroups(input, key('a'), key('', { noValue: true }))!.columns[1];
		expect(none.workers).toMatchObject({ count: 2, of: 9 });
		expect(none.support).toMatchObject({ count: 1, of: 2 });
	});
});

describe('compareGroups honesty', () => {
	it('refuses the same group twice, an unknown group and another Attribute', () => {
		expect(compareGroups(input, key('a'), key('a'))).toBeNull();
		expect(compareGroups(input, key('a'), key('c'))).toBeNull();
		expect(compareGroups(input, key('a'), 'frontier:other/x')).toBeNull();
	});
	it('gives no share, never an invented denominator, for an empty population', () => {
		expect(figure(0, 0, { kind: 'worksite' }).share).toBeNull();
		const empty = compareGroups({ groups, matrix, worksiteTotal: 0 }, key('a'), key('b'))!
			.columns[0];
		expect(empty.workers).toMatchObject({ of: 0, share: null });
	});
});
