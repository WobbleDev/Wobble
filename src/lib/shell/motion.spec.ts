import { describe, expect, it } from 'vitest';
import { resolveReducedMotion } from './motion.svelte.ts';

describe('resolving reduced motion', () => {
	it('follows the system preference when the setting is system', () => {
		expect(resolveReducedMotion('system', true)).toBe(true);
		expect(resolveReducedMotion('system', false)).toBe(false);
	});

	it('always reduces when the setting says reduce, whatever the system prefers', () => {
		expect(resolveReducedMotion('reduce', true)).toBe(true);
		expect(resolveReducedMotion('reduce', false)).toBe(true);
	});

	it('never reduces when the setting says full, even on a system that asks for less', () => {
		expect(resolveReducedMotion('full', true)).toBe(false);
		expect(resolveReducedMotion('full', false)).toBe(false);
	});
});
