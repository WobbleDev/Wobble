/**
 * The bullseye's shared view state: the zoom and pan that both the chart and the
 * page around it read.
 */
import { getContext, setContext } from 'svelte';

/**
 * The shell's presentation state for the Assessment bullseye: whether it draws
 * the dragged chart backdrop, and the scale the reader has set with the wheel. One owner
 * decides both — the shell knows the route, the reader's pointer and motion
 * preferences, and holds the scale — so the Overview reads the same answer
 * rather than re-deriving it, and the chart backdrop and its in-page stand-in can never
 * disagree about which is drawn or how large.
 */
export interface BullseyeView {
	readonly shown: boolean;
	readonly zoom: number;
	setZoom(next: number): void;
}

const bullseyeViewKey = Symbol('bullseye-view');

/** Set by the shell, once, before any page renders. */
export function setBullseyeView(view: BullseyeView): void {
	setContext(bullseyeViewKey, view);
}

/** Read by the page that draws the chart, to drive the wheel and size the chart. */
export function bullseyeView(): BullseyeView {
	return getContext<BullseyeView>(bullseyeViewKey);
}
