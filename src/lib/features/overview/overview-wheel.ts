import { zoomAfterWheel } from './bullseye/pan-mappings.ts';

/**
 * The Overview's wheel zoom, as a plain host-factory: the overlay skip list, the
 * no-scroll floor and the chart's bounds hit-test. The route wires the document
 * listener through overview-wheel.svelte.ts; this module holds the decisions so a
 * literal host can drive them in the spec beside it.
 */

/** An overlay keeps its own wheel: scrolling inside a dialog, drawer or menu must not rescale the chart. */
export const OVERLAY_SELECTOR = [
	'[role="dialog"]',
	'[data-slot="dialog-content"]',
	'[data-slot="alert-dialog-content"]',
	'[data-slot="sheet-content"]',
	'[data-slot="select-content"]',
	'[data-slot="dropdown-menu-content"]',
	'[data-slot="dropdown-menu-sub-content"]'
].join(', ');

/** The no-scroll contract's own floor, matched to the layout.css media query. */
export const NO_SCROLL_FLOOR = '(min-width: 64rem) and (min-height: 40rem)';

export interface WheelBox {
	readonly left: number;
	readonly right: number;
	readonly top: number;
	readonly bottom: number;
}

/** Whether a point lies inside a box, edges included. */
export function pointInBox(box: WheelBox, x: number, y: number): boolean {
	return !(x < box.left || x > box.right || y < box.top || y > box.bottom);
}

/** Whether a wheel's target sits inside an overlay that keeps its own scroll. */
export function isInsideOverlay(target: unknown): boolean {
	return Boolean((target as Element | null)?.closest?.(OVERLAY_SELECTOR));
}

export interface WheelEventLike {
	readonly target: unknown;
	readonly clientX: number;
	readonly clientY: number;
	readonly deltaY: number;
	readonly deltaMode: number;
	preventDefault(): void;
}

export interface WheelZoomHost {
	readonly view: {
		readonly shown: boolean;
		readonly zoom: number;
		setZoom(next: number): void;
	};
	/** The chart's cell, or undefined while it is not drawn in the page. */
	chart(): { getBoundingClientRect(): WheelBox } | undefined;
	/** Whether the no-scroll floor currently matches. */
	floorMatches(): boolean;
}

/**
 * The wheel is the fitted chart's scale gesture, and only its. The handler does
 * nothing while the ground owns the wheel, inside an overlay, below the floor, or
 * off the chart; otherwise it cancels the default so the surface never scrolls
 * under the chart and sets the zoom the wheel asks for.
 */
export function createWheelZoomHandler(host: WheelZoomHost): (event: WheelEventLike) => void {
	return (event) => {
		if (host.view.shown) return;
		if (isInsideOverlay(event.target)) return;
		if (!host.floorMatches()) return;

		const chart = host.chart();
		if (!chart) return;
		if (!pointInBox(chart.getBoundingClientRect(), event.clientX, event.clientY)) return;

		event.preventDefault();
		host.view.setZoom(zoomAfterWheel(host.view.zoom, event.deltaY, event.deltaMode));
	};
}

/** Where the wheel listens: the document on the route, a literal target in the spec. */
export interface WheelTargetLike {
	addEventListener(
		type: 'wheel',
		listener: (event: WheelEvent) => void,
		options: { passive: boolean }
	): void;
	removeEventListener(type: 'wheel', listener: (event: WheelEvent) => void): void;
}

export interface OverviewWheelHost extends WheelZoomHost {
	readonly target: WheelTargetLike;
	/** Runs `setup` and re-runs it when its reads change; the route passes $effect here. */
	effect(setup: () => (() => void) | void): void;
}

/**
 * The route's wheel listener: registered through the host's effect, so the listener
 * lives as long as the route. Returns the handler for direct calls.
 */
export function createOverviewWheel(host: OverviewWheelHost): {
	handle(event: WheelEventLike): void;
} {
	const handle = createWheelZoomHandler(host);
	host.effect(() => {
		const listener = (event: WheelEvent) => handle(event);
		host.target.addEventListener('wheel', listener, { passive: false });
		return () => host.target.removeEventListener('wheel', listener);
	});
	return { handle };
}
