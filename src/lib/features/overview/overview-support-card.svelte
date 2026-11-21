<script lang="ts">
	import { resolve } from '$app/paths';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { Button } from '#lib/components/ui/button/index.ts';
	import type { AssessmentOption } from '#lib/domain-vocabulary.ts';
	import { assessmentGroupLabel, assessmentLabel } from '#lib/i18n/assessment.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { leaderTarget } from './support-summary.ts';
	import {
		entranceAnimationCountUp,
		type DashboardTheme
	} from './overview-dashboard-presentation.ts';
	import CoverageMarks from './coverage-marks.svelte';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import OverviewSegmentBar from './overview-segment-bar.svelte';
	import { segmentHref } from './summary-links.ts';

	let {
		overall,
		counts,
		coverage,
		target,
		entranceAnimationState,
		entranceAnimationElapsed,
		theme,
		palette
	}: {
		overall: { rate: number; total: number; support: number };
		counts: Record<AssessmentOption, number>;
		coverage: { leaders: number; needed: number; gap: number };
		target: number;
		entranceAnimationState: string;
		entranceAnimationElapsed: number;
		theme: DashboardTheme;
		palette: 'default' | 'colorblind';
	} = $props();

	/* The Overall support figure counts up along the support band's timing curve
	   while the entrance animation runs, then reads the exact value. */
	const supportFinal = $derived(Math.round(overall.rate * 100));
	const supportPercent = $derived(
		entranceAnimationState === 'running'
			? entranceAnimationCountUp(supportFinal, entranceAnimationElapsed)
			: supportFinal
	);

	const coverageBasis = $derived(
		leaderTarget(target) === 1
			? m.overview_coverage_basis_one()
			: m.overview_coverage_basis_other({ count: leaderTarget(target) })
	);
	/* The tooltip and accessible name carry the whole reading, including a shortfall. */
	const coverageLabel = $derived(
		[
			m.overview_coverage_units({ leaders: coverage.leaders, needed: coverage.needed }),
			coverage.gap < 0
				? m.overview_coverage_short({
						leaders:
							coverage.leaders === 1 ? assessmentLabel('Leader') : assessmentGroupLabel('Leader'),
						count: -coverage.gap
					})
				: ''
		]
			.filter(Boolean)
			.join(' · ')
	);
</script>

<!-- Support and coverage -->
<section
	class="panel col-span-2 grid grid-cols-[auto_1fr] items-center gap-x-8"
	aria-label={m.overview_support_title()}
>
	<div>
		<h2 class="section-title">{m.overview_support_title()}</h2>
		{#if overall.total === 0}
			<p class="mt-2 max-w-[40ch] text-sm text-ink-2">{m.overview_support_empty()}</p>
			<Button
				variant="outline"
				size="sm"
				class="mt-2 min-h-tap lg:min-h-8"
				href={resolve('/workers')}
				data-add-first-worker
			>
				{m.workers_add_first_worker()}
			</Button>
		{:else}
			<Tooltip.Root>
				<Tooltip.Trigger
					class="mt-1 block cursor-default rounded-sm text-start text-[clamp(2rem,28cqw,3.75rem)] leading-none font-semibold tracking-headline tabular-nums focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					aria-label="{supportFinal}% — {m.overview_support_count({
						support: overall.support,
						total: overall.total
					})}"
					data-support-figure
				>
					{supportPercent}<span class="pct-sign">%</span>
				</Tooltip.Trigger>
				<Tooltip.Content>
					{m.overview_support_count({ support: overall.support, total: overall.total })}
				</Tooltip.Content>
			</Tooltip.Root>
		{/if}
	</div>
	{#if overall.total > 0}
		<div class="self-center">
			<OverviewSegmentBar
				{counts}
				height="h-9 text-sm"
				labelled
				hrefFor={(option) => segmentHref(undefined, option)}
				linkLabel={(option, count) =>
					m.overview_segment_link_all({
						count,
						standing: count === 1 ? assessmentLabel(option) : assessmentGroupLabel(option)
					})}
				{theme}
				{palette}
			/>
		</div>
	{/if}
</section>

<section class="panel" aria-label={m.domain_committee_coverage()}>
	<div>
		<h2 class="section-title">{m.domain_committee_coverage()}</h2>
		<div class="mt-2 flex items-center gap-2.5" data-coverage-figure>
			<CoverageMarks
				leaders={coverage.leaders}
				needed={coverage.needed}
				size="size-5"
				label={coverageLabel}
				detail={coverageBasis}
			/>
			{#if coverage.needed > 0 && coverage.gap >= 0}
				<CheckIcon
					class="size-5 shrink-0 text-state-success"
					role="img"
					aria-label={m.overview_target_met()}
				/>
			{/if}
		</div>
	</div>
</section>

<style>
	/* The sign rides at the figure's cap height, a step down, so the number leads. */
	.pct-sign {
		font-size: 0.55em;
		vertical-align: 0.62em;
		margin-inline-start: 0.04em;
		font-weight: 500;
	}
</style>
