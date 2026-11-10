import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditModel } from './edit-model.svelte.ts';
import { EDIT_STATUS_MS } from './edit-status.ts';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('EditModel draft registry', () => {
	it('flushes nothing, successfully, when no editor is open', async () => {
		const model = new EditModel();

		expect(await model.flushDrafts()).toBe(true);
	});

	it('commits every open editor before the selection moves', async () => {
		const model = new EditModel();
		const saved: string[] = [];
		model.registerDraft(async () => {
			saved.push('name');
			return true;
		});
		model.registerDraft(async () => {
			saved.push('email');
			return true;
		});

		expect(await model.flushDrafts()).toBe(true);
		expect(saved).toEqual(['name', 'email']);
	});

	it('is clean again once an editor closes: its commit is no longer asked', async () => {
		const model = new EditModel();
		let asked = 0;
		const unregister = model.registerDraft(async () => {
			asked += 1;
			return true;
		});

		unregister();

		expect(await model.flushDrafts()).toBe(true);
		expect(asked).toBe(0);
	});

	it('answers false when an editor refuses, and still flushes the others', async () => {
		const model = new EditModel();
		let otherSaved = false;
		model.registerDraft(async () => false);
		model.registerDraft(async () => {
			otherSaved = true;
			return true;
		});

		expect(await model.flushDrafts()).toBe(false);
		expect(otherSaved).toBe(true);
	});

	it('counts a commit that throws as refused', async () => {
		const model = new EditModel();
		model.registerDraft(async () => {
			throw new Error('write failed');
		});

		expect(await model.flushDrafts()).toBe(false);
	});

	it('keeps a refusing editor registered, so a retry asks the same commit again', async () => {
		const model = new EditModel();
		let attempts = 0;
		model.registerDraft(async () => {
			attempts += 1;
			return attempts > 1;
		});

		expect(await model.flushDrafts()).toBe(false);
		expect(await model.flushDrafts()).toBe(true);
		expect(attempts).toBe(2);
	});
});

describe('EditModel status', () => {
	it('shows a message and clears it after the status time', () => {
		const model = new EditModel();

		model.setStatus('Saved 3 workers');
		expect(model.status?.message).toBe('Saved 3 workers');

		vi.advanceTimersByTime(EDIT_STATUS_MS - 1);
		expect(model.status).not.toBeNull();
		vi.advanceTimersByTime(1);
		expect(model.status).toBeNull();
	});

	it('lets a newer message replace the older one and restart the clock', () => {
		const model = new EditModel();
		model.setStatus('First');
		vi.advanceTimersByTime(EDIT_STATUS_MS - 1);

		model.setStatus('Second');
		vi.advanceTimersByTime(EDIT_STATUS_MS - 1);

		expect(model.status?.message).toBe('Second');
	});

	it('runs Undo and then reports Undone', async () => {
		const model = new EditModel();
		let undone = 0;
		model.setStatus('Renamed', async () => {
			undone += 1;
		});

		await model.undo();

		expect(undone).toBe(1);
		expect(model.status?.message).toBe('Undone');
		expect(model.status?.undo).toBeNull();
		expect(model.undoPending).toBe(false);
	});

	it('keeps the message and its Undo when Undo fails, and a retry runs the same Undo', async () => {
		const model = new EditModel();
		let attempts = 0;
		model.setStatus('Renamed', async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('stopped');
		});

		await model.undo();

		expect(model.status?.message).toBe('Renamed');
		expect(model.error).not.toBe('');
		expect(model.undoPending).toBe(false);

		await model.undo();

		expect(attempts).toBe(2);
		expect(model.status?.message).toBe('Undone');
		expect(model.error).toBe('');
	});

	it('shows a failed write with no Undo', () => {
		const model = new EditModel();

		model.fail('Could not save');

		expect(model.status).toEqual({ message: 'Could not save', undo: null });
	});

	it('turns a report whose Undo stops part-way into a failed Undo that can be retried', async () => {
		const model = new EditModel();
		let calls = 0;
		model.report({
			message: 'Changed 2 workers',
			undo: async () => {
				calls += 1;
				return calls === 1
					? { restored: 1, total: 2, remaining: 1, error: null, refreshError: null }
					: { restored: 2, total: 2, remaining: 0, error: null, refreshError: null };
			}
		});

		await model.undo();
		expect(model.status?.message).toBe('Changed 2 workers');
		expect(model.error).not.toBe('');

		await model.undo();
		expect(model.status?.message).toBe('Undone');
	});

	it('counts New Worker requests', () => {
		const model = new EditModel();

		model.requestNewWorker();
		model.requestNewWorker();

		expect(model.newWorkerRequests).toBe(2);
	});
});
