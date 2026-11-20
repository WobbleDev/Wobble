import { describe, expect, it } from 'vitest';
import {
	PLACEMENT_WINDOW_MS,
	createGridFocusReturn,
	type GridFocusEnvironment,
	type GridFocusHost
} from './grid-focus-return.ts';

/** A clock that advances one frame (16 ms) each time the placement asks for the next. */
function fakeEnvironment(overrides: Partial<GridFocusEnvironment> = {}) {
	let clock = 0;
	const calls: string[] = [];
	const env: GridFocusEnvironment = {
		settle: () => Promise.resolve(),
		frame: (step) => {
			clock += 16;
			step();
		},
		now: () => clock,
		row: () => null,
		cell: () => null,
		focusLost: () => true,
		focusSearch: () => void calls.push('search'),
		focusNewWorkerTrigger: () => void calls.push('new-worker'),
		...overrides
	};
	return { env, calls };
}

function host(rows: string[], focused: [string, string | null][]): GridFocusHost {
	return {
		viewport: () => null,
		rows: () => rows.map((id) => ({ id })),
		activeCell: () => (rows[0] ? { workerId: rows[0], columnId: 'name' } : null),
		isMobile: () => false,
		focusCell: (workerId, columnId) => {
			focused.push([workerId, columnId]);
			return Promise.resolve();
		}
	};
}

describe('grid focus return after a removal', () => {
	it('lands on the row that took the deleted Worker place', async () => {
		const focused: [string, string | null][] = [];
		const { env } = fakeEnvironment();
		const flow = createGridFocusReturn(host(['a', 'b', 'c'], focused), env);
		flow.noteRemoval('b');
		await flow.afterRemoval();
		expect(focused[0]).toEqual(['b', 'name']);
	});

	it('clamps to the last row when the deleted Worker was last', async () => {
		const focused: [string, string | null][] = [];
		const { env } = fakeEnvironment();
		const rows = ['a', 'b', 'c'];
		const flow = createGridFocusReturn(host(rows, focused), env);
		flow.noteRemoval('c');
		rows.pop();
		await flow.afterRemoval();
		expect(focused[0]).toEqual(['b', 'name']);
	});

	it('hands the empty table to its New Worker control', async () => {
		const focused: [string, string | null][] = [];
		const { env, calls } = fakeEnvironment();
		const flow = createGridFocusReturn(host([], focused), env);
		await flow.afterRemoval();
		expect(focused).toEqual([]);
		expect(calls[0]).toBe('new-worker');
	});

	it('never steals a focus that is not lost, and stops after its window', async () => {
		const focused: [string, string | null][] = [];
		let frames = 0;
		const { env } = fakeEnvironment({ focusLost: () => false });
		const counting = { ...env, frame: (step: () => void) => (frames++, env.frame(step)) };
		const flow = createGridFocusReturn(host(['a'], focused), counting);
		await flow.afterRemoval();
		expect(focused).toEqual([]);
		expect(frames).toBeGreaterThan(1);
		expect(frames).toBeLessThanOrEqual(Math.ceil(PLACEMENT_WINDOW_MS / 16) + 1);
	});
});

describe('grid focus return after the record card closes', () => {
	it('falls back to the filter bar when neither row is mounted', async () => {
		const { env, calls } = fakeEnvironment();
		const flow = createGridFocusReturn(host(['a'], []), env);
		await flow.afterClose('a', null);
		expect(calls).toEqual(['search']);
	});
});
