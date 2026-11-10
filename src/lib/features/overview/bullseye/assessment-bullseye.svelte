<script lang="ts">
	import { cn } from '#lib/utils.ts';
	import type { Worker } from '#lib/domain-vocabulary.ts';
	import BullseyeChart from './bullseye-chart.svelte';
	import TooltipCallout from './tooltip-callout.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { createTooltip } from './tooltip.svelte.ts';

	let {
		workers,
		class: className,
		zoom = 1,
		arrivalState = 'idle',
		arrivalElapsed = 720,
		onzoomkey
	}: {
		workers: Worker[];
		class?: string;
		zoom?: number;
		arrivalState?: 'idle' | 'running' | 'complete';
		arrivalElapsed?: number;
		onzoomkey?: (next: number) => void;
	} = $props();

	const id = $props.id();
	const tooltip = createTooltip();

	/*
	 * A pin is the fitted form's selection: it keeps the name and the mark's pressed
	 * state after the pointer leaves, until the dot is toggled again, Escape is
	 * pressed, or the reader clicks away. Hovering or focusing another mark previews
	 * that Worker and drops the pin, so the name on screen always belongs to the
	 * pressed mark. The chart announces both changes through its own status.
	 */
	let pinnedId = $state<string | null>(null);

	function clearPin() {
		pinnedId = null;
		tooltip.hide();
	}

	function showDot(worker: Worker, element: SVGCircleElement) {
		if (pinnedId !== null && pinnedId !== worker.id) pinnedId = null;
		tooltip.show(worker, element);
	}

	function hideDot() {
		if (pinnedId === null) tooltip.hide();
	}

	function toggleDot(worker: Worker, element: SVGCircleElement) {
		if (pinnedId === worker.id) {
			clearPin();
			return;
		}
		pinnedId = worker.id;
		tooltip.show(worker, element);
	}
</script>

<svelte:window
	onclick={(event) => {
		if (!(event.target as Element | null)?.closest('[data-worker-id]')) clearPin();
	}}
	onkeydown={(event) => {
		if (event.key === 'Escape' && pinnedId !== null) clearPin();
	}}
/>

<!-- The chart, on the ground, with no card and no key: the Overview's dominant
     object. Everything the removed key used to say — which colour is which
     standing, how many workers hold it, and how far the Committee reaches — is
     carried by the chart's own accessible description, so the meaning goes with
     the marks rather than depending on a visible legend. -->
<div class={cn('flex min-h-0 flex-col items-center gap-3', className)}>
	<figure
		class="relative m-0 flex min-h-0 w-full flex-1 items-center justify-center"
		aria-labelledby={`${id}-chart-title`}
		style={`--fitted-zoom: ${zoom}`}
		bind:this={tooltip.reference}
	>
		<div class="absolute inset-0 flex items-center justify-center">
			<BullseyeChart
				{workers}
				{id}
				class="shrink-0"
				style={`width: calc(100% * ${zoom}); height: calc(100% * ${zoom}); max-width: calc(28rem * ${zoom}); max-height: calc(28rem * ${zoom})`}
				{zoom}
				{arrivalState}
				{arrivalElapsed}
				{onzoomkey}
				activeDotId={tooltip.active?.worker.id ?? null}
				pinnedDotId={pinnedId}
				onshow={showDot}
				onhide={hideDot}
				onfocus={showDot}
				onblur={hideDot}
				ontoggle={toggleDot}
			/>
		</div>
		<!-- Keep the natural fitting width independent of the drawing. Below the
		     no-scroll floor, reserve its zoomed height so it stays in page flow. -->
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox="0 0 256 256"
			class="fitting-space invisible block size-full"
		/>

		<TooltipCallout active={tooltip.active} />
	</figure>
	<p class="text-xs text-ink-2" data-bullseye-label>{m.overview_bullseye_label()}</p>
</div>

<style>
	.fitting-space {
		max-width: 28rem;
		max-height: 28rem;
	}

	@media (width < 64rem), (height < 40rem) {
		.fitting-space {
			height: auto;
			max-height: none;
			aspect-ratio: calc(1 / var(--fitted-zoom));
		}
	}
</style>
