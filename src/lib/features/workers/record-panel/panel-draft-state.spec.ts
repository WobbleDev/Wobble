import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Worker } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import { scriptFetch, type ScriptedReply } from '#lib/testing/http.ts';
import type { WorkerDraft, WorkerDraftInput } from '#lib/client/workers-api.ts';
import { PanelDraftState } from './panel-draft-state.svelte.ts';

const worker = (extra: Partial<Worker> = {}) =>
	baseWorker({
		name: 'Ada Lovelace',
		email: 'ada@example.test',
		assessment: 'Supporter',
		notes: [{ id: 'n1', text: 'Old', timestamp: '2024-01-01T09:00:00.000Z' }],
		...extra
	});

/** The record as a stored draft's `base`: the Worker as the whole-record update shape. */
const base: WorkerDraftInput['base'] = {
	name: 'Ada Lovelace',
	email: 'ada@example.test',
	phone: '',
	assessment: 'Supporter',
	attributes: {},
	agitations: [],
	languages: [],
	relationships: [],
	notes: [{ id: 'n1', text: 'Old', timestamp: '2024-01-01T09:00:00.000Z' }]
};

function storedDraft(overrides: Partial<WorkerDraft> = {}): WorkerDraft {
	return {
		update: { ...base!, name: 'Ada L.' },
		pendingNote: { text: '' },
		base,
		updatedAt: '2026-10-20T08:00:00.000Z',
		...overrides
	};
}

/** The reply the draft read route answers: a draft, JSON-encoded the way the core sends it. */
function draftReply(draft: WorkerDraft | null): ScriptedReply {
	return { body: { draft } };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('PanelDraftState', () => {
	it('holds no open editors on a fresh panel', () => {
		const state = new PanelDraftState();

		expect(state.open).toEqual({ noteEdits: {}, attributes: {} });
		expect(state.ready).toBe(false);
	});

	it('is back to no open editors when every edit is reverted', () => {
		const state = new PanelDraftState();

		state.setField('name', 'Grace');
		state.setComposer({ text: 'Half a note' });
		state.setNoteEdit('n1', { text: 'Edited' });
		expect(state.open).toEqual({
			name: 'Grace',
			composer: { text: 'Half a note' },
			noteEdits: { n1: { text: 'Edited' } },
			attributes: {}
		});

		state.setField('name', undefined);
		state.setComposer(undefined);
		state.setNoteEdit('n1', undefined);

		expect(state.open).toEqual({ noteEdits: {}, attributes: {} });
	});

	it('reopens the editors a stored draft changed, and says when it was taken', async () => {
		const { calls } = scriptFetch({
			'GET /api/worker-drafts/w1': () =>
				draftReply(storedDraft({ pendingNote: { text: 'Call back' } }))
		});
		const state = new PanelDraftState();

		await state.load(worker(), []);

		expect(calls).toContainEqual({ method: 'GET', path: '/api/worker-drafts/w1', body: undefined });
		expect(state.restored).toEqual({
			name: 'Ada L.',
			composer: { text: 'Call back' },
			noteEdits: {},
			attributes: {}
		});
		expect(state.restoredAt).toBe('2026-10-20T08:00:00.000Z');
		expect(state.baseChanged).toBe(false);
		expect(state.stored).toBe(true);
		expect(state.ready).toBe(true);
		expect(state.restoreRevision).toBe(1);
	});

	it('flags a stored draft whose record moved on since it was taken', async () => {
		scriptFetch({ 'GET /api/worker-drafts/w1': () => draftReply(storedDraft()) });
		const state = new PanelDraftState();

		await state.load(worker({ phone: '555-0100' }), []);

		expect(state.baseChanged).toBe(true);
	});

	it('forgets a stored draft that reopens nothing', async () => {
		const { calls } = scriptFetch({
			'GET /api/worker-drafts/w1': () => draftReply(storedDraft({ update: { ...base! } })),
			'DELETE /api/worker-drafts/w1': () => ({})
		});
		const state = new PanelDraftState();

		await state.load(worker(), []);

		expect(calls).toContainEqual({
			method: 'DELETE',
			path: '/api/worker-drafts/w1',
			body: undefined
		});
		expect(state.restored).toEqual({ noteEdits: {}, attributes: {} });
		expect(state.stored).toBe(false);
		expect(state.ready).toBe(true);
	});

	it('still shows the record when the stored draft cannot be read', async () => {
		scriptFetch({
			'GET /api/worker-drafts/w1': () => {
				throw new Error('unreadable');
			}
		});
		const state = new PanelDraftState();

		await state.load(worker(), []);

		expect(state.ready).toBe(true);
		expect(state.stored).toBe(false);
		expect(state.restored).toEqual({ noteEdits: {}, attributes: {} });
	});

	it('is ready at once with no Worker selected', async () => {
		const { calls } = scriptFetch({});
		const state = new PanelDraftState();

		await state.load(null, []);

		expect(state.ready).toBe(true);
		expect(calls).toEqual([]);
	});

	it('drops a late stored draft for a Worker the panel has since left', async () => {
		let release: (reply: ScriptedReply) => void = () => {};
		const { calls } = scriptFetch({
			'GET /api/worker-drafts/w1': () =>
				new Promise<ScriptedReply>((resolve) => {
					release = resolve;
				}),
			'GET /api/worker-drafts/w2': () => draftReply(null)
		});
		const state = new PanelDraftState();
		const first = state.load(worker(), []);

		const second = state.load(worker({ id: 'w2', name: 'Grace' }), []);
		release(draftReply(storedDraft()));
		await Promise.all([first, second]);

		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			'GET /api/worker-drafts/w1',
			'GET /api/worker-drafts/w2'
		]);
		expect(state.workerId).toBe('w2');
		expect(state.restored).toEqual({ noteEdits: {}, attributes: {} });
		expect(state.stored).toBe(false);
	});

	it('Discard forgets the stored draft and closes what it reopened', async () => {
		const { calls } = scriptFetch({
			'GET /api/worker-drafts/w1': () => draftReply(storedDraft()),
			'DELETE /api/worker-drafts/w1': () => ({})
		});
		const state = new PanelDraftState();
		await state.load(worker(), []);

		await state.discard();

		expect(calls).toContainEqual({
			method: 'DELETE',
			path: '/api/worker-drafts/w1',
			body: undefined
		});
		expect(state.restored).toEqual({ noteEdits: {}, attributes: {} });
		expect(state.restoredAt).toBeNull();
		expect(state.stored).toBe(false);
	});
});
