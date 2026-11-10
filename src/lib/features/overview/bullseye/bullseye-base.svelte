<script lang="ts">
	/**
	 * The Overview bullseye as a ground: larger than its frame, clipped, drawn
	 * behind the shell as the dashboard's faded floor. At rest it is inert and
	 * hidden from assistive technology, and only the drawing is faded and
	 * blurred; focused it grows in place and answers drag, wheel and zoom keys.
	 * The name callout is lifted out of the clip so the layering cannot hide it.
	 */
	import { untrack } from 'svelte';
	import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { cn } from '#lib/utils.ts';
	import BullseyeChart from './bullseye-chart.svelte';
	import { DOT_FOOTPRINT } from './bullseye-geometry.ts';
	import { bullseyeView } from './bullseye-view.ts';
	import { overviewFocus } from '../overview-focus.svelte.ts';
	import { zoomAfterWheel } from './pan-mappings.ts';
	import { floorPlacement } from '../overview-dashboard-presentation.ts';
	import { createDragPan } from './pan.svelte.ts';
	import TooltipCallout from './tooltip-callout.svelte';
	import { createTooltip } from './tooltip.svelte.ts';
	import type { NameTag } from './worker-label.ts';

	let {
		workers,
		attributes,
		class: className,
		zoom = 1,
		arrivalState = 'idle',
		arrivalElapsed = 720
	}: {
		workers: Worker[];
		attributes: readonly WorkerAttributeDefinition[];
		class?: string;
		zoom?: number;
		arrivalState?: 'idle' | 'running' | 'complete';
		arrivalElapsed?: number;
	} = $props();

	const id = $props.id();
	/** The shell holds the one shared scale; this ground reads it and sets it. */
	const view = bullseyeView();
	/** The slid strip's right edge, in the frame's coordinates: the drag's left limit. */
	let columnRight = $state(0);
	/** The frame's own size, read from the ground element: what the floor's placement is measured from. */
	let frameWidth = $state(0);
	let frameHeight = $state(0);
	/* The shell's focus state: at rest the floor is faded and inert, focused it
	   grows in place and answers the pointer. */
	const focus = overviewFocus();
	const placement = $derived(floorPlacement(frameWidth, frameHeight, focus.focused));
	const pan = createDragPan(() => columnRight);
	const tooltip = createTooltip();
	let ground = $state<HTMLElement>();
	/* A click centres a Worker and dims the rest of the chart to their ties; clicking
	   them again, the chart's empty ground, or Escape clears it. */
	let selectedId = $state<string | null>(null);
	/** The selected worker and their ties, named for as long as the selection stands. */
	let nameTags = $state<NameTag[]>([]);

	/**
	 * The frame's own measure: the slid dashboard's remaining strip and its right
	 * edge, which the drag's bound reads. At rest that edge is the dashboard's
	 * own right side; focused it is the edge of the strip left under the chart
	 * and the rail. Reading it from the page rather than from the stylesheet
	 * keeps density out of the arithmetic.
	 */
	function measure(scale: number = zoom) {
		const bounds = ground;
		if (!bounds) return;

		frameWidth = bounds.clientWidth;
		frameHeight = bounds.clientHeight;

		const dashboard = document.querySelector('[data-dashboard]');
		columnRight = dashboard
			? Math.max(0, dashboard.getBoundingClientRect().right - bounds.getBoundingClientRect().left)
			: 0;

		/* The travel's centre is the placement's own, read arithmetically: the
		   layer's offsets still hold the previous placement on the first measure
		   after it moves, which would drag the resting chart off its floor. */
		pan.measure(scale, { x: placement.centerX, y: placement.centerY });
		/* At rest there is no bound and no gesture, so the chart sits exactly on
		   its placement and a clamp built for the focused strip cannot shift it. */
		if (!focus.focused) pan.reset();
	}

	/**
	 * The wheel is the ground's own gesture: the scale changes about the point under
	 * the pointer, so the ring being read stays under it. The event's default is
	 * cancelled so the surface never scrolls under the chart.
	 */
	function onWheel(event: WheelEvent) {
		/* The wheel answers only while focused; at rest the ground is inert and the
		   event never reaches it, but the guard keeps the gesture honest. */
		if (!focus.focused) return;
		const scale = zoom;
		const next = zoomAfterWheel(scale, event.deltaY, event.deltaMode);
		event.preventDefault();
		if (next === scale) return;

		const layer = pan.layer;
		const bounds = ground;
		if (!layer || !bounds) return;

		const box = bounds.getBoundingClientRect();
		pan.zoomAnchored(
			{
				x: event.clientX - box.left - layer.offsetLeft,
				y: event.clientY - box.top - layer.offsetTop
			},
			next / scale,
			next
		);
		view.setZoom(next);
	}

	function showDot(worker: Worker, element: SVGCircleElement) {
		tooltip.show(worker, element);
	}

	function hideDot() {
		tooltip.hide();
	}

	function focusDot(worker: Worker, element: SVGCircleElement) {
		// Keyboard focus can land on a dot the pointer never dragged to.
		// The callout is placed from the dot's position, so it waits for the glide to land.
		pan.snapIntoView(element, () => tooltip.show(worker, element));
	}

	/** A click selects the Worker and glides their dot to the middle; a second click clears it. */
	function toggleDot(worker: Worker, element: SVGCircleElement) {
		selectedId = selectedId === worker.id ? null : worker.id;
		if (selectedId) pan.snapIntoView(element);
	}

	function onKeydown(event: KeyboardEvent) {
		/* Clearing a pin consumes the Escape, so leaving focus does not also fire:
		   the dot's own Escape wins. */
		if (event.key === 'Escape' && selectedId && !event.defaultPrevented) {
			selectedId = null;
			event.preventDefault();
		}
		focus.handleKeydown(event);
	}

	$effect(() => {
		if (!ground) return;
		pan.bounds = ground;
		tooltip.reference = ground;
		untrack(() => measure());

		const observer = new ResizeObserver(() => measure());
		observer.observe(ground);

		/* The gesture is followed on the window rather than on the ground: a quick drag
		   can leave the chart's own subtree — the chart sits behind the leading column,
		   and its events are not ours to hear there — before it has moved far enough to
		   count as a drag, and the gesture would then end before it had begun. */
		window.addEventListener('pointermove', pan.move, { passive: true });
		window.addEventListener('pointerup', pan.end);
		window.addEventListener('pointercancel', pan.end);

		return () => {
			observer.disconnect();
			window.removeEventListener('pointermove', pan.move);
			window.removeEventListener('pointerup', pan.end);
			window.removeEventListener('pointercancel', pan.end);
			pan.cancel();
		};
	});

	/* The scale is the layer's size, so a new scale is a new resting box: re-measure
	   the travel, and drop a name that no longer sits on its dot. */
	$effect(() => {
		const scale = zoom;
		untrack(() => {
			tooltip.hide();
			measure(scale);
		});
	});

	/* A drag leaves no name behind: the callout is placed once and the chart moves
	   out from under it, so the drag takes it away as soon as it is really a drag. */
	$effect(() => {
		if (pan.dragging) tooltip.hide();
	});

	/* The dashboard's sliding edge is the drag's bound: re-read it on every focus
	   flip, and once the 650ms slide lands, so a drag mid-slide still has a bound
	   and the settled bound is exact. */
	$effect(() => {
		const flipped = focus.focused;
		untrack(() => measure());
		const landed = window.setTimeout(() => {
			if (focus.focused === flipped) measure();
		}, 700);
		return () => window.clearTimeout(landed);
	});
</script>

<svelte:window
	onclick={(event) => {
		const target = event.target as Element | null;
		// The click that ends a drag is the pan's tail, not a click on the chart.
		if (pan.takeDragTail()) return;
		if (!target?.closest('[data-worker-id]')) tooltip.hide();
		// Only the chart's own ground clears a selection; the page's panels leave it.
		if (target?.closest('[data-bullseye-pan-surface]')) selectedId = null;
	}}
	onkeydown={onKeydown}
/>

<!-- The ground itself: inert and hidden from assistive technology at rest, so no
     dot is in the tab order and no pointer event reaches the chart below the
     dashboard; focused it rises above the dashboard and answers. -->
<div
	class={cn(
		'pointer-events-none absolute inset-0 [clip-path:inset(0_0_0_calc(-1*var(--overview-rail-reach)))]',
		focus.focused ? 'z-[3]' : '-z-10',
		className
	)}
	class:cursor-grab={!pan.dragging}
	class:cursor-grabbing={pan.dragging}
	bind:this={ground}
	inert={!focus.focused}
	aria-hidden={!focus.focused}
	data-bullseye-base
	onpointerdown={(event) => {
		/* The drag answers only while focused; at rest a press falls through. */
		if (focus.focused) pan.start(event);
	}}
	onwheel={onWheel}
>
	<!-- The chart that is not a dot has to be draggable too, and the ground itself is
	     inert at rest: this surface is the hit target for the whole frame while
	     focused, including the faded strip on the left where the dashboard sits
	     inert beneath the chart. At rest it collapses to the dashboard's own right
	     edge so it takes no pointer. It is drawn before the layer so the dots win
	     the pointer where they sit. -->
	<div
		bind:this={pan.surface}
		data-bullseye-pan-surface
		class="pointer-events-auto absolute"
		style="left: {focus.focused ? 0 : columnRight}px; top: 0; right: 0; bottom: 0"
	></div>

	<!-- The chart, sized at 1.4x the frame's height and centred at 77% of its
	     width and 69% of its height, measured from the ground element itself.
	     The size is the frame's height times the reader's scale, and that is
	     load-bearing rather than a taste: the chart is resized rather than scaled by
	     a transform, so its ring names keep reading at interface pixels and its dots
	     keep their own proportions at every scale. The reader's drag is the only
	     offset on top of that placement, and the travel it is held inside is read
	     from this box. Opacity and blur sit on the drawing, not the layer. -->
	<div
		bind:this={pan.layer}
		data-bullseye-layer
		class="absolute aspect-square max-w-none will-change-transform"
		style="width: {zoom *
			placement.size}px; left: {placement.centerX}px; top: {placement.centerY}px; transform: translate(-50%, -50%) translate3d({pan.x}px, {pan.y}px, 0)"
	>
		<!-- The focus growth sits inside the pan: scaling here leaves the drag's
		     one-for-one travel and its bound in unscaled units, and only the scale
		     animates, so a drag or a glide never lags a transform transition. -->
		<div
			class="focus-scale absolute inset-0"
			style="scale: {placement.scale}; transform-origin: {placement.origin}"
		>
			<BullseyeChart
				{workers}
				{id}
				class="chart-drawing size-full {focus.focused ? 'opacity-100' : 'opacity-30 blur-[2px]'}"
				{zoom}
				{arrivalState}
				{arrivalElapsed}
				onzoomkey={(next) => {
					if (focus.focused) view.setZoom(next);
				}}
				activeDotId={tooltip.active?.worker.id ?? selectedId}
				selectedDotId={selectedId}
				pinnedDotId={selectedId}
				onhighlight={(tags) => (nameTags = tags)}
				onshow={showDot}
				onhide={hideDot}
				onfocus={focusDot}
				onblur={hideDot}
				ontoggle={toggleDot}
			/>

			<!-- Inside the layer, so the tags pan and resize with the dots they name, and
		     set at interface size, since the layer is resized rather than scaled. -->
			<div
				class="[container-type:inline-size] pointer-events-none absolute inset-0"
				aria-hidden="true"
			>
				{#each nameTags as tag (tag.id)}
					<span
						class={[
							'absolute rounded-control border border-rule-strong bg-panel px-2 py-1 text-xs whitespace-nowrap text-ink shadow-tooltip',
							tag.id === selectedId && 'z-10 font-semibold'
						]}
						data-dot-name={tag.id}
						style="left: {(tag.cx / 256) * 100}%; top: {(tag.cy / 256) *
							100}%; transform: translate(-50%, calc(-100% - {((DOT_FOOTPRINT / 256) * 100).toFixed(
							3
						)}cqw - 0.5rem));"
					>
						{tag.name}
						<!-- The pointer: the tag reads as attached to its dot, not floating near it. -->
						<span
							class="absolute top-full left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-r border-b border-rule-strong bg-panel"
						></span>
					</span>
				{/each}
			</div>
		</div>
	</div>
</div>

<!-- Above the shell and outside the clip, so the ground's layering cannot hide it. -->
<TooltipCallout active={tooltip.active} {attributes} />

<style>
	/* The focus growth and the drawing's fade share the dashboard's 650ms curve.
	   The blur switches without animating: animating it was measured as too slow. */
	.focus-scale {
		transition: scale 650ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.chart-drawing {
		transition: opacity 650ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	/* The focus change is instant under reduced motion. */
	@media (prefers-reduced-motion: reduce) {
		:global(html:not([data-motion='full'])) .focus-scale,
		:global(html:not([data-motion='full'])) .chart-drawing {
			transition-duration: 1ms;
		}
	}
	:global(html[data-motion='reduce']) .focus-scale,
	:global(html[data-motion='reduce']) .chart-drawing {
		transition-duration: 1ms;
	}
</style>
