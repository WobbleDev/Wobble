import { describe, expect, it } from 'vitest';
import { isSystemRegion, regionIdentity } from './region-identity.ts';

describe('regionIdentity', () => {
	it('keeps an ordinary answer id as the answer identity', () => {
		expect(regionIdentity('loc~Store A')).toBe('answer');
		expect(isSystemRegion('loc~Store A')).toBe(false);
	});

	it('names the Worker no-value system region', () => {
		expect(regionIdentity('')).toBe('no-value');
	});

	it('treats every system identity as system, and a remainder too', () => {
		expect(isSystemRegion('')).toBe(true);
		expect(isSystemRegion('#self:loc:loc~Central')).toBe(true);
		expect(regionIdentity('#self:loc:loc~Central')).toBe('remainder');
	});
});
