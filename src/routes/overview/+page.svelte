<script lang="ts">
	/**
	 * Overview: four readings laid over the Assessment bullseye floor.
	 *
	 * Overall support and Committee coverage read the whole Worksite; By
	 * Attribute bands and the Agitations matrix read the Attribute named by the
	 * by parameter (Department, then the first Single-Select Attribute, when it
	 * is missing or unknown). The shell owns the bullseye ground behind this
	 * page; where it cannot be dragged, the fitted chart is drawn in the page
	 * instead. The shell branches this route needs (the rail-reach clip and the
	 * surface-less card) live in the layout, keyed on this route.
	 */
	import { page } from '$app/state';
	import AssessmentBullseye from '#lib/features/overview/bullseye/assessment-bullseye.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { bullseyeView } from '#lib/features/overview/bullseye/bullseye-view.ts';
	import {
		agitationGroupMatrix,
		assessmentCounts,
		coverageReading,
		groupReadings,
		supportReading
	} from '#lib/features/overview/support-summary.ts';
	import { createGroupJump } from '#lib/features/overview/group-jump.svelte.ts';
	import { frontierKey } from '#lib/features/overview/overview-comparison.ts';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { overviewArrivalClaim } from '#lib/features/overview/overview-arrival-claim.svelte.ts';
	import { overviewArrivalController } from '#lib/features/overview/overview-arrival.svelte.ts';
	import OverviewAgitationsCard from '#lib/features/overview/overview-agitations-card.svelte';
	import { createOverviewAgitationsCard } from '#lib/features/overview/overview-agitations-card.svelte.ts';
	import OverviewBreakdownCard from '#lib/features/overview/overview-breakdown-card.svelte';
	import { createOverviewBreakdownCard } from '#lib/features/overview/overview-breakdown-card.svelte.ts';
	import { overviewFocus } from '#lib/features/overview/overview-focus.svelte.ts';
	import { createOverviewGrouping } from '#lib/features/overview/overview-grouping.svelte.ts';
	import { overviewRootState } from '#lib/features/overview/overview-root-state.svelte.ts';
	import OverviewSupportCard from '#lib/features/overview/overview-support-card.svelte';
	import { NO_SCROLL_FLOOR } from '#lib/features/overview/overview-chart-zoom.ts';
	import { wireOverviewChartZoom } from '#lib/features/overview/overview-chart-zoom.svelte.ts';
	import WorksiteSetupDialog from '#lib/features/overview/worksite-setup-dialog.svelte';
	import { PanCapability } from '#lib/hooks/pan-capability.svelte.ts';
	import { replaceCurrentUrl } from '#lib/shared/navigation.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	// The arrival claim stays with the page, as before: the shell-owned ground
	// animates from it, and the dashboard's own entrance runs from the same claim.
	const arrival = overviewArrivalController();
	const panCapability = new PanCapability();
	const claim = overviewArrivalClaim({
		arrival,
		worksiteId: () => data.worksite?.id,
		reducedMotion: () => panCapability.reducedMotion
	});
	/* Enlarged text, the applied theme and the Assessment palette, read from the
	   document root the first paint writes. */
	const rootState = overviewRootState();

	const workers = $derived(data.workers);
	const target = $derived(data.worksite?.committeeTarget ?? 5);
	const overall = $derived(supportReading(workers));
	const counts = $derived(assessmentCounts(workers));
	const coverage = $derived(coverageReading(workers, target));

	const categories = $derived(data.attributes.filter((a) => a.kind === 'category'));
	// The chosen Attribute is address state: changing the Select rewrites by=
	// in place, so a reload or a shared link opens the same reading.
	const grouping = createOverviewGrouping({
		categories: () => categories,
		initial: () => page.url.searchParams.get('by') ?? '',
		replaceUrl: replaceCurrentUrl
	});
	const attribute = $derived(grouping.attribute);
	const groups = $derived(groupReadings(workers, attribute, target));

	// Agitations against the chosen Attribute's groups: one row per Agitation
	// held, one column per group, each cell the holders in that group.
	const matrix = $derived(agitationGroupMatrix({ workers }, data.agitations, attribute));

	const breakdown = createOverviewBreakdownCard({
		attributeId: () => attribute?.id,
		groupIds: () => groups.map((group) => group.answerId)
	});
	const agitations = createOverviewAgitationsCard({
		attribute: () => attribute,
		matrix: () => matrix,
		locale: getLocale,
		allLabel: () => m.overview_dashboard_all()
	});

	/* Jump to group turns both pagers to the page holding one group, by stable key:
	   the Support rows run by support and the matrix columns by configured order. */
	const groupJump = createGroupJump({
		pagers: () => [
			{
				pages: () =>
					breakdown.paging.pages.map((rows) => rows.map((index) => frontierKey(groups[index]))),
				goTo: (next) => breakdown.paging.goTo(next)
			},
			{
				pages: () => agitations.pages.map((rows) => rows.map(frontierKey)),
				goTo: (next) => agitations.paging.goTo(next)
			}
		]
	});

	/* The shell decides whether the bullseye is a ground behind the page or a
	   chart drawn in the page here, where there is nothing to drag; it also holds
	   the scale the wheel sets. */
	const view = bullseyeView();
	/* The shell's focus state: at rest this dashboard reads, focused it slides aside. */
	const focus = overviewFocus();
	/** The chart's own cell, and the region the wheel reads while the chart is drawn here. */
	let chartCell = $state<HTMLElement>();
	wireOverviewChartZoom({
		view,
		chart: () => chartCell,
		floorMatches: () => window.matchMedia(NO_SCROLL_FLOOR).matches
	});
</script>

<!-- The dashboard over the shell-owned floor: Overall support spans two columns
     beside Committee coverage, with the By-Attribute bands and the Agitations
     matrix below. The By list pages whole rows; the matrix scrolls vertically
     inside its card, so the page itself never scrolls on the no-scroll surface. -->
<div
	class="relative -m-4 flex min-h-0 flex-1 flex-col lg:-m-6"
	data-dashboard-root
	class:fitted-dashboard={!view.shown}
	data-focused={focus.focused}
	data-overview-arrival
	data-arrival-state={claim.arrivalState}
	data-arrival-generation={claim.claimedGeneration ?? undefined}
>
	<!-- The sliding dashboard: focused it runs left under the chart and the rail,
	     faded and blurred, and inert so every pointer and tab stop reaches the
	     bullseye instead. -->
	<!-- A scroller needs a tab stop, or a keyboard reader can neither reach nor scroll it. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="dashboard grid min-h-0 flex-1 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.9fr)] grid-rows-[auto_minmax(0,1fr)] gap-3 p-4 lg:p-5"
		data-dashboard
		data-scroll-region={rootState.enlargedText ? '' : undefined}
		role={rootState.enlargedText ? 'region' : undefined}
		aria-label={rootState.enlargedText ? m.nav_overview() : undefined}
		tabindex={rootState.enlargedText ? 0 : undefined}
		inert={focus.focused}
	>
		<OverviewSupportCard
			{overall}
			{counts}
			{coverage}
			{target}
			arrivalState={claim.arrivalState}
			arrivalElapsed={claim.arrivalElapsed}
			theme={rootState.theme}
			palette={rootState.palette}
		/>
		<OverviewBreakdownCard
			{grouping}
			{categories}
			{groups}
			{matrix}
			worksiteTotal={workers.length}
			card={breakdown}
			{groupJump}
			theme={rootState.theme}
			palette={rootState.palette}
		/>
		<OverviewAgitationsCard
			card={agitations}
			{matrix}
			{attribute}
			attributes={data.attributes}
			workerCount={workers.length}
			theme={rootState.theme}
		/>
	</div>

	<!-- The fitted chart where the ground cannot be dragged: below the floor,
	     under reduced motion, or on a coarse pointer. Drawn after the dashboard
	     in the page flow, with every dot on screen. -->
	{#if !view.shown}
		<div class="no-scroll-chart" bind:this={chartCell}>
			<AssessmentBullseye
				workers={data.workers}
				class="h-full"
				zoom={view.zoom}
				arrivalState={claim.arrivalState}
				arrivalElapsed={claim.arrivalElapsed}
				onzoomkey={(next) => view.setZoom(next)}
			/>
		</div>
	{/if}
</div>

<!-- Reset zoom is a control over the chart rather than over the column. It shows
     here only for the fitted chart, where the ground cannot be dragged: below the
     Shell tier the page flows again, so it sits in that flow under the chart. The
     focused ground carries its own reset in the shell, at the lower right above
     the chart. The zoom lives in the shell's shared view context, so resetting
     writes that rather than touching the DOM. Its visible label names it; an
     aria-label override would break label-in-name. -->
{#if !view.shown}
	<Button
		variant="outline"
		size="sm"
		class="pointer-events-auto z-10 mt-2 min-h-tap self-end lg:fixed lg:right-6 lg:bottom-6 lg:mt-0 lg:min-h-8"
		disabled={view.zoom === 1}
		onclick={() => view.setZoom(1)}
	>
		{m.overview_reset_zoom()}
	</Button>
{/if}

{#if page.url.searchParams.get('setup') === '1' && data.worksite}
	<WorksiteSetupDialog worksite={data.worksite} />
{/if}

<style>
	.dashboard :global(.panel) {
		container-type: inline-size;
		border: 1px solid var(--rule);
		border-radius: 0.625rem;
		background: color-mix(in oklab, var(--panel) 62%, transparent);
		backdrop-filter: blur(8px);
		padding: 1rem 1.125rem;
	}
	@media (width >= 64rem) and (height >= 40rem) {
		.fitted-dashboard .dashboard {
			flex: 2 1 0;
			grid-template-rows: auto minmax(min-content, 1fr);
		}
		.fitted-dashboard .no-scroll-chart {
			flex: 1 1 0;
			align-self: stretch;
		}
	}
	/* Enlarged text: the dashboard is the one scroller; its rows take their own height. */
	.dashboard[data-scroll-region] {
		overflow-y: auto;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: auto;
		align-content: start;
	}
	.dashboard[data-scroll-region] > :global(section) {
		grid-column: auto;
		min-height: 14rem;
	}
	.dashboard[data-scroll-region] > :global(section:first-child) {
		grid-template-columns: minmax(0, 1fr);
	}
	@media (width < 40rem) {
		.dashboard {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto;
		}
		.dashboard > :global(section) {
			grid-column: auto;
			min-width: 0;
		}
		.dashboard > :global(section:first-child) {
			grid-template-columns: minmax(0, 1fr);
			gap: 1rem;
		}
	}
	@media (prefers-reduced-transparency: reduce), (forced-colors: active) {
		.dashboard :global(.panel) {
			background: var(--panel);
			backdrop-filter: none;
		}
	}
	@supports not (backdrop-filter: blur(1px)) {
		.dashboard :global(.panel) {
			background: var(--panel);
		}
	}
	.dashboard {
		transition:
			transform 650ms cubic-bezier(0.22, 1, 0.36, 1),
			opacity 650ms cubic-bezier(0.22, 1, 0.36, 1),
			filter 650ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	/* The slide runs only on the no-scroll surface: below the floor the fitted
	   chart is drawn instead, the edge control is gone, and the page scrolls. */
	@media (min-width: 64rem) and (min-height: 40rem) {
		/* Focused, the dashboard runs left to a 34rem strip, faded and blurred,
		   beneath the bullseye. */
		[data-focused='true'] .dashboard {
			transform: translateX(calc(-100% + 34rem));
			opacity: 0.3;
			filter: blur(2px);
		}
		/* The slid strip paints under the navigation rail's glass: the scroll
		   viewport gives up its clip on this route, as the shell's card does. */
		:global([data-scroll-viewport]:has([data-dashboard-root])) {
			overflow-x: visible;
			overflow-y: clip;
		}
	}
	/* The focus change is instant under reduced motion. */
	@media (prefers-reduced-motion: reduce) {
		:global(html:not([data-motion='full'])) .dashboard {
			transition-duration: 1ms;
		}
	}
	:global(html[data-motion='reduce']) .dashboard {
		transition-duration: 1ms;
	}
</style>
