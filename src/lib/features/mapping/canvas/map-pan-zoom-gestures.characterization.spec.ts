// @module-tag mapping
/**
 * Pins the map's pan gestures, camera framing and animated moves as they behave today, ahead of
 * breaking up map-canvas: drag-to-pan with its click threshold and pointer capture, framing a box
 * in the free canvas, and the eased and timed camera travels. Browser geometry is replaced by the
 * smallest literal stand-ins; time by fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPanZoom } from './map-pan-zoom.svelte.ts';

class FakeHTMLElement {
	captured: number[] = [];
	setPointerCapture(id: number) {
		this.captured.push(id);
	}
}
/** The centred layer: client (400, 250) reads as (100, 50), as in the wheel spec. */
class FakeSVGGraphicsElement {
	getScreenCTM() {
		return { e: 300, f: 200, inverse: () => ({ offsetX: -300, offsetY: -200 }) };
	}
}
class FakeDOMPoint {
	constructor(
		public x: number,
		public y: number
	) {}
	matrixTransform(matrix: { offsetX: number; offsetY: number }) {
		return new FakeDOMPoint(this.x + matrix.offsetX, this.y + matrix.offsetY);
	}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
	// Node has no animation frames: one frame is a 16 ms timer that reads the fake clock.
	vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) =>
		setTimeout(() => callback(performance.now()), 16)
	);
	vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
	vi.stubGlobal('HTMLElement', FakeHTMLElement);
	vi.stubGlobal('SVGGraphicsElement', FakeSVGGraphicsElement);
	vi.stubGlobal('DOMPoint', FakeDOMPoint);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function mounted() {
	const view = createPanZoom();
	const centred = new FakeSVGGraphicsElement();
	view.layer = {
		parentElement: centred,
		getScreenCTM: () => ({ inverse: () => ({ offsetX: -300, offsetY: -200 }) }),
		ownerSVGElement: {
			getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 })
		}
	} as unknown as SVGGElement;
	return view;
}

function pointer(
	surface: FakeHTMLElement,
	clientX: number,
	clientY: number,
	overrides: Record<string, unknown> = {}
) {
	return {
		button: 0,
		pointerId: 1,
		clientX,
		clientY,
		currentTarget: surface,
		target: surface,
		preventDefault: vi.fn(),
		...overrides
	} as unknown as PointerEvent;
}

describe('drag to pan', () => {
	it('moves the pan with the pointer once the drag passes the click threshold, and captures it', () => {
		const view = mounted();
		const surface = new FakeHTMLElement();
		view.startPan(pointer(surface, 400, 250));
		expect(view.isPanning).toBe(false);
		view.movePan(pointer(surface, 401, 251));
		expect(view.isPanning).toBe(false);
		expect(surface.captured).toEqual([]);
		view.movePan(pointer(surface, 430, 280));
		expect(view.isPanning).toBe(true);
		expect(surface.captured).toEqual([1]);
		expect([view.panX, view.panY]).toEqual([30, 30]);
		view.movePan(pointer(surface, 410, 300));
		expect([view.panX, view.panY]).toEqual([10, 50]);
		expect(surface.captured).toEqual([1]);
		view.endPan(pointer(surface, 410, 300));
		expect(view.isPanning).toBe(false);
	});

	it('claims the press only for the primary button, and only one drag at a time', () => {
		const view = mounted();
		const surface = new FakeHTMLElement();
		const secondary = pointer(surface, 400, 250, { button: 2 });
		view.startPan(secondary);
		expect(secondary.preventDefault).not.toHaveBeenCalled();
		const first = pointer(surface, 400, 250);
		view.startPan(first);
		expect(first.preventDefault).toHaveBeenCalled();
		const second = pointer(surface, 400, 250, { pointerId: 2 });
		view.startPan(second);
		expect(second.preventDefault).not.toHaveBeenCalled();
	});

	it('ignores moves and ends from another pointer', () => {
		const view = mounted();
		const surface = new FakeHTMLElement();
		view.startPan(pointer(surface, 400, 250));
		view.movePan(pointer(surface, 460, 250, { pointerId: 9 }));
		expect(view.panX).toBe(0);
		view.endPan(pointer(surface, 400, 250, { pointerId: 9 }));
		view.movePan(pointer(surface, 460, 250));
		expect(view.panX).toBe(60);
	});

	it('does not start without a layer or a surface element', () => {
		const view = createPanZoom();
		const surface = new FakeHTMLElement();
		const event = pointer(surface, 400, 250);
		view.startPan(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		const bare = mounted();
		const notElement = pointer({} as FakeHTMLElement, 400, 250);
		bare.startPan(notElement);
		expect(notElement.preventDefault).not.toHaveBeenCalled();
	});

	it('ends on the loss of capture only for the surface that took it, and only after a move', () => {
		const view = mounted();
		const surface = new FakeHTMLElement();
		view.startPan(pointer(surface, 400, 250));
		view.endCapture(pointer(surface, 400, 250));
		view.movePan(pointer(surface, 440, 250));
		expect(view.isPanning).toBe(true);
		// A touch drag starts with implicit capture on a mark; losing that must not end the pan.
		view.endCapture(pointer(surface, 440, 250, { target: new FakeHTMLElement() }));
		expect(view.isPanning).toBe(true);
		view.endCapture(pointer(surface, 440, 250));
		expect(view.isPanning).toBe(false);
	});

	it('stops any camera travel when a drag begins', () => {
		const view = mounted();
		view.setView({ zoom: 2, panX: 50, panY: 50 });
		view.animateReset(500);
		expect(view.animating).toBe(true);
		view.startPan(pointer(new FakeHTMLElement(), 400, 250));
		expect(view.animating).toBe(false);
	});
});

describe('map point', () => {
	it('reads a pointer position in the layer space, or nothing without a layer', () => {
		expect(mounted().toMapPoint({ clientX: 400, clientY: 250 })).toEqual({ x: 100, y: 50 });
		expect(createPanZoom().toMapPoint({ clientX: 400, clientY: 250 })).toBeUndefined();
	});
});

describe('framing a box', () => {
	const box = { x: 0, y: 0, width: 400, height: 300 };

	it('centres the box at the framed zoom, keeping clear of the floating chrome', () => {
		const view = mounted();
		view.framedZoom = 1;
		view.centreOn(box);
		// centre (400, 300) on screen, layer origin at (300, 200), box centre (200, 150) at zoom 1
		expect([view.zoom, view.panX, view.panY]).toEqual([1, -100, -50]);
		view.setInsets(100, 0);
		view.centreOn(box);
		expect(view.panY).toBe(0);
		view.setInsets(0, 0, 200, 0);
		view.centreOn(box);
		expect(view.panX).toBe(0);
	});

	it('fits a box with padding, zooming no further than the ceiling', () => {
		const view = mounted();
		const target = view.fitTo({ x: 0, y: 0, width: 100, height: 75 }, 28, 2);
		expect(target?.zoom).toBe(2);
		expect(view.zoom).toBe(2);
		const wide = view.fitTo({ x: 0, y: 0, width: 1488, height: 100 }, 28);
		expect(wide?.zoom).toBeCloseTo((800 - 56) / 1488, 6);
	});

	it('cannot frame without a layer or from a negative box, and changes nothing', () => {
		expect(createPanZoom().fitTo(box)).toBeUndefined();
		const view = mounted();
		view.setView({ zoom: 2, panX: 5, panY: 6 });
		expect(view.fitTo({ x: 0, y: 0, width: -1, height: 10 })).toBeUndefined();
		view.centreOn({ x: 0, y: 0, width: 10, height: -1 });
		view.animateFit({ x: 0, y: 0, width: -1, height: 10 });
		expect([view.zoom, view.panX, view.panY]).toEqual([2, 5, 6]);
		expect(view.animating).toBe(false);
	});
});

describe('timed camera travel', () => {
	it('animates the reset back to 1x centred over its duration, then stops', () => {
		const view = mounted();
		view.framedZoom = 1;
		view.setView({ zoom: 3, panX: 80, panY: -40 });
		view.animateReset(400);
		expect(view.animating).toBe(true);
		vi.advanceTimersByTime(200);
		expect(view.zoom).toBeLessThan(3);
		expect(view.zoom).toBeGreaterThan(1);
		vi.advanceTimersByTime(300);
		expect(view.zoom).toBe(1);
		expect(view.panX).toBeCloseTo(0, 9);
		expect(view.panY).toBeCloseTo(0, 9);
		expect(view.animating).toBe(false);
	});

	it('animates a fit to its target and lands on it exactly', () => {
		const view = mounted();
		const box = { x: 0, y: 0, width: 200, height: 150 };
		const target = view.targetFor(box, 28)!;
		view.animateFit(box, 28, 300);
		vi.advanceTimersByTime(400);
		expect(view.zoom).toBeCloseTo(target.zoom, 9);
		expect(view.panX).toBeCloseTo(target.panX, 9);
		expect(view.animating).toBe(false);
	});

	it('eases toward a target a step at a time and snaps when it is close enough', () => {
		const view = mounted();
		view.easeTo({ zoom: 2, panX: 100, panY: 0 }, 0.5);
		vi.advanceTimersByTime(16);
		expect(view.zoom).toBe(1.5);
		expect(view.panX).toBe(50);
		vi.advanceTimersByTime(2000);
		expect([view.zoom, view.panX, view.panY]).toEqual([2, 100, 0]);
		expect(view.animating).toBe(false);
	});

	it('lets the organizer’s own input cancel a travel and bumps the revision', () => {
		const view = mounted();
		view.easeTo({ zoom: 3, panX: 0, panY: 0 }, 0.1);
		const before = view.revision;
		view.panBy(5, 5);
		expect(view.animating).toBe(false);
		expect(view.revision).toBeGreaterThan(before);
		const stopped = view.zoom;
		vi.advanceTimersByTime(1000);
		expect(view.zoom).toBe(stopped);
	});
});

describe('zoom announcements', () => {
	it('says nothing until a ± or keyboard zoom, then the rounded percent of the framing', () => {
		const view = mounted();
		expect(view.announcedZoom).toBeUndefined();
		view.zoomIn();
		expect(view.announcedZoom).toBe(130);
		view.zoomOut();
		view.zoomOut();
		expect(view.announcedZoom).toBe(77);
	});
});
