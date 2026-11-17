<script lang="ts">
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import { screenFixed } from '../map-style.ts';
	import { headingFontPx } from './graph-text-metrics.ts';
	import type { Region } from '../layout/graph-layout.ts';
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
	/**
	 * The label's box in map units. WebKit does not hit SVG text where Playwright
	 * presses (#102), so a transparent rect behind the text takes the press. A
	 * measured heading brings its own box; otherwise the box is the estimate the
	 * placement already uses for it.
	 */
	const hit = $derived.by(() => {
		const box = region.labelBox;
		if (box) return { x: box.x, y: box.y, width: box.width, height: box.height };
		const fontSize = screenFixed(headingFontPx, zoom);
		const text = region.displayLabel ?? region.label;
		const suffix = count !== undefined && region.displayCount !== false ? `  · ${count}` : '';
		const width = [...(text + suffix)].length * fontSize * 0.72;
		const { x, y, textAnchor } = region.labelAt;
		const left = textAnchor === 'start' ? x : textAnchor === 'end' ? x - width : x - width / 2;
		const pad = screenFixed(3, zoom);
		return {
			x: left - pad,
			y: y - fontSize - pad,
			width: width + pad * 2,
			height: fontSize * 1.4
		};
	});
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
						data-region-label-hit={region.key}
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
	<!-- See `hit`: the text alone is not a press target in WebKit. -->
	<rect
		data-region-label-hit={region.key}
		x={hit.x}
		y={hit.y}
		width={hit.width}
		height={hit.height}
		fill="transparent"
	/>
	{@render text()}
{/if}
