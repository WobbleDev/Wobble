import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '#lib/testing/http.ts';
import { getRuntimeInfo } from './runtime-api.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('Product gap 15 — runtime diagnostics', () => {
	it('reads the running build, platform, version and active schema', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				appVersion: '0.0.1',
				build: 'wobble-core 0.0.1 (debug)',
				platform: 'macOS · Apple silicon',
				schemaVersion: 17
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(getRuntimeInfo()).resolves.toEqual({
			appVersion: '0.0.1',
			build: 'wobble-core 0.0.1 (debug)',
			platform: 'macOS · Apple silicon',
			schemaVersion: 17
		});
		expect(fetchMock).toHaveBeenCalledWith('/api/runtime', expect.objectContaining({}));
	});
});
