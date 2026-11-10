import { describe, expect, it, vi } from 'vitest';
import { createOverviewRootState } from './overview-root-state.svelte.ts';

/**
 * The root-state factory through a literal host: the root is a plain dataset, observers
 * record their callbacks, the colour-scheme query is a fake, and the effects are
 * collected and run by the spec the way the route's $effect would run them.
 */
function literalRoot(initial: Record<string, string | undefined> = {}, prefersDark = false) {
	const dataset: Record<string, string | undefined> = { ...initial };
	const observers: { callback: () => void; observed: unknown[]; disconnected: boolean }[] = [];
	const mediaListeners = new Set<() => void>();
	let matches = prefersDark;
	const media = {
		get matches() {
			return matches;
		},
		addEventListener: vi.fn((_type: 'change', listener: () => void) =>
			mediaListeners.add(listener)
		),
		removeEventListener: vi.fn((_type: 'change', listener: () => void) =>
			mediaListeners.delete(listener)
		)
	};
	const setups: (() => (() => void) | void)[] = [];
	const cleanups: (() => void)[] = [];
	const host = {
		root: { dataset },
		createObserver(callback: () => void) {
			const record = { callback, observed: [] as unknown[], disconnected: false };
			observers.push(record);
			return {
				observe: (target: unknown) => record.observed.push(target),
				disconnect: () => {
					record.disconnected = true;
				}
			};
		},
		media: vi.fn(() => media),
		effect: (setup: () => (() => void) | void) => {
			setups.push(setup);
		}
	};
	return {
		host,
		dataset,
		observers,
		setPrefersDark(next: boolean) {
			matches = next;
			for (const listener of mediaListeners) listener();
		},
		/** Runs the collected effects in order, as the route's effects would on mount. */
		flush() {
			for (const setup of setups) {
				const cleanup = setup();
				if (cleanup) cleanups.push(cleanup);
			}
		},
		dispose() {
			for (const cleanup of cleanups.splice(0)) cleanup();
		},
		media
	};
}

describe('createOverviewRootState', () => {
	it('reads enlarged text from the root, and follows the root attribute', () => {
		const root = literalRoot({ textSize: '125' });
		const state = createOverviewRootState(root.host);
		root.flush();
		expect(state.enlargedText).toBe(true);

		root.dataset.textSize = '100';
		root.observers[0]!.callback();
		expect(state.enlargedText).toBe(false);
	});

	it('treats only the 125 and 150 root sizes as enlarged', () => {
		const root = literalRoot({ textSize: '150' });
		const state = createOverviewRootState(root.host);
		root.flush();
		expect(state.enlargedText).toBe(true);
	});

	it('takes an explicit theme over the colour scheme and names the colour-blind palette', () => {
		const root = literalRoot({ theme: 'dark', assessmentPalette: 'colorblind' }, false);
		const state = createOverviewRootState(root.host);
		root.flush();
		expect(state.darkTheme).toBe(true);
		expect(state.colorblindPalette).toBe(true);
		expect(state.theme).toBe('dark');
		expect(state.palette).toBe('colorblind');
	});

	it('follows the colour scheme under the system theme, and re-reads on a change', () => {
		const root = literalRoot({ theme: 'system' }, false);
		const state = createOverviewRootState(root.host);
		root.flush();
		expect(state.darkTheme).toBe(false);

		root.setPrefersDark(true);
		expect(state.darkTheme).toBe(true);
	});

	it('observes only the attributes each reading depends on', () => {
		const root = literalRoot();
		createOverviewRootState(root.host);
		root.flush();
		const attributeWatchers = root.observers.map((observer) => observer.observed.length);
		expect(attributeWatchers).toEqual([1, 1]);
		expect(root.host.media).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
	});

	it('disconnects its observers and removes its colour-scheme listener on teardown', () => {
		const root = literalRoot();
		createOverviewRootState(root.host);
		root.flush();
		root.dispose();
		expect(root.observers.every((observer) => observer.disconnected)).toBe(true);
		expect(root.media.removeEventListener).toHaveBeenCalledOnce();
	});
});
