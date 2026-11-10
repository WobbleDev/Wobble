/**
 * A node's tooltip waits for the pointer to rest on it, so crossing nodes while panning
 * does not flash a card per node; once one is up it follows the pointer without waiting
 * again. A finger has no hover, so a touch tap shows the card instead.
 */
import type { WorkerGraphNode } from './worker-relationship-map-model.ts';

/** How long the pointer must rest on a node before its card appears. */
export const hoverIntentMs = 120;
/** A touch release shows the card this much later than the chart's own pointerleave clears it. */
const touchTapDelayMs = 30;

/**
 * The node card the chart's snippet hands the canvas, as the canvas uses it.
 *
 * A hit circle and the painted dot it stands in for share one set of handlers,
 * so the card a pointer opens is the same card whichever of the two it found.
 */
export type NodeTooltip = {
	show: (event: PointerEvent, node: WorkerGraphNode) => void;
	hide: () => void;
};

/** What hover intent reads from the canvas and writes back to it. */
export type HoverIntentHost = {
	/** A pan is looking around, not reading a worker. */
	isPanning: () => boolean;
	/** The open card already says everything the tooltip would. */
	selectedId: () => string;
	/** Lifts the pointed-at Worker (its id), or drops the lift (''). */
	onHover: (workerId: string) => void;
};

export function createHoverIntent(host: HoverIntentHost) {
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	let hoverEvent: PointerEvent | undefined;
	let tooltipShown = false;

	function cancel() {
		clearTimeout(hoverTimer);
		hoverTimer = undefined;
		hoverEvent = undefined;
		tooltipShown = false;
	}

	return {
		/** Drops any pending or shown intent; also what a destroyed canvas calls. */
		cancel,
		/** Pointing at a Worker lifts it, whether the pointer found the dot or its target. */
		enter(node: WorkerGraphNode) {
			host.onHover(node.id);
		},
		/** Pointing away drops the lift and puts the card away. */
		leave(tooltip: NodeTooltip) {
			host.onHover('');
			cancel();
			tooltip.hide();
		},
		move(event: PointerEvent, node: WorkerGraphNode, tooltip: NodeTooltip) {
			// The open card already says everything the tooltip would, and a pan is
			// looking around, not reading a worker.
			if (host.isPanning() || host.selectedId() === node.id) {
				cancel();
				tooltip.hide();
				return;
			}
			if (tooltipShown) tooltip.show(event, node);
			else {
				hoverEvent = event;
				hoverTimer ??= setTimeout(() => {
					hoverTimer = undefined;
					if (host.isPanning() || !hoverEvent) return;
					tooltipShown = true;
					tooltip.show(hoverEvent, node);
				}, hoverIntentMs);
			}
		},
		/** A finger has no hover, so a tap is the only way a touch reader reaches the card. */
		up(event: PointerEvent, node: WorkerGraphNode, tooltip: NodeTooltip) {
			// A drag never lands here: the surface owns the pointer once the gesture
			// passes the threshold.
			if (event.pointerType === 'mouse') return;
			// Lifting the finger also fires the chart's own pointerleave, which clears
			// the card on the next tick, so this lands just after it — shown
			// immediately instead, the card flashes for a frame and goes.
			setTimeout(() => tooltip.show(event, node), touchTapDelayMs);
		},
		/** Pressing a Worker puts the card away; the caller then arms the drag. */
		press(tooltip: NodeTooltip) {
			cancel();
			tooltip.hide();
		}
	};
}

export type HoverIntent = ReturnType<typeof createHoverIntent>;
