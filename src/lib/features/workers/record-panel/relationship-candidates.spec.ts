import { describe, expect, it } from 'vitest';
import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import { relationshipCandidates, RELATIONSHIP_CANDIDATE_LIMIT } from './relationship-candidates.ts';

const attributes: WorkerAttributeDefinition[] = [
	{
		id: 'shifts',
		name: 'Shifts',
		kind: 'tag',
		answers: [{ id: 'dinner', value: 'Dinner' }]
	},
	{
		id: 'dept',
		name: 'Department',
		kind: 'category',
		answers: [
			{ id: 'front', value: 'Front' },
			{ id: 'back', value: 'Back' }
		]
	},
	{
		id: 'role',
		name: 'Role',
		kind: 'category',
		answers: [{ id: 'cook', value: 'Cook' }]
	}
];

const worker = (id: string, name: string, extra: Partial<Worker> = {}) =>
	baseWorker({ id, name, assessment: 'Supporter', ...extra });

describe('relationshipCandidates', () => {
	const ada = worker('w1', 'Ada Lovelace', { relationships: ['w2'] });
	const grace = worker('w2', 'Grace Hopper', { relationships: ['w1'] });
	const katherine = worker('w3', 'Katherine Johnson', { attributes: { dept: 'back' } });
	const mary = worker('w4', 'Mary Jackson', { attributes: { dept: '', role: 'cook' } });
	const everyone = [ada, grace, katherine, mary];

	it('lists candidates in name order, before cutting to the limit', () => {
		const names = ['zed', 'Bea', 'adam', 'Cy'];
		const workers = [ada, ...names.map((name, index) => worker(`n${index}`, name))];

		const { matches } = relationshipCandidates(ada, workers, attributes, '');

		expect(matches.map((match) => match.worker.name)).toEqual(['adam', 'Bea', 'Cy', 'zed']);
	});

	it('leaves out the worker themselves and their existing relationships', () => {
		const { matches } = relationshipCandidates(ada, everyone, attributes, '');

		expect(matches.map((match) => match.worker.name)).toEqual([
			'Katherine Johnson',
			'Mary Jackson'
		]);
	});

	it('filters by name, ignoring case and surrounding space', () => {
		const { matches } = relationshipCandidates(ada, everyone, attributes, '  JACK ');

		expect(matches.map((match) => match.worker.name)).toEqual(['Mary Jackson']);
	});

	it('shows the first Category answer that is filled in, never a Tag', () => {
		const { matches } = relationshipCandidates(ada, everyone, attributes, '');

		expect(matches.map((match) => match.detail)).toEqual(['Back', 'Cook']);
		expect(
			relationshipCandidates(ada, [worker('w9', 'Nobody Answered')], attributes, '').matches[0]
				.detail
		).toBe('');
	});

	it('caps the list and says when more matched', () => {
		const crowd = Array.from({ length: RELATIONSHIP_CANDIDATE_LIMIT + 5 }, (_, index) =>
			worker(`x${index}`, `Person ${index}`)
		);

		const result = relationshipCandidates(ada, crowd, attributes, 'person');

		expect(result.matches).toHaveLength(RELATIONSHIP_CANDIDATE_LIMIT);
		expect(result.more).toBe(true);
		expect(relationshipCandidates(ada, crowd, attributes, 'Person 3').more).toBe(false);
	});
});

describe('relationshipCandidates for the record panel add list', () => {
	// Same input shape as e2e/workers-record-panel.spec.ts:1884: Ada choosing between
	// Grace (holding the first Category answer) and Katherine (holding nothing).
	const chooser = worker('ada', 'Ada Lovelace');
	const front = worker('grace', 'Grace Hopper', { attributes: { dept: 'front' } });
	const noAnswer = worker('katherine', 'Katherine Johnson');
	const candidates = [chooser, front, noAnswer];

	it('leaves out the chooser and already-related workers, and filters by name', () => {
		const open = relationshipCandidates(chooser, candidates, attributes, '');

		expect(open.matches.map((match) => match.worker.name)).toEqual([
			'Grace Hopper',
			'Katherine Johnson'
		]);
		expect(open.more).toBe(false);

		const narrowed = relationshipCandidates(chooser, candidates, attributes, 'kath');

		expect(narrowed.matches.map((match) => match.worker.name)).toEqual(['Katherine Johnson']);

		const related = relationshipCandidates(
			worker('ada', 'Ada Lovelace', { relationships: ['grace'] }),
			candidates,
			attributes,
			''
		);

		expect(related.matches.map((match) => match.worker.name)).toEqual(['Katherine Johnson']);
	});

	it('shows the first Category answer as the candidate detail', () => {
		const { matches } = relationshipCandidates(chooser, candidates, attributes, '');

		expect(matches.find((match) => match.worker.name === 'Grace Hopper')?.detail).toBe('Front');
	});
});
