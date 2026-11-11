import { describe, expect, it } from 'vitest';
import { fontsLoadedFor, loadFonts, type FontRequest } from './graph-text-metrics.ts';

const requests: FontRequest[] = [
	{ font: '500 12px "Public Sans Variable"', text: 'Zoë' },
	{ font: '400 11px "Roboto Mono Variable"', text: 'Front' }
];

/** A font set whose faces load only once `load` has been asked for them. */
function fakeFonts(failing: string[] = []) {
	const loaded = new Set<string>();
	return {
		check: (font: string) => loaded.has(font),
		load: async (font: string) => {
			if (failing.includes(font)) throw new Error('NetworkError');
			loaded.add(font);
			return [];
		}
	};
}

describe('fontsLoadedFor', () => {
	it('is false while a requested face has not been asked for, whatever the set reports overall', () => {
		expect(fontsLoadedFor(fakeFonts(), requests)).toBe(false);
	});
});

describe('loadFonts', () => {
	it('asks for every requested face and resolves true once all are in', async () => {
		const fonts = fakeFonts();
		expect(await loadFonts(fonts, requests, 1000)).toBe(true);
		expect(fontsLoadedFor(fonts, requests)).toBe(true);
	});

	it('resolves false, not rejected, when a face fails to load', async () => {
		const fonts = fakeFonts([requests[1].font]);
		expect(await loadFonts(fonts, requests, 1000)).toBe(false);
	});

	it('gives up after the timeout when a face never arrives', async () => {
		const fonts = { check: () => false, load: () => new Promise<never[]>(() => {}) };
		expect(await loadFonts(fonts, requests, 20)).toBe(false);
	});
});
