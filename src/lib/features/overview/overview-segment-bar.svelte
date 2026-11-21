<script lang="ts">
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import { assessmentGroupLabel } from '#lib/i18n/assessment.ts';
	import type { AssessmentOption } from '#lib/domain-vocabulary.ts';
	import { isSupportAssessment } from '#lib/shared/workers/assessment.ts';
	import {
		segmentFill,
		segmentLabelTone,
		segments,
		showsSegmentCount,
		toneClass,
		type DashboardTheme
	} from './overview-dashboard-presentation.ts';

	let {
		counts,
		height,
		labelled = false,
		neutral = false,
		hrefFor,
		linkLabel,
		theme,
		palette
	}: {
		counts: Record<AssessmentOption, number>;
		height: string;
		labelled?: boolean;
		neutral?: boolean;
		/** Each segment opens its Workers: the address that standing's segment leads to. */
		hrefFor?: (option: AssessmentOption) => string;
		/** What the segment's link opens, for its accessible name. */
		linkLabel?: (option: AssessmentOption, count: number) => string;
		theme: DashboardTheme;
		palette: 'default' | 'colorblind';
	} = $props();

	const total = $derived(Object.values(counts).reduce((n, x) => n + x, 0));
	const parts = $derived(segments(counts));
</script>

<div class="flex w-full gap-0.5 {height}" class:neutral-bar={neutral}>
	{#each parts as s, i (s.option)}
		{@const last = i === parts.length - 1}
		{@const href = hrefFor?.(s.option)}
		{@const name =
			href && linkLabel
				? linkLabel(s.option, s.count)
				: `${s.count} ${assessmentGroupLabel(s.option)}`}
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<svelte:element
						this={href ? 'a' : 'button'}
						{...props}
						{href}
						type={href ? undefined : 'button'}
						class="seg {isSupportAssessment(s.option) ? 'support' : ''} {s.option === 'Unassessed'
							? 'unassessed'
							: ''} flex h-full min-w-0 items-center justify-center font-mono font-medium tabular-nums
							{i === 0 ? 'rounded-l-[3px]' : ''} {last ? 'rounded-r-[3px]' : ''}
							{toneClass(segmentLabelTone(s.option, theme, palette), 'text-ink')}"
						style="flex: {s.count} 0 0; --seg: {segmentFill(s.option)}"
						aria-label={name}
						data-segment={s.option}
					>
						{#if labelled && showsSegmentCount(s.count, total)}<span class="seg-count"
								>{s.count}</span
							>{/if}
					</svelte:element>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>{assessmentGroupLabel(s.option)}</Tooltip.Content>
		</Tooltip.Root>
	{/each}
</div>

<style>
	/* Segments render through tooltip triggers, so these selectors are global. */
	:global(.seg) {
		background-color: var(--seg);
		transition: filter 120ms ease-out;
	}
	:global(.seg:hover),
	:global(.seg:focus-visible) {
		filter: brightness(1.08);
	}
	:global(.seg:focus-visible) {
		outline: 2px solid var(--ring);
		outline-offset: -2px;
	}
	/* Every segment, including Unassessed, keeps its share of the same
	   population in every state. Hover/focus changes paint only. Separators
	   overlay the segments so they never participate in flex sizing. */
	:global(.neutral-bar) {
		gap: 0;
	}
	:global(.neutral-bar .seg) {
		position: relative;
		background-color: var(--rule);
		border-radius: 0;
		transition: background 150ms;
	}
	:global(.neutral-bar .seg.support) {
		background: var(--ink-2);
	}
	:global(.neutral-bar .seg::before) {
		content: '';
		position: absolute;
		inset-block: 0;
		inset-inline-start: 0;
		width: 1px;
		background: var(--panel);
		opacity: 0;
		pointer-events: none;
	}
	/* A band reads in the standing colours while its row or its bar is hovered or
	   focused; the counts appear only on the bar itself, over the segment under it. */
	:global(.neutral-bar .seg.support + .seg:not(.support)::before),
	:global(.breakdown-row:hover .neutral-bar .seg + .seg::before),
	:global(.breakdown-row:focus-within .neutral-bar .seg + .seg::before),
	:global(.neutral-bar:hover .seg + .seg::before),
	:global(.neutral-bar:focus-within .seg + .seg::before) {
		opacity: 1;
	}
	:global(.breakdown-row:hover .neutral-bar .seg),
	:global(.breakdown-row:focus-within .neutral-bar .seg),
	:global(.neutral-bar:hover .seg),
	:global(.neutral-bar:focus-within .seg) {
		background-color: var(--seg);
	}
	:global(.neutral-bar .seg-count) {
		opacity: 0;
		transition: opacity 150ms;
	}
	:global(.neutral-bar:hover .seg-count),
	:global(.neutral-bar:focus-within .seg-count) {
		opacity: 1;
	}
	@media (pointer: coarse) {
		:global(.neutral-bar) {
			height: var(--tap-target);
		}
	}
</style>
