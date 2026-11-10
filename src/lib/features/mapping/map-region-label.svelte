<script lang="ts">
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import { screenFixed } from './map-style.ts';
	import { headingFontPx } from './graph-text-metrics.ts';
	import type { Region } from './graph-layout.ts';
	let {
		region,
		count,
		zoom
	}: {
		region: Region;
		count?: number;
		zoom: number;
	} = $props();
	const truncated = $derived(
		region.displayLabel !== undefined && region.displayLabel !== region.label
	);
</script>

{#snippet text(local = false)}
	<text
		x={local ? 0 : region.labelAt.x}
		y={local ? 0 : region.labelAt.y}
		text-anchor={region.labelAt.textAnchor}
		data-region-label={truncated ? undefined : region.key}
		class="label fill-ink-3"
		style="font-size: {screenFixed(headingFontPx, zoom)}px"
	>
		{region.displayLabel ??
			region.label}{#if count !== undefined && region.displayCount !== false}<tspan
				dx="5"
				class="num fill-ink-2">· {count}</tspan
			>{/if}
	</text>
{/snippet}

{#if truncated}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<!-- Focus reveals the full label. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<g
					{...props}
					transform={`translate(${region.labelAt.x} ${region.labelAt.y})`}
					data-region-label={region.key}
					tabindex="0"
					aria-label={region.label}
					class="focus-visible:outline-2 focus-visible:outline-ring"
				>
					<!-- A local origin gives WebKit a reliable SVG hit box and tooltip anchor. -->
					<rect
						x="-4"
						y="-15"
						width={region.labelBox?.width ?? 20}
						height="20"
						fill="transparent"
					/>
					{@render text(true)}
				</g>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content role="tooltip">{region.label}</Tooltip.Content>
	</Tooltip.Root>
{:else}
	{@render text()}
{/if}
