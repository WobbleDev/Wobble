import { describe, expect, it } from 'vitest';
import { UnsavedChanges, type UnsavedIntent } from './unsaved-changes.svelte.ts';

function intent(run: () => void | Promise<void>): UnsavedIntent {
	return { title: 'Discard unsaved changes?', description: 'Leaving.', confirmLabel: 'Leave', run };
}

describe('UnsavedChanges', () => {
	it('runs the intent straight through when there is nothing to lose', async () => {
		const guard = new UnsavedChanges(() => false);
		let ran = 0;

		await guard.request(
			intent(() => {
				ran += 1;
			})
		);

		expect(ran).toBe(1);
		expect(guard.open).toBe(false);
	});

	it('holds the intent and shows the prompt while the draft is dirty', async () => {
		const guard = new UnsavedChanges(() => true);
		let ran = 0;

		await guard.request(
			intent(() => {
				ran += 1;
			})
		);

		expect(ran).toBe(0);
		expect(guard.open).toBe(true);
		expect(guard.confirmLabel).toBe('Leave');
	});

	it('Stay runs nothing and closes the prompt', async () => {
		const guard = new UnsavedChanges(() => true);
		let ran = 0;
		await guard.request(
			intent(() => {
				ran += 1;
			})
		);

		guard.stay();

		expect(ran).toBe(0);
		expect(guard.open).toBe(false);
		// The held intent is gone, not paused: a later Discard must not revive it.
		await guard.discard();
		expect(ran).toBe(0);
	});

	it('Discard runs the held intent once and closes the prompt', async () => {
		const guard = new UnsavedChanges(() => true);
		let ran = 0;
		await guard.request(
			intent(() => {
				ran += 1;
			})
		);

		await guard.discard();
		await guard.discard();

		expect(ran).toBe(1);
		expect(guard.open).toBe(false);
	});

	it('reports itself released only while a Discarded navigation is in flight', async () => {
		const guard = new UnsavedChanges(() => true);
		const seen: boolean[] = [];
		await guard.request(
			intent(async () => {
				seen.push(guard.released);
			})
		);

		expect(guard.released).toBe(false);
		await guard.discard();
		expect(seen).toEqual([true]);
		expect(guard.released).toBe(false);
	});

	it('keeps the release up when the released navigation throws', async () => {
		const guard = new UnsavedChanges(() => true);
		await guard.request(
			intent(() => {
				throw new Error('navigation refused');
			})
		);

		await expect(guard.discard()).rejects.toThrow('navigation refused');
		expect(guard.released).toBe(false);
	});

	it('drops a second request while the prompt is already up', async () => {
		const guard = new UnsavedChanges(() => true);
		let first = 0;
		let second = 0;
		await guard.request(
			intent(() => {
				first += 1;
			})
		);
		await guard.request(
			intent(() => {
				second += 1;
			})
		);

		expect(guard.confirmLabel).toBe('Leave');
		await guard.discard();
		expect(first).toBe(1);
		expect(second).toBe(0);
	});

	it('reads the dirty flag at request time rather than at construction', async () => {
		let dirty = false;
		const guard = new UnsavedChanges(() => dirty);
		let ran = 0;

		await guard.request(
			intent(() => {
				ran += 1;
			})
		);
		dirty = true;
		await guard.request(
			intent(() => {
				ran += 1;
			})
		);

		expect(ran).toBe(1);
		expect(guard.open).toBe(true);
	});
});
