import { afterEach, describe, expect, it, vi } from 'vitest';
import { dismissSplash, splashRemainingWait } from './dismiss-splash.ts';

describe('the start-up screen minimum', () => {
	it('waits out the rest of the one-second minimum when the app mounts early', () => {
		expect(splashRemainingWait(200)).toBe(800);
	});

	it('waits no further when exactly the minimum has passed', () => {
		expect(splashRemainingWait(1000)).toBe(0);
	});

	it('never waits when the app mounts after the minimum, so a slow start adds nothing', () => {
		expect(splashRemainingWait(1400)).toBe(0);
	});

	it('uses a one-second minimum by default', () => {
		expect(splashRemainingWait(0)).toBe(1000);
	});
});

describe('skipping the start-up screen', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('removes the screen synchronously when the e2e flag is set', () => {
		const remove = vi.fn();
		vi.stubGlobal('window', { wobbleSkipSplash: true });
		vi.stubGlobal('document', { getElementById: () => ({ remove, dataset: {} }) });
		dismissSplash();
		expect(remove).toHaveBeenCalledOnce();
	});
});
