import { describe, expect, it, vi } from 'vitest';
import {
	isEnlargedText,
	readRootTheme,
	watchRootAttributes,
	type RootMediaLike,
	type RootObserverLike
} from './overview-root-attributes.ts';

function literalHost(matches = false) {
	const observed: { target: unknown; options: unknown }[] = [];
	let callback: (() => void) | undefined;
	const observer: RootObserverLike = {
		observe: vi.fn((target, options) => observed.push({ target, options })),
		disconnect: vi.fn()
	};
	const listeners = new Set<() => void>();
	const media: RootMediaLike = {
		matches,
		addEventListener: vi.fn((_type, listener) => listeners.add(listener)),
		removeEventListener: vi.fn((_type, listener) => listeners.delete(listener))
	};
	const root = { id: 'html' };
	return {
		host: {
			root,
			createObserver(cb: () => void) {
				callback = cb;
				return observer;
			},
			media
		},
		observer,
		observed,
		media,
		listeners,
		fire: () => callback?.(),
		root
	};
}

describe('watchRootAttributes', () => {
	it('reads once up front, observes the attributes, and reads again on each change', () => {
		const h = literalHost();
		const read = vi.fn();
		watchRootAttributes(h.host, ['data-theme', 'class'], read);
		expect(read).toHaveBeenCalledTimes(1);
		expect(h.observed).toEqual([
			{ target: h.root, options: { attributes: true, attributeFilter: ['data-theme', 'class'] } }
		]);
		h.fire();
		expect(read).toHaveBeenCalledTimes(2);
	});

	it('reads again on a colour-scheme change when a media query is given', () => {
		const h = literalHost();
		const read = vi.fn();
		watchRootAttributes(h.host, ['data-theme'], read);
		expect(h.listeners.size).toBe(1);
		for (const listener of h.listeners) listener();
		expect(read).toHaveBeenCalledTimes(2);
	});

	it('removes both listeners on cleanup', () => {
		const h = literalHost();
		const cleanup = watchRootAttributes(h.host, ['data-text-size'], () => {});
		cleanup();
		expect(h.observer.disconnect).toHaveBeenCalledOnce();
		expect(h.listeners.size).toBe(0);
	});

	it('works without a media query', () => {
		const h = literalHost();
		const host = { root: h.root, createObserver: h.host.createObserver };
		const read = vi.fn();
		const cleanup = watchRootAttributes(host, ['data-text-size'], read);
		expect(read).toHaveBeenCalledOnce();
		expect(() => cleanup()).not.toThrow();
		expect(h.media.removeEventListener).not.toHaveBeenCalled();
	});
});

describe('isEnlargedText', () => {
	it('is true only for the enlarged root sizes', () => {
		expect(isEnlargedText('125')).toBe(true);
		expect(isEnlargedText('150')).toBe(true);
		expect(isEnlargedText('100')).toBe(false);
		expect(isEnlargedText(undefined)).toBe(false);
	});
});

describe('readRootTheme', () => {
	it('follows the colour scheme under the system theme', () => {
		expect(readRootTheme(undefined, undefined, true).darkTheme).toBe(true);
		expect(readRootTheme('system', undefined, false).darkTheme).toBe(false);
	});

	it('takes an explicit theme over the colour scheme', () => {
		expect(readRootTheme('dark', undefined, false).darkTheme).toBe(true);
		expect(readRootTheme('light', undefined, true).darkTheme).toBe(false);
	});

	it('names the colour-blind palette from the root', () => {
		expect(readRootTheme('light', 'colorblind', false).colorblindPalette).toBe(true);
		expect(readRootTheme('light', 'standard', false).colorblindPalette).toBe(false);
	});
});
