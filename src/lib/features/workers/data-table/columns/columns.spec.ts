import { describe, expect, it } from 'vitest';
import type {
	Agitation,
	Language,
	Worker,
	WorkerAttributeDefinition
} from '#lib/domain-vocabulary.ts';
import { columnsKey } from './columns.ts';

const attributes: WorkerAttributeDefinition[] = [
	{
		id: 'department',
		name: 'Department',
		kind: 'category',
		answers: [
			{ id: 'front', value: 'Front of House' },
			{ id: 'back', value: 'Back of House' }
		]
	},
	{
		id: 'shifts',
		name: 'Shifts',
		kind: 'tag',
		answers: [{ id: 'dinner', value: 'Dinner' }]
	}
];
const agitations: Agitation[] = [{ id: 'pay', text: 'Pay' }];
const languages: Language[] = [{ id: 'spanish', name: 'Spanish' }];

describe('columnsKey', () => {
	it('gives equal keys to fresh arrays with the same content', () => {
		expect(
			columnsKey(
				attributes.map((attribute) => ({
					...attribute,
					answers: attribute.answers.map((a) => ({ ...a }))
				})),
				agitations.map((agitation) => ({ ...agitation })),
				languages.map((language) => ({ ...language }))
			)
		).toBe(columnsKey(attributes, agitations, languages));
	});

	it('changes when an answer label is renamed', () => {
		const renamed = attributes.map((attribute) => ({
			...attribute,
			answers: [...attribute.answers]
		}));
		renamed[0].answers[0] = { ...renamed[0].answers[0], value: 'Front' };

		expect(columnsKey(renamed, agitations, languages)).not.toBe(
			columnsKey(attributes, agitations, languages)
		);
	});

	it('changes when an Attribute is added or Attributes are reordered', () => {
		expect(
			columnsKey(
				[...attributes, { ...attributes[0], id: 'crew', name: 'Crew' }],
				agitations,
				languages
			)
		).not.toBe(columnsKey(attributes, agitations, languages));
		expect(columnsKey([...attributes].reverse(), agitations, languages)).not.toBe(
			columnsKey(attributes, agitations, languages)
		);
	});

	it('changes when an Attribute name, kind, or answer id changes', () => {
		const renamed = [{ ...attributes[0], name: 'Team' }, attributes[1]];
		const changedKind = [{ ...attributes[0], kind: 'tag' as const }, attributes[1]];
		const changedAnswerId = [
			{
				...attributes[0],
				answers: [{ ...attributes[0].answers[0], id: 'new-id' }, attributes[0].answers[1]]
			},
			attributes[1]
		];

		for (const changed of [renamed, changedKind, changedAnswerId]) {
			expect(columnsKey(changed, agitations, languages)).not.toBe(
				columnsKey(attributes, agitations, languages)
			);
		}
	});

	it('changes when an Agitation is renamed', () => {
		expect(columnsKey(attributes, [{ id: 'pay', text: 'Wages' }], languages)).not.toBe(
			columnsKey(attributes, agitations, languages)
		);
	});

	it('changes when an answer is added or reparented', () => {
		const withAnswer: WorkerAttributeDefinition = {
			...attributes[0],
			answers: [...attributes[0].answers, { id: 'patio', value: 'Patio' }]
		};
		const reparented: WorkerAttributeDefinition = {
			...withAnswer,
			answers: withAnswer.answers.map((answer, index) =>
				index === 1 ? { ...answer, parentId: withAnswer.answers[0].id } : answer
			)
		};
		expect(columnsKey([withAnswer, attributes[1]], agitations, languages)).not.toBe(
			columnsKey(attributes, agitations, languages)
		);
		expect(columnsKey([reparented, attributes[1]], agitations, languages)).not.toBe(
			columnsKey([withAnswer, attributes[1]], agitations, languages)
		);
	});

	it('changes when a Language is renamed', () => {
		expect(columnsKey(attributes, agitations, [{ id: 'spanish', name: 'Español' }])).not.toBe(
			columnsKey(attributes, agitations, languages)
		);
	});

	it('does not change for a Worker update because Workers are not key inputs', () => {
		const worker: Worker = {
			id: 'w1',
			name: 'Ada',
			email: '',
			phone: '',
			assessment: 'Supporter',
			attributes: {},
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		};
		const before = columnsKey(attributes, agitations, languages);
		const updatedWorker = { ...worker, assessment: 'Leader' as const };

		expect(updatedWorker.assessment).not.toBe(worker.assessment);
		expect(columnsKey(attributes, agitations, languages)).toBe(before);
	});
});
