<script lang="ts">
	/**
	 * The map's canvas: it asks the arrangement module where every Worker draws
	 * under the current mode, glides the dots from where they were last drawn,
	 * draws the grouping regions behind them, and renders each Worker as a dot
	 * you can read, focus and drag.
	 */
	import { Chart as LayerChart, Layer, Circle } from 'layerchart';
	import * as Chart from '#lib/components/ui/chart/index.ts';
	import { MediaQuery, SvelteMap } from 'svelte/reactivity';
	import { getContext, onDestroy, untrack, type Snippet } from 'svelte';
	import { appSettingsContextKey, type AppSettingsContext } from '#lib/shared/app/app-settings.ts';
	import { createLayoutGate, expectedRootFontPx } from '../map-layout-gate.ts';
	import { reducedMotion as motionIsReduced } from '#lib/shell/motion.svelte.ts';
	import { NARROW_BREAKPOINT } from '#lib/hooks/is-mobile.svelte.ts';
	import { fade } from 'svelte/transition';
	import { cubicInOut } from 'svelte/easing';
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { assessmentLabel } from '#lib/i18n/assessment.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { Point, GroupRegion } from '../layout/graph-layout.ts';
	import {
		freeCanvasBox,
		freeCanvasInMap,
		freeCanvasInsets as readFreeCanvasInsets
	} from '../layout/graph-free-canvas.ts';
	import { cameraForSize, isolateFitPositions, referenceFromCamera } from '../map-view-model.ts';
	import { createArranger, type ArrangeInput } from '../layout/graph-arrangement.ts';
	import {
		applyManual,
		noManual,
		shifted,
		translateGroupRegions,
		type ManualGeometry
	} from '../layout/graph-manual.ts';
	import { attachName, freezeName, thawName, type FrozenName } from '../map-frozen-names.ts';
	import { mapLabelText, type Box as LabelBox } from '../labels/graph-label-placement.ts';
	import type { CompositionInput } from '../composition/graph-composition.ts';
	import {
		estimateTextSnapshot,
		fontsLoadedFor,
		loadFonts,
		measureTextSnapshot,
		textFontRequests,
		type TextSnapshot
	} from '../labels/graph-text-metrics.ts';
	import { boundsOf, frameWithNames, type Rect } from '../labels/map-name-framing.ts';
	import { regionCounts } from '../map-reading.ts';
	import { nodeEase, easeStopThreshold } from '../layout/graph-group-physics.ts';
	import type { WorkerGraphNode } from './worker-relationship-map-model.ts';
	import type { MapViewModel } from '../map-view-model.ts';
	import type { PanZoom } from './map-pan-zoom.svelte.ts';
	import { afterMeasuredMapSurface } from '../map-readiness.ts';
	import { interpretMapKey } from '../map-keyboard.ts';
	import {
		hitRadius,
		isEgoLink,
		linkOpacity,
		isHighlightFaded,
		nodeOpacity,
		nodeRadius,
		nodeStroke,
		screenFixed,
		showsLabel
	} from '../map-style.ts';
	import {
		floatingKeyBoxes,
		keptNames,
		placeAllNames,
		restingNameBoxes as placedRestingNameBoxes,
		wholeMapViewport,
		type Camera,
		type NameScene,
		type PlacedName
	} from '../labels/map-name-placement.ts';
	import {
		flattenedRoutes,
		haloClipPathOf,
		labelViewRegions,
		layoutReservedRects,
		regionKeysOf,
		settledFrameOf,
		textStringsOf
	} from './map-drawing.ts';
	import { createMapDrag } from './map-drag.svelte.ts';
	import { createHoverIntent } from './map-hover-intent.svelte.ts';
	import { createPublishedReport } from './map-canvas-published-report.svelte.ts';
	import MapRegionsLayer from './map-regions-layer.svelte';
	import MapNodeTooltip from './map-node-tooltip.svelte';
	import MapEmptyState from './map-empty-state.svelte';
	import type { MapEmptyKind } from '../map-scope.ts';

	const arrange = createArranger();

	type Props = {
		nodes: readonly WorkerGraphNode[];
		attributes: readonly WorkerAttributeDefinition[];
		groupingAttribute: WorkerAttributeDefinition | undefined;
		subGroupingAttribute: WorkerAttributeDefinition | undefined;
		viewModel: MapViewModel;
		colorFor: (node: WorkerGraphNode) => string;
		radiusFor: (node: WorkerGraphNode) => number;
		formatValue: (value: string | string[] | undefined) => string;
		chartConfig: Chart.ChartConfig;
		panZoom: PanZoom;
		/** The floating strip's measured height, from the toolbar. */
		stripHeight: number;
		/** The floating bottom bar's measured height, from the toolbar. */
		barHeight: number;
		/** The floating key's measured box (bottom-left corner), kept clear of region labels. */
		keySize?: { width: number; height: number };
		/** The dot-size key, floating over the bottom-right corner. */
		dotKeySize?: { width: number; height: number };
		/** Whether the worker card is open, so its column leaves the free canvas. */
		cardOpen: boolean;
		/** The user-set gap between group bodies. */
		groupGap: number;
		/** Which empty state to show, when nobody is drawn. */
		emptyKind: MapEmptyKind | undefined;
		/** The Isolate focus's name, for the empty-Isolate state. */
		isolateName: string | undefined;
		onExitIsolate: () => void;
		/** How many Workers the filters are hiding, for the empty state. */
		hiddenCount: number;
		/**
		 * The toolbar and the rest of the canvas frame. The reset control asks the
		 * canvas to recover the view, because the drawn geometry lives here.
		 */
		children?: Snippet<[{ resetFrame: () => void }]>;
		/** The filter groups currently hiding workers, for the empty state. */
		activeFilterLabels: readonly string[];
		onClearFilters: () => void;
		onSelect: (workerId: string) => void;
		onHover: (workerId: string) => void;
		onReady: () => void;
	};

	let {
		nodes,
		attributes,
		groupingAttribute,
		subGroupingAttribute,
		viewModel,
		colorFor,
		radiusFor: baseRadiusFor,
		formatValue,
		chartConfig,
		panZoom,
		stripHeight,
		barHeight,
		cardOpen,
		keySize,
		dotKeySize,
		groupGap,
		emptyKind,
		isolateName,
		onExitIsolate,
		hiddenCount,
		activeFilterLabels,
		onClearFilters,
		onSelect,
		onHover,
		onReady,
		children
	}: Props = $props();

	let fittingNames = $state(false);
	let nameFitFrame: number | undefined;
	/**
	 * The camera a Free map's first framing settled on, once its standing names were fitted
	 * clear of the canvas edge and the floating keys, and the canvas size it is valid for.
	 * Reset returns to it: a name keeps its offset from its dot on screen, so any other pan
	 * can stand one under a key it was placed clear of (#190).
	 */
	let fitCamera: { key: string; size: string; camera: Camera } | undefined;

	/** Finish whole-map framing against the names the renderer actually placed. */
	function finishNameFit(bounds: Rect) {
		if (nameFitFrame !== undefined) cancelAnimationFrame(nameFitFrame);
		fittingNames = true;
		let attempts = 0;
		let clearFrames = 0;
		const check = () => {
			if (!landed) {
				nameFitFrame = requestAnimationFrame(check);
				return;
			}
			const layer = panZoom.layer;
			const svg = layer?.ownerSVGElement;
			const matrix = layer?.getScreenCTM();
			const viewport = nameViewport();
			const excluded = nameChrome(panZoom);
			const clipped =
				matrix &&
				viewport &&
				[...(layer?.querySelectorAll('text[data-node-label]') ?? [])].some((name) => {
					const screen = name.getBoundingClientRect();
					const box = {
						left: (screen.left - matrix.e) / matrix.a,
						right: (screen.right - matrix.e) / matrix.a,
						top: (screen.top - matrix.f) / matrix.d,
						bottom: (screen.bottom - matrix.f) / matrix.d
					};
					return (
						box.left < viewport.left ||
						box.right > viewport.right ||
						box.top < viewport.top ||
						box.bottom > viewport.bottom ||
						excluded.some(
							(reserved) =>
								box.left < reserved.right &&
								box.right > reserved.left &&
								box.top < reserved.bottom &&
								box.bottom > reserved.top
						)
					);
				});
			if (svg && !clipped && clearFrames++ < 2) {
				nameFitFrame = requestAnimationFrame(check);
				return;
			}
			if (clipped) clearFrames = 0;
			if (svg && clipped && attempts++ < 24) {
				const camera = panZoom.targetFor(bounds, 28, undefined, panZoom.zoom * 0.97);
				if (camera) {
					panZoom.framedZoom = camera.zoom;
					panZoom.setView(camera);
					if (groupingAttribute === undefined)
						anchorFreeNames({ zoom: camera.zoom, panX: camera.panX, panY: camera.panY });
					nameFitFrame = requestAnimationFrame(check);
					return;
				}
			}
			nameFitFrame = undefined;
			fittingNames = false;
			settleLabelShape();
			// The camera is final only now, so this is where Free's names take their anchor.
			if (groupingAttribute === undefined) {
				anchorFreeNames();
				fitCamera = {
					key: untrack(() => fitKey),
					size: `${width}x${height}`,
					camera: { zoom: panZoom.zoom, panX: panZoom.panX, panY: panZoom.panY }
				};
			}
			signalReady();
		};
		nameFitFrame = requestAnimationFrame(check);
	}

	/**
	 * Recovers the view: the drawn Workers are centred in the free canvas at the
	 * view's 100% (the whole-map framing), so
	 * a panned-away map — and an isolated neighbourhood — comes back whole. It never
	 * changes what is drawn, so it never leaves Isolate.
	 */
	function resetFrame() {
		const bounds = drawnBounds();
		if (!bounds) {
			panZoom.resetView();
			return;
		}
		// A Free map resets to the frame that holds its resting names too, at the whole-map
		// framing's zoom or, when the window has since shrunk, only as much lower as they need.
		const dots = groupingAttribute === undefined && !viewModel.isolated ? settledFrame : undefined;
		if (dots) {
			// On the canvas the map was framed for, Reset goes back to that framing itself. A
			// resized canvas is framed afresh below, to the frame that holds its names.
			if (fitCamera && fitCamera.key === fitKey && fitCamera.size === `${width}x${height}`) {
				panZoom.setView(fitCamera.camera);
				anchorFreeNames();
				settleLabelShape();
				return;
			}
			const zoomFor = (frame: Rect) => {
				const fit = panZoom.targetFor(frame, 28)?.zoom;
				return fit === undefined ? undefined : Math.min(panZoom.framedZoom, fit);
			};
			const { frame, zoom } = frameWithNames({ dots, namesAt: restingNameBoxes, zoomFor });
			panZoom.centreOn(frame, zoom);
			// Reset refits the camera, so it also refits the names' anchor.
			anchorFreeNames();
			return;
		}
		// A composed drawing resets to its initial frame: its packet's own fit, with no name-fit
		// pass, so the screen-fixed labels keep the map space the packet evaluated.
		if (hasPacket && !viewModel.isolated && settledFrame) {
			const camera = panZoom.fitTo(settledFrame, 28);
			if (camera) panZoom.framedZoom = camera.zoom;
			settleLabelShape();
			return;
		}
		panZoom.centreOn(bounds);
	}

	/** The extent of every drawn dot in map coordinates: what a reset centres. */
	function drawnBounds(): { x: number; y: number; width: number; height: number } | undefined {
		const positions = targetPositions;
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;

		for (const node of viewModel.visibleNodes) {
			const point = positions.get(node.id);
			if (!point) continue;
			minX = Math.min(minX, point.x);
			minY = Math.min(minY, point.y);
			maxX = Math.max(maxX, point.x);
			maxY = Math.max(maxY, point.y);
		}

		if (minX === Number.POSITIVE_INFINITY) return undefined;
		return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
	}

	const labelGap = 8;

	let width = $state(720);
	let height = $state(520);

	const visibleIds = $derived(new Set(viewModel.visibleNodes.map((node) => node.id)));

	// The free canvas: the space the floating control strip, bottom bar and open
	// worker card leave the drawing (panels never reflow it). The camera reads its insets, so a
	// fit keeps the map clear of the chrome an organizer is reading. Below `lg` the
	// chrome is in-flow and covers nothing.
	const floatingChrome = new MediaQuery('min-width: 1024px');
	const surface = $derived({ width, height });
	const chrome = $derived(
		readFreeCanvasInsets({ floating: floatingChrome.current, stripHeight, barHeight, cardOpen })
	);
	const freeCanvas = $derived(freeCanvasBox(surface, chrome));

	$effect(() => {
		const box = freeCanvas;
		panZoom.setInsets(box.y, height - (box.y + box.height), box.x, width - (box.x + box.width));
	});

	// A resize refits the camera, not the arrangement. The camera shown is a pure
	// function of the live size: a reference camera, held in the layout canvas's
	// frame, scaled by how far the canvas has since shrunk or grown. The organizer's
	// own pan and zoom (and the framing) update the reference. Isolate's fit already
	// follows the free canvas, so there the camera is only read.
	let referenceCamera = { zoom: 1, panX: 0, panY: 0 };
	/** The whole-map framing at the layout size; a resize scales it with the camera. */
	let referenceFramedZoom = 1;
	let shownCamera: { zoom: number; panX: number; panY: number } | undefined;
	let shownLayout: object | undefined;
	$effect(() => {
		const live = { width, height };
		const layout = { width: layoutCanvas.width, height: layoutCanvas.height };
		const current = { zoom: panZoom.zoom, panX: panZoom.panX, panY: panZoom.panY };
		const isolated = viewModel.isolated;
		untrack(() => {
			const relaid = shownLayout !== layoutCanvas;
			const changed =
				!shownCamera ||
				current.zoom !== shownCamera.zoom ||
				current.panX !== shownCamera.panX ||
				current.panY !== shownCamera.panY;
			shownLayout = layoutCanvas;
			if (changed || relaid || isolated) {
				referenceCamera = referenceFromCamera({ camera: current, layout, live });
				referenceFramedZoom = referenceFromCamera({
					camera: { zoom: panZoom.framedZoom, panX: 0, panY: 0 },
					layout,
					live
				}).zoom;
				shownCamera = current;
				return;
			}
			// The 100% follows the window too, or the zoom limits — set from it —
			// stay at the old size: a shrunk window left the camera pinned at the
			// floor, and the wheel could not zoom out at all.
			panZoom.framedZoom = cameraForSize({
				reference: { zoom: referenceFramedZoom, panX: 0, panY: 0 },
				layout,
				live
			}).zoom;
			panZoom.setView(cameraForSize({ reference: referenceCamera, layout, live }));
			shownCamera = { zoom: panZoom.zoom, panX: panZoom.panX, panY: panZoom.panY };
		});
	});

	function afterMeasuredSurface(frame: () => void) {
		return afterMeasuredMapSurface(
			() => ({
				surface: { width, height },
				svg: panZoom.layer?.ownerSVGElement?.getBoundingClientRect()
			}),
			frame
		);
	}

	let fittedKey = '';
	/** Whether the last framing was Isolate's, so the framing that leaves it glides back. */
	let fitWasIsolated = false;
	/**
	 * What the camera was last framed for, readable by the drawing's readiness. Empty until
	 * the first framing: until then the drawing waits unseen, because it would otherwise
	 * show for a frame or two at the unframed camera, a fragment in a corner, before the
	 * fitted map replaces it.
	 */
	let fittedMirror = $state('');

	// Re-frame when the visible set changes, so a filtered map fills the canvas
	// again. The first load frames the whole map too, so a narrow screen sees the
	// worksite instead of a body running off both edges. An ungrouped first frame
	// keeps its natural size rather than zooming a sparse map up to the ceiling.
	$effect(() => {
		// Every re-frame trigger is named here: the visible set, Isolate's focus, and the
		// layout key (data, filters, Grouping, Sub-grouping, layout mode). A dot drag changes
		// the arrangement without changing this key, and must not jump the camera under the
		// pointer: the anchor stays and the names follow their dots at the kept sides. There
		// is no public arrangement revision to add without reframing on every drag.
		// Isolating, or isolating someone else, is a new frame over the same dots.
		const key = fitKey;
		if (!firstMeasured || !panZoom.layer || layoutCanvas.key !== layoutKey || key === fittedKey)
			return;

		const isInitial = fittedKey === '';
		// Leaving Isolate travels back on the same timed glide that went in.
		const leavingIsolate = fitWasIsolated;
		fitWasIsolated = viewModel.isolated;

		// Isolate changes only the camera. Start its glide immediately, on the clock the dots share.
		if (viewModel.isolated) {
			fittedKey = key;
			fittedMirror = key;
			// Isolate frames its neighbourhood at 1×, so that is its 100%.
			panZoom.framedZoom = 1;
			freeAnchorCamera = undefined;
			if (isInitial || reducedMotion) panZoom.resetView();
			else glideCameraTo({ zoom: 1, panX: 0, panY: 0 });
			return afterMeasuredSurface(signalReady);
		}

		// Grouped is exactly when the map draws regions.
		const framed = groupingAttribute !== undefined;
		const fitCap = isInitial && !framed ? 1.2 : undefined;

		const target = settledFrame;
		const staticFrame = reducedMotion;
		/** Free: the dots' frame with the names that stand at rest, and the zoom they fit at. */
		const withNames = (dots: Rect) =>
			frameWithNames({
				dots,
				namesAt: restingNameBoxes,
				zoomFor: (box) => panZoom.targetFor(box, 28, fitCap)?.zoom
			});
		const frame = () => {
			fittedKey = key;
			fittedMirror = key;

			// The first frame is placed at once, so no animation is still moving under
			// the pointer when the organizer starts to interact. Later frames travel to
			// the predicted resting extent; reduced motion frames the real rendered box
			// once the static pass has painted it. A composed drawing is the exception: its
			// names and headings were placed at the camera that frames the packet's own
			// frame, so every framing of it, the first or a re-solve's, goes there. The
			// rendered box also holds the names drawn before the re-solve, and framing it
			// pans the drawing away from the camera the packet was solved for, which can
			// leave a reused name under a floating key (#210).
			// Whichever way it arrives, the whole-map framing is the view's 100%.
			if (isInitial || (staticFrame && framed && hasPacket && target)) {
				const named = target && !framed ? withNames(target) : undefined;
				const camera = target
					? panZoom.fitTo(named?.frame ?? target, 28, named?.zoom ?? fitCap)
					: undefined;
				if (camera) {
					panZoom.framedZoom = camera.zoom;
					if (!framed) anchorFreeNames(camera);
				}
			} else if (staticFrame) {
				const box = panZoom.layer?.getBBox();
				const camera = box
					? panZoom.fitTo({ x: box.x, y: box.y, width: box.width, height: box.height }, 28, fitCap)
					: undefined;
				if (camera) {
					panZoom.framedZoom = camera.zoom;
					if (!framed) anchorFreeNames(camera);
				}
			} else {
				if (target) {
					const named = !framed ? withNames(target) : undefined;
					const camera = panZoom.targetFor(named?.frame ?? target, 28, named?.zoom ?? fitCap);
					if (camera) {
						panZoom.framedZoom = camera.zoom;
						if (!framed) anchorFreeNames(camera);
						if (leavingIsolate) glideCameraTo(camera);
						else panZoom.easeTo(camera);
					}
				}
			}
			if (framed) anchorFreeNames();
			// A composed drawing is framed at its packet's own fit, where its names and
			// headings were placed. Lowering the camera to fit a clipping resting name
			// would draw the packet off-reference: the screen-fixed labels would then
			// occupy larger map-space boxes than the packet evaluated, and the published
			// conflict report would no longer describe the drawing. Free maps keep the
			// name-fitting pass.
			if (target && !hasPacket) finishNameFit(target);
			else {
				settleLabelShape();
				signalReady();
			}
		};

		// Read the SVG only after the measured arrangement has reached the DOM.
		const cancel = afterMeasuredSurface(frame);
		return () => {
			cancel();
			if (nameFitFrame !== undefined) cancelAnimationFrame(nameFitFrame);
			nameFitFrame = undefined;
			fittingNames = false;
		};
	});

	/** How many Workers every drawn region holds, keyed the way the layout keys them. */
	const counts = $derived(
		regionCounts(viewModel.visibleNodes, groupingAttribute, subGroupingAttribute)
	);

	/*
	 * The arrangement reads a layout canvas, not the live size: captured from the
	 * settled canvas when the map is laid out and again only on a re-layout
	 * (data, filter, Grouping, Sub-grouping or layout mode). A resize never
	 * re-solves; the camera refits the same arrangement instead.
	 */
	/** The first measurement is part of the first layout; later sizes are resizes. */
	let firstMeasured = $state(false);
	$effect(() => {
		if (firstMeasured || !surfaceElement || width <= 0 || height <= 0) return;
		// Floating chrome reports its height after mount; the first layout waits for it.
		if (floatingChrome.current && (stripHeight <= 0 || !keySize?.width || !dotKeySize?.width))
			return;
		let cancelled = false;
		let frame = 0;
		const gate = createLayoutGate();
		const sample = () => {
			if (cancelled || firstMeasured) return;
			const ready = gate.step({
				appearanceApplied: appearanceApplied(),
				size: surfaceElement
					? `${surfaceElement.clientWidth}x${surfaceElement.clientHeight}|${stripHeight}|${barHeight}|${keySize?.width}x${keySize?.height}|${dotKeySize?.width}x${dotKeySize?.height}`
					: ''
			});
			if (!ready) {
				frame = requestAnimationFrame(sample);
				return;
			}
			layoutCanvas = {
				key: layoutCanvas.key,
				width,
				height,
				free: layoutFree(),
				reserved: layoutReserved()
			};
			takeText();
			firstMeasured = true;
		};
		// The first layout takes the fonts it can have, never waiting indefinitely; the chrome
		// sizes then settle under the gate before the capture.
		const { names, headings } = untrack(() => textStrings);
		const fonts =
			surfaceElement && document.fonts
				? loadFonts(document.fonts, textFontRequests(surfaceElement, names, headings), 1000)
				: Promise.resolve(false);
		void fonts.then(() => {
			if (!cancelled) frame = requestAnimationFrame(sample);
		});
		// Upgrade path: if the first layout used estimated text because fonts missed the
		// window above, re-take once they arrive so composition runs on measured widths.
		// The composition input reads the snapshot, so it re-runs from the new revision.
		if (typeof document !== 'undefined' && document.fonts) {
			void document.fonts.ready.then(() => {
				if (cancelled) return;
				untrack(() => {
					if (textSnapshot?.source === 'estimate') takeText();
				});
			});
		}
		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
		};
	});

	const settingsContext = getContext<AppSettingsContext | undefined>(appSettingsContextKey);
	/**
	 * Whether the root's computed font size is the saved density's: the cached first paint can
	 * differ from it, and the stylesheet can apply a frame after the attribute.
	 */
	function appearanceApplied() {
		if (!settingsContext || typeof document === 'undefined') return true;
		const computed = getComputedStyle(document.documentElement);
		const textScale = Number(computed.getPropertyValue('--text-scale')) || 1;
		const expected = expectedRootFontPx(settingsContext.density, textScale);
		return Math.abs(parseFloat(computed.fontSize) - expected) < 0.01;
	}

	/** The floating keys, in pixels from the free canvas's top-left: text steps around them. */
	function layoutReserved() {
		return layoutReservedRects({
			floating: floatingChrome.current,
			free: layoutFree(),
			keySize,
			dotKeySize
		});
	}

	/** The free canvas as laid out: persistent chrome excluded, the worker card closed. */
	function layoutFree() {
		const box = freeCanvasBox(
			{ width, height },
			readFreeCanvasInsets({
				floating: floatingChrome.current,
				stripHeight,
				barHeight,
				cardOpen: false
			})
		);
		return { width: box.width, height: box.height };
	}

	/** Whether this map is laid out as a one-level Grouped composition. */
	const composes = $derived(
		viewModel.effectiveLayout === 'grouped' && groupingAttribute !== undefined
	);

	/**
	 * The strings the composition reserves room for: the names that stand at rest
	 * and the group headings with their counts. Selection, hover and search are
	 * not in it.
	 */
	const textStrings = $derived(
		textStringsOf({
			layoutNodes: viewModel.layoutNodes,
			restingLabelIds: viewModel.restingLabelIds,
			composes,
			groupingAttribute,
			subGroupingAttribute
		})
	);

	/** The numeric text snapshot the layout was composed with: frozen until a layout or data trigger. */
	let textSnapshot = $state.raw<TextSnapshot | undefined>(undefined);
	let textSnapshotKey = '';
	/** Measures the strings now on the map; the conservative estimate stands in until fonts are ready. */
	function takeText() {
		const { names, headings, key } = untrack(() => textStrings);
		textSnapshotKey = key;
		if (surfaceElement && typeof document !== 'undefined' && document.fonts) {
			const requests = textFontRequests(surfaceElement, names, headings);
			if (fontsLoadedFor(document.fonts, requests)) {
				textSnapshot = measureTextSnapshot(surfaceElement, names, headings);
				return;
			}
			// A face still on its way: stand on the estimate, and measure once it lands.
			void loadFonts(document.fonts, requests, 5000).then((loaded) => {
				if (loaded && textSnapshotKey === key) takeText();
			});
		}
		textSnapshot = estimateTextSnapshot(names, headings);
	}
	// A rename or a changed count is a data trigger: it takes a fresh snapshot.
	$effect(() => {
		const key = textStrings.key;
		untrack(() => {
			if (firstMeasured && key !== textSnapshotKey) takeText();
		});
	});

	/**
	 * Which map a resting snapshot belongs to. A different layout, grouping or set of
	 * visible Workers is a different map, and must start from the seed again.
	 */
	const restingKey = $derived(
		[
			viewModel.effectiveLayout,
			groupingAttribute?.id ?? '',
			viewModel.layoutNodes
				.map((node) => node.id)
				.sort()
				.join(',')
		].join('|')
	);
	/** Which layout the layout canvas belongs to: a re-layout trigger captures it afresh. */
	const layoutKey = $derived(`${restingKey}|${subGroupingAttribute?.id ?? ''}`);
	let layoutCanvas = $state({
		key: '',
		width: untrack(() => width),
		height: untrack(() => height),
		free: { width: 0, height: 0 },
		reserved: [] as { x: number; y: number; width: number; height: number }[]
	});
	$effect.pre(() => {
		const key = layoutKey;
		untrack(() => {
			if (layoutCanvas.key === key) return;
			layoutCanvas = { key, width, height, free: layoutFree(), reserved: layoutReserved() };
			if (firstMeasured) takeText();
			// The bound chrome sizes follow this layout's content a frame or two later.
			if (firstMeasured && typeof requestAnimationFrame !== 'undefined') {
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						if (layoutCanvas.key !== key) return;
						layoutCanvas = {
							key,
							width,
							height,
							free: layoutFree(),
							reserved: layoutReserved()
						};
					})
				);
			}
		});
	});
	/**
	 * What the organizer has moved, for the layout it belongs to: pure translations over the
	 * automatic arrangement. A re-layout trigger (data, filters, Grouping, hierarchy) drops it.
	 */
	let committed = $state.raw<{ key: string; manual: ManualGeometry } | undefined>(undefined);
	/** Counts kept manual moves, so a test can wait for the one it made. */
	let manualRevision = $state(0);

	function commitManual(change: (manual: ManualGeometry) => ManualGeometry) {
		const base = committed?.key === sceneKey ? committed.manual : noManual;
		committed = { key: sceneKey, manual: change(base) };
		manualRevision += 1;
	}

	/** Space held: any press pans, over hulls and dots too. */
	let spaceHeld = $state(false);

	/** Group and Worker drags, and the clicks a drag must not turn into. */
	const drag = createMapDrag({
		isolated: () => viewModel.isolated,
		grouped: () => groupingAttribute !== undefined,
		spaceHeld: () => spaceHeld,
		settled: () => settled,
		panZoom: () => panZoom,
		commitWorker: (id, delta) =>
			commitManual((manual) => ({
				...manual,
				workerShift: shifted(manual.workerShift, id, delta)
			})),
		commitGroup: (key, delta) =>
			commitManual((manual) => ({
				...manual,
				groupShift: shifted(manual.groupShift, key, delta)
			}))
	});

	/** The manual geometry now drawn: what is kept, plus the move under the pointer. */
	const manual: ManualGeometry = $derived.by(() => {
		const kept = committed?.key === sceneKey ? committed.manual : noManual;
		const group = drag.draggedGroup;
		const worker = drag.draggedWorker;
		if (!group && !worker) return kept;
		return {
			groupShift: group ? shifted(kept.groupShift, group.key, group.delta) : kept.groupShift,
			workerShift: worker ? shifted(kept.workerShift, worker.id, worker.delta) : kept.workerShift
		};
	});

	/** Composition asks for names, headings and paths chosen with the placement; it needs the frozen screen facts. */
	const composition: CompositionInput | undefined = $derived(
		composes && textSnapshot && layoutCanvas.free.width > 0
			? {
					freeCanvas: layoutCanvas.free,
					reserved: layoutCanvas.reserved,
					restingNameIds: [...viewModel.restingLabelIds].filter((id) =>
						viewModel.layoutNodes.some((node) => node.id === id)
					),
					text: textSnapshot
				}
			: undefined
	);

	/** The settled arrangement the framing travels to. */
	const arrangementInput: ArrangeInput = $derived({
		mode: viewModel.effectiveLayout,
		nodes: viewModel.layoutNodes,
		links: viewModel.layoutLinks,
		groupingAttribute,
		subGroupingAttribute,
		canvas: { width: layoutCanvas.width, height: layoutCanvas.height },
		gap: groupGap,
		composition
	});
	const automatic = $derived(arrange(arrangementInput));
	const sceneKey = $derived(`${automatic.revision}|${textStrings.key}`);
	// A re-layout trigger (data, filters, Grouping, hierarchy, layout mode) starts from the
	// automatic arrangement again: coming back to an earlier layout does not restore old moves.
	$effect.pre(() => {
		const key = sceneKey;
		untrack(() => {
			if (committed && committed.key !== key) committed = undefined;
		});
	});

	/** Everything that asks for a new framing: the visible set, Isolate's focus and the layout. */
	const fitKey = $derived(
		[...visibleIds].sort().join('|') +
			(viewModel.isolated ? `#${viewModel.selectedId}` : '') +
			`@${sceneKey}|${layoutKey}|${layoutCanvas.free.width}x${layoutCanvas.free.height}|${JSON.stringify(layoutCanvas.reserved)}`
	);

	const settled = $derived(
		applyManual(automatic, manual, viewModel.layoutNodes, groupingAttribute, subGroupingAttribute)
	);

	/**
	 * Isolate's fit: the arrangement's positions for the drawn set, scaled and
	 * centred in the free canvas. A view-level reading of the arrangement — the
	 * layout is never recomputed — undefined outside Isolate.
	 */
	const isolateFit = $derived.by(() => {
		if (!viewModel.isolated) return undefined;

		return isolateFitPositions({
			positions: settled.positions,
			drawnIds: viewModel.visibleNodes.map((node) => node.id),
			freeCanvas: freeCanvasInMap(surface, chrome),
			radii: new Map(
				viewModel.visibleNodes.map((node) => [node.id, nodeRadius(node.relationshipCount)])
			)
		});
	});

	/**
	 * Where the dots are drawn toward: the arrangement, or Isolate's fitted spread.
	 * Every drawn position is a reading of one of the two, never a rewrite.
	 */
	const targetPositions = $derived(isolateFit?.positions ?? settled.positions);

	/**
	 * Isolate's fitted radius for a drawn Worker, else the base radius. Radii snap
	 * with the fit while positions glide, so a dot never changes size mid-glide.
	 */
	const radiusFor = (node: WorkerGraphNode) =>
		isolateFit?.radii.get(node.id) ?? baseRadiusFor(node);

	/** The drawn positions, published once per frame after the easing pass. */
	let drawn = $state<Map<string, Point>>(new Map());

	/** How long Isolate's glide takes, in ms: long enough to read as travel, short enough to feel direct. */
	const glideDuration = 420;
	/**
	 * Isolate's glide is timed, not eased per frame: the dots and the camera read one
	 * clock and one ease-in-out curve, so they move as a single motion that starts and
	 * stops gently instead of starting at full speed and trailing off for a second.
	 */
	let glideClock = { start: 0, duration: glideDuration, dots: false, camera: false };
	/** The clock the dots and the camera share: whichever claims it first starts it. */
	function claimGlideClock(role: 'dots' | 'camera') {
		const now = performance.now();
		if (glideClock[role] || now - glideClock.start > 250) {
			glideClock = { start: now, duration: glideDuration, dots: false, camera: false };
		}
		glideClock[role] = true;
		return glideClock;
	}
	type CameraView = { zoom: number; panX: number; panY: number };
	/**
	 * The camera's timed glide, shared with the dots. Every frame, the camera and the dots
	 * work out the camera at that frame's own timestamp from this, so they agree to the pixel
	 * whichever runs first.
	 */
	let glideCamera: { from: CameraView; to: CameraView; clock: typeof glideClock } | undefined;
	function cameraAt(glide: NonNullable<typeof glideCamera>, now: number): CameraView {
		const progress = Math.min(1, Math.max(0, (now - glide.clock.start) / glide.clock.duration));
		const eased = cubicInOut(progress);
		const { from, to } = glide;
		return {
			zoom: from.zoom + (to.zoom - from.zoom) * eased,
			panX: from.panX + (to.panX - from.panX) * eased,
			panY: from.panY + (to.panY - from.panY) * eased
		};
	}
	/** Glides the camera on the shared clock, and tells the dots which camera to move against. */
	function glideCameraTo(to: CameraView) {
		// Read the camera untracked: this runs inside an effect that must not follow it.
		untrack(() => {
			const clock = claimGlideClock('camera');
			glideCamera = {
				from: { zoom: panZoom.zoom, panX: panZoom.panX, panY: panZoom.panY },
				to,
				clock
			};
			panZoom.glideTo(to, clock);
		});
	}
	/** Each dot's radius as the last scene left it, so a radius that changes with Isolate grows or shrinks. */
	let restingRadii = new Map<string, number>();
	/** While a timed glide runs: the radii it started from and how far along it is (0 to 1). */
	let glideRadii = $state.raw<
		| {
				from: ReadonlyMap<string, number>;
				progress: number;
				/** The radius of a dot held still on screen, which keeps its drawn size while the camera zooms. */
				held: ReadonlyMap<string, number>;
		  }
		| undefined
	>(undefined);
	/** True while a timed glide runs; the standing names wait for it to land. */
	let timedGliding = $state(false);
	/** A dot's radius as drawn now: the scene's own, or blended from the last one mid-glide. */
	function shownRadius(node: WorkerGraphNode): number {
		const to = radiusFor(node);
		const glide = glideRadii;
		const held = glide?.held.get(node.id);
		if (held !== undefined) return held;
		const from = glide?.from.get(node.id);
		return glide && from !== undefined ? from + (to - from) * glide.progress : to;
	}
	/**
	 * Whether the drawn dots rest exactly on the arrangement's positions. Final
	 * paths are published for exactly those positions, so they draw only once the
	 * glide has arrived; in motion the direct ties between the dots draw.
	 */
	let landed = $state(false);
	/** Readiness waits for the settled drawing, not a placeholder of straight paths. */
	let readyPending = false;
	function signalReady() {
		if (landed) announceReady();
		else readyPending = true;
	}

	/**
	 * Reports the drawing ready once the camera has stopped travelling and the standing
	 * names have been frozen at it, so a reader that waits for readiness waits for the
	 * final names too. Bounded: a camera that never arrives stops being waited on.
	 */
	let steadyFrame: number | undefined;
	let preparationError = $state<string | undefined>();
	let notifyReady = false;
	function announceReady() {
		notifyReady = true;
		announceFreeze();
	}

	onDestroy(() => {
		if (steadyFrame !== undefined) cancelAnimationFrame(steadyFrame);
	});

	/**
	 * Names stand inside the dots' extent where a clear spot allows it, so a name at the edge of
	 * a Free map does not run off the canvas. Free only; Isolate has its own framing.
	 */
	const nameBounds = $derived.by((): LabelBox | undefined => {
		if (groupingAttribute !== undefined || viewModel.isolated) return undefined;
		const box = boundsOf(
			viewModel.visibleNodes.flatMap((node) => {
				const point = settled.positions.get(node.id);
				return point ? [{ left: point.x, top: point.y, right: point.x, bottom: point.y }] : [];
			})
		);
		return box && { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
	});

	/** Floating keys in map coordinates at the camera being evaluated. */
	function nameChrome(camera: Camera): LabelBox[] {
		return floatingKeyBoxes(
			{ floating: floatingChrome.current, width, height, keySize, dotKeySize },
			camera
		);
	}

	/** Screen-fixed names must fit the current usable canvas at whole-map framing. */
	function nameViewport(): LabelBox | undefined {
		return wholeMapViewport({
			isolated: viewModel.isolated,
			camera: { zoom: panZoom.zoom, panX: panZoom.panX, panY: panZoom.panY },
			framedZoom: panZoom.framedZoom,
			surface,
			chrome
		});
	}

	/**
	 * The camera Free's standing names chose their side and ring at: the whole-map fitting.
	 * Ordinary zoom, pan, hover and selection leave it alone; a fit or reset
	 * moves it. A resize only scales the camera, and the names replay at their kept sides.
	 */
	let freeAnchorCamera = $state<{ zoom: number; panX: number; panY: number } | undefined>();

	/** Anchor Free's standing names at a camera, or drop the anchor outside Free. */
	function anchorFreeNames(camera?: { zoom: number; panX: number; panY: number }) {
		// Isolate refits the drawn set to the free canvas and has no whole-map framing to
		// anchor to, so its names are placed anew at each camera, as they always were.
		if (groupingAttribute !== undefined || viewModel.isolated) {
			freeAnchorCamera = undefined;
			return;
		}
		freeAnchorCamera = camera
			? { ...camera }
			: { zoom: panZoom.zoom, panX: panZoom.panX, panY: panZoom.panY };
	}

	/**
	 * The side and ring each standing name chose at the anchor camera. Placement at another
	 * zoom replays these while the spot stays clear, so zooming does not rearrange names.
	 */
	const freeKept = $derived.by(() => {
		const camera = freeAnchorCamera;
		if (!camera || groupingAttribute !== undefined || viewModel.isolated) return undefined;
		return keptNames(nameScene, camera);
	});

	/** The boxes of the names that stand at rest on the settled Free arrangement at a zoom. */
	function restingNameBoxes(zoom: number, frame: Rect): Rect[] {
		const frozen = frozenNames;
		// Once the names are frozen, a reset reads them by arithmetic; the placement search
		// is only for the first framing of a scene.
		if (!frozen || frozen.key !== nameSceneKey)
			return placedRestingNameBoxes(nameScene, zoom, frame);
		return viewModel.visibleNodes.flatMap((node) => {
			const kept = frozen.names.get(node.id);
			const dot = settled.positions.get(node.id);
			if (!kept || !dot) return [];
			const { box } = thawName(kept, dot, baseRadiusFor(node), zoom);
			return [
				{ x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }
			];
		});
	}

	/**
	 * What the settled composition published, valid only while the dots rest on it
	 * and no Isolate fit is drawn. During a glide, a drag or Isolate the direct ties
	 * between the dots draw instead.
	 */
	const published = $derived(landed && !viewModel.isolated ? settled : undefined);
	/** A composition that chose to move something, as opposed to keeping the shipped drawing. */
	const composed = $derived(
		composes && settled.composition !== undefined && settled.composition.chosen !== 'original'
	);
	/**
	 * Whether the settled arrangement came with a composition packet at all. The
	 * packet's conflict report is evaluated over the packet's own names, so names
	 * must be drawn from it whenever it exists — including when it kept the shipped
	 * drawing (chosen 'original'). Drawing legacy names there makes the rendered
	 * geometry disagree with the report the drawing publishes.
	 */
	const hasPacket = $derived(composes && settled.composition !== undefined);
	const routes = $derived(published?.routes);
	const packet = $derived(published?.composition);
	/** At the packet's own fit its reference names and headings are the drawing. */
	const atReference = $derived(
		packet !== undefined && Math.abs(panZoom.zoom / packet.scale - 1) < 0.02
	);

	/** Flattened final paths, for names to stand clear of: only the ties, never the leaders. */
	const routeSegments = $derived(flattenedRoutes(routes, packet?.scale));

	/** What a name placement reads from the drawing, as it is at the moment the placement runs. */
	const nameScene: NameScene = {
		get viewModel() {
			return viewModel;
		},
		get grouped() {
			return groupingAttribute !== undefined;
		},
		get composed() {
			return composed;
		},
		radiusFor: (node) => radiusFor(node),
		get textSnapshot() {
			return textSnapshot;
		},
		get regions() {
			return regions;
		},
		get counts() {
			return counts;
		},
		get drawn() {
			return drawn;
		},
		get settledPositions() {
			return settled.positions;
		},
		get nameBounds() {
			return nameBounds;
		},
		camera: () => ({ zoom: panZoom.zoom, panX: panZoom.panX, panY: panZoom.panY }),
		viewport: nameViewport,
		chrome: nameChrome,
		chromeAtFit: (zoom, frame) =>
			nameChrome(panZoom.targetFor(frame, 28, undefined, zoom) ?? { zoom, panX: 0, panY: 0 }),
		get routeSegments() {
			return routeSegments;
		},
		get atReference() {
			return atReference;
		},
		// Below the Narrow tier the drawing is too small to hold every resting name
		// clear of the others, so a name that cannot be placed cleanly is dropped
		// rather than overprinted (the card and map table still name the Worker).
		get narrow() {
			return width > 0 && width < NARROW_BREAKPOINT;
		}
	};

	/**
	 * Which scene the standing names belong to: the automatic arrangement, the strings
	 * reserved for names, the visible set and Isolate's focus. A manual move is not in it.
	 */
	const nameSceneKey = $derived(
		[
			settled.revision,
			textStrings.key,
			[...visibleIds].sort().join(','),
			viewModel.isolated ? viewModel.selectedId : ''
		].join('|')
	);
	let frozenNames = $state.raw<
		| {
				key: string;
				fit: string;
				names: Map<string, FrozenName>;
				regions: GroupRegion[];
				groupShift: ReadonlyMap<string, Point>;
		  }
		| undefined
	>(undefined);
	/** The standing names, searched once for the scene as framed and kept. */
	function freezeNames() {
		untrack(() => {
			const placed = placeAllNames(
				nameScene,
				hasPacket ? settled.composition : undefined,
				freeKept
			);
			const standing = viewModel.isolated ? viewModel.labelIds : viewModel.restingLabelIds;
			const zoom = panZoom.zoom;
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- built whole, then published as one raw value
			const names = new Map<string, FrozenName>();
			for (const node of viewModel.visibleNodes) {
				const name = placed.get(node.id);
				const dot = drawn.get(node.id);
				if (!name || !dot || !standing.has(node.id)) continue;
				names.set(node.id, freezeName(name, dot, radiusFor(node), zoom));
			}
			frozenNames = {
				key: nameSceneKey,
				fit: fitKey,
				names,
				regions,
				groupShift: new Map(manual.groupShift)
			};
		});
	}
	// A rename, a changed resting set or a filter after the first reading takes a fresh freeze.
	$effect(() => {
		const key = nameSceneKey;
		untrack(() => {
			if (frozenNames && frozenNames.key !== key && firstMeasured) announceFreeze();
		});
	});
	function announceFreeze() {
		if (steadyFrame !== undefined) cancelAnimationFrame(steadyFrame);
		let frames = 0;
		preparationError = undefined;
		const step = () => {
			steadyFrame = undefined;
			if (panZoom.animating || !landed || fittingNames) {
				if (frames++ >= 180) {
					preparationError = 'Map preparation did not complete within 180 frames';
					return;
				}
				steadyFrame = requestAnimationFrame(step);
				return;
			}
			freezeNames();
			if (notifyReady) {
				notifyReady = false;
				onReady();
			}
		};
		steadyFrame = requestAnimationFrame(step);
	}

	/**
	 * The drawing is complete for the scene on screen: arranged, framed, landed and its
	 * standing names frozen at that framing. A test waits for this, not for two equal samples.
	 */
	const sceneReady = $derived(
		frozenNames?.key === nameSceneKey &&
			frozenNames.fit === fitKey &&
			fittedMirror === fitKey &&
			landed &&
			!fittingNames &&
			!panZoom.animating &&
			!panZoom.isPanning &&
			!drag.draggedGroup &&
			!drag.draggedWorker &&
			!preparationError
	);

	/**
	 * The names drawn: the frozen standing names thawed at the camera by arithmetic, and a
	 * selected or hovered name outside them attached beside its dot. Before the first
	 * freeze the names are searched live, as the drawing is still being framed.
	 */
	/**
	 * The names as last placed. While Isolate glides they are held, not searched again
	 * every frame for dots that are still travelling, and drawn faded out; they are
	 * placed once at the new scene when the glide lands.
	 */
	let heldPlacements: Map<string, PlacedName> | undefined;
	const labelPlacements = $derived.by(() => {
		if (timedGliding && heldPlacements) return heldPlacements;
		const placed = placeNames();
		heldPlacements = placed;
		return placed;
	});
	function placeNames(): Map<string, PlacedName> {
		const frozen = frozenNames;
		if (!frozen || frozen.key !== nameSceneKey) {
			return placeAllNames(nameScene, hasPacket ? settled.composition : undefined, freeKept);
		}
		const zoom = panZoom.zoom;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a derived value's local result, never mutated afterwards
		const placed = new Map<string, PlacedName>();
		for (const node of viewModel.visibleNodes) {
			if (!viewModel.labelIds.has(node.id) || !showsLabel(node.id, viewModel)) continue;
			const dot = drawn.get(node.id);
			if (!dot) continue;
			const kept = frozen.names.get(node.id);
			if (kept) {
				placed.set(node.id, thawName(kept, dot, radiusFor(node), zoom));
			} else if (node.id === viewModel.selectedId || node.id === viewModel.hoveredId) {
				const size = textSnapshot?.names.get(node.id) ?? { width: 60, height: 14 };
				placed.set(node.id, attachName(dot, radiusFor(node), size, zoom));
			}
		}
		return placed;
	}

	/** The frame loop's tick id, so a change into static mode stops the loop. */
	let rafId: number | undefined;

	/**
	 * Counts settled cameras. Chromium caches an SVG text element's shaped run under its
	 * font-size value and can keep drawing a name at the zoom from before the last camera
	 * change, while the attribute already reads the final zoom — its drawn box then misses
	 * the measured box by more than the one-pixel agreement. Each settle adds a novel,
	 * persistent epsilon to the label font size: the value never returns to an earlier
	 * one, so the cache key is new and the name is shaped at the current scale. One
	 * ten-thousandth of a user unit per settle is invisible.
	 */
	let labelShapeEpoch = $state(0);
	function settleLabelShape(): void {
		untrack(() => {
			labelShapeEpoch += 1;
		});
	}

	const reducedMotion = $derived(motionIsReduced());

	/**
	 * Eases every drawn dot one step from where it was last drawn toward `target`,
	 * and answers how far the furthest dot moved this frame — the measure that
	 * decides when the glide has arrived and the frame loop can stop.
	 *
	 * The previous positions are read untracked: this runs inside the effect that
	 * owns `drawn`, so a tracked read would make the effect depend on its output.
	 */
	function easeToward(target: Map<string, Point>): number {
		const previous = untrack(() => drawn);
		const next = new SvelteMap<string, Point>();
		let furthest = 0;
		for (const [id, point] of target) {
			const current = previous.get(id) ?? point;
			const x = current.x + (point.x - current.x) * nodeEase;
			const y = current.y + (point.y - current.y) * nodeEase;
			furthest = Math.max(furthest, Math.hypot(x - current.x, y - current.y));
			next.set(id, { x, y });
		}
		// Publish one fresh, complete frame rather than scheduling reactive work
		// once for each Worker position.
		drawn = next;
		landed = false;
		return furthest;
	}

	/** Lands the drawn dots exactly where they are drawn toward, with no further travel. */
	function landOn(target: Map<string, Point>) {
		drawn = new SvelteMap(target);
		landed = true;
		timedGliding = false;
		glideRadii = undefined;
		untrack(() => {
			restingRadii = new Map(viewModel.visibleNodes.map((node) => [node.id, radiusFor(node)]));
		});
		if (readyPending && !fittingNames) {
			readyPending = false;
			announceReady();
		}
	}

	/** The scene the dots were last drawn toward: a manual move keeps it and so never glides. */
	type MapLink = (typeof viewModel.visibleLinks)[number];
	/** Who was drawn before the change now being drawn, so a scene change knows who it adds and removes. */
	let removedIds = new Set<string>();
	let addedIds = new Set<string>();
	let nodesBefore: readonly WorkerGraphNode[] = [];
	let linksBefore: readonly MapLink[] = [];
	let isolateBefore = '';
	/**
	 * The Workers and ties Isolate has just taken off the map. Svelte's own exit would freeze
	 * them in map units while the camera moves, so they slide as they fade. They stay mounted
	 * a moment instead, held where they stood on the screen by the glide, and fade by opacity.
	 */
	let fadingNodes = $state.raw<readonly WorkerGraphNode[]>([]);
	let fadingLinks = $state.raw<readonly MapLink[]>([]);
	const fadingIds = $derived(new Set(fadingNodes.map((node) => node.id)));
	const fadingLinkIds = $derived(new Set(fadingLinks.map((link) => link.id)));
	const shownNodes = $derived(
		fadingNodes.length ? [...viewModel.visibleNodes, ...fadingNodes] : viewModel.visibleNodes
	);
	const shownLinks = $derived(
		fadingLinks.length ? [...viewModel.visibleLinks, ...fadingLinks] : viewModel.visibleLinks
	);
	let fadeTimer: ReturnType<typeof setTimeout> | undefined;
	onDestroy(() => clearTimeout(fadeTimer));
	// Runs before the drawing updates, so the dots Isolate removes are still in it when it does.
	$effect.pre(() => {
		const nodes = viewModel.visibleNodes;
		const links = viewModel.visibleLinks;
		const isolate = viewModel.isolated ? viewModel.selectedId : '';
		untrack(() => {
			if (isolate !== isolateBefore && !reducedMotion && nodesBefore.length > 0) {
				const now = new Set(nodes.map((node) => node.id));
				const nowLinks = new Set(links.map((link) => link.id));
				fadingNodes = nodesBefore.filter((node) => !now.has(node.id));
				fadingLinks = linksBefore.filter((link) => !nowLinks.has(link.id));
				clearTimeout(fadeTimer);
				fadeTimer = setTimeout(() => {
					fadingNodes = [];
					fadingLinks = [];
				}, 260);
			}
			const was = new Set(nodesBefore.map((node) => node.id));
			const is = new Set(nodes.map((node) => node.id));
			removedIds = new Set([...was].filter((id) => !is.has(id)));
			addedIds = new Set([...is].filter((id) => !was.has(id)));
			isolateBefore = isolate;
			nodesBefore = nodes;
			linksBefore = links;
		});
	});
	let drawnScene = '';
	let drawnIsolated = false;
	$effect(() => {
		const scene = `${settled.revision}|${viewModel.isolated ? viewModel.selectedId : ''}`;
		const sameScene = untrack(() => scene === drawnScene && drawn.size > 0);
		// Entering, leaving or changing Isolate glides on a clock; any other re-arrangement eases.
		const timed = viewModel.isolated || drawnIsolated;
		drawnScene = scene;
		drawnIsolated = viewModel.isolated;
		if (reducedMotion || sameScene) {
			// The static path, and a manual move, land where the model says, with no travel.
			landOn(targetPositions);
			if (rafId !== undefined) cancelAnimationFrame(rafId);
			rafId = undefined;
			return;
		}

		// A first drawing, with nowhere to glide from, lands where it is drawn.
		if (untrack(() => drawn).size === 0) {
			landOn(targetPositions);
		} else if (timed) {
			const target = targetPositions;
			const from = untrack(() => drawn);
			const clock = claimGlideClock('dots');
			const startCamera = untrack(() => ({
				zoom: panZoom.zoom,
				panX: panZoom.panX,
				panY: panZoom.panY
			}));
			// A dot that Isolate takes off the map or puts back fades where it stands on screen. Left
			// in map units it rides the camera across the canvas as it fades. The leaving ones stay
			// where they were seen; the arriving ones wait where they will end up.
			const fadeAt = new SvelteMap<string, 'start' | 'end'>();
			for (const id of removedIds) fadeAt.set(id, 'start');
			for (const id of addedIds) fadeAt.set(id, 'end');
			// Their size is held too: a dot fixed on screen would otherwise grow and shrink with the zoom.
			const heldSize = untrack(() => {
				const sizes = new SvelteMap<string, number>();
				for (const id of removedIds) {
					const size = restingRadii.get(id);
					if (size !== undefined) sizes.set(id, size);
				}
				for (const node of viewModel.visibleNodes) {
					if (addedIds.has(node.id)) sizes.set(node.id, radiusFor(node));
				}
				return sizes;
			});
			glideRadii = { from: restingRadii, progress: 0, held: new SvelteMap() };
			timedGliding = true;
			landed = false;
			const timedStep = (now: number) => {
				const progress = Math.min(1, Math.max(0, (now - clock.start) / clock.duration));
				if (progress >= 1) {
					landOn(target);
					rafId = undefined;
					return;
				}
				// The organizer took the camera over mid-glide: the dots stop where they are drawn to.
				if (glideCamera?.clock === clock && !panZoom.animating) {
					landOn(target);
					rafId = undefined;
					return;
				}
				const eased = cubicInOut(progress);
				// The dots travel straight across the screen, whatever the camera does meanwhile: each
				// goes from where it was drawn to where it will be drawn, and its map position is
				// read back through the camera as it is at this frame. Moving them in map units
				// instead would add the camera's motion to theirs and make the speed rise twice.
				const camera = glideCamera?.clock === clock ? cameraAt(glideCamera, now) : startCamera;
				const end = glideCamera?.clock === clock ? glideCamera.to : startCamera;
				const next = new SvelteMap<string, Point>();
				// eslint-disable-next-line svelte/prefer-svelte-reactivity -- built whole each frame, then published as one raw value
				const held = new Map<string, number>();
				for (const [id, point] of target) {
					const start = from.get(id) ?? point;
					const fromX = startCamera.zoom * start.x + startCamera.panX;
					const fromY = startCamera.zoom * start.y + startCamera.panY;
					const toX = end.zoom * point.x + end.panX;
					const toY = end.zoom * point.y + end.panY;
					const stays = fadeAt.get(id);
					const size = heldSize.get(id);
					if (stays && size !== undefined) {
						held.set(id, (size * (stays === 'start' ? startCamera.zoom : end.zoom)) / camera.zoom);
					}
					// Where it is on screen this frame: travelling, or fixed for a fading dot.
					const screenX =
						stays === 'start' ? fromX : stays === 'end' ? toX : fromX + (toX - fromX) * eased;
					const screenY =
						stays === 'start' ? fromY : stays === 'end' ? toY : fromY + (toY - fromY) * eased;
					next.set(id, {
						x: (screenX - camera.panX) / camera.zoom,
						y: (screenY - camera.panY) / camera.zoom
					});
				}
				drawn = next;
				glideRadii = { from: restingRadii, progress: eased, held };
				rafId = requestAnimationFrame(timedStep);
			};
			rafId = requestAnimationFrame(timedStep);
			return () => {
				if (rafId !== undefined) {
					cancelAnimationFrame(rafId);
					rafId = undefined;
				}
			};
		} else easeToward(targetPositions);

		const step = () => {
			if (easeToward(targetPositions) < easeStopThreshold) {
				// Arrived: land exactly on the target, so the drawn geometry equals
				// the static path's, and stop burning frames on the glide.
				landOn(targetPositions);
				rafId = undefined;
				return;
			}
			rafId = requestAnimationFrame(step);
		};
		if (rafId === undefined) rafId = requestAnimationFrame(step);

		return () => {
			if (rafId !== undefined) {
				cancelAnimationFrame(rafId);
				rafId = undefined;
			}
		};
	});

	/** The resting arrangement's extent in map coordinates, which the framing travels to. */
	const settledFrame = $derived(
		settledFrameOf({
			visibleNodes: viewModel.visibleNodes,
			positions: settled.positions,
			baseRadiusFor,
			labelGap,
			grouped: groupingAttribute !== undefined,
			composedFrame: composed ? settled.composition?.frame : undefined,
			regions: settled.regions
		})
	);

	/**
	 * One region per group, each holding the regions of its sub-groups.
	 *
	 * Regions wrap the drawn positions, so they follow the eased dots per frame
	 * instead of leading or trailing them.
	 */
	const regions = $derived.by(() => {
		const frozen = frozenNames;
		if (frozen?.key === nameSceneKey) {
			return translateGroupRegions(frozen.regions, frozen.groupShift, manual.groupShift);
		}
		return labelViewRegions({
			arranger: arrange,
			arrangement: arrangementInput,
			drawn,
			visibleNodes: viewModel.visibleNodes,
			radiusFor,
			labelGap,
			isolated: viewModel.isolated,
			ghostedIds: viewModel.ghostedIds,
			composed,
			textSnapshot,
			reference: atReference ? packet?.headings : undefined,
			camera: { zoom: panZoom.zoom, panX: panZoom.panX, panY: panZoom.panY },
			free: freeCanvasInMap(surface, chrome),
			surface,
			floating: floatingChrome.current,
			keySize,
			dotKeySize
		});
	});

	const publishedReport = createPublishedReport({
		ready: () => sceneReady && atReference,
		textVersion: () => settled.composition?.textSource,
		packetConflicts: () => settled.composition?.conflicts,
		source: () => ({
			visibleNodes: viewModel.visibleNodes,
			visibleLinks: viewModel.visibleLinks,
			positions: drawn,
			routes: packet?.routes,
			radiusFor,
			placements: labelPlacements,
			regions,
			textSnapshot,
			zoom: panZoom.zoom,
			groupingAttribute,
			subGroupingAttribute
		})
	});

	// Diagnostics describe the initial automatic packet. Re-evaluating collisions here
	// would run expensive test-only work on every zoom, pan and manual move.

	const spotlightRegionKeys = $derived(
		regionKeysOf(nodes, viewModel.spotlightIds, groupingAttribute, subGroupingAttribute)
	);

	/**
	 * The regions holding a drawn Worker that a complete Highlight query selects.
	 * Empty when there is no complete query.
	 */
	const highlightRegionKeys = $derived(
		regionKeysOf(nodes, viewModel.highlightIds, groupingAttribute, subGroupingAttribute)
	);

	/** A region is full when the spotlight and, if there is one, the Highlight both keep it lit. */
	function regionOpacity(key: string): number {
		const spotlightLit = viewModel.spotlightIds.size === 0 || spotlightRegionKeys.has(key);
		if (viewModel.highlightIds === undefined) return spotlightLit ? 1 : 0.5;
		return spotlightLit && highlightRegionKeys.has(key) ? 1 : 0.5;
	}

	/**
	 * The interaction surface itself, focused by keyboard readers and by the
	 * focus fallback below.
	 */
	let surfaceElement = $state<HTMLDivElement>();
	const hover = createHoverIntent({
		isPanning: () => panZoom.isPanning,
		selectedId: () => viewModel.selectedId,
		onHover: (workerId) => onHover(workerId)
	});

	onDestroy(hover.cancel);

	/** Whether the focus now sitting on the map sits on a Worker's node. */
	let focusOnNode = false;

	const haloClipId = $props.id();
	// Clip every halo around every painted dot, including its own. SVG clipping
	// affects hit testing, so a real pointer always reaches the painted dot's button.
	const haloClipPath = $derived(
		haloClipPathOf(
			viewModel.visibleNodes.map((node) => ({
				...(drawn.get(node.id) ?? { x: 0, y: 0 }),
				radius: radiusFor(node),
				hit: hitRadius(radiusFor(node), panZoom.zoom)
			}))
		)
	);

	/** Selecting a Worker by pointer: a drag that moved the dot is not a selection. */
	function selectNode(event: MouseEvent, node: WorkerGraphNode) {
		event.stopPropagation();
		if (drag.suppressesNodeClick()) return;
		onSelect(node.id);
	}

	/** The map's own keys while a Worker has focus: Enter or Space reads it, Escape clears. */
	function keyNode(event: KeyboardEvent, node: WorkerGraphNode) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onSelect(node.id);
		} else if (event.key === 'Escape') {
			// Clearing may take this very node off the map — leaving isolation
			// reframes everything — so focus follows the node only if it is still
			// drawn.
			const element = event.currentTarget;
			onSelect('');
			requestAnimationFrame(() => {
				if (focusOnNode && !(element instanceof Element && document.contains(element))) {
					focusOnNode = false;
					surfaceElement?.focus();
				}
			});
		}
	}

	/**
	 * What the surface does with a key. Only the map's own keys are handled —
	 * everything else keeps its default — and a key from a text control is
	 * never the map's: the toolbar's search field stands beside the surface,
	 * not inside it, and the guard holds even so.
	 */
	function isTextControl(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
	}

	function handleSurfaceKey(event: KeyboardEvent) {
		if (isTextControl(event.target)) return;

		const action = interpretMapKey(event.key, event.shiftKey);
		if (!action) return;

		event.preventDefault();
		if (action.type === 'pan') panZoom.panBy(action.dx, action.dy);
		else if (action.type === 'zoom') {
			if (action.direction === 'in') panZoom.zoomIn();
			else panZoom.zoomOut();
		} else onSelect('');
	}

	/**
	 * Where focus goes when the visible set takes the focused node with it: a
	 * removed element drops focus to the body, so the map hands its surface
	 * the focus instead of leaving the keyboard reader nowhere. It runs only
	 * on a visible-set change, never on an ordinary tab or click away.
	 */
	$effect(() => {
		void visibleIds;
		if (focusOnNode && document.activeElement === document.body) {
			focusOnNode = false;
			surfaceElement?.focus();
		}
	});
</script>

<svelte:window
	onpointermove={drag.move}
	onpointerup={drag.end}
	onpointercancel={drag.end}
	onkeydown={(event) => {
		if (event.code === 'Space' && !isTextControl(event.target)) spaceHeld = true;
	}}
	onkeyup={(event) => {
		if (event.code === 'Space') spaceHeld = false;
	}}
	onblur={() => (spaceHeld = false)}
/>

<div
	class="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden"
	onfocusin={(event) => {
		focusOnNode = event.target !== surfaceElement;
	}}
>
	{@render children?.({ resetFrame })}

	<!-- eslint-disable-next-line svelte/no-unused-svelte-ignore -- the compiler's a11y warnings below are suppressed for a deliberate keyboard target; the accessible name is the aria-label. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<div
		bind:this={surfaceElement}
		data-testid="relationship-map-surface"
		data-map-settled={landed && !fittingNames ? 'true' : undefined}
		data-scene-revision={settled.revision}
		data-layout-solves={automatic && arrange.solves}
		data-camera-revision={panZoom.revision}
		data-camera-idle={panZoom.animating ? undefined : 'true'}
		data-scene-error={preparationError}
		data-manual-revision={manualRevision}
		data-manual-moves={manual.groupShift.size + manual.workerShift.size}
		data-names-frozen={frozenNames?.key === nameSceneKey ? 'true' : undefined}
		data-scene-ready={sceneReady ? 'true' : undefined}
		data-composition-chosen={settled.composition?.chosen}
		data-composition-text={settled.composition?.textSource}
		data-text-source={textSnapshot?.source}
		data-composition-published={publishedReport.published ? 'true' : undefined}
		data-layout-canvas={`${Math.round(layoutCanvas.width)}x${Math.round(layoutCanvas.height)}`}
		data-composition-scale={settled.composition?.scale}
		data-composition-report={settled.composition
			? JSON.stringify({
					chosen: settled.composition.chosen,
					work: settled.composition.work,
					conflicts: publishedReport.conflicts,
					candidates: settled.composition.candidates.map(
						({ key, status, reason, conflicts, crossings, scale, unresolved }) => ({
							key,
							status,
							reason,
							conflicts,
							crossings,
							scale,
							unresolved
						})
					)
				})
			: undefined}
		data-at-reference={atReference ? 'true' : undefined}
		data-routes-published={routes ? 'true' : undefined}
		bind:clientWidth={width}
		bind:clientHeight={height}
		tabindex="0"
		role="application"
		aria-label={m.mapping_map_aria()}
		class="order-2 min-h-0 w-full flex-1 touch-none overflow-hidden select-none"
		class:cursor-grab={!panZoom.isPanning}
		class:cursor-grabbing={panZoom.isPanning || drag.draggedGroup !== undefined}
		onwheel={panZoom.handleWheel}
		onpointerdown={(event) => {
			drag.pressSurface(event);
			panZoom.startPan(event);
		}}
		onpointermove={panZoom.movePan}
		onpointerup={panZoom.endPan}
		onpointercancel={(event) => {
			drag.cancelSurfacePress();
			panZoom.endPan(event);
		}}
		onlostpointercapture={panZoom.endCapture}
		onclick={(event) => {
			focusOnNode = false;
			if (drag.dismissesOnClick(event)) onSelect('');
		}}
		onkeydown={handleSurfaceKey}
	>
		<Chart.ChartContainer config={chartConfig} class="aspect-auto h-full w-full">
			<LayerChart width={Math.max(1, width)} height={Math.max(1, height)}>
				{#snippet children({ context })}
					<Layer center>
						<g
							bind:this={panZoom.layer}
							data-testid="relationship-map-layer"
							transform={`translate(${panZoom.panX} ${panZoom.panY}) scale(${panZoom.zoom})`}
							style:visibility={fittedMirror === '' ? 'hidden' : undefined}
						>
							<MapRegionsLayer
								{regions}
								{counts}
								{regionOpacity}
								zoom={panZoom.zoom}
								grabbable={!viewModel.isolated && !spaceHeld}
								grabbing={drag.draggedGroup !== undefined}
								onGroupPress={drag.startGroup}
							/>

							{#each shownLinks as link (link.id)}
								{@const sourceId = link.source}
								{@const targetId = link.target}
								{@const sourcePoint = drawn.get(sourceId) ?? { x: 0, y: 0 }}
								{@const targetPoint = drawn.get(targetId) ?? { x: 0, y: 0 }}
								{@const isCross = !viewModel.isolated && settled.crossLinkIds.has(link.id)}
								{@const path =
									routes?.get(link.id)?.d ??
									`M ${sourcePoint.x} ${sourcePoint.y} L ${targetPoint.x} ${targetPoint.y}`}
								<!-- A tie that crosses between groups is drawn heavier, so the
								     bridges between groups stand out from the ties inside them. -->
								<path
									in:fade={{ duration: reducedMotion ? 0 : 150 }}
									d={path}
									class={isEgoLink(link, viewModel) ? 'stroke-ink' : 'stroke-ink-3'}
									fill="none"
									stroke-width={isCross ? 2 : 1}
									style:stroke-opacity={fadingLinkIds.has(link.id)
										? 0
										: linkOpacity(link, viewModel)}
									style:transition={reducedMotion ? 'none' : 'stroke-opacity 200ms ease-out'}
									vector-effect="non-scaling-stroke"
									data-tie={isCross ? 'cross' : 'within'}
									data-tie-id={link.id}
									data-tie-source={sourceId}
									data-tie-target={targetId}
									pointer-events="none"
								/>
							{/each}

							<!-- One button owns the halo and dot. The shared clip leaves every
                                 painted dot reachable above overlapping halos. -->
							<defs>
								<clipPath id={haloClipId} clipPathUnits="userSpaceOnUse">
									<path d={haloClipPath} clip-rule="evenodd" />
								</clipPath>
							</defs>

							{#each shownNodes as node (node.id)}
								{@const point = drawn.get(node.id) ?? { x: 0, y: 0 }}
								{@const radius = shownRadius(node)}
								{@const labelPlacement = labelPlacements.get(node.id)}
								{@const isActive =
									viewModel.selectedId === node.id || viewModel.hoveredId === node.id}
								<g
									in:fade={{ duration: reducedMotion ? 0 : 150 }}
									out:fade={{ duration: reducedMotion ? 0 : 150 }}
								>
									<g
										class="transition-opacity duration-150 ease-out outline-none focus-visible:[&>circle[data-focus-ring]]:stroke-ring"
										opacity={fadingIds.has(node.id) ? 0 : nodeOpacity(node, viewModel)}
										pointer-events={fadingIds.has(node.id) ? 'none' : undefined}
										aria-hidden={fadingIds.has(node.id) ? 'true' : undefined}
										role="button"
										tabindex="0"
										data-node-id={node.id}
										data-faded={isHighlightFaded(node.id, viewModel) ? 'true' : undefined}
										aria-pressed={viewModel.selectedId === node.id}
										aria-label={node.relationshipCount === 1
											? m.mapping_node_one({
													name: node.name,
													assessment: assessmentLabel(node.assessment),
													count: node.relationshipCount
												})
											: m.mapping_node_other({
													name: node.name,
													assessment: assessmentLabel(node.assessment),
													count: node.relationshipCount
												})}
										onclick={(event) => selectNode(event, node)}
										onkeydown={(event) => keyNode(event, node)}
										onpointerenter={() => hover.enter(node)}
										onpointerleave={() => hover.leave(context.tooltip)}
										onpointermove={(event) => hover.move(event, node, context.tooltip)}
										onpointerup={(event) => hover.up(event, node, context.tooltip)}
										onpointerdown={(event) => {
											// Pressing a Worker puts the card away and arms the drag.
											hover.press(context.tooltip);
											drag.startWorker(event, node.id);
										}}
									>
										<circle
											cx={point.x}
											cy={point.y}
											r={hitRadius(radius, panZoom.zoom)}
											fill="transparent"
											pointer-events="all"
											data-hit-for={node.id}
											clip-path={`url(#${haloClipId})`}
										/>
										<!-- The focus ring leaves a gap between the mark and the boundary,
										     so a low-degree dot still shows where focus is. -->
										<circle
											cx={point.x}
											cy={point.y}
											r={radius + 6}
											class="fill-none stroke-transparent transition-colors duration-150 ease-out"
											class:stroke-ring={isActive}
											data-focus-ring
											pointer-events="none"
											stroke-width="2.5"
										/>
										<Circle
											cx={point.x}
											cy={point.y}
											r={radius}
											fill={colorFor(node)}
											class="stroke-2 transition-colors duration-150 ease-out"
											stroke={nodeStroke(node, colorFor)}
										/>
										{#if viewModel.selectedId === node.id}
											<circle
												cx={point.x}
												cy={point.y}
												r={radius + 3}
												fill="none"
												class="stroke-ink"
												stroke-width="2"
												vector-effect="non-scaling-stroke"
												pointer-events="none"
												data-selected-ring={node.id}
											/>
										{/if}
									</g>
									{#if labelPlacement?.leader}
										<!-- A short leader tells a displaced name its dot; it is thinner, dotted and
										     round-capped, so it never reads as a Relationship. -->
										<line
											x1={labelPlacement.leader.x1}
											y1={labelPlacement.leader.y1}
											x2={labelPlacement.leader.x2}
											y2={labelPlacement.leader.y2}
											class="stroke-ink-3"
											stroke-width="1"
											stroke-dasharray="1 2.5"
											stroke-linecap="round"
											vector-effect="non-scaling-stroke"
											opacity={timedGliding ? 0 : nodeOpacity(node, viewModel)}
											pointer-events="none"
											aria-hidden="true"
											data-name-leader={node.id}
										/>
									{/if}
									{#if labelPlacement}
										<text
											x={labelPlacement.x}
											y={labelPlacement.y}
											text-anchor={labelPlacement.textAnchor}
											dominant-baseline="central"
											aria-hidden="true"
											data-node-label={node.id}
											data-name-metrics={textSnapshot?.names.has(node.id)
												? `${textSnapshot.names.get(node.id)?.width}x${textSnapshot.names.get(node.id)?.height}`
												: undefined}
											class="pointer-events-none fill-ink font-medium transition-opacity duration-150 ease-out"
											opacity={timedGliding ? 0 : nodeOpacity(node, viewModel)}
											font-size={screenFixed(12, panZoom.zoom) + labelShapeEpoch * 0.0001}
											paint-order="stroke"
											stroke="var(--panel)"
											stroke-width={screenFixed(3, panZoom.zoom)}
										>
											<title>{node.name}</title>
											{mapLabelText(node.name)}
										</text>
									{/if}
								</g>
							{/each}
						</g>
					</Layer>

					<MapNodeTooltip {attributes} {formatValue} />
				{/snippet}
			</LayerChart>
		</Chart.ChartContainer>
	</div>

	{#if emptyKind}
		<MapEmptyState
			kind={emptyKind}
			{hiddenCount}
			{activeFilterLabels}
			{isolateName}
			{onClearFilters}
			{onExitIsolate}
		/>
	{/if}
</div>
