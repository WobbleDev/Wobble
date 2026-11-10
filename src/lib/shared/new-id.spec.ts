import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from './new-id.ts';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('newId', () => {
	it('returns a UUID v4', () => {
		expect(newId()).toMatch(uuidV4);
	});

	it('falls back to getRandomValues when randomUUID is unavailable', () => {
		const getRandomValues = vi.fn((array: Uint8Array) => array.fill(0xab));
		vi.stubGlobal('crypto', { getRandomValues });

		expect(newId()).toBe('abababab-abab-4bab-abab-abababababab');
		expect(getRandomValues).toHaveBeenCalledOnce();
	});
});
