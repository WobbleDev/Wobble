import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNDO_OFFER_MS, createUndoOffer } from './map-undo-offer.svelte.ts';

function offerOver(view: { value: string }) {
	return createUndoOffer<string>({
		capture: () => view.value,
		restore: (snapshot) => {
			view.value = snapshot;
		}
	});
}

describe('the map undo offer', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('holds the view as it was and puts it back on apply', () => {
		const view = { value: 'before' };
		const undo = offerOver(view);
		undo.offer('Filters cleared');
		view.value = 'after';
		expect(undo.current?.label).toBe('Filters cleared');
		undo.apply();
		expect(view.value).toBe('before');
		expect(undo.current).toBeNull();
	});

	it('lapses on its own after the offer time', () => {
		const undo = offerOver({ value: 'v' });
		undo.offer('Reset');
		vi.advanceTimersByTime(UNDO_OFFER_MS - 1);
		expect(undo.current).not.toBeNull();
		vi.advanceTimersByTime(1);
		expect(undo.current).toBeNull();
	});

	it('stays while paused and restarts the full time on resume', () => {
		const undo = offerOver({ value: 'v' });
		undo.offer('Reset');
		undo.pause();
		vi.advanceTimersByTime(UNDO_OFFER_MS * 3);
		expect(undo.current).not.toBeNull();
		undo.resume();
		vi.advanceTimersByTime(UNDO_OFFER_MS - 1);
		expect(undo.current).not.toBeNull();
		vi.advanceTimersByTime(1);
		expect(undo.current).toBeNull();
	});

	it('does not start a clock on resume when nothing is on offer', () => {
		const undo = offerOver({ value: 'v' });
		undo.resume();
		undo.offer('Reset');
		undo.dismiss();
		undo.resume();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('a newer offer replaces the older one and its clock', () => {
		const view = { value: 'a' };
		const undo = offerOver(view);
		undo.offer('First');
		vi.advanceTimersByTime(UNDO_OFFER_MS - 10);
		view.value = 'b';
		undo.offer('Second');
		vi.advanceTimersByTime(20);
		expect(undo.current?.label).toBe('Second');
		undo.apply();
		expect(view.value).toBe('b');
	});

	it('dispose leaves no timer behind', () => {
		const undo = offerOver({ value: 'v' });
		undo.offer('Reset');
		undo.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
});
