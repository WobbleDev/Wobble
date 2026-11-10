import { describe, expect, it } from 'vitest';
import { decodeBootStatus } from './boot-api.ts';

describe('storage lifecycle decoding', () => {
	it('keeps locked states explicit before any dataset is available', () => {
		expect(
			decodeBootStatus({
				state: 'locked',
				firstRun: true,
				legacyPlaintext: false,
				markerPending: false
			})
		).toEqual({ state: 'locked', firstRun: true, legacyPlaintext: false, markerPending: false });
		expect(
			decodeBootStatus({
				state: 'locked',
				firstRun: false,
				legacyPlaintext: true,
				markerPending: true
			})
		).toEqual({ state: 'locked', firstRun: false, legacyPlaintext: true, markerPending: true });
	});
	it.each([
		null,
		{},
		{ state: 'unknown' },
		{ state: 'open', encrypted: false },
		{ state: 'open' },
		{ state: 'locked' },
		{ state: 'locked', firstRun: 'true', legacyPlaintext: false, markerPending: false },
		{ state: 'failed', reason: 'Recovery required', recoveryPath: 12 }
	])('rejects malformed lifecycle responses: %j', (value) => {
		expect(() => decodeBootStatus(value)).toThrow();
	});
	it('projects only the public lifecycle fields', () => {
		expect(decodeBootStatus({ state: 'open', encrypted: true, unexpected: 'discarded' })).toEqual({
			state: 'open',
			encrypted: true
		});
		expect(
			decodeBootStatus({
				state: 'failed',
				reason: 'Recovery required',
				recoveryPath: '/installation/recovery',
				unexpected: 'discarded'
			})
		).toEqual({
			state: 'failed',
			reason: 'Recovery required',
			recoveryPath: '/installation/recovery'
		});
	});
	it('validates conversion paths before displaying receipts', () => {
		const receipt = { databasePath: '/owned/live.sqlite', recoveryPath: '/owned/recovery.sqlite' };
		expect(decodeBootStatus({ state: 'open', encrypted: true, conversion: receipt })).toEqual({
			state: 'open',
			encrypted: true,
			conversion: receipt
		});
		expect(() =>
			decodeBootStatus({ state: 'open', encrypted: true, conversion: { databasePath: 12 } })
		).toThrow();
	});
});
