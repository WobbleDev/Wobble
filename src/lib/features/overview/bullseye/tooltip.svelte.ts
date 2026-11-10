/**
 * The bullseye's tooltip: which Worker's card is open, and where it sits.
 */
import type { Worker } from '#lib/domain-vocabulary.ts';
import { calloutAnchor } from './tooltip-placement.ts';

export interface ActiveTooltip {
	worker: Worker;
	x: number;
	/** The name's anchor: the dot's top edge, or its bottom when the name draws below. */
	y: number;
	/** True when the dot sits too close to the reference's top to draw the name above it. */
	below: boolean;
	/** The dot's own top and bottom in the reference, for a callout that measures its own room. */
	dotTop: number;
	dotBottom: number;
	/** The reference's own width, so the callout can stay inside it horizontally. */
	referenceWidth: number;
}

/**
 * The shared hover-name behaviour: the worker under the pointer and where to
 * draw its name, measured against `reference` so a caller can place the callout
 * wherever its own layering will not clip it. A dot near the reference's top
 * edge anchors the name to its bottom instead, so the shell's clip cannot cut
 * the name off.
 */
export function createTooltip() {
	let reference = $state<HTMLElement>();
	let active = $state<ActiveTooltip | null>(null);

	function show(worker: Worker, element: SVGCircleElement) {
		const base = reference?.getBoundingClientRect();
		if (!base) return;
		const dot = element.getBoundingClientRect();
		const anchor = calloutAnchor(dot.top - base.top, dot.height);
		active = {
			worker,
			x: dot.left - base.left + dot.width / 2,
			y: anchor.y,
			below: anchor.below,
			dotTop: dot.top - base.top,
			dotBottom: dot.bottom - base.top,
			referenceWidth: base.width
		};
	}

	function hide() {
		active = null;
	}

	function toggle(worker: Worker, element: SVGCircleElement) {
		if (active?.worker.id === worker.id) hide();
		else show(worker, element);
	}

	return {
		get reference() {
			return reference;
		},
		set reference(value: HTMLElement | undefined) {
			reference = value;
		},
		get active() {
			return active;
		},
		show,
		hide,
		toggle
	};
}
