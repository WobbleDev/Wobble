<script lang="ts">
	/**
	 * The Grouping regions drawn under the map: one well per group, each holding its
	 * sub-regions, with the group's member count beside its label.
	 *
	 * Rendered inside the map's own `g`, so it adds no wrapper element and every
	 * length written here is multiplied by the camera's zoom. Type is therefore
	 * counter-scaled through `screenFixed`, and the outlines carry a non-scaling
	 * stroke, so a region label and its boundary read the same size at every zoom.
	 */
	import MapRegionLabel from './labels/map-region-label.svelte';
	import type { GroupRegion } from './layout/graph-layout.ts';

	let {
		regions,
		counts,
		regionOpacity,
		zoom,
		grabbable = false,
		grabbing = false,
		onGroupPress
	}: {
		regions: GroupRegion[];
		counts: Map<string, number>;
		regionOpacity: (regionKey: string) => number;
		/** The camera's scale, which the labels and strokes are held against. */
		zoom: number;
		/** Hulls and labels show the grab cursor and take a drag press. */
		grabbable?: boolean;
		grabbing?: boolean;
		/** A press inside a top-level group's hull or label; sub-regions report their parent. */
		onGroupPress?: (event: PointerEvent, regionKey: string) => void;
	} = $props();
</script>

<!-- A region is a well in the paper: it takes the recess stop at
     full strength rather than a wash of it, because a tone
     mixed from an alpha is a tone the ladder does not own.
     A sub-region is a division *inside* that well, so it
     takes the next stop deeper (the chip) and no outline: a
     deeper well inside a well, never a third kind of line. -->
{#each regions as region (region.key)}
	{@const count = counts.get(region.key)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<g
		class="transition-opacity duration-150 ease-out"
		class:cursor-grab={grabbable && !grabbing}
		class:cursor-grabbing={grabbable && grabbing}
		opacity={regionOpacity(region.key)}
		data-group-hull={region.key}
		onpointerdown={(event) => onGroupPress?.(event, region.key)}
	>
		{#if region.outlined}
			<path
				d={region.path}
				class="fill-inset stroke-rule"
				stroke-width="1"
				stroke-linejoin="round"
				vector-effect="non-scaling-stroke"
			/>
		{/if}
		<MapRegionLabel {region} {count} {zoom} />
		{#each region.subRegions as subRegion (subRegion.key)}
			{@const subCount = counts.get(subRegion.key)}
			<g
				class="transition-opacity duration-150 ease-out"
				opacity={regionOpacity(subRegion.key)}
				data-sub-hull={subRegion.key}
			>
				{#if subRegion.outlined}
					<path d={subRegion.path} class="fill-chip" />
				{/if}
				<MapRegionLabel region={subRegion} count={subCount} {zoom} />
			</g>
		{/each}
	</g>
{/each}
