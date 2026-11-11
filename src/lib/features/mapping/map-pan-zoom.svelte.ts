/**
 * The map's pan and zoom: the current transform, the drag gestures, and fitting the
 * map into a box.
 */
import { untrack } from 'svelte';
import { cubicOut } from 'svelte/easing';
import { fitFloor } from './composition/graph-composition-layout.ts';
import { easeStopThreshold, nodeEase } from './layout/graph-group-physics.ts';

const minZoom = 0.4;
/**
 * Framing the whole map may go below {@link minZoom} when the map needs it, so
 * every map fits, and zooming by hand can then reach the framed level too. The
 * framing always fits; the shared floor only guards degenerate maps.
 */
const maxZoom = 4;
const dragThreshold = 3;

type FitBounds = { x: number; y: number; width: number; height: number };
type FitView = {
	width: number;
	height: number;
	left: number;
	top: number;
	/** The centred layer's screen offset (its CTM e and f). */
	matrixE: number;
	matrixF: number;
	insets: { top: number; bottom: number; left: number; right: number };
};

/** The zoom and pan that frame `box` in the chart area; `forceZoom` pins the zoom. */
export function fitCamera(
	box: FitBounds,
	view: FitView,
	padding = 28,
	cap = maxZoom,
	forceZoom?: number
) {
	const { insets } = view;
	const fit = Math.min(
		(view.width - padding * 2) / box.width,
		(view.height - padding * 2 - insets.top - insets.bottom) / box.height
	);
	const next = forceZoom ?? Math.max(fitFloor, Math.min(cap, fit));
	const centerX = view.left + (view.width + insets.left - insets.right) / 2;
	const centerY = view.top + (view.height + insets.top - insets.bottom) / 2;

	return {
		zoom: next,
		panX: centerX - view.matrixE - next * (box.x + box.width / 2),
		panY: centerY - view.matrixF - next * (box.y + box.height / 2)
	};
}

export function createPanZoom() {
	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let isPanning = $state(false);
	let layer = $state<SVGGElement | undefined>(undefined);
	let animation = $state<number | undefined>();
	let revision = $state(0);
	let dragStart:
		| {
				pointerId: number;
				x: number;
				y: number;
				panX: number;
				panY: number;
				surface: HTMLElement;
				moved: boolean;
		  }
		| undefined;

	function toLayerPoint(
		event: Pick<PointerEvent | WheelEvent, 'clientX' | 'clientY'>
	): DOMPoint | undefined {
		const centeredLayer = layer?.parentElement;
		if (!(centeredLayer instanceof SVGGraphicsElement)) return undefined;

		const matrix = centeredLayer.getScreenCTM();
		if (!matrix) return undefined;

		return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
	}

	/** A pointer position in the layer's own user space, where the dots' positions live. */
	function toMapPoint(
		event: Pick<PointerEvent, 'clientX' | 'clientY'>
	): { x: number; y: number } | undefined {
		const matrix = layer?.getScreenCTM();
		if (!matrix) return undefined;
		const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
		return { x: point.x, y: point.y };
	}

	/** The organizer's own hand takes over: stop any travel and follow the input. */
	function cancelAnimation() {
		// Commands can run inside a rendering effect. Reading the revision/RAF handle here
		// must not subscribe that effect to its own writes and cancel its pending fit.
		untrack(() => {
			revision += 1;
			if (animation !== undefined) cancelAnimationFrame(animation);
			animation = undefined;
		});
	}

	/**
	 * The zoom that frames the whole map: the view's 100%. Reset returns to it.
	 */
	let framedZoom = $state(1);
	/**
	 * The last level announced for the ± controls or the keyboard. Wheel and drag
	 * zoom never write it, so a live region can say only what the user asked for.
	 */
	let announcedZoom = $state<number | undefined>(undefined);
	/**
	 * The view's 40%. The floor follows the framing, like the ceiling: an absolute
	 * floor sat at the framing itself on a large map, so zooming out did nothing.
	 */
	const lowest = () => minZoom * framedZoom;
	/** The view's 400%: four times the whole-map framing. */
	const highest = () => maxZoom * framedZoom;

	function applyZoom(nextZoom: number, anchor?: { x: number; y: number }) {
		cancelAnimation();
		const clamped = Math.max(lowest(), Math.min(highest(), nextZoom));
		if (clamped === zoom) return;

		const target = anchor ?? { x: 0, y: 0 };
		const ratio = clamped / zoom;
		panX = target.x - (target.x - panX) * ratio;
		panY = target.y - (target.y - panY) * ratio;
		zoom = clamped;
	}

	/** Records the level the mounted polite live region should say after a ± or key zoom. */
	function announceZoomLevel() {
		announcedZoom = Math.round((zoom / framedZoom) * 100);
	}

	function handleWheel(event: WheelEvent) {
		const surface = event.currentTarget;
		if (!(surface instanceof HTMLElement)) return;

		const point = toLayerPoint(event);
		if (!point) return;

		event.preventDefault();
		const deltaMultiplier =
			event.deltaMode === WheelEvent.DOM_DELTA_LINE
				? 16
				: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
					? surface.clientHeight
					: 1;

		applyZoom(zoom * Math.exp(-event.deltaY * deltaMultiplier * 0.001), {
			x: point.x,
			y: point.y
		});
	}

	function startPan(event: PointerEvent) {
		if (event.button !== 0 || dragStart) return;
		cancelAnimation();

		const surface = event.currentTarget;
		const point = toLayerPoint(event);
		if (!(surface instanceof HTMLElement) || !point) return;

		event.preventDefault();
		dragStart = {
			pointerId: event.pointerId,
			x: point.x,
			y: point.y,
			panX,
			panY,
			surface,
			moved: false
		};
	}

	function movePan(event: PointerEvent) {
		if (dragStart?.pointerId !== event.pointerId) return;

		const point = toLayerPoint(event);
		if (!point) return;

		const dx = point.x - dragStart.x;
		const dy = point.y - dragStart.y;

		// Capture only after real movement so a plain click still reaches marks.
		if (!dragStart.moved && Math.hypot(dx, dy) < dragThreshold) return;
		if (!dragStart.moved) {
			dragStart.moved = true;
			isPanning = true;
			dragStart.surface.setPointerCapture(event.pointerId);
		}

		panX = dragStart.panX + dx;
		panY = dragStart.panY + dy;
	}

	function endPan(event: PointerEvent) {
		if (dragStart?.pointerId !== event.pointerId) return;

		dragStart = undefined;
		isPanning = false;
	}

	/**
	 * `lostpointercapture` bubbles, and a touch drag begins with the browser's
	 * implicit capture sitting on whatever mark is under the finger. Capturing
	 * the surface therefore fires a capture loss that the surface never took,
	 * and ending the drag on it stopped a touch pan after one step. Only the
	 * surface this gesture captured may end the gesture.
	 */
	function endCapture(event: PointerEvent) {
		if (!dragStart?.moved || event.target !== dragStart.surface) return;
		endPan(event);
	}

	function zoomIn() {
		applyZoom(zoom * 1.3);
		announceZoomLevel();
	}

	/** A keyboard pan step: the organizer's own hand, so any travel stops first. */
	function panBy(dx: number, dy: number) {
		cancelAnimation();
		panX += dx;
		panY += dy;
	}

	function zoomOut() {
		applyZoom(zoom / 1.3);
		announceZoomLevel();
	}

	function resetView() {
		cancelAnimation();
		zoom = 1;
		panX = 0;
		panY = 0;
	}

	/** Travels the camera back to 1× centred, so it reads as part of the move. */
	function animateReset(duration = 500) {
		cancelAnimation();
		const startZoom = zoom;
		const startX = panX;
		const startY = panY;
		const start = performance.now();

		const step = (now: number) => {
			const progress = Math.min(1, (now - start) / duration);
			const eased = cubicOut(progress);

			zoom = startZoom + (1 - startZoom) * eased;
			panX = startX * (1 - eased);
			panY = startY * (1 - eased);
			animation = progress < 1 ? requestAnimationFrame(step) : undefined;
		};

		animation = requestAnimationFrame(step);
	}

	type Bounds = { x: number; y: number; width: number; height: number };

	// Floating chrome (the control strip, the bottom bar, the worker card) covers
	// the canvas edge it floats on, so a fit keeps the drawing clear of it.
	let insetTop = 0;
	let insetBottom = 0;
	let insetLeft = 0;
	let insetRight = 0;

	/**
	 * The zoom and pan that frame `box` in the chart area, or nothing if it cannot
	 * be framed. `forceZoom` pins the zoom instead of fitting to the box, which is
	 * how a reset keeps the map at its recorded scale.
	 */
	function targetFor(box: Bounds, padding = 28, cap = maxZoom, forceZoom?: number) {
		const element = layer;
		const centeredLayer = element?.parentElement;
		const surface = element?.ownerSVGElement;
		if (!element || !surface || !(centeredLayer instanceof SVGGraphicsElement)) {
			return undefined;
		}

		const matrix = centeredLayer.getScreenCTM();
		const rect = surface.getBoundingClientRect();
		if (!matrix || box.width < 0 || box.height < 0) return undefined;

		const target = fitCamera(
			box,
			{
				width: rect.width,
				height: rect.height,
				left: rect.left,
				top: rect.top,
				matrixE: matrix.e,
				matrixF: matrix.f,
				insets: { top: insetTop, bottom: insetBottom, left: insetLeft, right: insetRight }
			},
			padding,
			cap,
			forceZoom
		);
		return target;
	}

	/**
	 * Puts a box in the middle of the free canvas at the view's 100%: the reset. The
	 * insets the caller set keep it clear of the floating control strip, bar and card,
	 * and the zoom returns to the whole-map framing.
	 */
	function centreOn(box: Bounds, atZoom = framedZoom) {
		const target = targetFor(box, 0, maxZoom, atZoom);
		if (!target) return;

		cancelAnimation();
		zoom = target.zoom;
		panX = target.panX;
		panY = target.panY;
	}

	/** Frames an explicit box at once, optionally without zooming past a ceiling. */
	function fitTo(box: Bounds, padding = 28, cap = maxZoom) {
		const target = targetFor(box, padding, cap);
		if (!target) return undefined;

		cancelAnimation();
		zoom = target.zoom;
		panX = target.panX;
		panY = target.panY;
		return target;
	}

	/** Travels the framing to an explicit box, so it reads as part of the move. */
	function animateFit(box: Bounds, padding = 28, duration = 500, cap = maxZoom) {
		const target = targetFor(box, padding, cap);
		if (!target) return;

		cancelAnimation();
		const startZoom = zoom;
		const startX = panX;
		const startY = panY;
		const start = performance.now();

		const step = (now: number) => {
			const progress = Math.min(1, (now - start) / duration);
			const eased = cubicOut(progress);

			zoom = startZoom + (target.zoom - startZoom) * eased;
			panX = startX + (target.panX - startX) * eased;
			panY = startY + (target.panY - startY) * eased;
			animation = progress < 1 ? requestAnimationFrame(step) : undefined;
		};

		animation = requestAnimationFrame(step);
	}

	/**
	 * Eases the camera to `target` with the same per-frame ease as the dot glide, so
	 * the two settle together. Snaps once every remaining delta is below a pixel.
	 */
	function easeTo(target: { zoom: number; panX: number; panY: number }, rate = nodeEase) {
		cancelAnimation();
		const step = () => {
			const dz = target.zoom - zoom;
			const dx = target.panX - panX;
			const dy = target.panY - panY;
			if (
				Math.abs(dz) < 0.001 &&
				Math.abs(dx) < easeStopThreshold &&
				Math.abs(dy) < easeStopThreshold
			) {
				zoom = target.zoom;
				panX = target.panX;
				panY = target.panY;
				animation = undefined;
				return;
			}
			zoom += dz * rate;
			panX += dx * rate;
			panY += dy * rate;
			animation = requestAnimationFrame(step);
		};

		animation = requestAnimationFrame(step);
	}

	return {
		toMapPoint,
		get zoom() {
			return zoom;
		},
		/** The whole-map framing's zoom, which the view calls 100%. */
		get framedZoom() {
			return framedZoom;
		},
		set framedZoom(value: number) {
			framedZoom = value;
		},
		/** The level last announced for the ± controls or the keyboard; undefined before any. */
		get announcedZoom() {
			return announcedZoom;
		},
		get panX() {
			return panX;
		},
		get panY() {
			return panY;
		},
		get isPanning() {
			return isPanning;
		},
		/** Whether an eased camera move is still travelling. */
		get revision() {
			return revision;
		},
		get animating() {
			return animation !== undefined;
		},
		get layer() {
			return layer;
		},
		set layer(value: SVGGElement | undefined) {
			layer = value;
		},
		setInsets(top: number, bottom: number, left = 0, right = 0) {
			insetTop = top;
			insetBottom = bottom;
			insetLeft = left;
			insetRight = right;
		},
		setView(next: { zoom: number; panX: number; panY: number }) {
			cancelAnimation();
			zoom = Math.max(lowest(), Math.min(highest(), next.zoom));
			panX = next.panX;
			panY = next.panY;
		},
		handleWheel,
		startPan,
		movePan,
		endPan,
		endCapture,
		zoomIn,
		zoomOut,
		panBy,
		resetView,
		animateReset,
		centreOn,
		fitTo,
		animateFit,
		easeTo,
		targetFor
	};
}

export type PanZoom = ReturnType<typeof createPanZoom>;
