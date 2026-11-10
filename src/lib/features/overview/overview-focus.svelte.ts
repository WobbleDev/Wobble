import { getContext, setContext } from 'svelte';

/**
 * The Overview's focus state: at rest the dashboard reads and the bullseye is
 * a faded floor; focused, the dashboard slides aside and the bullseye answers
 * the pointer. The shell creates it beside the bullseye view state and shares
 * it through context, so the edge control, the dashboard and the ground agree.
 */
export interface OverviewFocusHost {
	/** Whether the reader is on the Overview; the shell's route, read live. */
	isOverview: () => boolean;
}

export interface OverviewFocus {
	readonly focused: boolean;
	/** The edge control's flip between rest and focus. */
	toggle(): void;
	/** The return to rest: Escape, or the ground going away. */
	blur(): void;
	/**
	 * The return to rest on every Overview arrival, as the zoom does. The shell
	 * calls this from an effect that reads the route, so the literal host in
	 * the spec stands in for the route.
	 */
	resetOnArrival(): void;
	/**
	 * Escape blurs, but only while focused and only when no dot consumed it:
	 * a pin-clearing Escape calls preventDefault on its way up, so by the time
	 * this runs the event says the dot won.
	 */
	handleKeydown(event: KeyboardEvent): void;
}

export function createOverviewFocus(host: OverviewFocusHost): OverviewFocus {
	let focused = $state(false);

	return {
		get focused() {
			return focused;
		},
		toggle() {
			focused = !focused;
		},
		blur() {
			focused = false;
		},
		resetOnArrival() {
			if (host.isOverview()) focused = false;
		},
		handleKeydown(event: KeyboardEvent) {
			if (event.key !== 'Escape' || !focused || event.defaultPrevented) return;
			focused = false;
		}
	};
}

const overviewFocusKey = Symbol('overview-focus');

/** Set by the shell, once, before any page renders. */
export function setOverviewFocus(focus: OverviewFocus): void {
	setContext(overviewFocusKey, focus);
}

/** Read by the edge control, the dashboard and the ground. */
export function overviewFocus(): OverviewFocus {
	return getContext<OverviewFocus>(overviewFocusKey);
}
