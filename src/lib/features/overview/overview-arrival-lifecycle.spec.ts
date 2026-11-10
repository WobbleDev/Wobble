import { describe, expect, it } from 'vitest';
import { createArrivalLifecycle } from './overview-arrival-lifecycle.ts';

describe('Overview arrival lifecycle', () => {
	it('claims the initial Worksite once and ignores same-Worksite refreshes', () => {
		const arrival = createArrivalLifecycle('A');
		expect(arrival.claim('wrong')).toBeNull();
		expect(arrival.claim('A')).toEqual({ generation: 1 });
		expect(arrival.claim('A')).toBeNull();
		expect(arrival.observe('A')).toBe(false);
		expect(arrival.pending).toBe(false);
		expect(arrival.generation).toBe(1);
	});

	it('arms each activation, including returning to an earlier Worksite', () => {
		const arrival = createArrivalLifecycle('A');
		expect(arrival.claim('A')).toEqual({ generation: 1 });
		expect(arrival.observe('B')).toBe(true);
		expect(arrival.claim('B')).toEqual({ generation: 2 });
		expect(arrival.observe('A')).toBe(true);
		expect(arrival.claim('A')).toEqual({ generation: 3 });
		expect(arrival.pending).toBe(false);
	});

	it('keeps an arrival armed while no Worksite exists, then arms the first activation', () => {
		const arrival = createArrivalLifecycle(null);
		expect(arrival.claim('A')).toBeNull();
		expect(arrival.observe(null)).toBe(false);
		expect(arrival.observe('A')).toBe(true);
		expect(arrival.claim('A')).toEqual({ generation: 1 });
	});
});
