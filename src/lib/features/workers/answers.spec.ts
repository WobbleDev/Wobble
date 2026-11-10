import { describe, expect, it } from 'vitest';
import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import {
	answerChoices,
	answerFilterChoices,
	describeAnswerValue,
	heldAnswerIds,
	holdsAnswer,
	textChoices
} from './answers.ts';

const department: WorkerAttributeDefinition = {
	id: 'department',
	name: 'Department',
	kind: 'category',
	answers: [
		{ id: 'a1', value: 'Front of House' },
		{ id: 'a2', value: 'Back of House' }
	]
};
const shifts: WorkerAttributeDefinition = {
	id: 'shifts',
	name: 'Shifts',
	kind: 'tag',
	answers: [
		{ id: 's1', value: 'Dinner' },
		{ id: 's2', value: 'Brunch' }
	]
};

const worker = (overrides: Partial<Worker> = {}) =>
	baseWorker({
		name: 'Ada',
		assessment: 'Supporter',
		attributes: { department: 'a1', shifts: ['s1'] },
		...overrides
	});

describe('answers', () => {
	it('reads the held value ids, blank when a Worker has none', () => {
		expect(heldAnswerIds(worker(), department)).toBe('a1');
		expect(heldAnswerIds(worker(), shifts)).toEqual(['s1']);
		expect(heldAnswerIds(worker({ attributes: {} }), department)).toBe('');
		expect(heldAnswerIds(worker({ attributes: {} }), shifts)).toEqual([]);
	});

	it('tests a held value by id', () => {
		expect(holdsAnswer(worker(), department, 'a1')).toBe(true);
		expect(holdsAnswer(worker(), department, 'a2')).toBe(false);
		expect(holdsAnswer(worker(), shifts, 's1')).toBe(true);
	});

	it('labels choices with their text and keys them by id', () => {
		expect(answerChoices(department)).toEqual([
			{ value: 'a1', label: 'Front of House' },
			{ value: 'a2', label: 'Back of House' }
		]);
		expect(textChoices(['Spanish'])).toEqual([{ value: 'Spanish', label: 'Spanish' }]);
	});

	it('qualifies only same-named values with their path, for every selector', () => {
		const location: WorkerAttributeDefinition = {
			id: 'location',
			name: 'Location',
			kind: 'category',
			answers: [
				{ id: 'central', value: 'Central' },
				{ id: 'store-a', value: 'Store A', parentId: 'central' },
				{ id: 'central-packing', value: 'Packing', parentId: 'central' },
				{ id: 'other', value: 'Other' },
				{ id: 'other-packing', value: 'Packing', parentId: 'other' }
			]
		};

		expect(answerChoices(location)).toEqual([
			{ value: 'central', label: 'Central' },
			{ value: 'store-a', label: 'Store A' },
			{ value: 'central-packing', label: 'Central / Packing' },
			{ value: 'other', label: 'Other' },
			{ value: 'other-packing', label: 'Other / Packing' }
		]);
	});
});

describe('describeAnswerValue', () => {
	/** The same Attribute once a real answer reads exactly as its no-value reading. */
	const colliding: WorkerAttributeDefinition = {
		...department,
		answers: [...department.answers, { id: 'a3', value: 'No Department' }]
	};

	it('reads a held value by its configured text, not its id', () => {
		expect(describeAnswerValue(department, 'a1')).toBe('Front of House');
		expect(describeAnswerValue(department, ['a2'])).toBe('Back of House');
	});

	it('reads an empty value by the no-value reading', () => {
		expect(describeAnswerValue(department, '')).toBe('No Department');
		expect(describeAnswerValue(shifts, [])).toBe('No Shifts');
	});

	it('adds No selection only to the system reading when a real value reads the same', () => {
		expect(describeAnswerValue(colliding, '')).toBe('No Department, No selection');
		expect(describeAnswerValue(colliding, 'a3')).toBe('No Department');
	});

	it('reads a same-named value with enough path context to tell it apart', () => {
		const location: WorkerAttributeDefinition = {
			id: 'location',
			name: 'Location',
			kind: 'tag',
			answers: [
				{ id: 'central-packing', value: 'Packing', parentId: 'central' },
				{ id: 'other-packing', value: 'Packing', parentId: 'other' },
				{ id: 'central', value: 'Central' },
				{ id: 'other', value: 'Other' }
			]
		};

		expect(describeAnswerValue(location, ['central-packing'])).toBe('Central / Packing');
		expect(describeAnswerValue(location, ['other-packing'])).toBe('Other / Packing');
		expect(describeAnswerValue(location, 'central')).toBe('Central');
	});
});

describe('heldAnswerIds with a Multi-Select group (ADR 0043)', () => {
	const site: WorkerAttributeDefinition = {
		id: 'site',
		name: 'Site',
		kind: 'category',
		answers: [
			{ id: 'foh', value: 'Front of House', mode: 'multi' },
			{ id: 'server', value: 'Server', parentId: 'foh' },
			{ id: 'host', value: 'Host', parentId: 'foh' }
		]
	};

	it('returns an array of held ids for a category that stores a list', () => {
		expect(heldAnswerIds(worker({ attributes: { site: ['server', 'host'] } }), site)).toEqual([
			'server',
			'host'
		]);
	});

	it('returns a single id for a plain category', () => {
		expect(heldAnswerIds(worker(), department)).toBe('a1');
	});
});

describe('Product gap 06 filter choices', () => {
	it('Product gap 06 adds the shared no-value reading to a Single-Select filter', () => {
		expect(answerFilterChoices(department).at(-1)).toEqual({
			value: '',
			label: 'No Department',
			description: null,
			missing: true
		});
	});

	it('Product gap 06 adds the secondary No selection only when a real value collides', () => {
		const colliding: WorkerAttributeDefinition = {
			...department,
			answers: [...department.answers, { id: 'a3', value: 'No Department' }]
		};

		const choices = answerFilterChoices(colliding);

		expect(choices.filter((choice) => choice.label === 'No Department')).toEqual([
			{ value: 'a3', label: 'No Department' },
			{ value: '', label: 'No Department', description: 'No selection', missing: true }
		]);
	});

	it('offers the shared no-value reading for a Multi-Select Attribute too', () => {
		expect(answerFilterChoices(shifts)).toEqual([
			...answerChoices(shifts),
			{ value: '', label: 'No Shifts', description: null, missing: true }
		]);
	});

	it('Product gap 06 names the choice from the current configured Attribute name', () => {
		const renamed: WorkerAttributeDefinition = { ...department, name: 'Team' };

		expect(answerFilterChoices(renamed).at(-1)?.label).toBe('No Team');
	});
});
