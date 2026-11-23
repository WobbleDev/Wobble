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
			{ id: 'ana', name: 'Ana', detail: 'Front of House', ties: 0 },
			{ id: 'zed', name: 'Zed', detail: 'Back of House', ties: 0 }
		]);
	});

	it('leaves the context line empty without a Category or an answer', () => {
		const leader = worker('Ana', 'Leader');
		expect(committeeMembers([leader], [], 5, 'en').members[0].detail).toBe('');
		expect(committeeMembers([leader], [department], 5, 'en').members[0].detail).toBe('');
	});

	it("counts a Leader's ties from either side, once, and ignores Workers no longer there", () => {
		const ana = baseWorker({
			id: 'ana',
			name: 'Ana',
			assessment: 'Leader',
			relationships: ['bo', 'gone', 'ana']
		});
		const bo = baseWorker({
			id: 'bo',
			name: 'Bo',
			assessment: 'Supporter',
			relationships: ['ana']
		});
		const cy = baseWorker({ id: 'cy', name: 'Cy', assessment: 'Activist', relationships: ['ana'] });
		const { members } = committeeMembers([ana, bo, cy], [], 5, 'en');
		expect(members[0].ties).toBe(2);
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
