import { describe, expect, it } from 'vitest';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import type { AssessmentOption, WorkerAttributeDefinition } from '../../domain-vocabulary.ts';
import { committeeMembers } from './committee-members.ts';

const worker = (name: string, assessment: AssessmentOption, answers: Record<string, string> = {}) =>
	baseWorker({ id: name.toLowerCase(), name, assessment, attributes: answers });

const department: WorkerAttributeDefinition = {
	id: 'department',
	name: 'Department',
	kind: 'category',
	answers: [
		{ id: 'front', value: 'Front of House' },
		{ id: 'back', value: 'Back of House' }
	]
};

describe('committeeMembers', () => {
	it('lists only Leaders, by name, with their first Category answer', () => {
		const { members } = committeeMembers(
			[
				worker('Zed', 'Leader', { department: 'back' }),
				worker('Ana', 'Leader', { department: 'front' }),
				worker('Bo', 'Supporter', { department: 'front' })
			],
			[department],
			5,
			'en'
		);
		expect(members).toEqual([
			{ id: 'ana', name: 'Ana', detail: 'Front of House' },
			{ id: 'zed', name: 'Zed', detail: 'Back of House' }
		]);
	});

	it('leaves the context line empty without a Category or an answer', () => {
		const leader = worker('Ana', 'Leader');
		expect(committeeMembers([leader], [], 5, 'en').members[0].detail).toBe('');
		expect(committeeMembers([leader], [department], 5, 'en').members[0].detail).toBe('');
	});

	it('carries the coverage reading the dashboard shows', () => {
		const crew = [
			worker('Ana', 'Leader'),
			...Array.from({ length: 9 }, (_, i) => worker(`W${i}`, 'Supporter'))
		];
		expect(committeeMembers(crew, [], 5, 'en').coverage).toEqual({
			leaders: 1,
			needed: 2,
			gap: -1
		});
	});
});
