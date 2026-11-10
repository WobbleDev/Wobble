import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMPACT_BREAKPOINT, NARROW_BREAKPOINT, SHELL_BREAKPOINT } from './is-mobile.svelte.ts';

describe('the responsive tier breakpoints', () => {
	const css = readFileSync(new URL('../../routes/layout.css', import.meta.url), 'utf8');

	function cssBreakpoint(name: string): number {
		const token = css.match(new RegExp(`--breakpoint-${name}:\\s*([\\d.]+)rem`));
		expect(token).not.toBeNull();
		return Number.parseFloat(token?.[1] ?? '') * 16;
	}

	it('names three tiers that match the CSS breakpoint tokens', () => {
		expect(cssBreakpoint('sm')).toBe(NARROW_BREAKPOINT);
		expect(cssBreakpoint('md')).toBe(COMPACT_BREAKPOINT);
		expect(cssBreakpoint('lg')).toBe(SHELL_BREAKPOINT);
	});
});
