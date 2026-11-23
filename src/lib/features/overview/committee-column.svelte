<script lang="ts">
	/**
	 * My Committee: the Leaders, in a column beside the focused bullseye. It stands
	 * where the slid dashboard's strip is, above the chart, and reads the same Workers
	 * the chart does. A row pins that Leader on the chart, as a click on their dot does,
	 * and the chart glides to them.
	 */
	import CheckIcon from '@lucide/svelte/icons/check';
	import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import SwatchDot from '#lib/shared/ui/swatch-dot.svelte';
	import { assessmentColorFor } from '#lib/shared/workers/assessment.ts';
	import CoverageMarks from './coverage-marks.svelte';
	import { overviewFocus } from './overview-focus.svelte.ts';
	import { committeeMembers } from './committee-members.ts';

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
	const reading = $derived(committeeMembers(workers, attributes, target, getLocale()));
	const short = $derived(-reading.coverage.gap);

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
	class="committee-column absolute z-[4] flex w-[min(21rem,calc(100%-2rem))] flex-col gap-4 rounded-[0.625rem] border border-rule bg-panel/80 p-4 backdrop-blur-md"
	class:is-focused={focus.focused}
	style={box
		? `top: ${box.top}px; left: ${box.left}px; max-height: ${box.height}px`
		: 'visibility: hidden'}
	aria-labelledby="committee-title"
	data-committee-column
	inert={!focus.focused}
	aria-hidden={!focus.focused}
>
	<header>
		<h2 id="committee-title" class="section-title">{m.overview_committee_title()}</h2>
		<div class="mt-2 flex items-center gap-2.5" data-committee-coverage>
			<span class="text-sm font-semibold text-ink tabular-nums">
				{m.overview_coverage_units({
					leaders: reading.coverage.leaders,
					needed: reading.coverage.needed
				})}
			</span>
			{#if reading.coverage.needed > 0 && reading.coverage.gap >= 0}
				<CheckIcon
					class="size-4 shrink-0 text-state-success"
					role="img"
					aria-label={m.overview_target_met()}
				/>
			{/if}
		</div>
		{#if reading.coverage.needed > 0}
			<div class="mt-2">
				<CoverageMarks
					leaders={reading.coverage.leaders}
					needed={reading.coverage.needed}
					size="size-3.5"
					label={m.overview_coverage_tooltip({
						leaders: reading.coverage.leaders,
						needed: reading.coverage.needed
					})}
				/>
			</div>
		{/if}
		{#if short > 0}
			<p class="mt-2 text-xs text-ink-3" data-committee-short>
				{short === 1
					? m.overview_committee_short_one()
					: m.overview_committee_short_many({ count: short })}
			</p>
		{/if}
	</header>

	{#if reading.members.length === 0}
		<p class="text-sm text-ink-2" data-committee-empty>{m.overview_committee_empty()}</p>
	{:else}
		<!-- A scroller needs a tab stop; the rows are buttons, so the list has them already. -->
		<ul class="-mx-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-0.5">
			{#each reading.members as member (member.id)}
				{@const pinned = focus.pinnedWorkerId === member.id}
				<li>
					<button
						type="button"
						class="flex w-full min-w-0 items-center gap-3 rounded-control px-2 py-2 text-start transition-colors hover:bg-inset focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:bg-inset motion-reduce:transition-none"
						aria-pressed={pinned}
						data-committee-member={member.id}
						onclick={() => focus.togglePin(member.id)}
					>
						<SwatchDot color={assessmentColorFor('Leader')} class="size-2.5" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm font-medium text-ink">{member.name}</span>
							{#if member.detail}
								<span class="block truncate text-xs text-ink-3">{member.detail}</span>
							{/if}
						</span>
					</button>
				</li>
			{/each}
		</ul>
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
