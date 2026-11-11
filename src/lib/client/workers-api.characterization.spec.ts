/**
 * Pins the wire contract of every `workers-api.ts` call, ahead of splitting the module by
 * resource: the method, path and JSON body each one sends, the plain-words message it throws
 * when the core refuses without one, and the decoding of the drafts and merges it returns.
 * Synthetic names only; `fetch` is the scripted stub from `#lib/testing/http.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scriptFetch } from '#lib/testing/http.ts';
import {
	attributeWrites,
	createWorker,
	decodeDraft,
	deleteWorker,
	deleteWorkerDraft,
	deleteWorksite,
	editWorkerNote,
	getWorkerDraft,
	mergeWorkers,
	previewConfiguration,
	previewWorkerMerge,
	restoreWorkerField,
	saveAgitations,
	saveAttributes,
	saveLanguages,
	saveWorkerDraft,
	saveWorksiteName,
	suggestShortForms,
	undoWorkerMerge,
	updateWorkerAssessment,
	updateWorkerAttribute,
	updateWorkerLanguages
} from './workers-api.ts';

afterEach(() => vi.unstubAllGlobals());

const update = {
	name: 'Mary Wollstonecraft',
	email: 'mary@example.com',
	phone: '',
	assessment: 'Supporter' as const,
	attributes: {},
	agitations: [],
	languages: [],
	relationships: [],
	notes: []
};

type Case = {
	name: string;
	call: () => Promise<unknown>;
	method: string;
	path: string;
	body: unknown;
	refused: string;
};

// A refusal with no message of its own reads as the call's own fallback sentence.
const cases: Case[] = [
	{
		name: 'updateWorkerAttribute',
		call: () => updateWorkerAttribute('w 1', 'dept', 'front'),
		method: 'PATCH',
		path: '/api/workers/w%201',
		body: { attributeId: 'dept', value: 'front' },
		refused: 'Could not save attribute (HTTP 500).'
	},
	{
		name: 'updateWorkerAssessment',
		call: () => updateWorkerAssessment('w1', 'Leader'),
		method: 'PATCH',
		path: '/api/workers/w1',
		body: { field: 'assessment', value: 'Leader' },
		refused: 'Could not save assessment (HTTP 500).'
	},
	{
		name: 'updateWorkerLanguages',
		call: () => updateWorkerLanguages('w1', ['greek']),
		method: 'PATCH',
		path: '/api/workers/w1',
		body: { field: 'languages', value: ['greek'] },
		refused: 'Could not save languages (HTTP 500).'
	},
	{
		name: 'restoreWorkerField',
		call: () => restoreWorkerField('w1', 'phone', '555-0100'),
		method: 'PATCH',
		path: '/api/workers/w1',
		body: { field: 'phone', value: '555-0100', action: 'restore' },
		refused: 'Could not put the phone back (HTTP 500).'
	},
	{
		name: 'editWorkerNote',
		call: () => editWorkerNote('w1', { id: 'n1', text: 'Edited' } as never),
		method: 'PATCH',
		path: '/api/workers/w1',
		body: { field: 'notes', action: 'edit', value: { id: 'n1', text: 'Edited' } },
		refused: 'Could not save the Note (HTTP 500).'
	},
	{
		name: 'deleteWorker',
		call: () => deleteWorker('w1'),
		method: 'DELETE',
		path: '/api/workers/w1',
		body: undefined,
		refused: 'Could not delete worker (HTTP 500).'
	},
	{
		name: 'createWorker',
		call: () => createWorker('Mary Wollstonecraft', { dept: 'front' }),
		method: 'POST',
		path: '/api/workers',
		body: {
			name: 'Mary Wollstonecraft',
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: { dept: 'front' },
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		},
		refused: 'Could not add worker (HTTP 500).'
	},
	{
		name: 'getWorkerDraft',
		call: () => getWorkerDraft('new'),
		method: 'GET',
		path: '/api/worker-drafts/new',
		body: undefined,
		refused: 'Could not load the draft (HTTP 500).'
	},
	{
		name: 'saveWorkerDraft',
		call: () => saveWorkerDraft('w1', { update, pendingNote: { text: 'half a note' }, base: null }),
		method: 'PUT',
		path: '/api/worker-drafts/w1',
		body: { update, pendingNote: { text: 'half a note' }, base: null },
		refused: 'Could not save the draft (HTTP 500).'
	},
	{
		name: 'deleteWorkerDraft',
		call: () => deleteWorkerDraft('w1'),
		method: 'DELETE',
		path: '/api/worker-drafts/w1',
		body: undefined,
		refused: 'Could not discard the draft (HTTP 500).'
	},
	{
		name: 'saveAttributes',
		call: () =>
			saveAttributes([
				{
					id: 'dept',
					name: 'Department',
					kind: 'category',
					answers: [{ id: 'front', value: 'Front' }]
				}
			]),
		method: 'PUT',
		path: '/api/attributes',
		body: [
			{
				id: 'dept',
				name: 'Department',
				kind: 'category',
				options: [{ id: 'front', value: 'Front' }]
			}
		],
		refused: 'Could not save attributes (HTTP 500).'
	},
	{
		name: 'saveAgitations',
		call: () => saveAgitations([{ id: 'pay', text: 'Pay', mergedInto: 'wages' }]),
		method: 'PUT',
		path: '/api/agitations',
		body: [{ id: 'pay', text: 'Pay', mergedInto: 'wages' }],
		refused: 'Could not save agitations (HTTP 500).'
	},
	{
		name: 'saveLanguages',
		call: () => saveLanguages([{ id: 'greek', name: 'Greek' }]),
		method: 'PUT',
		path: '/api/languages',
		body: [{ id: 'greek', name: 'Greek' }],
		refused: 'Could not save languages (HTTP 500).'
	},
	{
		name: 'deleteWorksite',
		call: () => deleteWorksite(),
		method: 'DELETE',
		path: '/api/worksite',
		body: undefined,
		refused: 'Could not delete the worksite (HTTP 500).'
	},
	{
		name: 'saveWorksiteName',
		call: () => saveWorksiteName('Harbour Depot'),
		method: 'PUT',
		path: '/api/worksite',
		body: { name: 'Harbour Depot' },
		refused: 'Could not save the worksite name (HTTP 500).'
	},
	{
		name: 'previewConfiguration',
		call: () => previewConfiguration({ attributes: [], agitations: [], languages: [] }),
		method: 'POST',
		path: '/api/configuration/preview',
		body: { attributes: [], agitations: [], languages: [] },
		refused: 'Could not check these changes (HTTP 500).'
	},
	{
		name: 'suggestShortForms',
		call: () => suggestShortForms({ attributes: [], agitations: [], languages: [] }),
		method: 'POST',
		path: '/api/configuration/short-forms',
		body: { attributes: [], agitations: [], languages: [] },
		refused: 'Could not suggest Short forms (HTTP 500).'
	},
	{
		name: 'previewWorkerMerge',
		call: () => previewWorkerMerge('w1', 'w2'),
		method: 'POST',
		path: '/api/worker-merge/preview',
		body: { survivorId: 'w1', absorbedId: 'w2' },
		refused: 'Could not preview the merge (HTTP 500).'
	},
	{
		name: 'mergeWorkers',
		call: () =>
			mergeWorkers('w1', 'w2', 'digest', { scalars: { email: 'absorbed' }, attributes: {} }),
		method: 'POST',
		path: '/api/worker-merge',
		body: {
			survivorId: 'w1',
			absorbedId: 'w2',
			readSet: 'digest',
			decisions: { scalars: { email: 'absorbed' }, attributes: {} }
		},
		refused: 'Could not merge the workers (HTTP 500).'
	},
	{
		name: 'undoWorkerMerge',
		call: () => undoWorkerMerge('token-1'),
		method: 'POST',
		path: '/api/worker-merge/undo',
		body: { token: 'token-1' },
		refused: 'Could not undo the merge (HTTP 500).'
	}
];

describe('workers-api wire contract', () => {
	it.each(cases)('$name sends its method, path and body', async (testCase) => {
		const route = `${testCase.method} ${testCase.path}`;
		const { calls } = scriptFetch({
			[route]: () => ({ body: { worker: { ...update, id: 'w1' }, draft: null, preview: {} } })
		});
		// The reply shape does not matter here: a decoder may reject it after the request went out.
		await testCase.call().catch(() => undefined);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			method: testCase.method,
			path: testCase.path,
			body: testCase.body
		});
	});

	it.each(cases)('$name reads a message-less refusal as its own sentence', async (testCase) => {
		scriptFetch({ [`${testCase.method} ${testCase.path}`]: () => ({ status: 500, body: {} }) });
		await expect(testCase.call()).rejects.toThrow(testCase.refused);
	});

	it.each(cases)('$name shows the core message when the refusal carries one', async (testCase) => {
		scriptFetch({
			[`${testCase.method} ${testCase.path}`]: () => ({
				status: 409,
				body: { message: 'Core says no.' }
			})
		});
		await expect(testCase.call()).rejects.toThrow('Core says no.');
	});
});

describe('stored Worker drafts', () => {
	it('reads no draft as null', async () => {
		scriptFetch({ 'GET /api/worker-drafts/w1': () => ({ body: { draft: null } }) });
		await expect(getWorkerDraft('w1')).resolves.toBeNull();
		expect(decodeDraft(undefined)).toBeNull();
	});

	it('decodes a stored draft with its pending note, base and stamp', async () => {
		const draft = {
			update,
			pendingNote: { text: 'half a note' },
			base: { ...update, name: 'Mary Shelley' },
			updatedAt: '2026-01-02T03:04:05Z'
		};
		scriptFetch({ 'GET /api/worker-drafts/w1': () => ({ body: { draft } }) });
		await expect(getWorkerDraft('w1')).resolves.toEqual(draft);
		expect(decodeDraft({ ...draft, base: null })?.base).toBeNull();
	});
});

describe('attributeWrites', () => {
	it('renames answers to options and keeps merge markers and order', () => {
		expect(
			attributeWrites([
				{
					id: 'dept',
					name: 'Department',
					kind: 'tag',
					answers: [{ id: 'a', value: 'A' }, { id: 'b', value: 'B', mergedInto: 'a' } as never]
				}
			])
		).toEqual([
			{
				id: 'dept',
				name: 'Department',
				kind: 'tag',
				options: [
					{ id: 'a', value: 'A' },
					{ id: 'b', value: 'B', mergedInto: 'a' }
				]
			}
		]);
		expect(attributeWrites([])).toEqual([]);
	});
});

describe('merge replies', () => {
	it('hands back the core reply as it came, undecoded', async () => {
		const reply = { survivorId: 'w1', token: 'undo-1' };
		scriptFetch({ 'POST /api/worker-merge': () => ({ body: reply }) });
		await expect(
			mergeWorkers('w1', 'w2', 'digest', { scalars: {}, attributes: {} })
		).resolves.toEqual(reply);
	});
});
