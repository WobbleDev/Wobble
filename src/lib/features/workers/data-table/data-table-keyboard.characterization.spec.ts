/**
 * Pins the Workers table's keyboard `move` and the action state as they behave today, ahead of
 * the data-table split. Specced through the factories with literal hosts (no table, no DOM).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDataTableActionState } from './data-table-action-state.svelte.ts';
import { createWorkersKeyboard, type WorkersKeyboardHost } from './data-table-keyboard.svelte.ts';

beforeEach(() => {
	vi.stubGlobal('CSS', { escape: (value: string) => value });
	vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
		callback();
		return 0;
	});
});

afterEach(() => vi.unstubAllGlobals());

function setup(
	options: { grid?: boolean; creating?: boolean; flush?: boolean; range?: boolean } = {}
) {
	const calls: string[] = [];
	const ids = ['ada', 'bob', 'cyd', 'dee'];
	const focused: string[] = [];
	const cell = { focus: () => focused.push('cell'), scrollIntoView: vi.fn() };
	const row = {
		focus: () => focused.push('row'),
		scrollIntoView: vi.fn(),
		querySelector: () => cell
	};
	const viewport = { querySelector: () => row } as unknown as HTMLElement;
	const host: WorkersKeyboardHost = {
		rowIds: () => ids,
		viewport: () => viewport,
		scrollToRow: (index) => calls.push(`scroll:${index}`),
		flushDrafts: async () => {
			calls.push('flush');
			return options.flush ?? true;
		},
		selection: {
			liveSelection: ['seed'],
			setKeyboardRange: async (range: string[], before: string[]) => {
				calls.push(`range:${range.join(',')}|${before.join(',')}`);
				return options.range ?? true;
			}
		} as never,
		creating: () => options.creating ?? false,
		isGrid: () => options.grid ?? true,
		currentColumnId: () => 'name',
		select: (id) => calls.push(`select:${id}`),
		activate: (id, column) => calls.push(`activate:${id}:${column}`)
	};
	return { keyboard: createWorkersKeyboard(host), calls, focused, host };
}

describe('workers keyboard move', () => {
	it('selects the next row, activates the kept column and focuses its cell', async () => {
		const { keyboard, calls, focused } = setup();
		await keyboard.move('ada', 1);
		expect(calls).toEqual(['flush', 'select:bob', 'activate:bob:name', 'scroll:1']);
		expect(focused).toEqual(['cell']);
		expect(keyboard.navigating).toBe(true);
	});

	it('moves to a named column, and to the last row on a boundary move', async () => {
		const { keyboard, calls } = setup();
		await keyboard.move('ada', 1, 'languages', false, true);
		expect(calls).toContain('select:dee');
		expect(calls).toContain('activate:dee:languages');
	});

	it('focuses the row itself on the phone list, with no active cell', async () => {
		const { keyboard, calls, focused } = setup({ grid: false });
		await keyboard.move('bob', -1);
		expect(calls).toEqual(['flush', 'select:ada', 'scroll:0']);
		expect(focused).toEqual(['row']);
	});

	it('does nothing past either end, but still marks the keyboard as driving', async () => {
		const { keyboard, calls } = setup();
		await keyboard.move('ada', -1);
		await keyboard.move('dee', 1);
		expect(calls).toEqual([]);
		expect(keyboard.navigating).toBe(true);
	});

	it('ignores a move while the New Worker placeholder is open', async () => {
		const { keyboard, calls } = setup({ creating: true });
		await keyboard.move('ada', 1);
		expect(calls).toEqual([]);
		expect(keyboard.navigating).toBe(false);
	});

	it('stops when a draft refuses to save', async () => {
		const { keyboard, calls } = setup({ flush: false });
		await keyboard.move('ada', 1);
		expect(calls).toEqual(['flush']);
	});

	it('extends a checked range from the anchor and keeps what was checked before it', async () => {
		const { keyboard, calls } = setup();
		await keyboard.move('ada', 1, undefined, true);
		await keyboard.move('bob', 1, undefined, true);
		expect(calls.filter((call) => call.startsWith('range:'))).toEqual([
			'range:ada,bob|seed',
			'range:ada,bob,cyd|seed'
		]);
		expect(keyboard.endRange()).toBe(true);
		expect(keyboard.endRange()).toBe(false);
	});

	it('leaves the selection where it was when the range is refused', async () => {
		const { keyboard, calls } = setup({ range: false });
		await keyboard.move('ada', 1, undefined, true);
		expect(calls).toEqual(['flush', 'range:ada,bob|seed']);
	});

	it('ends an open range on a plain move', async () => {
		const { keyboard } = setup();
		await keyboard.move('ada', 1, undefined, true);
		await keyboard.move('bob', 1);
		expect(keyboard.endRange()).toBe(false);
	});

	it('does not scroll for a row that is not in the list', async () => {
		const { keyboard, calls } = setup();
		await keyboard.focusCell('nobody', 'name');
		expect(calls).toEqual([]);
	});

	it('gives up quietly when the row never mounts', async () => {
		const { keyboard, calls, host } = setup();
		host.viewport = () => null;
		await keyboard.focusCell('bob', 'name');
		expect(calls).toEqual(['scroll:1']);
	});

	it('lets the pointer clear the navigating flag', () => {
		const { keyboard } = setup();
		keyboard.setNavigating(true);
		expect(keyboard.navigating).toBe(true);
		keyboard.setNavigating(false);
		expect(keyboard.navigating).toBe(false);
	});
});

describe('data table action state', () => {
	it('runs an action, holding pending only while it runs', async () => {
		const state = createDataTableActionState();
		let release = () => {};
		const running = state.run(
			() => new Promise<void>((resolve) => (release = resolve)),
			'fallback'
		);
		expect(state.pending).toBe(true);
		release();
		expect(await running).toBe(true);
		expect(state.pending).toBe(false);
		expect(state.errorMessage).toBe('');
	});

	it('refuses a second action while one is in flight', async () => {
		const state = createDataTableActionState();
		let release = () => {};
		const first = state.run(() => new Promise<void>((resolve) => (release = resolve)), 'x');
		let ran = false;
		expect(
			await state.run(async () => {
				ran = true;
			}, 'x')
		).toBe(false);
		expect(ran).toBe(false);
		release();
		await first;
	});

	it('keeps the failure message, or the fallback for a non-Error throw, and clears it on the next run', async () => {
		const state = createDataTableActionState();
		expect(await state.run(() => Promise.reject(new Error('Disk full')), 'fallback')).toBe(false);
		expect(state.errorMessage).toBe('Disk full');
		expect(await state.run(() => Promise.reject('nope'), 'fallback')).toBe(false);
		expect(state.errorMessage).toBe('fallback');
		expect(await state.run(async () => {}, 'fallback')).toBe(true);
		expect(state.errorMessage).toBe('');
		state.setError('manual');
		expect(state.errorMessage).toBe('manual');
		state.clearError();
		expect(state.errorMessage).toBe('');
		expect(state.pending).toBe(false);
	});
});
