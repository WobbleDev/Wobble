import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import OverviewResetZoom from './overview-reset-zoom.svelte';
import OverviewContextHost from '#lib/testing/overview-context-host.svelte';
import TooltipProviderHost from '#lib/testing/tooltip-provider-host.svelte';

function control(focused: boolean, zoom = 1) {
	return render(TooltipProviderHost, {
		props: {
			component: OverviewContextHost,
			props: { component: OverviewResetZoom, focused, zoom }
		}
	}).body;
}

describe('OverviewResetZoom', () => {
	it('offers Reset zoom only while focused', () => {
		expect(control(false)).not.toContain('data-focus-reset');
		expect(control(true)).toContain('data-focus-reset');
	});

	it('disables Reset zoom at the rest scale and enables it once zoomed', () => {
		const resetTag = (body: string) => body.match(/<button[^>]*data-focus-reset[^>]*>/)?.[0] ?? '';
		expect(resetTag(control(true, 1))).toMatch(/\sdisabled(=""|\s|>)/);
		expect(resetTag(control(true, 1.5))).not.toMatch(/\sdisabled(=""|\s|>)/);
	});
});
