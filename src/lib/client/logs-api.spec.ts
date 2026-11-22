import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '#lib/testing/http.ts';
import { getRecentLogs } from './logs-api.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('reading the diagnostics log', () => {
	it('asks for the newest lines and returns them oldest first', async () => {
		const lines = ['2026-01-02T03:04:05Z INFO app_started version=0.0.1'];
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ available: true, lines }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(getRecentLogs(50)).resolves.toEqual({ available: true, lines });
		expect(fetchMock).toHaveBeenCalledWith('/api/logs?lines=50', { cache: 'no-store' });
	});

	it('rejects a body that is not a log', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ available: true, lines: [1, 2] }))
		);

		await expect(getRecentLogs()).rejects.toThrow('Log response was invalid.');
	});
});
