/**
 * The bullseye chart backdrop's drag, specced through the factory the component mounts:
 * the press that becomes a drag, the travel that keeps a quarter of the chart in
 * its region, the scale change that re-anchors the chart under the
 * pointer, and the glide that carries a dot to the middle.
 *
 * The factory reads real layout (the layer's resting box and the chart backdrop's own
 * size), so the elements here are the smallest literal fakes that answer those
 * reads: they are never queried or mutated by the module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_VISIBLE_SHARE, REST_SCALE } from './pan-mappings.ts';
import { createDragPan } from './pan.svelte.ts';

// The system motion preference is a browser boundary; node's svelte/reactivity reports
// the fallback, so the boundary is stubbed to drive both the glide and its reduced path.
const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('#lib/shell/motion.svelte.ts', () => ({ reducedMotion: () => motion.reduced }));

/** The frame's own size, the layer's resting centre and the leading column's edge. */
const FRAME = { width: 1024, height: 900 };
const RESTING = { x: 894, y: 470 };
const COLUMN_RIGHT = 376;
/** The chart's resting side and the quarter of it that must stay in the region. */
const SIZE = FRAME.width * REST_SCALE;
const VISIBLE = SIZE * MIN_VISIBLE_SHARE;

beforeEach(() => {
	motion.reduced = false;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function fakeElements() {
	const layer = { offsetLeft: RESTING.x, offsetTop: RESTING.y } as unknown as HTMLElement;
	const bounds = {
		clientWidth: FRAME.width,
		clientHeight: FRAME.height,
		getBoundingClientRect: () => ({ left: 0, top: 0, width: FRAME.width, height: FRAME.height })
	} as unknown as HTMLElement;
	const capture = vi.fn();
	const surface = { setPointerCapture: capture } as unknown as HTMLElement;
	return { layer, bounds, surface, capture };
}

/** A factory with its frame measured at 1x, and the fakes it reads. */
function setup() {
	const pan = createDragPan(() => COLUMN_RIGHT);
	const elements = fakeElements();
	pan.layer = elements.layer;
	pan.bounds = elements.bounds;
	pan.surface = elements.surface;
	pan.measure(1);
	return { pan, ...elements };
}

function pointer(x: number, y: number, extra: Partial<PointerEvent> = {}) {
	return {
		pointerId: 1,
		button: 0,
		buttons: 1,
		clientX: x,
		clientY: y,
		...extra
	} as unknown as PointerEvent;
}

/** The layer's edges at a pan offset, as the frame's own coordinates measure them. */
function edges(pan: { x: number; y: number }, scale = 1) {
	const size = SIZE * scale;
	const centre = { x: RESTING.x + pan.x, y: RESTING.y + pan.y };
	return {
		left: centre.x - size / 2,
		right: centre.x + size / 2,
		top: centre.y - size / 2,
		bottom: centre.y + size / 2
	};
}

describe('a new chart backdrop', () => {
	it('a new chart backdrop rests at the origin with no element attached', () => {
		const pan = createDragPan(() => COLUMN_RIGHT);
		expect(pan.x).toBe(0);
		expect(pan.y).toBe(0);
		expect(pan.dragging).toBe(false);
		expect(pan.layer).toBeUndefined();
		expect(pan.bounds).toBeUndefined();
		expect(pan.surface).toBeUndefined();
	});

	it('is a drag that moves nothing before the frame has been measured', () => {
		const pan = createDragPan(() => COLUMN_RIGHT);
		pan.start(pointer(0, 0));
		pan.move(pointer(200, 200));
		expect(pan.dragging).toBe(true);
		expect(pan.x).toBe(0);
		expect(pan.y).toBe(0);
	});

	it('reads back the layer, bounds and surface it is given', () => {
		const { layer, bounds, surface } = fakeElements();
		const pan = createDragPan(() => COLUMN_RIGHT);
		pan.layer = layer;
		pan.bounds = bounds;
		pan.surface = surface;

		expect(pan.layer).toBe(layer);
		expect(pan.bounds).toBe(bounds);
		expect(pan.surface).toBe(surface);
	});

	it('moves nothing when only one half of the frame is known', () => {
		const { layer } = fakeElements();
		const pan = createDragPan(() => COLUMN_RIGHT);
		pan.layer = layer;
		pan.measure(1);
		pan.start(pointer(0, 0));
		pan.move(pointer(200, 200));
		expect(pan.x).toBe(0);
		expect(pan.y).toBe(0);
	});
});

describe('drag', () => {
	it('moves the chart one for one from where the press began', () => {
		const { pan, capture } = setup();
		pan.start(pointer(500, 500));
		pan.move(pointer(504, 503));
		expect(pan.dragging).toBe(true);
		expect(capture).toHaveBeenCalledWith(1);
		expect(pan.x).toBe(4);
		expect(pan.y).toBe(3);

		pan.move(pointer(560, 480));
		expect(pan.x).toBe(60);
		expect(pan.y).toBe(-20);

		pan.end(pointer(560, 480));
		expect(pan.dragging).toBe(false);
		expect(pan.x).toBe(60);
	});

	it('keeps a press that stays within the threshold a click', () => {
		const { pan, capture } = setup();
		pan.start(pointer(500, 500));
		pan.move(pointer(502, 501));
		expect(pan.dragging).toBe(false);
		expect(pan.x).toBe(0);
		expect(capture).not.toHaveBeenCalled();

		pan.move(pointer(505, 500));
		expect(pan.dragging).toBe(true);
		expect(pan.x).toBe(5);
	});

	it('ignores a press from another button or pointer while one is held', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0, { button: 2 }));
		pan.move(pointer(50, 0));
		expect(pan.x).toBe(0);

		pan.start(pointer(100, 100));
		pan.start(pointer(300, 300, { pointerId: 2 }));
		pan.move(pointer(150, 100));
		expect(pan.x).toBe(50);

		pan.move(pointer(150, 100, { pointerId: 2 }));
		expect(pan.x).toBe(50);
	});

	it('ends only the pointer that started the drag, and only once', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0));
		pan.move(pointer(50, 0));
		pan.end(pointer(50, 0, { pointerId: 2 }));
		expect(pan.dragging).toBe(true);

		pan.end(pointer(50, 0));
		expect(pan.dragging).toBe(false);
		pan.end(pointer(50, 0));
		expect(pan.dragging).toBe(false);
	});

	it('ends a drag whose release the window never saw', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0));
		pan.move(pointer(50, 0));
		expect(pan.dragging).toBe(true);

		pan.move(pointer(80, 0, { buttons: 0 }));
		expect(pan.dragging).toBe(false);
		pan.move(pointer(120, 0));
		expect(pan.x).toBe(50);
	});
});

describe('the quarter-visible bound', () => {
	it('stops at the right and bottom limits', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0));
		pan.move(pointer(5000, 5000));

		// The left edge stays where a quarter of the chart is still inside the frame.
		expect(edges(pan).left).toBeCloseTo(FRAME.width - VISIBLE, 6);
		expect(edges(pan).top).toBeCloseTo(FRAME.height - VISIBLE, 6);
	});

	it('stops at the left and top limits, clear of the leading column', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0));
		pan.move(pointer(-5000, -5000));

		// The right edge stays a quarter of the chart right of the leading column.
		expect(edges(pan).right).toBeCloseTo(COLUMN_RIGHT + VISIBLE, 6);
		expect(edges(pan).bottom).toBeCloseTo(VISIBLE, 6);
	});

	it('holds the quarter at every reachable offset and scale', () => {
		for (const scale of [0.5, 1, 2]) {
			const { pan } = setup();
			pan.measure(scale);
			for (const [dx, dy] of [
				[5000, 5000],
				[-5000, -5000],
				[5000, -5000],
				[-5000, 5000]
			]) {
				pan.start(pointer(0, 0));
				pan.move(pointer(dx, dy));
				const box = edges(pan, scale);
				const size = SIZE * scale;
				const visible = size * MIN_VISIBLE_SHARE;
				expect(box.right - COLUMN_RIGHT).toBeGreaterThanOrEqual(visible - 1e-6);
				expect(FRAME.width - box.left).toBeGreaterThanOrEqual(visible - 1e-6);
				expect(box.bottom).toBeGreaterThanOrEqual(visible - 1e-6);
				expect(FRAME.height - box.top).toBeGreaterThanOrEqual(visible - 1e-6);
				pan.end(pointer(dx, dy));
				pan.measure(scale);
			}
		}
	});
});

describe('measure', () => {
	it('pulls a pan that no longer fits back inside the travel a smaller scale leaves', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0));
		pan.move(pointer(5000, 0));
		expect(pan.x).toBeGreaterThan(0);

		pan.measure(0.5);
		// A shrunken chart leaves less travel; the pan is pulled back to its new right limit.
		expect(edges(pan, 0.5).left).toBeCloseTo(FRAME.width - SIZE * 0.5 * MIN_VISIBLE_SHARE, 6);
	});

	it('leaves a pan that still fits alone when the chart grows', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0));
		pan.move(pointer(40, 20));
		pan.measure(2);
		expect(pan.x).toBe(40);
		expect(pan.y).toBe(20);
	});
});

describe('zoom anchoring', () => {
	it('keeps the chart point under the pointer where it is', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0));
		pan.move(pointer(60, -20));
		pan.end(pointer(60, -20));

		const offset = { x: 100, y: -50 };
		const ratio = 2;
		pan.zoomAnchored(offset, ratio, 2);

		// The point under the pointer keeps its screen offset at the new scale.
		expect(pan.x + (offset.x - 60) * ratio).toBeCloseTo(offset.x, 6);
		expect(pan.y + (offset.y - -20) * ratio).toBeCloseTo(offset.y, 6);
		expect(pan.x).toBeCloseTo(20, 6);
		expect(pan.y).toBeCloseTo(10, 6);
	});

	it('holds the anchored pan inside the travel the new scale leaves', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0));
		pan.move(pointer(60, 0));
		pan.end(pointer(60, 0));

		pan.zoomAnchored({ x: -2000, y: 0 }, 2, 2);
		expect(pan.x).toBeCloseTo(FRAME.width - SIZE * 2 * MIN_VISIBLE_SHARE - (RESTING.x - SIZE), 6);
		expect(edges(pan, 2).left).toBeCloseTo(FRAME.width - SIZE * 2 * MIN_VISIBLE_SHARE, 6);
	});
});

describe('snapIntoView', () => {
	function frames() {
		const pending: FrameRequestCallback[] = [];
		const cancel = vi.fn();
		let id = 0;
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			pending.push(callback);
			return (id += 1);
		});
		vi.stubGlobal('cancelAnimationFrame', cancel);
		return { pending, cancel };
	}

	/** A dot 288px right of and 40px above the frame's middle. */
	const dot = {
		getBoundingClientRect: () => ({ left: 800, top: 400, width: 20, height: 20 })
	} as unknown as SVGCircleElement;

	it('glides the dot to the middle and settles on the last frame', () => {
		const { pan } = setup();
		const raf = frames();
		vi.spyOn(performance, 'now').mockReturnValue(1000);
		const settled = vi.fn();

		pan.snapIntoView(dot, settled);
		expect(raf.pending).toHaveLength(1);
		expect(settled).not.toHaveBeenCalled();

		raf.pending[0](1200);
		expect(pan.x).toBeCloseTo(-298 * 0.875, 6);
		expect(pan.y).toBeCloseTo(40 * 0.875, 6);

		raf.pending[1](1400);
		expect(pan.x).toBeCloseTo(-298, 6);
		expect(pan.y).toBeCloseTo(40, 6);
		expect(settled).toHaveBeenCalledOnce();
		expect(raf.pending).toHaveLength(2);
	});

	it('jumps straight there and settles when motion is reduced', () => {
		const { pan } = setup();
		const raf = frames();
		motion.reduced = true;
		const settled = vi.fn();

		pan.snapIntoView(dot, settled);
		expect(pan.x).toBeCloseTo(-298, 6);
		expect(pan.y).toBeCloseTo(40, 6);
		expect(settled).toHaveBeenCalledOnce();
		expect(raf.pending).toHaveLength(0);
	});

	it('clamps the glide to the travel', () => {
		const { pan } = setup();
		motion.reduced = true;
		const far = {
			getBoundingClientRect: () => ({ left: -10_000, top: -10_000, width: 20, height: 20 })
		} as unknown as SVGCircleElement;

		pan.snapIntoView(far);
		// The far dot would drag the chart down-right past the travel, so it stops at the limit.
		expect(edges(pan).left).toBeCloseTo(FRAME.width - VISIBLE, 6);
		expect(edges(pan).top).toBeCloseTo(FRAME.height - VISIBLE, 6);
	});

	it('settles without moving when the frame is not known', () => {
		const pan = createDragPan(() => COLUMN_RIGHT);
		const settled = vi.fn();
		pan.snapIntoView(dot, settled);
		expect(settled).toHaveBeenCalledOnce();
		expect(pan.x).toBe(0);
	});

	it('leaves the pan to a drag already in flight', () => {
		const { pan } = setup();
		const raf = frames();
		pan.start(pointer(0, 0));
		pan.move(pointer(50, 0));
		const settled = vi.fn();

		pan.snapIntoView(dot, settled);
		expect(settled).toHaveBeenCalledOnce();
		expect(pan.x).toBe(50);
		expect(raf.pending).toHaveLength(0);
	});

	it('stops a glide in flight when the reader presses again', () => {
		const { pan } = setup();
		const raf = frames();
		pan.snapIntoView(dot);
		expect(raf.pending).toHaveLength(1);

		pan.start(pointer(0, 0));
		expect(raf.cancel).toHaveBeenCalledWith(1);
	});

	it('stops a glide in flight when the chart backdrop goes away', () => {
		const { pan } = setup();
		const raf = frames();
		pan.snapIntoView(dot);

		pan.cancel();
		expect(raf.cancel).toHaveBeenCalledWith(1);
		expect(pan.x).toBe(0);
	});
});

describe('reset', () => {
	it('returns the chart to rest wherever it stood, unclamped', () => {
		const { pan } = setup();
		pan.start(pointer(500, 500));
		pan.move(pointer(504, 503));
		expect(pan.x).toBe(4);
		expect(pan.y).toBe(3);

		pan.reset();
		expect(pan.dragging).toBe(false);
		expect(pan.x).toBe(0);
		expect(pan.y).toBe(0);
	});
});

describe('the drag tail', () => {
	it('spends the click that follows a drag, once', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0));
		pan.move(pointer(50, 0));
		pan.end(pointer(50, 0));

		expect(pan.takeDragTail()).toBe(true);
		expect(pan.takeDragTail()).toBe(false);
	});

	it('leaves a click that was never a drag its own', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0));
		pan.move(pointer(1, 1));
		pan.end(pointer(1, 1));
		expect(pan.takeDragTail()).toBe(false);
	});

	it('forgets an unconsumed tail when the next press arrives', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0));
		pan.move(pointer(50, 0));
		pan.end(pointer(50, 0));

		pan.start(pointer(0, 0));
		expect(pan.takeDragTail()).toBe(false);
	});
});

describe('cancel', () => {
	it('drops a drag in flight and keeps the chart where it was', () => {
		const { pan } = setup();
		pan.start(pointer(0, 0));
		pan.move(pointer(80, 40));
		pan.cancel();

		expect(pan.dragging).toBe(false);
		expect(pan.x).toBe(80);
		pan.move(pointer(200, 200));
		expect(pan.x).toBe(80);
	});
});
