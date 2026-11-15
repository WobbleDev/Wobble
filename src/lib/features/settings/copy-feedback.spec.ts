import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const copyText = vi.fn(async () => {});
vi.mock('./copy-text.ts', () => ({ copyText }));

const { CopyFeedback } = await import('./copy-feedback.svelte.ts');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('CopyFeedback', () => {
	it('shows Copied for 1.6 s', async () => {
		const feedback = new CopyFeedback();
		await feedback.copy('x');
		expect(feedback.copied).toBe(true);
		vi.advanceTimersByTime(1600);
		expect(feedback.copied).toBe(false);
	});

	it('a second click restarts the window instead of ending it early', async () => {
		const feedback = new CopyFeedback();
		await feedback.copy('x');
		vi.advanceTimersByTime(1000);
		await feedback.copy('x');
		vi.advanceTimersByTime(1000);
		expect(feedback.copied).toBe(true);
		vi.advanceTimersByTime(600);
		expect(feedback.copied).toBe(false);
	});

	it('dispose clears the pending reset', async () => {
		const feedback = new CopyFeedback();
		await feedback.copy('x');
		feedback.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
});
