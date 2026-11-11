<script lang="ts">
	/**
	 * The card shown while a Worker is read on the map: their Assessment, their
	 * relationship count, and every Attribute the worksite asks about.
	 */
	import { Tooltip as LayerTooltip } from 'layerchart';
	import SwatchDot from '#lib/shared/swatch-dot.svelte';
	import { assessmentColorFor } from '#lib/shared/assessment.ts';
	import { assessmentLabel } from '#lib/i18n/assessment.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { answerDisplay } from '../layout/graph-analysis.ts';

	let {
		attributes,
		formatValue
	}: {
		attributes: readonly WorkerAttributeDefinition[];
		formatValue: (value: string | string[] | undefined) => string;
	} = $props();
</script>

<!-- The node card is the one thing on this surface that leaves the
     page, so shadow is what separates it: a border here would be a
     second separator doing the same job. It wears the same skin as the
     bullseye's callout (control radius, panel fill, tooltip shadow);
     `--popover` is the panel's tone and what the theme test reads. The
     name takes the record card's weight, not the library's bold. -->
<LayerTooltip.Root
	variant="none"
	classes={{
		// Under the worker card (z-20) so a hover near it never covers it.
		root: '!z-[15]',
		container:
			'rounded-control bg-popover px-2 py-1 text-sm text-popover-foreground shadow-tooltip [&_.lc-tooltip-header]:font-normal'
	}}
>
	{#snippet children({ data: worker })}
		<LayerTooltip.Header>{worker.name}</LayerTooltip.Header>
		<LayerTooltip.List>
			<LayerTooltip.Item label={m.mapping_table_assessment()}>
				<span class="flex items-center gap-2">
					<SwatchDot color={assessmentColorFor(worker.assessment)} />
					{assessmentLabel(worker.assessment)}
				</span>
			</LayerTooltip.Item>
			<LayerTooltip.Item label={m.domain_relationships()}>
				<span class="num">{worker.relationshipCount}</span>
			</LayerTooltip.Item>
			{#each attributes as attribute (attribute.id)}
				<LayerTooltip.Item
					label={attribute.name}
					value={formatValue(answerDisplay(attribute, worker.attributes))}
				/>
			{/each}
		</LayerTooltip.List>
	{/snippet}
</LayerTooltip.Root>
