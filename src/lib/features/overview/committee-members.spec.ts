import { describe, expect, it } from 'vitest';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import type { AssessmentOption, WorkerAttributeDefinition } from '../../domain-vocabulary.ts';
import { committeeReading } from './committee-members.ts';

const worker = (
	name: string,
	assessment: AssessmentOption,
	answers: Record<string, string> = {},
	relationships: string[] = []
) => baseWorker({ id: name.toLowerCase(), name, assessment, attributes: answers, relationships });

const department: WorkerAttributeDefinition = {
	id: 'department',
	name: 'Department',
	kind: 'category',
	answers: [
		{ id: 'front', value: 'Front of House' },
		{ id: 'back', value: 'Back of House' },
		{ id: 'kitchen', value: 'Kitchen' }
	]
};

const names = (members: { name: string }[]) => members.map((member) => member.name);

describe('committeeReading', () => {
	it('lists the whole Committee by name when nothing is grouped', () => {
		const { sections } = committeeReading(
			[worker('Zed', 'Leader'), worker('Ana', 'Leader'), worker('Bo', 'Supporter')],
			undefined,
			5,
			'en'
		);
		expect(sections).toHaveLength(1);
		expect(sections[0]).toMatchObject({ key: 'all', label: null, leaders: 2, needed: 1 });
		expect(names(sections[0].members)).toEqual(['Ana', 'Zed']);
	});

	it('keeps a single group flat', () => {
		const { sections } = committeeReading(
			[
				worker('Ana', 'Leader', { department: 'front' }),
				worker('Bo', 'Supporter', { department: 'front' })
			],
			department,
			5,
			'en'
		);
		expect(sections.map((section) => section.label)).toEqual([null]);
	});

	it("groups Leaders under the Attribute, in its order, with each group's own coverage", () => {
		const crew = [
			worker('Zed', 'Leader', { department: 'back' }),
			worker('Ana', 'Leader', { department: 'front' }),
			worker('Ines', 'Leader', { department: 'front' }),
			...Array.from({ length: 6 }, (_, i) => worker(`F${i}`, 'Supporter', { department: 'front' })),
			worker('Kay', 'Supporter', { department: 'kitchen' })
		];
		const { sections } = committeeReading(crew, department, 5, 'en');
		expect(
			sections.map(({ label, leaders, needed, members }) => [
				label,
				leaders,
				needed,
				names(members)
			])
		).toEqual([
			['Front of House', 2, 2, ['Ana', 'Ines']],
			['Back of House', 1, 1, ['Zed']],
			['Kitchen', 0, 1, []]
		]);
	});

	it("reads who a Leader's ties reach, from either side, nearest ring first", () => {
		const ana = worker('Ana', 'Leader', {}, ['bo', 'gone', 'ana', 'dee']);
		const bo = worker('Bo', 'Disengaged');
		const cy = worker('Cy', 'Supporter', {}, ['ana']);
		const dee = worker('Dee', 'Supporter');
		const { sections } = committeeReading([ana, bo, cy, dee], undefined, 5, 'en');
		const [member] = sections[0].members;
		expect(member.ties).toBe(3);
		expect(names(member.tied)).toEqual(['Cy', 'Dee', 'Bo']);
		expect(member.reach).toEqual([
			{ assessment: 'Supporter', count: 2 },
			{ assessment: 'Disengaged', count: 1 }
		]);
		expect(member.furthest).toBe('Disengaged');
	});

	it('has no furthest ring without ties, or when ties reach only Unassessed Workers', () => {
		const lone = committeeReading([worker('Ana', 'Leader')], undefined, 5, 'en');
		expect(lone.sections[0].members[0]).toMatchObject({ ties: 0, furthest: null, reach: [] });
		const quiet = committeeReading(
			[worker('Ana', 'Leader', {}, ['bo']), worker('Bo', 'Unassessed')],
			undefined,
			5,
			'en'
		);
		expect(quiet.sections[0].members[0]).toMatchObject({ ties: 1, furthest: null, reach: [] });
	});

	it('carries the coverage reading the dashboard shows', () => {
		const crew = [
			worker('Ana', 'Leader'),
			...Array.from({ length: 9 }, (_, i) => worker(`W${i}`, 'Supporter'))
		];
		expect(committeeReading(crew, undefined, 5, 'en').coverage).toEqual({
			leaders: 1,
			needed: 2,
			gap: -1
		});
	});
});
