<script lang="ts">
	/**
	 * Committee coverage as marks: a filled mark is a Leader, an open mark is a Leader
	 * still needed. The dot zone is fixed by its card, so the marks sweep down from 16px
	 * to 7.5px; below that each mark stands for a clean unit of Leaders, with a partial
	 * mark for the remainder and one inline caption naming the unit.
	 */
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { coverageLayout, UNIT_CAPTION_RESERVE } from './coverage-layout.ts';

	let {
		leaders,
		needed,
		label,
		tooltip = label,
		detail,
		maxDiameter = 16
	}: {
		leaders: number;
		needed: number;
		/** The reading in words: the accessible name, and by default the tooltip's first line. */
		label: string;
		/** The tooltip's first line, when it should say less than the accessible name. */
		tooltip?: string;
		/** A second tooltip line, such as the target the marks are measured against. */
		detail?: string;
		/** The largest mark this zone draws; the breakdown's small marks pass 10. */
		maxDiameter?: number;
	} = $props();

	let zone = $state<HTMLElement>();
	let zoneWidth = $state(0);
	let zoneHeight = $state(0);

	const total = $derived(Math.max(leaders, needed));
	const measured = $derived(zoneWidth > 0 && zoneHeight > 0);
	const layout = $derived(
		coverageLayout({
			total,
			leaders,
			width: measured ? zoneWidth : 240,
			height: measured ? zoneHeight : maxDiameter,
			maxDiameter
		})
	);
	const unitCaption = $derived(
		layout.unit > 1 ? m.overview_coverage_unit_other({ count: layout.unit }) : ''
	);
	const marksWidth = $derived(
		layout.unit > 1 ? Math.max(1, zoneWidth - UNIT_CAPTION_RESERVE) : zoneWidth || 240
	);
	// A unit caption sits right after its marks rather than floating at a reserved edge;
	// a multi-row unit grid still spans the row width it wrapped in.
	const marksContentWidth = $derived.by(() => {
		const count = layout.marks.length;
		if (count === 0) return layout.diameter;
		if (layout.rows <= 1) return count * layout.diameter + (count - 1) * layout.gap;
		return Math.min(marksWidth, layout.perRow * layout.diameter + (layout.perRow - 1) * layout.gap);
	});

	$effect(() => {
		if (!zone) return;
		const node = zone;
		const measure = () => {
			zoneWidth = node.clientWidth;
			zoneHeight = node.clientHeight;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	});
</script>

<div bind:this={zone} class="flex h-full w-full min-w-0 items-center" data-coverage-zone>
	<Tooltip.Root>
		<Tooltip.Trigger
			class="flex h-full w-full min-w-0 items-center rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			aria-label={label}
			data-coverage-marks
			data-leaders={leaders}
			data-needed={needed}
			data-unit={layout.unit}
			data-short={leaders < needed ? 'true' : undefined}
		>
			<div class="flex w-full min-w-0 items-center gap-2">
				<div
					class="flex min-w-0 flex-wrap content-center items-center"
					style:width="{layout.unit > 1 ? marksContentWidth : marksWidth}px"
					style:gap="{layout.gap}px"
				>
					{#each layout.marks as mark, index (index)}
						<span
							class="relative block shrink-0 overflow-hidden rounded-full border border-ink {mark.filled >=
							1
								? 'bg-ink'
								: 'bg-transparent'}"
							style:width="{layout.diameter}px"
							style:height="{layout.diameter}px"
							data-mark={mark.filled > 0 ? 'leader' : 'needed'}
							data-partial={mark.filled > 0 && mark.filled < 1 ? mark.filled : undefined}
						>
							{#if mark.filled > 0 && mark.filled < 1}
								<span
									class="absolute inset-px rounded-full"
									style:background="conic-gradient(var(--ink) {mark.filled * 360}deg, transparent 0)"
								></span>
							{/if}
						</span>
					{/each}
					{#if total === 0}
						<span
							class="block shrink-0 rounded-full border border-rule"
							style:width="{layout.diameter}px"
							style:height="{layout.diameter}px"
						></span>
					{/if}
				</div>
				{#if unitCaption}
					<span
						class="shrink-0 text-xs whitespace-nowrap text-ink-3 tabular-nums"
						data-coverage-unit-caption>{unitCaption}</span
					>
				{/if}
			</div>
		</Tooltip.Trigger>
		<Tooltip.Content>
			<p>{tooltip}</p>
			{#if detail}<p class="mt-0.5 text-ink-3">{detail}</p>{/if}
		</Tooltip.Content>
	</Tooltip.Root>
</div>
