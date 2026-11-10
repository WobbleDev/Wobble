import { describe, expect, it } from 'vitest';
import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import { toWorkerUpdate } from './worker-update.ts';

const attributes: WorkerAttributeDefinition[] = [
	{
		id: 'department',
		name: 'Department',
		kind: 'category',
		answers: []
	},
	{
		id: 'languages-spoken',
		name: 'Languages spoken',
		kind: 'tag',
		answers: []
	}
];

const worker = (overrides: Partial<Worker> = {}) =>
	baseWorker({
		id: 'w-1',
		name: 'Mary Anning',
		email: 'mary@example.com',
		phone: '555-0100',
		assessment: 'Leader',
		attributes: { department: 'd-1', 'languages-spoken': ['t-1', 't-2'] },
		agitations: ['ag-1'],
		languages: ['Spanish'],
		relationships: ['w-2'],
		notes: [{ id: 'n-1', text: 'Asked about rota', timestamp: '2026-01-02T10:00:00Z' }],
		...overrides
	});

describe('toWorkerUpdate', () => {
	it('carries every field across except the id', () => {
		const update = toWorkerUpdate(worker(), attributes);
		expect(update).toEqual({
			name: 'Mary Anning',
			email: 'mary@example.com',
			phone: '555-0100',
			assessment: 'Leader',
			attributes: { department: 'd-1', 'languages-spoken': ['t-1', 't-2'] },
			agitations: ['ag-1'],
			languages: ['Spanish'],
			relationships: ['w-2'],
			notes: [{ id: 'n-1', text: 'Asked about rota', timestamp: '2026-01-02T10:00:00Z' }]
		});
		expect(update).not.toHaveProperty('id');
	});

	it('fills an Attribute the Worker has no value for with the empty value of its kind', () => {
		const update = toWorkerUpdate(worker({ attributes: {} }), attributes);
		expect(update.attributes).toEqual({ department: '', 'languages-spoken': [] });
	});

	it('lists every configured Attribute, so a draft base cannot drop a saved value', () => {
		// The record panel builds a draft's update and base from this call: an Attribute
		// left out here would let an older draft snapshot clear it on the next save.
		const update = toWorkerUpdate(worker({ attributes: { department: 'd-1' } }), attributes);
		expect(Object.keys(update.attributes).sort()).toEqual(['department', 'languages-spoken']);
		expect(update.attributes).toEqual({ department: 'd-1', 'languages-spoken': [] });
	});

	it('leaves out values for Attributes that are not in the definitions', () => {
		const stray = worker({ attributes: { department: 'd-1', retired: 'x' } });
		const update = toWorkerUpdate(stray, attributes);
		expect(update.attributes).toEqual({ department: 'd-1', 'languages-spoken': [] });
	});

	it('gives an empty update for a Worker with no fields set and no Attributes defined', () => {
		const bare = worker({
			name: '',
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: {},
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		});
		expect(toWorkerUpdate(bare, [])).toEqual({
			name: '',
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: {},
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		});
	});

	it('copies the lists and notes so editing the update does not change the Worker', () => {
		const source = worker();
		const update = toWorkerUpdate(source, attributes);
		update.languages.push('Polish');
		update.agitations.push('ag-2');
		update.relationships.push('w-3');
		update.notes[0].text = 'changed';

		expect(source.languages).toEqual(['Spanish']);
		expect(source.agitations).toEqual(['ag-1']);
		expect(source.relationships).toEqual(['w-2']);
		expect(source.notes[0].text).toBe('Asked about rota');
	});
});
