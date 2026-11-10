import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import OverviewEdgeControl from './overview-edge-control.svelte';
import OverviewContextHost from '#lib/testing/overview-context-host.svelte';

function control(focused: boolean, zoom = 1) {
	return render(OverviewContextHost, {
		props: { component: OverviewEdgeControl, focused, zoom }
	}).body;
}

describe('OverviewEdgeControl', () => {
	it('is the focus tab at rest: pressed false, labelled to focus the bullseye', () => {
		const body = control(false);
		expect(body).toContain('data-focus-edge');
		expect(body).toContain('aria-pressed="false"');
		expect(body).toContain('aria-label="Focus bullseye"');
	});

	it('is pressed and labelled to show the dashboard while focused', () => {
		const body = control(true);
		expect(body).toContain('aria-pressed="true"');
		expect(body).toContain('aria-label="Show dashboard"');
	});

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
