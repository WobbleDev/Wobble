import { describe, expect, it } from 'vitest';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import type { ExpansionRefusal, GroupingReading } from '../grouping/grouping-types.ts';
import { createGroupingRefusals, expansionRefusalText } from './grouping-refusals.svelte.ts';

const department = {
	id: 'dept',
	name: 'Department',
	kind: 'category',
	answers: [
		{ id: 'front', value: 'Front' },
		{ id: 'back', value: 'Back' }
	]
} as unknown as WorkerAttributeDefinition;

const role = {
	id: 'role',
	name: 'Role',
	kind: 'category',
	answers: [{ id: 'cook', value: 'Cook' }]
} as unknown as WorkerAttributeDefinition;

const unavailable = (reason: unknown, suggestions: unknown[] = []) =>
	({
		status: 'unavailable',
		attributeId: 'dept',
		reason,
		ambiguous: new Map(),
		suggestions
	}) as unknown as GroupingReading;

function setup(reading: GroupingReading | undefined) {
	return createGroupingRefusals({
		reading: () => reading,
		view: () => ({ groupingAttribute: department, subGroupingAttribute: role }) as never,
		workerNames: () => new Map([['w1', 'Ada']]),
		attributeById: () =>
			new Map([
				[department.id, department],
				[role.id, role]
			])
	});
}

describe('the grouping refusals', () => {
	it('says nothing while the reading is fine', () => {
		const refusals = setup(undefined);
		expect(refusals.groupingRefusal).toBeUndefined();
		expect(refusals.groupingReason).toBe('');
		expect(refusals.groupingSuggestions).toEqual([]);
		expect(refusals.subGroupingRefusal).toBeUndefined();
	});

	it('names each Worker and the regions it holds', () => {
		const refusals = setup(
			unavailable({
				code: 'multiple-regions',
				attributeId: 'dept',
				workers: [{ workerId: 'w1', keys: ['front', 'back'] }]
			})
		);
		expect(refusals.groupingReason).toContain('Department');
		expect(refusals.groupingReason).toContain('Ada');
		expect(refusals.groupingReason).toContain('Front');
		expect(refusals.groupingReason).toContain('Back');
	});

	it('lists the answers it could not resolve', () => {
		const refusals = setup(
			unavailable({
				code: 'unresolved-answer',
				attributeId: 'dept',
				answerIds: ['front'],
				workerIds: ['w1']
			})
		);
		expect(refusals.groupingReason).toContain('Department');
		expect(refusals.groupingReason).toContain('front');
	});

	it('offers the narrowing answer and the no-value reading as suggestions', () => {
		const refusals = setup(
			unavailable(
				{ code: 'unresolved-answer', attributeId: 'dept', answerIds: [], workerIds: [] },
				[
					{ attributeId: 'role', answerIds: ['cook'], missing: false, resolves: 1 },
					{ attributeId: 'role', answerIds: [], missing: true, resolves: 1 }
				]
			)
		);
		expect(refusals.groupingSuggestions.map((suggestion) => suggestion.key)).toEqual([
			'role:cook',
			'role:missing'
		]);
		expect(refusals.groupingSuggestions[0]!.label).toContain('Role');
		expect(refusals.groupingSuggestions[0]!.label).toContain('Cook');
	});

	it('reports a Sub-grouping refusal only while the primary grouping stands', () => {
		const available = {
			status: 'available',
			attributeId: 'dept',
			regions: [],
			regionOf: new Map(),
			membersOf: new Map(),
			counts: new Map(),
			subGrouping: {
				status: 'unavailable',
				attributeId: 'role',
				reason: {
					code: 'paired-regions-differ',
					attributeId: 'dept',
					subAttributeId: 'role',
					workers: [{ workerId: 'w1', pairs: [['front', 'cook']] }]
				},
				pairs: new Map(),
				suggestions: []
			}
		} as unknown as GroupingReading;
		const refusals = setup(available);
		expect(refusals.groupingRefusal).toBeUndefined();
		expect(refusals.subGroupingRefusal).toBeDefined();
		expect(refusals.subGroupingReason).toContain('Ada');
		expect(refusals.subGroupingReason).toContain('Front');
		expect(refusals.subGroupingReason).toContain('Cook');
	});

	it('names the branch and the Workers a refused expansion would split', () => {
		const reading = {
			code: 'expansion-breaks-partition',
			attributeId: 'dept',
			branchId: 'front',
			workers: [{ workerId: 'w1', keys: ['front', 'back'] }]
		} as unknown as ExpansionRefusal;
		const text = expansionRefusalText(reading, department, new Map([['w1', 'Ada']]));
		expect(text).toContain('Front');
		expect(text).toContain('Ada');
		expect(expansionRefusalText(null, department, new Map())).toBe('');
	});
});
