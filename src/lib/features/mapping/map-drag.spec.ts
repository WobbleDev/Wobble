// @module-tag mapping
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapDrag } from './map-drag.svelte.ts';
import { regionKey } from './graph-layout.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function pointer(x: number, y: number, extra: Partial<PointerEvent> = {}) {
	return {
		clientX: x,
		clientY: y,
		button: 0,
		pointerType: 'mouse',
		stopPropagation: vi.fn(),
		...extra
	} as unknown as PointerEvent;
}

function setup(overrides: { isolated?: boolean; grouped?: boolean; spaceHeld?: boolean } = {}) {
	const commitWorker = vi.fn();
	const commitGroup = vi.fn();
	const host = {
		isolated: () => overrides.isolated ?? false,
		grouped: () => overrides.grouped ?? false,
		spaceHeld: () => overrides.spaceHeld ?? false,
		settled: () => ({
			positions: new Map([['a', { x: 10, y: 20 }]]),
			centres: new Map([
				['north', { x: 100, y: 200 }],
				['', { x: -50, y: -60 }]
			])
		}),
		// The map point is the client point, so offsets are easy to read.
		panZoom: () => ({
			toMapPoint: (event: PointerEvent) => ({ x: event.clientX, y: event.clientY })
		}),
		commitWorker,
		commitGroup
	};
	return { drag: createMapDrag(host), commitWorker, commitGroup };
}

describe('Worker drag', () => {
	it('a press that stays within 3px is a click: nothing drags and the click is not suppressed', () => {
		const { drag, commitWorker } = setup();
		drag.startWorker(pointer(100, 100), 'a');
		drag.move(pointer(103, 100));
		expect(drag.draggedWorker).toBeUndefined();
		drag.end();
		expect(commitWorker).not.toHaveBeenCalled();
		expect(drag.suppressesNodeClick()).toBe(false);
	});

	it('a press that travels 5px moves the dot by the pointer delta and suppresses the click once', () => {
		const { drag, commitWorker } = setup();
		const press = pointer(100, 100);
		drag.startWorker(press, 'a');
		expect(press.stopPropagation).toHaveBeenCalledOnce();

		drag.move(pointer(105, 100));
		expect(drag.draggedWorker).toEqual({ id: 'a', delta: { x: 5, y: 0 } });
		drag.move(pointer(140, 60));
		expect(drag.draggedWorker).toEqual({ id: 'a', delta: { x: 40, y: -40 } });

		drag.end();
		expect(commitWorker).toHaveBeenCalledOnce();
		expect(commitWorker).toHaveBeenCalledWith('a', { x: 40, y: -40 });
		expect(drag.draggedWorker).toBeUndefined();
		// The click that follows the release reads the suppression, and spends it.
		expect(drag.suppressesNodeClick()).toBe(true);
		expect(drag.suppressesNodeClick()).toBe(false);
	});

	it('clears the suppression on the next tick when no click follows the release', () => {
		const { drag } = setup();
		drag.startWorker(pointer(0, 0), 'a');
		drag.move(pointer(10, 0));
		drag.end();
		vi.runAllTimers();
		expect(drag.suppressesNodeClick()).toBe(false);
	});

	it.each([
		['Isolate', { isolated: true }, pointer(0, 0)],
		['Space held', { spaceHeld: true }, pointer(0, 0)],
		['a touch press', {}, pointer(0, 0, { pointerType: 'touch' })],
		['a secondary button', {}, pointer(0, 0, { button: 2 })]
	])('does not arm on %s', (_name, overrides, press) => {
		const { drag } = setup(overrides);
		drag.startWorker(press, 'a');
		drag.move(pointer(50, 50));
		expect(drag.draggedWorker).toBeUndefined();
	});
});

describe('group drag', () => {
	it('needs a grouped map and a known group', () => {
		const flat = setup({ grouped: false });
		flat.drag.startGroup(pointer(0, 0), 'north');
		flat.drag.move(pointer(50, 50));
		expect(flat.drag.draggedGroup).toBeUndefined();

		const grouped = setup({ grouped: true });
		grouped.drag.startGroup(pointer(0, 0), 'nowhere');
		grouped.drag.move(pointer(50, 50));
		expect(grouped.drag.draggedGroup).toBeUndefined();
	});

	it('moves the group by the pointer delta from the press', () => {
		const { drag, commitGroup } = setup({ grouped: true });
		drag.startGroup(pointer(105, 205), 'north');
		drag.move(pointer(107, 205));
		expect(drag.draggedGroup).toBeUndefined();

		drag.move(pointer(110, 205));
		expect(drag.draggedGroup).toEqual({ key: 'north', delta: { x: 5, y: 0 } });
		drag.move(pointer(205, 305));
		expect(drag.draggedGroup).toEqual({ key: 'north', delta: { x: 100, y: 100 } });

		drag.end();
		expect(commitGroup).toHaveBeenCalledOnce();
		expect(commitGroup).toHaveBeenCalledWith('north', { x: 100, y: 100 });
		expect(drag.draggedGroup).toBeUndefined();
	});

	it('reads the no-answer region as the empty key', () => {
		const { drag } = setup({ grouped: true });
		drag.startGroup(pointer(0, 0), regionKey(''));
		drag.move(pointer(20, 0));
		expect(drag.draggedGroup?.key).toBe('');
	});

	it('the release of a group drag does not dismiss the card, and the next click does', () => {
		const { drag } = setup({ grouped: true });
		drag.startGroup(pointer(100, 200), 'north');
		drag.move(pointer(150, 200));
		drag.end();
		drag.pressSurface(pointer(150, 200));
		expect(drag.dismissesOnClick(pointer(150, 200))).toBe(false);
		drag.pressSurface(pointer(150, 200));
		expect(drag.dismissesOnClick(pointer(150, 200))).toBe(true);
	});
});

describe('surface click', () => {
	it('dismisses when the press stayed within 4px, however shaky', () => {
		const { drag } = setup();
		drag.pressSurface(pointer(100, 100));
		expect(drag.dismissesOnClick(pointer(102, 103))).toBe(true);
	});

	it('does not dismiss after a pan of more than 4px', () => {
		const { drag } = setup();
		drag.pressSurface(pointer(100, 100));
		expect(drag.dismissesOnClick(pointer(105, 100))).toBe(false);
	});

	it('dismisses a click with no remembered press, and forgets a cancelled one', () => {
		const { drag } = setup();
		expect(drag.dismissesOnClick(pointer(0, 0))).toBe(true);
		drag.pressSurface(pointer(100, 100));
		drag.cancelSurfacePress();
		expect(drag.dismissesOnClick(pointer(300, 300))).toBe(true);
	});

	it('spends the press on the click that reads it', () => {
		const { drag } = setup();
		drag.pressSurface(pointer(100, 100));
		expect(drag.dismissesOnClick(pointer(300, 300))).toBe(false);
		expect(drag.dismissesOnClick(pointer(300, 300))).toBe(true);
	});
});
