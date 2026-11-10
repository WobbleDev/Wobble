// @module-tag mapping
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPanZoom } from './map-pan-zoom.svelte.ts';

/**
 * The wheel path reads the browser's SVG geometry. These are the smallest stand-ins
 * for it: a layer whose parent is translated by (300, 200) on screen, so a pointer at
 * client (400, 250) is at (100, 50) in the centred layer's own space.
 */
class FakeHTMLElement {}
class FakeSVGGraphicsElement {
	getScreenCTM() {
		return { inverse: () => ({ offsetX: -300, offsetY: -200 }) };
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
class FakeWheelEvent {
	static DOM_DELTA_LINE = 1;
	static DOM_DELTA_PAGE = 2;
}

beforeEach(() => {
	vi.stubGlobal('HTMLElement', FakeHTMLElement);
	vi.stubGlobal('SVGGraphicsElement', FakeSVGGraphicsElement);
	vi.stubGlobal('DOMPoint', FakeDOMPoint);
	vi.stubGlobal('WheelEvent', FakeWheelEvent);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A pan-zoom with a layer to read pointer positions from. */
function mounted() {
	const view = createPanZoom();
	const centred = new FakeSVGGraphicsElement();
	view.layer = { parentElement: centred } as unknown as SVGGElement;
	return view;
}

/** A wheel at client (400, 250), i.e. (100, 50) in the layer. deltaY -693.147 doubles the zoom. */
function wheelAt(deltaY: number) {
	const preventDefault = vi.fn();
	const event = {
		currentTarget: new FakeHTMLElement(),
		clientX: 400,
		clientY: 250,
		deltaY,
		deltaMode: 0,
		preventDefault
	} as unknown as WheelEvent;
	return { event, preventDefault };
}
const DOUBLE = -693.147180559945;

describe('createPanZoom zoom steps', () => {
	it('starts at 1x, unpanned', () => {
		const view = createPanZoom();

		expect([view.zoom, view.panX, view.panY]).toEqual([1, 0, 0]);
	});

	it('zooms in by 30% and out by a 30% step back', () => {
		const view = createPanZoom();

		view.zoomIn();
		expect(view.zoom).toBeCloseTo(1.3, 10);

		view.zoomOut();
		expect(view.zoom).toBeCloseTo(1, 10);
	});

	it('stops zooming in at four times the whole-map framing', () => {
		const view = createPanZoom();

		for (let i = 0; i < 20; i += 1) view.zoomIn();

		expect(view.zoom).toBe(4);
	});

	it('stops zooming out at 40% of the whole-map framing', () => {
		const view = createPanZoom();

		for (let i = 0; i < 20; i += 1) view.zoomOut();

		expect(view.zoom).toBeCloseTo(0.4, 10);
	});

	it('moves both bounds with the framing: a map framed at 2x spans 0.8 to 8', () => {
		const view = createPanZoom();
		view.framedZoom = 2;

		view.setView({ zoom: 100, panX: 0, panY: 0 });
		expect(view.zoom).toBe(8);

		view.setView({ zoom: 0.01, panX: 0, panY: 0 });
		expect(view.zoom).toBeCloseTo(0.8, 10);
	});

	it('clamps a view that is set from outside, and keeps its pan', () => {
		const view = createPanZoom();

		view.setView({ zoom: 9, panX: 12, panY: -7 });

		expect([view.zoom, view.panX, view.panY]).toEqual([4, 12, -7]);
	});

	it('moves the pan by a keyboard step and puts everything back on reset', () => {
		const view = createPanZoom();
		view.panBy(10, -5);
		view.panBy(10, -5);
		expect([view.panX, view.panY]).toEqual([20, -10]);

		view.zoomIn();
		view.resetView();

		expect([view.zoom, view.panX, view.panY]).toEqual([1, 0, 0]);
	});
});

describe('createPanZoom wheel zoom', () => {
	it('keeps the point under the cursor in place when it doubles the zoom', () => {
		const view = mounted();
		const { event, preventDefault } = wheelAt(DOUBLE);

		view.handleWheel(event);

		// Cursor at (100, 50), map point (100, 50): screen = pan + 2 * (100, 50) = (100, 50).
		expect(view.zoom).toBeCloseTo(2, 6);
		expect(view.panX).toBeCloseTo(-100, 4);
		expect(view.panY).toBeCloseTo(-50, 4);
		expect(preventDefault).toHaveBeenCalled();
	});

	it('keeps the point under the cursor in place from an already panned view', () => {
		const view = mounted();
		view.setView({ zoom: 1, panX: 30, panY: -20 });

		view.handleWheel(wheelAt(DOUBLE).event);

		// The map point under (100, 50) is (70, 70); at 2x it needs pan (-40, -90).
		expect(view.zoom).toBeCloseTo(2, 6);
		expect(view.panX).toBeCloseTo(-40, 4);
		expect(view.panY).toBeCloseTo(-90, 4);
	});

	it('zooms out around the cursor too', () => {
		const view = mounted();
		view.setView({ zoom: 2, panX: -100, panY: -50 });

		view.handleWheel(wheelAt(-DOUBLE).event);

		expect(view.zoom).toBeCloseTo(1, 6);
		expect(view.panX).toBeCloseTo(0, 4);
		expect(view.panY).toBeCloseTo(0, 4);
	});

	it('anchors on the cursor when the wheel is cut short by the zoom ceiling', () => {
		const view = mounted();
		view.setView({ zoom: 3, panX: 0, panY: 0 });

		view.handleWheel(wheelAt(DOUBLE).event);

		// Doubling would reach 6; the ceiling stops it at 4, a ratio of 4/3.
		expect(view.zoom).toBe(4);
		expect(view.panX).toBeCloseTo(-100 / 3, 4);
		expect(view.panY).toBeCloseTo(-50 / 3, 4);
	});

	it('leaves the view alone when the wheel arrives at the ceiling', () => {
		const view = mounted();
		view.setView({ zoom: 4, panX: 15, panY: 25 });

		view.handleWheel(wheelAt(DOUBLE).event);

		expect([view.zoom, view.panX, view.panY]).toEqual([4, 15, 25]);
	});

	it('ignores the wheel before the map has a layer', () => {
		const view = createPanZoom();
		const { event, preventDefault } = wheelAt(DOUBLE);

		view.handleWheel(event);

		expect(view.zoom).toBe(1);
		expect(preventDefault).not.toHaveBeenCalled();
	});
});
