// @module-tag mapping
import { afterEach, expect, it, vi } from 'vitest';
import { afterMeasuredMapSurface } from './map-readiness.ts';

afterEach(() => vi.unstubAllGlobals());

function animationFrames() {
	const callbacks = new Map<number, FrameRequestCallback>();
	let nextId = 0;
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		callbacks.set(++nextId, callback);
		return nextId;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
	return () => {
		const pending = [...callbacks.values()];
		callbacks.clear();
		for (const callback of pending) callback(0);
	};
}

it('waits for a nonzero surface and matching SVG measurement before framing', () => {
	const tick = animationFrames();
	let surface = { width: 0, height: 0 };
	let svg = { width: 720, height: 520 };
	const frame = vi.fn();
	afterMeasuredMapSurface(() => ({ surface, svg }), frame);
	tick();
	expect(frame).not.toHaveBeenCalled();
	surface = { width: 359, height: 168 };
	tick();
	expect(frame).not.toHaveBeenCalled();
	svg = { width: 359, height: 168 };
	tick();
	expect(frame).toHaveBeenCalledOnce();
	tick();
	expect(frame).toHaveBeenCalledOnce();
});

it('cancels a pending measurement when its layout is replaced', () => {
	const tick = animationFrames();
	const frame = vi.fn();
	const cancel = afterMeasuredMapSurface(
		() => ({ surface: { width: 359, height: 168 }, svg: undefined }),
		frame
	);
	cancel();
	tick();
	expect(frame).not.toHaveBeenCalled();
});
