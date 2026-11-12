import { describe, expect, it, vi } from 'vitest';
import { zoomAfterWheel } from './bullseye/pan-mappings.ts';
import {
	createOverviewChartZoom,
	createChartZoomHandler,
	isInsideOverlay,
	pointInBox,
	type WheelEventLike,
	type ChartZoomHost
} from './overview-chart-zoom.ts';

const BOX = { left: 100, right: 300, top: 50, bottom: 250 };

function wheel(overrides: Partial<WheelEventLike> = {}): WheelEventLike & {
	preventDefault: ReturnType<typeof vi.fn>;
} {
	return {
		target: { closest: () => null },
		clientX: 200,
		clientY: 150,
		deltaY: 100,
		deltaMode: 0,
		preventDefault: vi.fn(),
		...overrides
	} as WheelEventLike & { preventDefault: ReturnType<typeof vi.fn> };
}

/** A literal host standing in for the route: the view, the chart cell and the floor. */
function setup(
	overrides: Partial<{ shown: boolean; zoom: number; chart: boolean; floor: boolean }> = {}
) {
	const setZoom = vi.fn();
	const host: ChartZoomHost = {
		view: {
			shown: overrides.shown ?? false,
			zoom: overrides.zoom ?? 1,
			setZoom
		},
		chart: () => ((overrides.chart ?? true) ? { getBoundingClientRect: () => BOX } : undefined),
		floorMatches: () => overrides.floor ?? true
	};
	return { handle: createChartZoomHandler(host), setZoom };
}

describe('pointInBox', () => {
	it('includes the edges and the interior', () => {
		expect(pointInBox(BOX, 100, 50)).toBe(true);
		expect(pointInBox(BOX, 300, 250)).toBe(true);
		expect(pointInBox(BOX, 200, 150)).toBe(true);
	});

	it('excludes points just outside on each side', () => {
		expect(pointInBox(BOX, 99.5, 150)).toBe(false);
		expect(pointInBox(BOX, 300.5, 150)).toBe(false);
		expect(pointInBox(BOX, 200, 49.5)).toBe(false);
		expect(pointInBox(BOX, 200, 250.5)).toBe(false);
	});
});

describe('isInsideOverlay', () => {
	it('is true when the target sits inside an overlay', () => {
		expect(isInsideOverlay({ closest: () => ({}) })).toBe(true);
	});

	it('is false outside an overlay and for a target with no element methods', () => {
		expect(isInsideOverlay({ closest: () => null })).toBe(false);
		expect(isInsideOverlay(null)).toBe(false);
		expect(isInsideOverlay({})).toBe(false);
	});
});

describe('createChartZoomHandler', () => {
	it('zooms and cancels the default over the chart at the no-scroll floor', () => {
		const { handle, setZoom } = setup();
		const event = wheel({ deltaY: 100 });
		handle(event);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(setZoom).toHaveBeenCalledWith(zoomAfterWheel(1, 100, 0));
	});

	it('leaves the wheel alone while the chart backdrop owns it', () => {
		const { handle, setZoom } = setup({ shown: true });
		const event = wheel();
		handle(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(setZoom).not.toHaveBeenCalled();
	});

	it('leaves the wheel to an overlay that keeps its own scroll', () => {
		const { handle, setZoom } = setup();
		const event = wheel({ target: { closest: () => ({}) } });
		handle(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(setZoom).not.toHaveBeenCalled();
	});

	it('leaves the wheel to the page below the floor', () => {
		const { handle, setZoom } = setup({ floor: false });
		const event = wheel();
		handle(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(setZoom).not.toHaveBeenCalled();
	});

	it('does nothing when the chart is not drawn in the page', () => {
		const { handle, setZoom } = setup({ chart: false });
		const event = wheel();
		handle(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(setZoom).not.toHaveBeenCalled();
	});

	it('does nothing when the pointer is off the chart', () => {
		const { handle, setZoom } = setup();
		const event = wheel({ clientX: 10, clientY: 10 });
		handle(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(setZoom).not.toHaveBeenCalled();
	});
});

/**
 * The route's listener, specced through a literal host: the target records the
 * listener, the effect is run by the spec, and the cleanup must remove the same one.
 */
describe('createOverviewChartZoom', () => {
	function literalRoute(options: { shown?: boolean } = {}) {
		const listeners: ((event: WheelEvent) => void)[] = [];
		const target = {
			addEventListener: vi.fn((_type: 'wheel', listener: (event: WheelEvent) => void) => {
				listeners.push(listener);
			}),
			removeEventListener: vi.fn()
		};
		const setZoom = vi.fn();
		let setup: (() => (() => void) | void) | undefined;
		const host = {
			view: { shown: options.shown ?? false, zoom: 1, setZoom },
			chart: () => ({ getBoundingClientRect: () => BOX }),
			floorMatches: () => true,
			target,
			effect: (run: () => (() => void) | void) => {
				setup = run;
			}
		};
		return { host, target, setZoom, listeners, run: () => setup?.() };
	}

	it('registers a passive:false wheel listener through the effect, not at creation', () => {
		const route = literalRoute();
		createOverviewChartZoom(route.host);
		expect(route.target.addEventListener).not.toHaveBeenCalled();
		route.run();
		expect(route.target.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), {
			passive: false
		});
	});

	it('the registered listener zooms the chart from a wheel over it', () => {
		const route = literalRoute();
		createOverviewChartZoom(route.host);
		route.run();
		const event = wheel({ deltaY: 100 });
		route.listeners[0]!(event as unknown as WheelEvent);
		expect(route.setZoom).toHaveBeenCalledWith(zoomAfterWheel(1, 100, 0));
		expect(event.preventDefault).toHaveBeenCalledOnce();
	});

	it('removes the same listener it added when the effect is torn down', () => {
		const route = literalRoute();
		createOverviewChartZoom(route.host);
		const cleanup = route.run();
		cleanup?.();
		expect(route.target.removeEventListener).toHaveBeenCalledWith('wheel', route.listeners[0]);
	});

	it('the direct handle leaves the wheel alone while the chart backdrop owns it', () => {
		const route = literalRoute({ shown: true });
		const { handle } = createOverviewChartZoom(route.host);
		const event = wheel();
		handle(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(route.setZoom).not.toHaveBeenCalled();
	});
});
