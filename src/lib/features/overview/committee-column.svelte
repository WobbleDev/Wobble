<script lang="ts">
	/**
	 * My Committee: the Leaders, in a column beside the focused bullseye. It stands
	 * where the slid dashboard's strip is, above the chart, and reads the same Workers
	 * the chart does. A row pins that Leader on the chart, as a click on their dot does,
	 * and the chart glides to them.
	 */
	import CheckIcon from '@lucide/svelte/icons/check';
	import Link2Icon from '@lucide/svelte/icons/link-2';
	import { page } from '$app/state';
	import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { assessmentGroupLabel, assessmentLabel } from '#lib/i18n/assessment.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import SwatchDot from '#lib/shared/ui/swatch-dot.svelte';
	import { assessmentColorFor } from '#lib/shared/workers/assessment.ts';
	import CoverageMarks from './coverage-marks.svelte';
	import { overviewFocus } from './overview-focus.svelte.ts';
	import { committeeReading } from './committee-members.ts';
	import { resolveGroupingAttribute } from './overview-grouping.svelte.ts';

	let {
		workers,
		attributes,
		target
	}: {
		workers: readonly Worker[];
		attributes: readonly WorkerAttributeDefinition[];
		target: number;
	} = $props();

	const focus = overviewFocus();
	/* The column groups by the Attribute the dashboard reads, named by the same address. */
	const attribute = $derived(
		resolveGroupingAttribute(
			attributes.filter((candidate) => candidate.kind === 'category'),
			page.url.searchParams.get('by') ?? ''
		)
	);
	const reading = $derived(committeeReading(workers, attribute, target, getLocale()));
	const short = $derived(-reading.coverage.gap);
	const noLeaders = $derived(reading.coverage.leaders === 0);
	/** How many of a Leader's ties stand in one ring, in words: "2 Supporters". */
	const ringCount = (assessment: Parameters<typeof assessmentLabel>[0], count: number) =>
		`${count} ${count === 1 ? assessmentLabel(assessment) : assessmentGroupLabel(assessment)}`;
	/** The most names the pinned row spells out before the rest are a count. */
	const NAMED = 6;

	/* The column sits over the dashboard's own box, so it is measured from it: the
	   dashboard root's top and left, and the room under the cards' padding. */
	let box = $state<{ top: number; left: number; height: number } | null>(null);
	let column = $state<HTMLElement>();

	$effect(() => {
		const parent = column?.offsetParent;
		if (!parent) return;
		function measure() {
			const root = document.querySelector('[data-dashboard-root]');
			const frame = parent?.getBoundingClientRect();
			if (!root || !frame) {
				box = null;
				return;
			}
			const rect = root.getBoundingClientRect();
			const inset = parseFloat(getComputedStyle(document.documentElement).fontSize) * 1.25;
			box = {
				top: rect.top - frame.top + inset,
				left: rect.left - frame.left + inset,
				height: Math.max(0, rect.height - inset * 2)
			};
		}
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(parent);
		const root = document.querySelector('[data-dashboard-root]');
		if (root) observer.observe(root);
		return () => observer.disconnect();
	});
</script>

<aside
	bind:this={column}
	class="committee-column absolute z-[4] flex w-[min(21rem,calc(100%-2rem))] flex-col rounded-[0.625rem] border border-rule bg-panel/92 px-[1.125rem] py-4 backdrop-blur-lg"
	class:is-focused={focus.focused}
	style={box
		? `top: ${box.top}px; left: ${box.left}px; max-height: ${box.height}px`
		: 'visibility: hidden'}
	aria-labelledby="committee-title"
	data-committee-column
	inert={!focus.focused}
	aria-hidden={!focus.focused}
>
	<!-- The head reads as the Committee coverage card does: the title, then the figure
	     at its size, then the marks. -->
	<header
		class="flex flex-col gap-2 pb-4"
		class:border-b={!noLeaders}
		class:border-rule={!noLeaders}
	>
		<h2 id="committee-title" class="section-title">{m.overview_committee_title()}</h2>
		<div class="flex items-center gap-2.5" data-committee-coverage>
			<span class="text-[1.75rem] leading-none font-semibold tracking-headline tabular-nums">
				{m.overview_coverage_units({
					leaders: reading.coverage.leaders,
					needed: reading.coverage.needed
				})}
			</span>
			{#if reading.coverage.needed > 0 && reading.coverage.gap >= 0}
				<CheckIcon
					class="size-5 shrink-0 text-state-success"
					role="img"
					aria-label={m.overview_target_met()}
				/>
			{/if}
		</div>
		{#if reading.coverage.needed > 0}
			<div class="flex items-center justify-between gap-3">
				<CoverageMarks
					leaders={reading.coverage.leaders}
					needed={reading.coverage.needed}
					size="size-3.5"
					label={m.overview_coverage_tooltip({
						leaders: reading.coverage.leaders,
						needed: reading.coverage.needed
					})}
				/>
				{#if short > 0}
					<p class="shrink-0 text-xs text-ink-3" data-committee-short>
						{short === 1
							? m.overview_committee_short_one()
							: m.overview_committee_short_many({ count: short })}
					</p>
				{/if}
			</div>
		{/if}
	</header>

	{#if noLeaders}
		<p class="mt-4 text-sm text-ink-2" data-committee-empty>{m.overview_committee_empty()}</p>
	{:else}
		<!-- The rows are buttons, so the list has tab stops already and needs none of its own. -->
		<div
			data-scroll-region
			class="-mx-2.5 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pt-2 pb-0.5"
		>
			{#each reading.sections as section (section.key)}
				<section aria-label={section.label ?? m.overview_committee_title()} data-committee-section>
					{#if section.label !== null}
						<h3
							class="flex items-center justify-between gap-3 px-2.5 pb-1 font-mono text-2xs tracking-key text-ink-2 uppercase"
						>
							<span class="truncate">{section.label}</span>
							<span
								class="flex shrink-0 items-center gap-1 tabular-nums"
								data-committee-group-coverage
								aria-label={m.overview_coverage_tooltip({
									leaders: section.leaders,
									needed: section.needed
								})}
							>
								<span aria-hidden="true">{section.leaders} / {section.needed}</span>
								{#if section.needed > 0 && section.leaders >= section.needed}
									<CheckIcon class="size-3 text-state-success" aria-hidden="true" />
								{/if}
							</span>
						</h3>
					{/if}
					<ul class="flex flex-col gap-px">
						{#each section.members as member (member.id)}
							{@const pinned = focus.pinnedWorkerId === member.id}
							<!-- The pinned row and the step it opens share one band. -->
							<li class="rounded-control" class:bg-inset={pinned}>
								<button
									type="button"
									class="flex w-full min-w-0 items-center gap-3 rounded-control px-2.5 py-2 text-start transition-colors hover:bg-inset focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
									aria-pressed={pinned}
									aria-expanded={member.ties > 0 ? pinned : undefined}
									data-committee-member={member.id}
									onclick={() => focus.togglePin(member.id)}
								>
									<SwatchDot color={assessmentColorFor('Leader')} class="size-2.5" />
									<span class="min-w-0 flex-1">
										<span
											class="block truncate text-sm leading-5 font-medium text-ink"
											title={member.name}>{member.name}</span
										>
										{#if member.reach.length > 0}
											<!-- Who the ties reach, as the chart's own colours: a count per ring. -->
											<span
												class="flex items-center gap-2.5 text-xs leading-4 text-ink-3 tabular-nums"
												data-committee-reach
											>
												{#each member.reach as ring (ring.assessment)}
													<span
														class="inline-flex items-center gap-1"
														title={ringCount(ring.assessment, ring.count)}
													>
														<SwatchDot color={assessmentColorFor(ring.assessment)} class="size-2" />
														<span class="sr-only">{ringCount(ring.assessment, ring.count)}</span>
														<span aria-hidden="true">{ring.count}</span>
													</span>
												{/each}
											</span>
										{/if}
									</span>
									{#if member.ties > 0}
										<span
											class="flex shrink-0 items-center gap-1 text-xs text-ink-3 tabular-nums"
											data-committee-ties={member.ties}
											title={member.ties === 1
												? m.overview_committee_ties_one()
												: m.overview_committee_ties_many({ count: member.ties })}
										>
											<Link2Icon class="size-3.5" aria-hidden="true" />
											<span class="sr-only">
												{member.ties === 1
													? m.overview_committee_ties_one()
													: m.overview_committee_ties_many({ count: member.ties })}
											</span>
											<span aria-hidden="true">{member.ties}</span>
										</span>
									{/if}
								</button>
								{#if pinned && member.ties > 0}
									<!-- The pinned Leader opens one step: how far the ties reach, and who. -->
									<div class="pr-2.5 pb-2 pl-8 text-xs leading-4 text-ink-2" data-committee-detail>
										{#if member.furthest}
											<p>
												{m.overview_committee_reach({
													assessment: assessmentGroupLabel(member.furthest)
												})}
											</p>
										{/if}
										<p class="mt-0.5 text-pretty text-ink-3">
											{member.tied
												.slice(0, NAMED)
												.map((tied) => tied.name)
												.join(', ')}{#if member.tied.length > NAMED}
												<span class="ms-1 tabular-nums">+{member.tied.length - NAMED}</span>{/if}
										</p>
									</div>
								{/if}
							</li>
						{:else}
							<li
								class="flex items-center gap-3 px-2.5 py-1.5 text-xs text-ink-3"
								data-committee-gap
							>
								<span class="size-2.5 shrink-0 rounded-full border border-ink-3" aria-hidden="true"
								></span>
								{m.overview_committee_gap()}
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	{/if}
</aside>

<style>
	/* The column arrives with the slide, on its curve, and leaves the same way. */
	.committee-column {
		opacity: 0;
		transform: translateX(-1.5rem);
		transition:
			opacity 650ms cubic-bezier(0.22, 1, 0.36, 1),
			transform 650ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.committee-column.is-focused {
		opacity: 1;
		transform: none;
	}
	@media (prefers-reduced-transparency: reduce), (forced-colors: active) {
		.committee-column {
			background: var(--panel);
			backdrop-filter: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(html:not([data-motion='full'])) .committee-column {
			transition-duration: 1ms;
		}
	}
	:global(html[data-motion='reduce']) .committee-column {
		transition-duration: 1ms;
	}
</style>
