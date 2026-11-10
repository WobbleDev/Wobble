import { describe, expect, it } from 'vitest';
import { personState } from '#lib/shared/person-state.svelte.ts';
import { openCreatedWorkers } from './open-created-workers.ts';

describe('opening the created Workers', () => {
	it('opens the first as the record and keeps all, in order, as the cohort', () => {
		openCreatedWorkers('ws-open', ['w2', 'w4', 'w9'], 'dept=x');
		const person = personState.forWorksite('ws-open');
		expect(person.workersSelectedId).toBe('w2');
		expect(person.workersCohort).toEqual(['w2', 'w4', 'w9']);
		expect(person.workersReturn).toEqual({
			sourceRoute: 'workers',
			sourceFocus: null,
			returnFiltersHash: 'dept=x'
		});
	});

	it('stays inside its own Worksite and leaves the record alone when nothing was created', () => {
		openCreatedWorkers('ws-a', ['w1'], '');
		openCreatedWorkers('ws-b', [], '');
		expect(personState.forWorksite('ws-b').workersSelectedId).toBeNull();
		expect(personState.forWorksite('ws-a').workersSelectedId).toBe('w1');
	});
});
