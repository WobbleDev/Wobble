<script lang="ts">
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { answerValueReading } from '#lib/shared/no-value-reading.ts';
	import { answerLabels } from '../support-summary.ts';
	import { workerLabel } from './worker-label.ts';
	import type { ActiveTooltip } from './tooltip.svelte.ts';

	let {
		active,
		attributes
	}: {
		active: ActiveTooltip | null;
		/** Given, the callout is the worker's card: their name and every Attribute's answer. */
		attributes?: readonly WorkerAttributeDefinition[];
	} = $props();

	const GAP = 6;
	let height = $state(0);
	let width = $state(0);
	/* The card is taller than a name, so it measures its own room above the dot
	   rather than trusting the name's fixed reserve. */
	const below = $derived(
		active ? (attributes ? active.dotTop < height + GAP : active.below) : false
	);
	const y = $derived(active ? (below ? active.dotBottom : active.dotTop) : 0);
	/*
	 * The callout is centred on its dot, so a mark near either edge would push it
	 * past the reference — and past the shell's clip around it. Clamp the centre to
	 * the reference's own width; a narrow viewport caps the card's own width, and a
	 * reference narrower than the callout centres it rather than overshooting.
	 */
	const x = $derived.by(() => {
		if (!active) return 0;
		if (width === 0 || active.referenceWidth <= 0) return active.x;
		const half = width / 2;
		if (active.referenceWidth <= width) return active.referenceWidth / 2;
		return Math.min(Math.max(active.x, half), active.referenceWidth - half);
	});
</script>

{#if active}
	{#if attributes}
		<section
			class="pointer-events-none absolute z-20 flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-surface bg-panel p-3 shadow-surface"
			data-bullseye-callout
			bind:clientHeight={height}
			bind:clientWidth={width}
			style="left: {x}px; top: {y}px; transform: translate(-50%, {below
				? `${GAP}px`
				: `calc(-100% - ${GAP}px)`});"
			aria-hidden="true"
		>
			<h2 class="title prose-value truncate text-ink" data-bullseye-callout-name>
				{active.worker.name}
			</h2>
			{#if attributes.length > 0}
				<dl class="flex flex-col gap-1">
					{#each attributes as attribute (attribute.id)}
						<div class="flex min-w-0 items-baseline justify-between gap-3">
							<dt class="label shrink-0 text-ink-3">{attribute.name}</dt>
							<dd class="prose-value min-w-0 truncate text-right text-sm text-ink">
								{answerValueReading(attribute, answerLabels(active.worker, attribute))}
							</dd>
						</div>
					{/each}
				</dl>
			{/if}
		</section>
	{:else}
		<div
			class="pointer-events-none absolute z-20 max-w-[calc(100vw-2rem)] rounded-control bg-panel px-2 py-1 text-xs shadow-tooltip"
			data-bullseye-callout
			bind:clientWidth={width}
			style="left: {x}px; top: {active.y}px; transform: translate(-50%, {active.below
				? '0.375rem'
				: 'calc(-100% - 0.375rem)'});"
			aria-hidden="true"
		>
			{workerLabel(active.worker)}
		</div>
	{/if}
{/if}
