import { describe, expect, it } from 'vitest';
import { createEntranceAnimationLifecycle } from './overview-entrance-animation-lifecycle.ts';

describe('Overview entrance animation lifecycle', () => {
	it('claims the initial Worksite once and ignores same-Worksite refreshes', () => {
		const entranceAnimation = createEntranceAnimationLifecycle('A');
		expect(entranceAnimation.claim('wrong')).toBeNull();
		expect(entranceAnimation.claim('A')).toEqual({ generation: 1 });
		expect(entranceAnimation.claim('A')).toBeNull();
		expect(entranceAnimation.observe('A')).toBe(false);
		expect(entranceAnimation.pending).toBe(false);
		expect(entranceAnimation.generation).toBe(1);
	});

	it('arms each activation, including returning to an earlier Worksite', () => {
		const entranceAnimation = createEntranceAnimationLifecycle('A');
		expect(entranceAnimation.claim('A')).toEqual({ generation: 1 });
		expect(entranceAnimation.observe('B')).toBe(true);
		expect(entranceAnimation.claim('B')).toEqual({ generation: 2 });
		expect(entranceAnimation.observe('A')).toBe(true);
		expect(entranceAnimation.claim('A')).toEqual({ generation: 3 });
		expect(entranceAnimation.pending).toBe(false);
	});

	it('keeps an entrance animation armed while no Worksite exists, then arms the first activation', () => {
		const entranceAnimation = createEntranceAnimationLifecycle(null);
		expect(entranceAnimation.claim('A')).toBeNull();
		expect(entranceAnimation.observe(null)).toBe(false);
		expect(entranceAnimation.observe('A')).toBe(true);
		expect(entranceAnimation.claim('A')).toEqual({ generation: 1 });
	});
});
