<script lang="ts">
	import { ARRIVAL_DURATION_MS } from '../overview-arrival-lifecycle.ts';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { assessmentColorFor } from '#lib/shared/assessment.ts';
	import type { Worker } from '#lib/domain-vocabulary.ts';
	import { assessmentGroupLabel, assessmentLabel } from '#lib/i18n/assessment.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.ts';
	import {
		CHART_CENTER,
		DOT_FOOTPRINT,
		DOT_RADIUS,
		DOT_STROKE_WIDTH,
		DRAWN_ASSESSMENTS,
		labelArcPath
	} from './bullseye-geometry.ts';
	import { bullseyeLayout } from './bullseye-lanes.ts';
	import { nearestTarget } from './dot-hit.ts';

	import { zoomAfterKey } from './pan-mappings.ts';
	import { assessmentCounts as countAssessments, committeeReach } from './reach.ts';
	import { workerLabel, type NameTag } from './worker-label.ts';

	/**
	 * The bullseye's drawing, and nothing else: bands, tie lines, dots and their
	 * accessible description. It owns no chrome and no tooltip — the caller draws
	 * the frame and is told when a dot is entered, left, focused or toggled, so it
	 * can place a name wherever its own layering needs it.
	 */
	let {
		workers,
		id,
		class: className,
		style,
		zoom = 1,
		pinnedDotId = null,
		arrivalState = 'idle',
		arrivalElapsed = 720,
		activeDotId = null,
		selectedDotId = null,
		onhighlight,
		onshow,
		onhide,
		onfocus,
		onblur,
		ontoggle,
		onzoomkey
	}: {
		workers: Worker[];
		/** Base for the chart's own `<title>` and `<desc>` ids. */
		id: string;
		class?: string;
		/** The chart's own box limits, set by whoever sizes it. */
		style?: string;
		/** The scale the reader has set, used for the description and the keyboard step. */
		zoom?: number;
		/** The Worker whose name is pinned, so the mark carries its pressed state. */
		pinnedDotId?: string | null;
		arrivalState?: 'idle' | 'running' | 'complete';
		arrivalElapsed?: number;
		/** The worker whose ties are highlighted, if any. */
		activeDotId?: string | null;
		/** The worker the reader clicked: every dot and tie outside their reach is dimmed. */
		selectedDotId?: string | null;
		/** Told the selected worker and everyone tied to them, with where their dots sit, for the caller's name tags. */
		onhighlight?: (tags: NameTag[]) => void;
		/** Pointer entered a dot. */
		onshow?: (worker: Worker, element: SVGCircleElement) => void;
		/** Pointer left a dot, or Escape was pressed. */
		onhide?: () => void;
		/** Keyboard focus arrived on a dot. */
		onfocus?: (worker: Worker, element: SVGCircleElement) => void;
		/** Keyboard focus left a dot. */
		onblur?: () => void;
		ontoggle?: (worker: Worker, element: SVGCircleElement) => void;
		/** A zoom key was pressed; the caller sets the new scale. */
		onzoomkey?: (next: number) => void;
	} = $props();

	/** The selected worker and the workers the chart draws a tie to them: everything else recedes. A relationship the chart does not draw does not count. */
	const selectedReach = $derived.by(() => {
		if (!selectedDotId) return null;
		const reach = new SvelteSet([selectedDotId]);
		for (const line of layout.ties) {
			if (line.from === selectedDotId) reach.add(line.to);
			else if (line.to === selectedDotId) reach.add(line.from);
		}
		return reach;
	});

	/** The drawn bands, outermost first, so the description names the rings in chart order. */
	const ringOrder = [...DRAWN_ASSESSMENTS].reverse();
	/** Display names used only by this chart; assessment values remain canonical. */
	const ringDisplayName = (assessment: Worker['assessment']) => assessmentGroupLabel(assessment);
	/** The centre ring reads as one Leader, so its count keeps the singular label. */
	const ringCountName = (assessment: Worker['assessment']) =>
		assessment === 'Leader' ? assessmentLabel(assessment) : assessmentGroupLabel(assessment);
	/** The drawn standings' names, which the layout keeps clear for each ring's name. */
	const ringNames = $derived({
		Leader: ringDisplayName('Leader'),
		Activist: ringDisplayName('Activist'),
		Supporter: ringDisplayName('Supporter'),
		Disengaged: ringDisplayName('Disengaged')
	});

	const assessmentCounts = $derived(countAssessments(workers));

	/* The reach stated once. The chart carries it in its description for AT, and
	   Overview prints the same sentence wherever the chart is a ground, so both
	   read from one owner. */
	const reachLabel = $derived(committeeReach(assessmentCounts));

	/** The colour map, which used to be the visible key: outermost ring first. */
	const colourMap = $derived(
		[
			...ringOrder.map((assessment) =>
				m.overview_bullseye_ring_count({
					assessment: ringCountName(assessment),
					count: assessmentCounts[assessment]
				})
			),
			m.overview_bullseye_hostile_outside({
				assessment: assessmentGroupLabel('Hostile'),
				count: assessmentCounts.Hostile
			}),
			m.overview_bullseye_unassessed_not_plotted({
				assessment: assessmentGroupLabel('Unassessed'),
				count: assessmentCounts.Unassessed
			})
		].join('. ')
	);

	/* Bands, dots and routed ties come from one layout, because the ties' lanes
	   may ask the bands for room. */
	const layout = $derived(bullseyeLayout(workers, assessmentCounts, ringNames));
	const ringGeometry = $derived(layout.bands);

	/** The break a lane run keeps under a leg crossing it, as a circle's radius. */
	const TIE_GAP_RADIUS = 1.3;

	/**
	 * The chart's names' type and their halo, in interface pixels. All of them are
	 * the Label step, so the chart speaks in one voice and its words belong to the
	 * page's type scale rather than to the drawing's.
	 */
	const RING_LABEL_PX = 11;
	const LABEL_HALO_PX = 3;
	/** The Committee's name at the centre: the same Label step as the rings, one ink step stronger. */
	const CENTRE_LABEL_PX = 11;
	const CENTRE_LABEL_MIN_PX = 11;
	/** The longer word of that name, in em, for fitting it to the centre's room. */
	const CENTRE_LABEL_EM = 7.5;
	/** Clearance between a ring's dots and its name where the ring has no boundary. */
	const TRACK_LABEL_GAP = 1.5;
	/**
	 * A ring's name is centred on its band's centreline, not set against its edge.
	 * The inset is the baseline's offset from that centreline, in em, which centres
	 * the word's ink on it. The band keeps a wedge clear of dots for the word (see
	 * `ringLabelWedge`), so the word lands in open space.
	 */
	const RING_LABEL_INSET_EM = 0.35;
	const RING_LABEL_INK_HALF_EM = 0.35;
	/** Half the Hostile name's ink height at the Label step, at a typical 2 px to the unit. */
	const HOSTILE_LABEL_HALF_INK = RING_LABEL_PX * RING_LABEL_INK_HALF_EM * 0.5;

	/* The chart's own rendered width, which is what turns an interface type step
	   into a user unit. The same chart is drawn at 1.2 px to the unit as a fitted
	   chart on a phone and at nearly 5 as the dragged ground on a wide screen, so a
	   name sized in user units would be a smudge at one end and a headline at the
	   other; measured, one chart reads the same at both. */
	let svgElement = $state<SVGSVGElement>();
	let renderedWidth = $state(0);
	let measuredZoom = $state<number | null>(null);
	$effect(() => {
		const currentZoom = zoom;
		if (!svgElement) return;
		const measure = () => {
			renderedWidth = svgElement?.getBoundingClientRect().width ?? 0;
			measuredZoom = currentZoom;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(svgElement);
		return () => observer.disconnect();
	});

	/* The chart is resized with zoom. Scale the last measured width immediately
	   with the zoom prop, before ResizeObserver reports the new DOM dimensions. */
	const pxPerUnit = $derived(
		renderedWidth > 0 && measuredZoom !== null
			? (renderedWidth * (zoom / measuredZoom)) / (CHART_CENTER * 2)
			: 0
	);
	const labelSize = $derived(pxPerUnit > 0 ? RING_LABEL_PX / pxPerUnit : 0);
	const labelHalo = $derived(pxPerUnit > 0 ? LABEL_HALO_PX / pxPerUnit : 0);

	/*
	 * The Committee's name, set in the room the innermost band holds clear for it.
	 * It takes the Body step where that room allows it and shrinks to fit where it
	 * does not, but it is left out rather than set below the Label step: a chart
	 * too small to carry the name legibly is a chart that shows the Committee by
	 * its dots alone, which is what the description is for.
	 */
	const centreLabel = $derived.by(() => {
		const leader = ringGeometry[0];
		if (!leader || pxPerUnit === 0) return null;
		const chordPx = 2 * leader.packingInnerRadius * pxPerUnit;
		const sizePx = Math.min(CENTRE_LABEL_PX, chordPx / CENTRE_LABEL_EM);
		if (sizePx < CENTRE_LABEL_MIN_PX) return null;
		return { size: sizePx / pxPerUnit, halo: LABEL_HALO_PX / pxPerUnit };
	});

	/*
	 * A ring's name sits inside that ring, just below the edge it names. Hostile is
	 * the exception: it holds no band, so its name sits on the ground beyond its
	 * own track instead, clear of the dots by a gap and its own upper half. Each
	 * name takes the stop of whatever it is drawn on as its halo, so the ties
	 * crossing it break behind the word while the boundary above it stays whole.
	 * The Leader ring carries no name on its edge, because its name is the centre.
	 */
	const ringLabels = $derived([
		...ringGeometry
			.filter((ring) => ring.assessment !== 'Leader')
			.map((ring) => ({
				text: ringDisplayName(ring.assessment),
				radius: (ring.innerRadius + ring.outerRadius) / 2,
				halo: ring.fill,
				inset: RING_LABEL_INSET_EM
			})),
		{
			text: assessmentGroupLabel('Hostile'),
			/* Fixed in user units: a radius that followed the measured label size moved the
			   word on every resize or zoom frame. Hostile holds no band, so its name
			   carries no halo stroke. */
			radius: layout.hostileRadius + DOT_FOOTPRINT + TRACK_LABEL_GAP + HOSTILE_LABEL_HALF_INK,
			halo: 'none',
			inset: 0
		}
	]);

	/**
	 * The stop each mark is drawn on, so a dot's halo is the surface beneath it
	 * rather than one tone that reads on half the rings and vanishes on the rest.
	 * Hostile sits on the page outside the bands, so its dots carry no halo stroke.
	 */
	const bandFillFor = $derived(
		new Map<string, string>([
			...ringGeometry.map((ring) => [ring.assessment as string, ring.fill] as const),
			['Hostile', 'none']
		])
	);
	const plottedWorkers = $derived(layout.groups);
	const allDots = $derived(plottedWorkers.flatMap((group) => group.dots));

	/*
	 * Two things a keyboard reader changes here cannot be seen: which Worker's
	 * name is pinned, and the scale the zoom keys set. Both are mirrored into one
	 * mounted polite status, so the change is announced instead of only drawn.
	 */
	let statusText = $state('');
	let announcedPinnedId: string | null = null;
	$effect(() => {
		const id = pinnedDotId;
		if (id === announcedPinnedId) return;
		if (id) {
			const worker = workers.find((entry) => entry.id === id);
			if (!worker) return;
			announcedPinnedId = id;
			statusText = m.overview_chart_pinned({ label: workerLabel(worker) });
			return;
		}
		const hadPinned = announcedPinnedId !== null;
		announcedPinnedId = null;
		if (hadPinned) statusText = m.overview_chart_pin_cleared();
	});

	const dotRevealBuckets = $derived.by(() => {
		const ordered = [...allDots].sort(
			(a, b) => a.cx - b.cx || a.worker.id.localeCompare(b.worker.id)
		);
		const buckets = new SvelteMap<string, number>();
		for (const dot of ordered) {
			const horizontalBucket = Math.min(15, Math.floor((dot.cx / 256) * 16));
			buckets.set(dot.worker.id, horizontalBucket);
		}
		return buckets;
	});

	/** FNV-1a, so each dot's flicker is random-looking but identical on every visit. */
	const hashOf = (id: string) => {
		let hash = 2166136261;
		for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
		return hash >>> 0;
	};
	/** A rough left-to-right sweep like current finding its way along the tube, with per-dot jitter. */
	const arrivalFlickerFor = (id: string) => ['a', 'b', 'c'][(hashOf(id) >>> 9) % 3];
	const arrivalDelayFor = (id: string) =>
		250 + (dotRevealBuckets.get(id) ?? 0) * 40 + (hashOf(id) % 420);
	const arrivalStyleFor = (id: string) => `--arrival-delay:${arrivalDelayFor(id)}ms`;
	/** A tie leaves its inner dot once that dot has stopped flickering. */
	const tieStyleFor = (from: string) => `--arrival-delay:${arrivalDelayFor(from) + 250}ms`;

	/* The ties draw themselves by dash offset. Their stroke is non-scaling, so the
	   dash lengths are screen pixels: measure each path's length on screen. */
	$effect(() => {
		if (arrivalState !== 'running' || !svgElement) return;
		for (const path of svgElement.querySelectorAll<SVGPathElement>('path.tie')) {
			const scale = path.getScreenCTM()?.a ?? 1;
			path.style.setProperty('--tie-length', `${path.getTotalLength() * scale + 2}px`);
		}
	});

	$effect(() => {
		const reach = selectedReach;
		onhighlight?.(
			reach
				? allDots
						.filter((dot) => reach.has(dot.worker.id))
						.map((dot) => ({ id: dot.worker.id, name: dot.worker.name, cx: dot.cx, cy: dot.cy }))
				: []
		);
	});

	const relationshipLines = $derived(layout.ties);

	const tieSummary = $derived.by(() => {
		const reached = new Set(relationshipLines.map((line) => line.to));
		return {
			ties: relationshipLines.length,
			reached: reached.size
		};
	});

	/** The ties stated as one complete sentence, pluralized in both counts. */
	const tieSentence = $derived.by(() => {
		const { ties, reached } = tieSummary;
		if (ties === 0) return m.overview_bullseye_ties_none();
		const inputs = { ties, reached };
		if (ties === 1) {
			return reached === 1
				? m.overview_bullseye_ties_one_one(inputs)
				: m.overview_bullseye_ties_one_many(inputs);
		}
		return reached === 1
			? m.overview_bullseye_ties_many_one(inputs)
			: m.overview_bullseye_ties_many_many(inputs);
	});

	/** Roving tab index: exactly one dot is in the page's tab order at a time. */
	let activeDotIndex = $state(0);
	const dotElements: (SVGCircleElement | undefined)[] = $state([]);

	function focusDot(index: number) {
		const clamped = Math.min(Math.max(index, 0), allDots.length - 1);
		activeDotIndex = clamped;
		dotElements[clamped]?.focus();
	}

	function handleDotKeydown(event: KeyboardEvent, index: number, worker: Worker) {
		if (event.key === 'Escape') {
			onhide?.();
			return;
		}
		/* The click only pins the name the dot already shows on focus, so Enter and
		   Space give that same toggle without a pointer. */
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			const element = dotElements[index];
			if (element) ontoggle?.(worker, element);
			return;
		}
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (step === undefined) {
			if (event.key === 'Home') {
				event.preventDefault();
				focusDot(0);
			} else if (event.key === 'End') {
				event.preventDefault();
				focusDot(allDots.length - 1);
			}
			return;
		}
		event.preventDefault();
		focusDot(index + step);
	}

	/** The scale as the reader's status reads it: 1.25×, 2×, 0.5×. */
	const formatScale = (value: number) => String(Number(value.toFixed(2)));

	function handleChartKeydown(event: KeyboardEvent) {
		const next = zoomAfterKey(zoom, event.key);
		if (next === zoom) return;
		event.preventDefault();
		onzoomkey?.(next);
		statusText = m.overview_chart_scale_status({ zoom: formatScale(next) });
	}

	/**
	 * The fitted chart is the form a coarse pointer gets, and a Worker's mark is
	 * only a few screen pixels across there. A tap aims at a point rather than at a
	 * shape, so it is answered by the nearest mark inside the physical 44px target;
	 * the painted circle keeps its size and a fine pointer's behaviour is untouched.
	 */
	function handleChartTap(event: MouseEvent) {
		if (!window.matchMedia('(pointer: coarse)').matches) return;
		const element = svgElement;
		const target = event.target as Element | null;
		if (!element || target?.closest('[data-worker-id]')) return;
		const matrix = element.getScreenCTM();
		if (!matrix) return;
		const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
		const scale = Math.hypot(matrix.a, matrix.b);
		if (!(scale > 0)) return;
		const nearest = nearestTarget(
			allDots.map((dot) => ({ id: dot.worker.id, cx: dot.cx, cy: dot.cy })),
			local.x,
			local.y,
			22 / scale
		);
		if (!nearest) return;
		const index = allDots.findIndex((dot) => dot.worker.id === nearest.id);
		const circle = dotElements[index];
		if (!circle) return;
		/* The tap is the chart's own: the page's outside-click dismissal must not
		   undo the pin this tap just made. */
		event.stopPropagation();
		ontoggle?.(allDots[index].worker, circle);
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<svg
	class={cn('block size-full', className)}
	{style}
	viewBox="0 0 256 256"
	class:arrival-running={arrivalState === 'running' && arrivalElapsed < ARRIVAL_DURATION_MS}
	role="group"
	aria-labelledby={`${id}-chart-title`}
	aria-describedby={`${id}-chart-description`}
	onkeydown={handleChartKeydown}
	onclick={handleChartTap}
	bind:this={svgElement}
>
	<title id={`${id}-chart-title`}>{m.overview_bullseye_title()}</title>
	<desc id={`${id}-chart-description`}>
		{colourMap}. {reachLabel}. {m.overview_bullseye_unassessed_note()}
		{tieSentence}
		{m.overview_bullseye_scale({ zoom })}
	</desc>

	<!-- Bands, outside in: each is a true annulus, so the grey and the panel
		     white alternate instead of stacking into one wash. The innermost
		     band — the Organizing Committee — gets a stronger outer boundary, so
		     the origin of the radius reads as the Committee itself rather than
		     the first of four bands. -->
	{#each [...ringGeometry].reverse() as ring (ring.assessment)}
		<path
			d={ring.path}
			fill={ring.fill}
			stroke="var(--rule)"
			stroke-width={ring.innerRadius === 0 ? 1.5 : 1}
			vector-effect="non-scaling-stroke"
		/>
	{/each}

	<!-- The inner boundary of each band, drawn as a dashed stroke of its own
		     circle so the line stays circular; 2πr holds with or without pathLength. -->
	{#each ringGeometry as ring (ring.assessment)}
		{#if ring.innerRadius > 0}
			<circle
				cx={CHART_CENTER}
				cy={CHART_CENTER}
				r={ring.outerRadius}
				fill="none"
				stroke="var(--rule)"
				stroke-width="1"
				stroke-dasharray={ring.dashArray}
				stroke-dashoffset={ring.dashOffset}
				vector-effect="non-scaling-stroke"
			/>
		{/if}
	{/each}

	<!-- Ties are hairlines drawn from the ramp with rank carried by the
		     stop, never by a wash of the ink role: at fifty workers the old
		     1.5-unit stroke at 40% opacity laid a grey web over the bands and
		     the chart read as noise. Three stops give the same hierarchy —
		     idle recedes, the default holds, the hovered worker comes forward.
		     Each tie leaves its inner dot straight out, runs along a circular
		     lane between two bands' rows and turns straight out to the outer
		     dot, so ties only cross at right angles; where one does, the lane
		     run breaks under the leg through a mask. A tie that found no lane is
		     drawn only while one of its ends is active. -->
	{#each relationshipLines as line, index (line.id)}
		{@const active = line.from === activeDotId || line.to === activeDotId}
		{#if !line.revealOnly || active}
			{#if line.gaps.length > 0}
				<defs>
					<mask
						id={`${id}-tie-gap-${index}`}
						maskUnits="userSpaceOnUse"
						x="0"
						y="0"
						width="256"
						height="256"
					>
						<rect x="0" y="0" width="256" height="256" fill="white" />
						{#each line.gaps as gap, gapIndex (gapIndex)}
							<circle cx={gap.x} cy={gap.y} r={TIE_GAP_RADIUS} fill="black" />
						{/each}
					</mask>
				</defs>
			{/if}
			<path
				class={[
					'tie',
					activeDotId && (active ? 'tie-active' : 'tie-idle'),
					selectedDotId && line.from !== selectedDotId && line.to !== selectedDotId && 'dimmed'
				]}
				d={line.d}
				style={tieStyleFor(line.from)}
				fill="none"
				stroke="var(--rule-strong)"
				stroke-width="1"
				vector-effect="non-scaling-stroke"
				mask={line.gaps.length > 0 ? `url(#${id}-tie-gap-${index})` : undefined}
			/>
		{/if}
	{/each}

	{#if labelSize > 0}
		<g aria-hidden="true">
			<!-- The Committee's own name, at the chart's centre: the one label not set
			     on an arc, and the only place the origin of the radius is spelled out.
			     The band's dots ring it rather than sit on it. -->
			{#if centreLabel}
				<text
					class="centre-label"
					x={CHART_CENTER}
					y={CHART_CENTER}
					font-size={centreLabel.size}
					stroke-width={centreLabel.halo}
					text-anchor="middle"
				>
					<tspan x={CHART_CENTER} dy="-0.25em">{m.overview_bullseye_centre_one()}</tspan>
					<tspan x={CHART_CENTER} dy="1.2em">{m.overview_bullseye_centre_two()}</tspan>
				</text>
			{/if}
		</g>
	{/if}

	<!-- One dot per assessed worker, each a control: an accessible name, a stable
	     worker id, a roving tab stop, its pinned state and a shared tooltip. -->
	{#each allDots as dot, index (dot.worker.id)}
		<circle
			class="pointer-events-auto"
			cx={dot.cx}
			cy={dot.cy}
			r={DOT_RADIUS}
			fill={assessmentColorFor(dot.worker.assessment)}
			stroke={bandFillFor.get(dot.worker.assessment) ?? 'var(--page)'}
			stroke-width={DOT_STROKE_WIDTH}
			role="button"
			aria-pressed={pinnedDotId === dot.worker.id ? 'true' : 'false'}
			aria-label={workerLabel(dot.worker)}
			data-worker-id={dot.worker.id}
			data-selected={dot.worker.id === selectedDotId ? '' : undefined}
			class:dimmed={selectedReach !== null && !selectedReach.has(dot.worker.id)}
			data-arrival-bucket={dotRevealBuckets.get(dot.worker.id) ?? 0}
			data-arrival-flicker={arrivalFlickerFor(dot.worker.id)}
			style={arrivalStyleFor(dot.worker.id)}
			tabindex={index === activeDotIndex ? 0 : -1}
			bind:this={dotElements[index]}
			onmouseenter={(event) => onshow?.(dot.worker, event.currentTarget)}
			onmouseleave={() => onhide?.()}
			onfocus={(event) => {
				activeDotIndex = index;
				onfocus?.(dot.worker, event.currentTarget);
			}}
			onblur={() => onblur?.()}
			onclick={(event) => ontoggle?.(dot.worker, event.currentTarget)}
			onkeydown={(event) => handleDotKeydown(event, index, dot.worker)}
		/>
	{/each}
	<!-- The ring names, set on the arc of each ring's centreline and drawn after the
		     dots, so each name paints over them. Pointer events are off: a dot under a
		     name stays hoverable. Decorative to AT: the description above already names
		     every ring, its count and its place. -->
	{#if labelSize > 0}
		<g aria-hidden="true" pointer-events="none">
			{#each ringLabels as label (label.text)}
				{@const arcId = `${id}-ring-${label.text}`}
				<path id={arcId} d={labelArcPath(label.radius)} fill="none" />
				<text
					class="ring-label"
					font-size={labelSize}
					stroke={label.halo}
					stroke-width={labelHalo}
					dominant-baseline="middle"
					dy={`${label.inset}em`}
				>
					<textPath href={`#${arcId}`} startOffset="50%" text-anchor="middle">{label.text}</textPath
					>
				</text>
			{/each}
		</g>
	{/if}
</svg>

<!-- The chart's own polite status: the pinned Worker, and the keyboard scale.
     Kept outside the SVG so a screen reader treats it as a live region. -->
<span class="sr-only" role="status" data-chart-status>{statusText}</span>

<style>
	/* A focused mark must be visible: the dot's own halo stroke is rewritten in
	   the action ink, which flips with the theme, and no browser default is left
	   to draw an unpredictable SVG outline. */
	circle[data-worker-id] {
		outline: none;
		/* Clickable, not draggable-looking: the grab hand belongs to the empty chart. */
		cursor: default;
	}

	circle[data-worker-id]:focus-visible {
		stroke: var(--ink);
		stroke-width: 2.5;
	}

	.tie {
		transition:
			stroke 120ms ease,
			opacity 200ms ease;
	}

	/* A selection pushes everything outside the selected worker's reach back, so
	   their ties and the workers at the other end read at a glance. */
	.dimmed {
		opacity: 0.2;
	}

	circle[data-worker-id] {
		transition: opacity 200ms ease;
	}

	.arrival-running circle[data-worker-id] {
		opacity: 0;
		animation-duration: 640ms;
		animation-timing-function: step-end;
		animation-fill-mode: both;
		animation-delay: var(--arrival-delay);
	}

	/* Ties draw out from their inner dot. Until measured, the fallback length hides them. */
	.arrival-running path.tie {
		stroke-dasharray: var(--tie-length, 9999px);
		stroke-dashoffset: var(--tie-length, 9999px);
		animation: bullseye-tie-draw 700ms ease-in-out var(--arrival-delay) both;
	}

	@keyframes bullseye-tie-draw {
		to {
			stroke-dashoffset: 0;
		}
	}

	/* Literal keyframe names: Svelte scopes them, and a var() would dodge the rewrite. */
	.arrival-running circle[data-arrival-flicker='a'] {
		animation-name: arrival-flicker-a;
	}

	.arrival-running circle[data-arrival-flicker='b'] {
		animation-name: arrival-flicker-b;
	}

	.arrival-running circle[data-arrival-flicker='c'] {
		animation-name: arrival-flicker-c;
	}

	.arrival-running circle[data-worker-id]:focus-visible,
	.arrival-running circle[data-worker-id]:hover {
		opacity: 1;
		animation: none;
	}

	@media (prefers-reduced-motion: reduce) {
		:global(html:not([data-motion='full'])) .arrival-running circle[data-worker-id],
		:global(html:not([data-motion='full'])) .arrival-running path.tie {
			animation: none;
			opacity: 1;
			stroke-dasharray: none;
			stroke-dashoffset: 0;
		}
	}

	:global(html[data-motion='reduce']) .arrival-running circle[data-worker-id],
	:global(html[data-motion='reduce']) .arrival-running path.tie {
		animation: none;
		opacity: 1;
		stroke-dasharray: none;
		stroke-dashoffset: 0;
	}

	.tie-active {
		stroke: var(--ink);
	}

	.tie-idle {
		stroke: var(--rule);
	}

	/* The ring names: the label voice, muted to the ink floor, set inside the band
	   they name with that band's own stop behind the glyphs — invisible against
	   the ring it sits in, and enough to break any tie hairline crossing the word.
	   Each label is given the band's stop as its stroke. */
	.ring-label {
		font-family: var(--font-mono);
		font-weight: 500;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		fill: var(--ink-3);
		paint-order: stroke;
		stroke-linejoin: round;
	}

	/* The Committee's name at the centre: the same label voice as the ring names,
	   one step of ink stronger, with the innermost band's own stop behind the
	   glyphs so the tie lines converging there break behind the name instead of
	   crossing it. */
	.centre-label {
		font-family: var(--font-mono);
		font-weight: 500;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		fill: var(--ink-2);
		stroke: var(--panel);
		paint-order: stroke;
		stroke-linejoin: round;
	}
</style>
