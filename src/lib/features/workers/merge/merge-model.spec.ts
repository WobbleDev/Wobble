import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/client/api-error.ts';
import type { MergePreview } from '#lib/client/workers-api.ts';
import { worker } from '#lib/testing/builders.ts';
import { createMergeModel, type MergeHost } from './merge-model.svelte.ts';

const ana = worker({ id: 'a', name: 'Ana' });
const anna = worker({ id: 'b', name: 'Anna' });

const clean: MergePreview = {
	readSet: 'digest-1',
	blockedDrafts: [],
	scalarConflicts: [],
	attributeConflicts: [],
	agitationIds: [],
	languageIds: [],
	relationshipIds: [],
	noteCount: 0,
	noteCollisions: 0
};
const conflicted: MergePreview = {
	...clean,
	scalarConflicts: [{ field: 'name', survivor: 'Ana', absorbed: 'Anna' }],
	attributeConflicts: [{ attributeId: 'dept', survivor: 'x', absorbed: 'y' }]
};

function host(overrides: Partial<MergeHost> = {}): MergeHost {
	return {
		preview: vi.fn().mockResolvedValue(clean),
		merge: vi.fn().mockResolvedValue({
			survivorId: 'a',
			absorbedId: 'b',
			undoToken: 'token-1',
			remappedNotes: 0
		}),
		undo: vi.fn().mockResolvedValue({ survivorId: 'a', absorbedId: 'b' }),
		refresh: vi.fn().mockResolvedValue(undefined),
		copy: {
			failed: 'failed',
			stale: 'stale',
			undoExpired: 'expired',
			undoFailed: 'undo failed',
			reloadFailed: 'reload failed'
		},
		...overrides
	};
}

describe('the merge model', () => {
	it('merges nothing until a surviving Worker is chosen', async () => {
		const model = createMergeModel(host(), [ana, anna]);
		expect(model.canMerge).toBe(false);
		expect(await model.commit()).toBeNull();

		await model.chooseSurvivor('b');
		expect(model.absorbedId).toBe('a');
		expect(model.canMerge).toBe(true);
	});

	it('needs one decision for every conflict before it can merge', async () => {
		const h = host({ preview: vi.fn().mockResolvedValue(conflicted) });
		const model = createMergeModel(h, [ana, anna]);
		await model.chooseSurvivor('a');
		expect(model.canMerge).toBe(false);

		model.decideScalar('name', 'absorbed');
		expect(model.canMerge).toBe(false);
		model.decideAttribute('dept', 'survivor');
		expect(model.canMerge).toBe(true);

		await model.commit();
		expect(h.merge).toHaveBeenCalledWith('a', 'b', 'digest-1', {
			scalars: { name: 'absorbed' },
			attributes: { dept: 'survivor' }
		});
	});

	it('blocks the merge while a Worker holds a draft', async () => {
		const h = host({
			preview: vi.fn().mockResolvedValue({ ...clean, blockedDrafts: ['b'] })
		});
		const model = createMergeModel(h, [ana, anna]);
		await model.chooseSurvivor('a');
		expect(model.blockedDrafts).toEqual(['b']);
		expect(model.canMerge).toBe(false);
	});

	it('drops its decisions and reloads the preview when the core says it is stale', async () => {
		const preview = vi
			.fn()
			.mockResolvedValueOnce(conflicted)
			.mockResolvedValueOnce({ ...conflicted, readSet: 'digest-2' });
		const h = host({
			preview,
			merge: vi.fn().mockRejectedValue(new ApiError(409, 'changed', 'merge_stale'))
		});
		const model = createMergeModel(h, [ana, anna]);
		await model.chooseSurvivor('a');
		model.decideScalar('name', 'survivor');
		model.decideAttribute('dept', 'survivor');

		expect(await model.commit()).toBeNull();
		expect(model.errorMessage).toBe('stale');
		expect(model.preview?.readSet).toBe('digest-2');
		expect(model.scalarChoice('name')).toBeUndefined();
		expect(model.canMerge).toBe(false);
	});

	it('answers an Undo that restores once and reloads the table', async () => {
		const h = host();
		const model = createMergeModel(h, [ana, anna]);
		await model.chooseSurvivor('a');
		const result = await model.commit();
		expect(result?.absorbedId).toBe('b');

		const undone = await result!.undo();
		expect(h.undo).toHaveBeenCalledWith('token-1');
		expect(undone).toMatchObject({ restored: 1, total: 1, remaining: 0, error: null });
		expect(h.refresh).toHaveBeenCalledTimes(2);
	});

	it('words an expired Undo and does not retry it', async () => {
		const h = host({
			undo: vi.fn().mockRejectedValue(new ApiError(409, 'gone', 'merge_undo_expired'))
		});
		const model = createMergeModel(h, [ana, anna]);
		await model.chooseSurvivor('a');
		const result = await model.commit();

		expect(await result!.undo()).toMatchObject({ restored: 0, remaining: 0, error: 'expired' });
		await result!.undo();
		expect(h.undo).toHaveBeenCalledTimes(1);
	});

	it('keeps a landed merge when the reload fails', async () => {
		const h = host({ refresh: vi.fn().mockRejectedValue(new Error('offline')) });
		const model = createMergeModel(h, [ana, anna]);
		await model.chooseSurvivor('a');
		expect(await model.commit()).not.toBeNull();
	});

	it('ignores a slow preview that lands after the survivor changed', async () => {
		let release: (value: MergePreview) => void = () => {};
		const preview = vi
			.fn()
			.mockImplementationOnce(() => new Promise<MergePreview>((resolve) => (release = resolve)))
			.mockResolvedValueOnce({ ...clean, readSet: 'second' });
		const model = createMergeModel(host({ preview }), [ana, anna]);
		const first = model.chooseSurvivor('a');
		await model.chooseSurvivor('b');
		release({ ...clean, readSet: 'first' });
		await first;
		expect(model.preview?.readSet).toBe('second');
	});
});
