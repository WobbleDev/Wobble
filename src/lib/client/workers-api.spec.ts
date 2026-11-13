import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '#lib/testing/http.ts';
import {
	addWorkerNote,
	addWorkerRelationship,
	assignWorkerAgitation,
	createAgitation,
	createLanguage,
	createWorker,
	deleteWorkerNote,
	importContacts,
	removeWorkerRelationship,
	restoreWorkerNote,
	saveConfigurationAttributes,
	saveWorksiteCommitteeGoal,
	unassignWorkerAgitation,
	updateWorkerField
} from './workers-api.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('importing contacts', () => {
	it('posts the accepted rows with the reviewed Attribute ids and returns row-to-id pairs', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				imported: 2,
				created: [
					{ row: 2, id: 'w1' },
					{ row: 5, id: 'w2' }
				]
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			importContacts(
				[
					{ row: 2, name: 'Ada' },
					{ row: 5, name: 'Grace' }
				],
				['a1']
			)
		).resolves.toEqual({
			imported: 2,
			created: [
				{ row: 2, id: 'w1' },
				{ row: 5, id: 'w2' }
			]
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/workers',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					contacts: [
						{ row: 2, name: 'Ada' },
						{ row: 5, name: 'Grace' }
					],
					attributeIds: ['a1']
				})
			})
		);
	});

	it('surfaces the server message when the request fails', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'Nope.' }, 400)));

		await expect(importContacts([{ row: 2, name: 'Ada' }], [])).rejects.toThrow('Nope.');
	});

	it('carries the stale-vocabulary code so the review can say what changed', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ message: 'Changed.', code: 'import_stale_vocabulary' }, 409)
				)
		);

		await expect(importContacts([{ row: 2, name: 'Ada' }], [])).rejects.toMatchObject({
			code: 'import_stale_vocabulary'
		});
	});
});

describe('creating a Worker with its Attributes', () => {
	it('posts the whole-record body with the chosen Attributes', async () => {
		const worker = {
			id: 'w1',
			name: 'Ada Lovelace',
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: {},
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		};
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worker }, 201));
		vi.stubGlobal('fetch', fetchMock);

		await expect(createWorker('Ada Lovelace', { 'a-department': 'd-front' })).resolves.toEqual({
			...worker,
			attributes: {}
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/workers',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					name: 'Ada Lovelace',
					email: '',
					phone: '',
					assessment: 'Unassessed',
					attributes: { 'a-department': 'd-front' },
					agitations: [],
					languages: [],
					relationships: [],
					notes: []
				})
			})
		);
	});
});

describe('creating an agitation', () => {
	it('posts the text and returns the agitation', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ agitation: { id: 'a1', text: 'Closed on Sundays' } }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(createAgitation('Closed on Sundays')).resolves.toEqual({
			id: 'a1',
			text: 'Closed on Sundays'
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/agitations',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('surfaces the server message when the create fails', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'Nope.' }, 400)));

		await expect(createAgitation('Closed on Sundays')).rejects.toThrow('Nope.');
	});
});

describe('creating a language', () => {
	it('posts the name and returns the language', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ language: { id: 'la1', name: 'Spanish' } }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(createLanguage('Spanish')).resolves.toEqual({ id: 'la1', name: 'Spanish' });
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/languages',
			expect.objectContaining({ method: 'POST' })
		);
	});
});

describe('saving the Configuration with its attribute move resolutions', () => {
	it('sends each acknowledged attribute move in the resolutions of the Save body', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
		vi.stubGlobal('fetch', fetchMock);

		await saveConfigurationAttributes({
			attributes: [],
			base: 'base-1',
			resolutions: {
				removedAnswers: [],
				removedAttributes: [],
				cardinality: [],
				attributeMoves: [{ sourceAttributeId: 'dept', answerId: 'packing' }],
				modeChanges: []
			}
		});

		const [path, init] = fetchMock.mock.calls[0];
		expect(path).toBe('/api/attributes');
		expect(JSON.parse(init.body).resolutions).toEqual({
			removedAnswers: [],
			removedAttributes: [],
			cardinality: [],
			attributeMoves: [{ sourceAttributeId: 'dept', answerId: 'packing' }],
			modeChanges: []
		});
	});
});

describe('saving the committee coverage target', () => {
	it('puts the target to the worksite endpoint', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worksite: {} }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(saveWorksiteCommitteeGoal(12)).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/worksite',
			expect.objectContaining({ method: 'PUT', body: JSON.stringify({ committeeTarget: 12 }) })
		);
	});
});

describe('updating one worker field', () => {
	const storedWorker = {
		id: 'w1',
		name: 'Ada Lovelace',
		email: 'ada@example.test',
		phone: '555-0100',
		assessment: 'Supporter',
		attributes: {},
		agitations: [],
		languages: [],
		relationships: [],
		notes: []
	};

	it('patches that field and returns the validated worker', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worker: storedWorker }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(updateWorkerField('w1', 'email', 'ada@example.test')).resolves.toEqual({
			...storedWorker,
			attributes: {}
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/workers/w1',
			expect.objectContaining({
				method: 'PATCH',
				body: JSON.stringify({ field: 'email', value: 'ada@example.test' })
			})
		);
	});

	it('surfaces the server message when the write is refused', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'Nope.' }, 400)));

		await expect(updateWorkerField('w1', 'name', '')).rejects.toThrow('Nope.');
	});
});

describe('adding and deleting a worker note', () => {
	const storedWorker = {
		id: 'w1',
		name: 'Ada Lovelace',
		email: '',
		phone: '',
		assessment: 'Supporter',
		attributes: {},
		agitations: [],
		languages: [],
		relationships: [],
		notes: [
			{
				id: 'n1',
				text: 'Called back',
				timestamp: '2026-10-07T09:00:00.000Z'
			}
		]
	};

	it('patches the note and returns the validated worker', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worker: storedWorker }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(addWorkerNote('w1', { text: 'Called back' })).resolves.toEqual({
			...storedWorker,
			attributes: {}
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/workers/w1',
			expect.objectContaining({
				method: 'PATCH',
				body: JSON.stringify({
					field: 'notes',
					action: 'add',
					value: { text: 'Called back' }
				})
			})
		);
	});

	it('surfaces the server message when the add is refused', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'Nope.' }, 400)));

		await expect(addWorkerNote('w1', { text: '  ' })).rejects.toThrow('Nope.');
	});

	it('deletes one note by id and returns the validated worker', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ worker: { ...storedWorker, notes: [] } }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(deleteWorkerNote('w1', 'n1')).resolves.toEqual({
			...storedWorker,
			notes: [],
			attributes: {}
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/workers/w1',
			expect.objectContaining({
				method: 'PATCH',
				body: JSON.stringify({ field: 'notes', action: 'delete', value: { id: 'n1' } })
			})
		);
	});

	it('sends the whole note back for a restore and returns the validated worker', async () => {
		const note = storedWorker.notes[0];
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worker: storedWorker }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(restoreWorkerNote('w1', note)).resolves.toEqual({
			...storedWorker,
			attributes: {}
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/workers/w1',
			expect.objectContaining({
				method: 'PATCH',
				body: JSON.stringify({ field: 'notes', action: 'restore', value: note })
			})
		);
	});
});

describe('adding and removing a relationship', () => {
	const storedWorker = {
		id: 'w1',
		name: 'Ada Lovelace',
		email: '',
		phone: '',
		assessment: 'Supporter',
		attributes: {},
		agitations: [],
		languages: [],
		relationships: ['w2'],
		notes: []
	};

	it('adds one pair by the other worker id and returns the validated worker', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worker: storedWorker }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(addWorkerRelationship('w1', 'w2')).resolves.toEqual({
			...storedWorker,
			attributes: {}
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/workers/w1',
			expect.objectContaining({
				method: 'PATCH',
				body: JSON.stringify({
					field: 'relationships',
					action: 'add',
					value: { id: 'w2' }
				})
			})
		);
	});

	it('removes one pair by the other worker id and returns the validated worker', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worker: storedWorker }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(removeWorkerRelationship('w1', 'w2')).resolves.toEqual({
			...storedWorker,
			attributes: {}
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/workers/w1',
			expect.objectContaining({
				method: 'PATCH',
				body: JSON.stringify({
					field: 'relationships',
					action: 'remove',
					value: { id: 'w2' }
				})
			})
		);
	});
});

describe('assigning and unassigning an agitation', () => {
	const storedWorker = {
		id: 'w1',
		name: 'Ada Lovelace',
		email: '',
		phone: '',
		assessment: 'Supporter',
		attributes: {},
		agitations: ['g1'],
		languages: [],
		relationships: [],
		notes: []
	};

	it('assigns one agitation by id and returns the validated worker', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worker: storedWorker }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(assignWorkerAgitation('w1', 'g1')).resolves.toEqual({
			...storedWorker,
			attributes: {}
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/workers/w1',
			expect.objectContaining({
				method: 'PATCH',
				body: JSON.stringify({ field: 'agitations', action: 'assign', value: { id: 'g1' } })
			})
		);
	});

	it('unassigns one agitation by id and returns the validated worker', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ worker: storedWorker }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(unassignWorkerAgitation('w1', 'g1')).resolves.toEqual({
			...storedWorker,
			attributes: {}
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/workers/w1',
			expect.objectContaining({
				method: 'PATCH',
				body: JSON.stringify({ field: 'agitations', action: 'unassign', value: { id: 'g1' } })
			})
		);
	});
});
