import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { AssessmentOption } from '#lib/domain-vocabulary.ts';
import TooltipProviderHost from '#lib/testing/tooltip-provider-host.svelte';
import OverviewSegmentBar from './overview-segment-bar.svelte';

const counts: Record<AssessmentOption, number> = {
	Leader: 2,
	Supporter: 1,
	Activist: 0,
	Hostile: 0,
	Disengaged: 0,
	Unassessed: 1
};

/** Renders the bar inside the tooltip provider the route supplies. */
function bar(props: Record<string, unknown>) {
	return render(TooltipProviderHost, {
		props: {
			component: OverviewSegmentBar,
			props: { counts, theme: 'light', palette: 'default', height: 'h-9', ...props }
		}
	}).body;
}

describe('OverviewSegmentBar', () => {
	it('draws one segment per non-empty Assessment, Unassessed last', () => {
		const body = bar({});
		const segments = body.match(/class="seg[^"]*"/g) ?? [];
		expect(segments).toHaveLength(3);
		expect(body.indexOf('aria-label="2 ')).toBeLessThan(body.indexOf('aria-label="1 '));
		expect(body.lastIndexOf('Unassessed')).toBeGreaterThan(body.indexOf('Leader'));
	});

	it("names each segment's count in its label, and shows counts only when labelled", () => {
		expect(bar({ labelled: false })).not.toMatch(/rounded-r-\[3px\]"[^>]*>2</);
		expect(bar({ labelled: true })).toMatch(/>2<\/button>|>2</);
	});

	it('marks the bar neutral only when asked, for the per-group bands', () => {
		expect(bar({ neutral: true, height: 'h-2' })).toContain('neutral-bar');
		expect(bar({ neutral: false, height: 'h-2' })).not.toContain('neutral-bar');
	});
});
