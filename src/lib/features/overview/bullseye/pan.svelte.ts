/**
 * The bullseye's drag-to-pan behaviour.
 */
import { anchorPan, panBounds, REST_SCALE, type PanBounds, type Vec2 } from './pan-mappings.ts';
import { reducedMotion } from '#lib/shell/motion.svelte.ts';

/** How far the pointer must travel before a press is a drag rather than a click. */
const DRAG_THRESHOLD = 3;

/** How long a click or focus takes to carry a dot to the middle. */
const GLIDE_MS = 400;

/** Before the frame has been read there is nowhere to move, so nothing may. */
const UNMEASURED: PanBounds = { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };

/**
 * The chart backdrop's drag: the pointer moves the chart one for one from where it rests,
 * and never past the travel the bounds allow, so a quarter of the chart always
 * stays in the chart region whatever the reader does with it.
 *
 * The frame is read from real layout — the layer's untransformed resting box and
 * the chart backdrop's own size — so a resize or a scale change re-measures rather than
 * being tracked, and the transform the drag writes can never feed back into the
 * measurement. Only the target is recomputed per pointer event.
 */
export function createDragPan(columnRight: () => number) {
	let x = $state(0);
	let y = $state(0);
	let dragging = $state(false);
	let layer = $state<HTMLElement>();
	let bounds = $state<HTMLElement>();
	/** The hit target a drag captures, so the pointer keeps arriving wherever it goes. */
	let surface = $state<HTMLElement>();

	/** The press that just ended was a drag, so the click that follows it is its tail. */
	let dragTail = false;

	let travel: PanBounds = UNMEASURED;
	let drag:
		| {
				pointerId: number;
				from: Vec2;
				pan: Vec2;
				captured: boolean;
		  }
		| undefined;

	/** Hold an offset inside the travel. Every write goes through here. */
	function clamp(next: Vec2, within: PanBounds = travel): Vec2 {
		return {
			x: Math.max(within.min.x, Math.min(within.max.x, next.x)),
			y: Math.max(within.min.y, Math.min(within.max.y, next.y))
		};
	}

	/**
	 * The travel a given scale leaves, read from the frame and the layer's resting
	 * box. The centre may be passed arithmetically: the layer's offsets still hold
	 * the previous placement on the first measure after it moves.
	 */
	function limitsFor(scale: number, centre?: Vec2): PanBounds {
		if (!layer || !bounds) return UNMEASURED;

		return panBounds({
			centre: centre ?? { x: layer.offsetLeft, y: layer.offsetTop },
			size: bounds.clientWidth * scale * REST_SCALE,
			frame: { width: bounds.clientWidth, height: bounds.clientHeight },
			columnRight: columnRight()
		});
	}

	/** Write an offset, clamped to the travel on hand. */
	function set(next: Vec2, within: PanBounds = travel) {
		const held = clamp(next, within);
		x = held.x;
		y = held.y;
	}

	/** Re-read the travel at this scale and pull a pan that no longer fits back inside it. */
	function measure(scale: number, centre?: Vec2) {
		travel = limitsFor(scale, centre);
		set({ x, y });
	}

	/**
	 * The scale change the wheel asks for, anchored on the point under the pointer:
	 * the chart point beneath it stays beneath it, and the pan it lands on is held
	 * inside the travel the new scale leaves.
	 */
	function zoomAnchored(offset: Vec2, ratio: number, next: number) {
		set(anchorPan({ x, y }, offset, ratio), limitsFor(next));
	}

	/** A press: remembered, but not yet a drag, so a plain click still reaches the dot under it. */
	function start(event: PointerEvent) {
		if (event.button !== 0 || drag) return;
		dragTail = false;
		stopGlide();
		drag = {
			pointerId: event.pointerId,
			from: { x: event.clientX, y: event.clientY },
			pan: { x, y },
			captured: false
		};
	}

	function move(event: PointerEvent) {
		if (!drag || drag.pointerId !== event.pointerId) return;
		// A release the window never saw — over browser chrome, say — ends the drag
		// here, so a bare pointer can never keep panning the chart.
		if ((event.buttons & 1) === 0) {
			drag = undefined;
			dragging = false;
			return;
		}

		const dx = event.clientX - drag.from.x;
		const dy = event.clientY - drag.from.y;
		if (!drag.captured) {
			if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
			drag.captured = true;
			dragging = true;
			// Captured on the surface rather than on whatever the press landed on: the
			// click that follows a drag then retargets to their common ancestor, so a
			// drag can never toggle the name of the dot it started on.
			surface?.setPointerCapture(event.pointerId);
		}

		set({ x: drag.pan.x + dx, y: drag.pan.y + dy });
	}

	function end(event: PointerEvent) {
		if (!drag || drag.pointerId !== event.pointerId) return;
		dragTail = drag.captured;
		drag = undefined;
		dragging = false;
	}

	/**
	 * Whether the click now arriving is the tail of a drag, not a click of its own.
	 * Answers once: a drag released where no click follows cannot swallow the next
	 * real click, because a new press clears it as well.
	 */
	function takeDragTail(): boolean {
		const wasTail = dragTail;
		dragTail = false;
		return wasTail;
	}

	let frame = 0;

	/** Stop any glide in flight, so the reader's own input always wins. */
	function stopGlide() {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
	}

	/**
	 * A dot can be focused or clicked without the pointer ever dragging to it. Glide
	 * the chart so it lands in the middle of the chart backdrop, clamped to the travel so it
	 * stops where the bound says. Reduced motion jumps instead.
	 */
	function snapIntoView(element: SVGCircleElement, settled?: () => void) {
		// A press focuses the dot under it; the press may become a drag, which owns the pan.
		if (!layer || !bounds || drag) {
			settled?.();
			return;
		}
		stopGlide();
		const box = bounds.getBoundingClientRect();
		const dot = element.getBoundingClientRect();
		const dx = box.left + box.width / 2 - (dot.left + dot.width / 2);
		const dy = box.top + box.height / 2 - (dot.top + dot.height / 2);
		const from = { x, y };
		const to = clamp({ x: x + dx, y: y + dy });
		if (reducedMotion()) {
			set(to);
			settled?.();
			return;
		}

		const started = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - started) / GLIDE_MS);
			const eased = 1 - (1 - t) ** 3;
			set({ x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased });
			frame = t < 1 ? requestAnimationFrame(step) : 0;
			if (t === 1) settled?.();
		};
		frame = requestAnimationFrame(step);
	}

	/** A gesture in flight when the chart backdrop goes away: the browser releases the capture itself. */
	function cancel() {
		stopGlide();
		drag = undefined;
		dragging = false;
	}

	/**
	 * Return the chart to its placement wherever it stood, unclamped: at rest
	 * there is no bound and no gesture, so only the placement may place it.
	 */
	function reset() {
		stopGlide();
		drag = undefined;
		dragging = false;
		x = 0;
		y = 0;
	}

	return {
		get x() {
			return x;
		},
		get y() {
			return y;
		},
		get dragging() {
			return dragging;
		},
		get layer() {
			return layer;
		},
		set layer(value: HTMLElement | undefined) {
			layer = value;
		},
		get bounds() {
			return bounds;
		},
		set bounds(value: HTMLElement | undefined) {
			bounds = value;
		},
		get surface() {
			return surface;
		},
		set surface(value: HTMLElement | undefined) {
			surface = value;
		},
		measure,
		zoomAnchored,
		start,
		move,
		end,
		snapIntoView,
		takeDragTail,
		cancel,
		reset
	};
}
