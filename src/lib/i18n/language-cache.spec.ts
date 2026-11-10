import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheLanguage, clearLanguage } from './language-cache.ts';

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key)
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the startup language hint', () => {
	it('remembers a confirmed preference and can be cleared after Restore', () => {
		const storage = memoryStorage();
		vi.stubGlobal('localStorage', storage);

		cacheLanguage('es-419', 'es-419');
		expect(storage.values.get('wobble.language')).toBe(
			JSON.stringify({ preference: 'es-419', appliedLocale: 'es-419' })
		);

		clearLanguage();
		expect(storage.values.has('wobble.language')).toBe(false);
	});

	it('does not throw when storage is denied', () => {
		vi.stubGlobal('localStorage', {
			removeItem() {
				throw new Error('denied');
			}
		});

		expect(() => clearLanguage()).not.toThrow();
	});
});
