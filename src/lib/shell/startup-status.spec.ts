import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/client/api-error.ts';
import { startupStatus } from './startup-status.ts';

describe('safe startup status', () => {
	it('preserves a useful HTTP error status without exposing diagnostic contents', () => {
		expect(
			startupStatus(
				new ApiError(503, 'Worker Jane at /private/roster.sqlite', 'secret-code', {
					passphrase: 'secret'
				})
			)
		).toBe(503);
	});
	it.each([
		undefined,
		null,
		'Worker Jane',
		new Error('/private/roster.sqlite'),
		{ status: 503 },
		new ApiError(200, 'secret'),
		new ApiError(NaN, 'secret')
	])('uses a safe fallback for unsupported errors', (value) => {
		expect(startupStatus(value)).toBe(500);
	});
});
