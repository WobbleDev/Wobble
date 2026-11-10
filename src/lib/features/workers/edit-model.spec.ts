import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditModel } from './edit-model.svelte.ts';
import { EDIT_STATUS_MS } from './edit-status.ts';

describe('EditModel status line', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('replaces the previous status with the next one', () => {
		const model = new EditModel();
		model.setStatus('Saved Ada Lovelace’s Assessment', async () => {});
		model.setStatus('Saved Languages for 2 workers');

		expect(model.status?.message).toBe('Saved Languages for 2 workers');
		expect(model.status?.undo).toBeNull();
	});

	it('clears itself after about eight seconds, and a new status restarts the timer', () => {
		const model = new EditModel();
		model.setStatus('First');
		vi.advanceTimersByTime(EDIT_STATUS_MS - 1000);
		model.setStatus('Second');
		vi.advanceTimersByTime(EDIT_STATUS_MS - 1000);
		expect(model.status?.message).toBe('Second');

		vi.advanceTimersByTime(1000);
		expect(model.status).toBeNull();
	});

	it('offers Undo only while the message is visible', async () => {
		const undo = vi.fn(async () => {});
		const model = new EditModel();
		model.setStatus('Saved', undo);
		vi.advanceTimersByTime(EDIT_STATUS_MS);

		await model.undo();
		expect(undo).not.toHaveBeenCalled();
	});

	it('Undo calls the inverse once, then says Undone, which also clears itself', async () => {
		const undo = vi.fn(async () => {});
		const model = new EditModel();
		model.setStatus('Saved', undo);

		await model.undo();
		await model.undo();
		expect(undo).toHaveBeenCalledTimes(1);
		expect(model.status).toEqual({ message: 'Undone', undo: null });

		vi.advanceTimersByTime(EDIT_STATUS_MS);
		expect(model.status).toBeNull();
	});

	it('a new edit after Undo replaces Undone', async () => {
		const model = new EditModel();
		model.setStatus('Saved', async () => {});
		await model.undo();
		model.setStatus('Saved Category for 1 worker', async () => {});

		expect(model.status?.message).toBe('Saved Category for 1 worker');
	});

	it('keeps Undo and says so in plain words when the inverse fails', async () => {
		const model = new EditModel();
		const undo = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValueOnce();
		model.setStatus('Saved', undo);

		await model.undo();
		expect(model.status?.undo).not.toBeNull();
		expect(model.error).toBe('Could not undo that change.');

		await model.undo();
		expect(model.status?.message).toBe('Undone');
		expect(model.error).toBe('');
	});

	it('does not announce Undone over an edit made while Undo was running', async () => {
		const model = new EditModel();
		let finish: () => void = () => {};
		model.setStatus(
			'Saved',
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);

		const pending = model.undo();
		model.setStatus('Saved Languages for 2 workers');
		finish();
		await pending;

		expect(model.status?.message).toBe('Saved Languages for 2 workers');
	});

	it('shows a failed write as a status with no Undo', () => {
		const model = new EditModel();
		model.setStatus('Saved', async () => {});
		model.fail('Could not save assessment.');

		expect(model.status).toEqual({ message: 'Could not save assessment.', undo: null });
		expect(model.error).toBe('');
	});
});

describe('EditModel New Worker request', () => {
	it('counts each request', () => {
		const model = new EditModel();
		model.requestNewWorker();
		model.requestNewWorker();

		expect(model.newWorkerRequests).toBe(2);
	});
});

describe('EditModel draft registry', () => {
	it('commits every registered draft', async () => {
		const model = new EditModel();
		const first = vi.fn(async () => true);
		const second = vi.fn(async () => true);
		model.registerDraft(first);
		model.registerDraft(second);

		await expect(model.flushDrafts()).resolves.toBe(true);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
	});

	it('does not commit a draft that has unregistered itself', async () => {
		const model = new EditModel();
		const commit = vi.fn(async () => true);
		const unregister = model.registerDraft(commit);
		unregister();

		await expect(model.flushDrafts()).resolves.toBe(true);
		expect(commit).not.toHaveBeenCalled();
	});

	it('commits the drafts it can and resolves false when one refuses', async () => {
		const model = new EditModel();
		const refused = vi.fn(async () => false);
		const accepted = vi.fn(async () => true);
		model.registerDraft(refused);
		model.registerDraft(accepted);

		await expect(model.flushDrafts()).resolves.toBe(false);
		expect(refused).toHaveBeenCalledTimes(1);
		expect(accepted).toHaveBeenCalledTimes(1);
	});
});
