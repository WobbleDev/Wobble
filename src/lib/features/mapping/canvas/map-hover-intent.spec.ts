// @module-tag mapping
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHoverIntent, hoverIntentMs } from './map-hover-intent.svelte.ts';
import type { WorkerGraphNode } from './worker-relationship-map-model.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const node = (id: string) => ({ id, name: id }) as unknown as WorkerGraphNode;
const event = (name: string, pointerType = 'mouse') =>
	({ name, pointerType }) as unknown as PointerEvent;

function setup(state: { panning?: boolean; selectedId?: string } = {}) {
	const onHover = vi.fn();
	const tooltip = { show: vi.fn(), hide: vi.fn() };
	const hover = createHoverIntent({
		isPanning: () => state.panning ?? false,
		selectedId: () => state.selectedId ?? '',
		onHover
	});
	return { hover, tooltip, onHover, state };
}

describe('hover intent', () => {
	it('is 120ms', () => {
		expect(hoverIntentMs).toBe(120);
	});

	it('lifts the Worker on enter and drops the lift and the card on leave', () => {
		const { hover, tooltip, onHover } = setup();
		hover.enter(node('a'));
		expect(onHover).toHaveBeenLastCalledWith('a');
		hover.leave(tooltip);
		expect(onHover).toHaveBeenLastCalledWith('');
		expect(tooltip.hide).toHaveBeenCalledOnce();
	});

	it('shows the card only after the pointer has rested for the delay, with the latest event', () => {
		const { hover, tooltip } = setup();
		hover.move(event('first'), node('a'), tooltip);
		vi.advanceTimersByTime(119);
		expect(tooltip.show).not.toHaveBeenCalled();
		hover.move(event('second'), node('a'), tooltip);
		vi.advanceTimersByTime(1);
		expect(tooltip.show).toHaveBeenCalledOnce();
		expect(tooltip.show).toHaveBeenCalledWith(event('second'), node('a'));
	});

	it('follows the pointer without waiting once the card is up', () => {
		const { hover, tooltip } = setup();
		hover.move(event('first'), node('a'), tooltip);
		vi.advanceTimersByTime(120);
		hover.move(event('next'), node('b'), tooltip);
		expect(tooltip.show).toHaveBeenCalledTimes(2);
		expect(tooltip.show).toHaveBeenLastCalledWith(event('next'), node('b'));
	});

	it('waits again after the pointer leaves', () => {
		const { hover, tooltip } = setup();
		hover.move(event('first'), node('a'), tooltip);
		vi.advanceTimersByTime(120);
		hover.leave(tooltip);
		hover.move(event('again'), node('b'), tooltip);
		expect(tooltip.show).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(120);
		expect(tooltip.show).toHaveBeenCalledTimes(2);
	});

	it('shows nothing over the open Worker or during a pan, and hides the card', () => {
		const selected = setup({ selectedId: 'a' });
		selected.hover.move(event('m'), node('a'), selected.tooltip);
		vi.advanceTimersByTime(500);
		expect(selected.tooltip.show).not.toHaveBeenCalled();
		expect(selected.tooltip.hide).toHaveBeenCalledOnce();

		const panning = setup();
		panning.hover.move(event('m'), node('a'), panning.tooltip);
		panning.state.panning = true;
		vi.advanceTimersByTime(500);
		expect(panning.tooltip.show).not.toHaveBeenCalled();
	});

	it('cancel drops a pending card', () => {
		const { hover, tooltip } = setup();
		hover.move(event('m'), node('a'), tooltip);
		hover.cancel();
		vi.advanceTimersByTime(500);
		expect(tooltip.show).not.toHaveBeenCalled();
	});

	it('a press puts the card away and cancels the pending one', () => {
		const { hover, tooltip } = setup();
		hover.move(event('m'), node('a'), tooltip);
		hover.press(tooltip);
		vi.advanceTimersByTime(500);
		expect(tooltip.hide).toHaveBeenCalledOnce();
		expect(tooltip.show).not.toHaveBeenCalled();
	});

	it('a touch tap shows the card 30ms after the release; a mouse release shows nothing', () => {
		const { hover, tooltip } = setup();
		hover.up(event('mouse', 'mouse'), node('a'), tooltip);
		vi.advanceTimersByTime(100);
		expect(tooltip.show).not.toHaveBeenCalled();

		hover.up(event('tap', 'touch'), node('a'), tooltip);
		vi.advanceTimersByTime(29);
		expect(tooltip.show).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(tooltip.show).toHaveBeenCalledWith(event('tap', 'touch'), node('a'));
	});
});
