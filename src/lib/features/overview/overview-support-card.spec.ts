import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { worker } from '#lib/testing/builders.ts';
import TooltipProviderHost from '#lib/testing/tooltip-provider-host.svelte';
import OverviewSupportCard from './overview-support-card.svelte';
import { assessmentCounts, coverageReading, supportReading } from './support-summary.ts';

// Three of four Workers are support (Leader, Supporter, Activist): 75%. One Leader against
// a target of 2 leaves coverage short only when the target asks for more than one.
const workers = [
	worker({ id: 'a', name: 'Ari', assessment: 'Leader' }),
	worker({ id: 'b', name: 'Bea', assessment: 'Supporter' }),
	worker({ id: 'c', name: 'Cory', assessment: 'Disengaged' }),
	worker({ id: 'd', name: 'Dee', assessment: 'Activist' })
];

function card(
	overrides: Partial<{
		workers: typeof workers;
		target: number;
		entranceAnimationState: 'idle' | 'running' | 'complete';
		entranceAnimationElapsed: number;
	}> = {}
) {
	const population = overrides.workers ?? workers;
	const target = overrides.target ?? 2;
	return render(TooltipProviderHost, {
		props: {
			component: OverviewSupportCard,
			props: {
				overall: supportReading(population),
				counts: assessmentCounts(population),
				coverage: coverageReading(population, target),
				target,
				entranceAnimationState: overrides.entranceAnimationState ?? 'complete',
				entranceAnimationElapsed: overrides.entranceAnimationElapsed ?? 2400,
				theme: 'light',
				palette: 'default'
			}
		}
	}).body;
}

describe('OverviewSupportCard', () => {
	it('reads the whole Worksite support as a whole percent', () => {
		expect(card()).toMatch(/75<span class="pct-sign[^"]*">%<\/span>/);
	});

	it('titles the card Committee and leaves the old metric wording off the card', () => {
		const body = card();
		expect(body).toMatch(/aria-label="Committee"/);
		expect(body).toMatch(/<h2[^>]*>\s*Committee\s*<\/h2>/);
		expect(body).not.toContain('Committee coverage');
	});

	it('names the support count and the coverage fraction from the same readings', () => {
		const body = card();
		expect(body).toContain('3 of 4');
		expect(body).toContain('1 / 2 Leaders');
		// One filled mark for the Leader, one open mark for the one still needed.
		expect(body.match(/data-mark="leader"/g)).toHaveLength(1);
		expect(body.match(/data-mark="needed"/g)).toHaveLength(1);
	});

	it('warns that coverage is short when the target asks for more Leaders', () => {
		expect(card({ target: 2 })).toContain('data-short="true"');
	});

	it('shows no coverage warning, and the target-met mark, when the target is covered', () => {
		// Two Leaders meet a target of two; one Leader does not.
		const twoLeaders = [
			worker({ id: 'a', name: 'Ari', assessment: 'Leader' }),
			worker({ id: 'b', name: 'Bea', assessment: 'Leader' }),
			worker({ id: 'c', name: 'Cory', assessment: 'Supporter' })
		];
		const body = card({ workers: twoLeaders, target: 2 });
		expect(body).not.toContain('data-short');
		expect(body).toMatch(/role="img"/);
	});

	it('counts the figure up while the entrance animation runs, and reads the exact value once settled', () => {
		const running = card({ entranceAnimationState: 'running', entranceAnimationElapsed: 0 });
		const settled = card({ entranceAnimationState: 'complete' });
		expect(running).not.toMatch(/75<span class="pct-sign/);
		expect(settled).toMatch(/75<span class="pct-sign/);
	});

	it('states the empty reading when no Worker is counted', () => {
		const body = card({ workers: [] });
		expect(body).not.toContain('pct-sign');
	});
});
