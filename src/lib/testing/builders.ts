import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';

/** A Worker with neutral defaults. Overrides fill in only what a test cares about. */
export function worker(overrides: Partial<Worker> = {}): Worker {
	return {
		id: 'w1',
		name: 'Worker 1',
		email: '',
		phone: '',
		assessment: 'Unassessed',
		attributes: {},
		agitations: [],
		languages: [],
		relationships: [],
		notes: [],
		...overrides
	};
}

/** An Attribute definition with neutral defaults and no answers yet. */
export function attributeDefinition(
	overrides: Partial<WorkerAttributeDefinition> = {}
): WorkerAttributeDefinition {
	return {
		id: 'department',
		name: 'Department',
		kind: 'category',
		answers: [],
		...overrides
	};
}
