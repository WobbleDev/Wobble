/**
 * Pins `textStringsOf`, the strings the grouped map reserves room for, ahead of splitting
 * map-canvas: which names stand at rest, which headings exist (with counts and the
 * sub-group child flag), and the key that tells the layout the text changed. Synthetic data.
 */
// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { textStringsOf } from './map-drawing.ts';
import type { WorkerGraphNode } from './worker-relationship-map-model.ts';

const department: WorkerAttributeDefinition = {
	id: 'dept',
	name: 'Department',
	kind: 'category',
	answers: [
		{ id: 'front', value: 'Front' },
		{ id: 'back', value: 'Back' }
	]
};
const shift: WorkerAttributeDefinition = {
	id: 'shift',
	name: 'Shift',
	kind: 'category',
	answers: [
		{ id: 'day', value: 'Day' },
		{ id: 'night', value: 'Night' }
	]
};

function node(id: string, name: string, attributes: Record<string, string>): WorkerGraphNode {
	return { id, name, assessment: 'Unassessed', attributes, relationshipCount: 0 };
}

const nodes = [
	node('w1', 'Ada Lovelace', { dept: 'front', shift: 'day' }),
	node('w2', 'Grace Hopper', { dept: 'front', shift: 'night' }),
	node('w3', 'Edsger Dijkstra With A Very Long Surname Indeed', { dept: 'back', shift: 'day' }),
	node('w4', 'Alan Turing', {})
];

const base = {
	layoutNodes: nodes,
	restingLabelIds: ['w1', 'w3'],
	composes: true,
	groupingAttribute: department,
	subGroupingAttribute: undefined
};

describe('textStringsOf', () => {
	it('lists resting names in the order given, trimming a long name to 24 characters', () => {
		const { names } = textStringsOf(base);
		expect(names.map((n) => n.id)).toEqual(['w1', 'w3']);
		expect(names[0]!.text).toBe('Ada Lovelace');
		expect(names[1]!.text).toBe('Edsger Dijkstra With A …');
		expect(names[1]!.text).toHaveLength(24);
	});

	it('skips a resting id that is not among the layout nodes', () => {
		expect(
			textStringsOf({ ...base, restingLabelIds: ['w1', 'ghost'] }).names.map((n) => n.id)
		).toEqual(['w1']);
		expect(textStringsOf({ ...base, restingLabelIds: new Set<string>() }).names).toEqual([]);
	});

	it('gives one heading per group in first-seen order, with its Worker count', () => {
		const { headings } = textStringsOf(base);
		expect(headings.map((h) => [h.label, h.count, h.child])).toEqual([
			['Front', 2, false],
			['Back', 1, false],
			['No Department', 1, false]
		]);
	});

	it('adds each group’s sub-group headings, flagged as children, after their parent', () => {
		const { headings } = textStringsOf({ ...base, subGroupingAttribute: shift });
		expect(headings.map((h) => h.child)).toEqual([false, true, true, false, true, false, true]);
		expect(headings.filter((h) => !h.child).map((h) => h.count)).toEqual([2, 1, 1]);
		expect(headings[1]!.count).toBe(1);
		expect(new Set(headings.map((h) => h.key)).size).toBe(headings.length);
	});

	it('has no headings unless the map composes with a grouping attribute', () => {
		expect(textStringsOf({ ...base, composes: false }).headings).toEqual([]);
		expect(textStringsOf({ ...base, groupingAttribute: undefined }).headings).toEqual([]);
	});

	it('keys the strings so the layout reruns exactly when the displayed text changes', () => {
		const first = textStringsOf(base).key;
		expect(textStringsOf({ ...base }).key).toBe(first);
		expect(textStringsOf({ ...base, restingLabelIds: ['w1'] }).key).not.toBe(first);
		const renamed = nodes.map((n) => (n.id === 'w1' ? { ...n, name: 'Ada King' } : n));
		expect(textStringsOf({ ...base, layoutNodes: renamed }).key).not.toBe(first);
		expect(textStringsOf({ ...base, composes: false }).key).not.toBe(first);
	});
});
