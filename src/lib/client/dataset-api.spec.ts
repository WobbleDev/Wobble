import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAppSettings } from '#lib/shared/app-settings.ts';
import { jsonResponse } from '#lib/testing/http.ts';
import {
	decodeWorksiteDataset,
	getWorksiteDataset,
	primeDataset,
	takePrimedDataset
} from './dataset-api.ts';

const emptyDataset = {
	workers: [],
	attributes: [],
	agitations: [],
	languages: [],
	worksite: null,
	worksites: [],
	settings: defaultAppSettings
};

// The core's reply: Attribute answers and Worker answers are ids.
const populatedWire = {
	...emptyDataset,
	workers: [
		{
			id: 'w1',
			name: 'Rosalind Franklin',
			email: 'rosalind@example.test',
			phone: '',
			assessment: 'Leader',
			attributes: { a1: ['x1', 'x2'] },
			agitations: ['g1'],
			languages: ['l1'],
			relationships: ['w2'],
			notes: [
				{
					id: 'n1',
					text: 'Called back.',
					timestamp: '2025-01-01T00:00:00.000Z'
				}
			]
		}
	],
	attributes: [
		{
			id: 'a1',
			name: 'Category',
			kind: 'tag',
			options: [
				{ id: 'x1', value: 'x' },
				{ id: 'x2', value: 'y' }
			]
		}
	],
	agitations: [{ id: 'g1', text: 'Pay' }],
	languages: [{ id: 'l1', name: 'Polish' }],
	worksite: { id: 'ws1', name: 'My Worksite', committeeGoal: 5, committeeTarget: 5 },
	worksites: [{ id: 'ws1', name: 'My Worksite', committeeGoal: 5, committeeTarget: 5 }],
	settings: { ...defaultAppSettings, theme: 'dark', density: 'compact' }
};

const populatedDataset = {
	workers: [
		{
			id: 'w1',
			name: 'Rosalind Franklin',
			email: 'rosalind@example.test',
			phone: '',
			assessment: 'Leader',
			attributes: { a1: ['x1', 'x2'] },
			agitations: ['g1'],
			languages: ['l1'],
			relationships: ['w2'],
			notes: [
				{
					id: 'n1',
					text: 'Called back.',
					timestamp: '2025-01-01T00:00:00.000Z'
				}
			]
		}
	],
	attributes: [
		{
			id: 'a1',
			name: 'Category',
			kind: 'tag',
			answers: [
				{ id: 'x1', value: 'x' },
				{ id: 'x2', value: 'y' }
			]
		}
	],
	agitations: [{ id: 'g1', text: 'Pay' }],
	languages: [{ id: 'l1', name: 'Polish' }],
	worksite: { id: 'ws1', name: 'My Worksite', committeeGoal: 5, committeeTarget: 5 },
	worksites: [{ id: 'ws1', name: 'My Worksite', committeeGoal: 5, committeeTarget: 5 }],
	settings: { ...defaultAppSettings, theme: 'dark', density: 'compact' }
};

function workerWithNotes(notes: unknown[]) {
	return {
		id: 'w1',
		name: 'Rosalind Franklin',
		email: '',
		phone: '',
		assessment: 'Leader',
		attributes: {},
		agitations: [],
		languages: [],
		relationships: [],
		notes
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('reading the worksite dataset', () => {
	it('fetches without caching and returns the decoded worksite', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(populatedWire));
		vi.stubGlobal('fetch', fetchMock);

		await expect(getWorksiteDataset()).resolves.toEqual(populatedDataset);
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/dataset',
			expect.objectContaining({ cache: 'no-store' })
		);
	});

	it('accepts an empty worksite with a null worksite', () => {
		expect(decodeWorksiteDataset(emptyDataset)).toEqual(emptyDataset);
	});

	it('keeps a valid editedAt and passes notes with one that does not parse through as sent', () => {
		const timestamp = '2025-03-15T14:30:00.000Z';
		const withEdit = {
			...emptyDataset,
			workers: [
				workerWithNotes([
					{ id: 'n1', text: 'Edited.', timestamp, editedAt: '2026-10-08T18:40:00.000Z' }
				])
			]
		};
		expect(decodeWorksiteDataset(withEdit).workers[0].notes[0].editedAt).toBe(
			'2026-10-08T18:40:00.000Z'
		);

		const badEdit = {
			...emptyDataset,
			workers: [workerWithNotes([{ id: 'n1', text: 'Edited.', timestamp, editedAt: 'nope' }])]
		};
		// The shared Worker decoder is as lenient as the draft check it replaced (ticket 13).
		expect(decodeWorksiteDataset(badEdit).workers[0].notes[0].editedAt).toBe('nope');
	});

	it('rejects invalid settings', () => {
		expect(() => decodeWorksiteDataset({ ...emptyDataset, settings: { theme: 'sepia' } })).toThrow(
			'Server returned an invalid dataset.'
		);
	});

	it('surfaces its fallback message when the read fails without a body', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

		await expect(getWorksiteDataset()).rejects.toThrow('Could not load the worksite (HTTP 500).');
	});
});

describe('one-shot dataset hand-off', () => {
	const primedPopulated = decodeWorksiteDataset(populatedWire);
	const primedEmpty = decodeWorksiteDataset(emptyDataset);

	it('returns a primed dataset once', () => {
		primeDataset(primedPopulated, 100);

		expect(takePrimedDataset(2100)).toBe(primedPopulated);
		expect(takePrimedDataset(2100)).toBeUndefined();
	});

	it('drops a dataset older than 2000 milliseconds', () => {
		primeDataset(primedPopulated, 100);

		expect(takePrimedDataset(2101)).toBeUndefined();
	});

	it('keeps the latest primed dataset', () => {
		primeDataset(primedEmpty, 100);
		primeDataset(primedPopulated, 200);

		expect(takePrimedDataset(2200)).toBe(primedPopulated);
	});
});

describe('decoding answer ids', () => {
	it('keeps each Worker answer id as sent, and each definition answer as its id and text', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify(populatedWire), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		);

		const dataset = await getWorksiteDataset();
		const [worker] = dataset.workers;

		expect(worker.attributes).toEqual({ a1: ['x1', 'x2'] });
		expect(dataset.attributes[0].answers).toEqual([
			{ id: 'x1', value: 'x' },
			{ id: 'x2', value: 'y' }
		]);
	});
});

describe('refusing empty vocabulary entities in the dataset', () => {
	it('accepts a Worker with an empty email, phone and name', () => {
		const worker = {
			id: 'w1',
			name: '',
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: {},
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		};

		expect(decodeWorksiteDataset({ ...emptyDataset, workers: [worker] }).workers).toEqual([worker]);
	});
});

it('decodes a current definition without retired scope metadata', () => {
	const decoded = decodeWorksiteDataset({
		...emptyDataset,
		attributes: [
			{
				id: 'job',
				name: 'Job',
				kind: 'category',
				options: []
			}
		]
	});

	expect(decoded.attributes).toEqual([
		{
			id: 'job',
			name: 'Job',
			kind: 'category',
			answers: []
		}
	]);
	// AC14: a legacy definition that still carries the retired keys loses them at the
	// boundary; only the current contract reaches the UI.
	const legacy = decodeWorksiteDataset({
		...emptyDataset,
		attributes: [
			{
				id: 'job',
				name: 'Job',
				kind: 'category',
				scope: 'worker',
				inferenceEligible: true,
				options: []
			}
		]
	});
	expect(Object.keys(legacy.attributes[0]).sort()).toEqual(['answers', 'id', 'kind', 'name']);
});

describe('decoding answer select modes (ADR 0043)', () => {
	it('keeps a valid answer mode, and leaves an unmoded answer without one', () => {
		const dataset = decodeWorksiteDataset({
			...emptyDataset,
			attributes: [
				{
					id: 'role',
					name: 'Role',
					kind: 'category',
					options: [
						{ id: 'foh', value: 'Front of House', mode: 'multi' },
						{ id: 'server', value: 'Server', parentId: 'foh' }
					]
				}
			]
		});

		expect(dataset.attributes[0].answers).toEqual([
			{ id: 'foh', value: 'Front of House', mode: 'multi' },
			{ id: 'server', value: 'Server', parentId: 'foh' }
		]);
		expect(dataset.attributes[0].answers[1]).not.toHaveProperty('mode');
	});
});

describe('decoding answer Short forms (ADR 0046)', () => {
	const withOptions = (options: unknown[]) => ({
		...emptyDataset,
		attributes: [{ id: 'role', name: 'Role', kind: 'category', options }]
	});

	it('keeps a Short form and its origin', () => {
		const dataset = decodeWorksiteDataset(
			withOptions([
				{
					id: 'a',
					value: 'Customer Service',
					shortForm: 'Customer …',
					shortFormOrigin: 'generated'
				},
				{ id: 'b', value: 'Kitchen', shortForm: 'Kit', shortFormOrigin: 'edited' }
			])
		);

		expect(dataset.attributes[0].answers).toEqual([
			{ id: 'a', value: 'Customer Service', shortForm: 'Customer …', shortFormOrigin: 'generated' },
			{ id: 'b', value: 'Kitchen', shortForm: 'Kit', shortFormOrigin: 'edited' }
		]);
	});

	it('counts the 10-character limit in graphemes, not code units', () => {
		const family = '👨‍👩‍👧‍👦'.repeat(10);
		const dataset = decodeWorksiteDataset(
			withOptions([{ id: 'a', value: 'x', shortForm: family, shortFormOrigin: 'edited' }])
		);

		expect(dataset.attributes[0].answers[0].shortForm).toBe(family);
	});
});
