import { getContext, setContext } from 'svelte';

/**
 * The Overview's focus state: at rest the dashboard reads and the bullseye is
 * a faded floor; focused, the dashboard slides aside and the bullseye answers
 * the pointer. The shell creates it beside the bullseye view state and shares
 * it through context, so the edge control, the dashboard and the chart backdrop agree.
 */
export interface OverviewFocusHost {
	/** Whether the reader is on the Overview; the shell's route, read live. */
	isOverview: () => boolean;
}

export interface OverviewFocus {
	readonly focused: boolean;
	/**
	 * The Worker pinned on the chart, whether by a click on their dot or on their row in the
	 * Committee column. Both read and write the one id, so the two never disagree.
	 */
	readonly pinnedWorkerId: string | null;
	/** Pins a Worker, or clears the pin with null. */
	pin(id: string | null): void;
	/** Pins a Worker, or clears the pin when they are already the one pinned. */
	togglePin(id: string): void;
	/** The edge control's flip between rest and focus. */
	toggle(): void;
	/** The return to rest: Escape, or the chart backdrop going away. */
	blur(): void;
	/**
	 * The return to rest on every Overview entrance animation, as the zoom does. The shell
	 * calls this from an effect that reads the route, so the literal host in
	 * the spec stands in for the route.
	 */
	resetOnEntranceAnimation(): void;
	/**
	 * Escape blurs, but only while focused and only when no dot consumed it:
	 * a pin-clearing Escape calls preventDefault on its way up, so by the time
	 * this runs the event says the dot won.
	 */
	handleKeydown(event: KeyboardEvent): void;
}

export function createOverviewFocus(host: OverviewFocusHost): OverviewFocus {
	let focused = $state(false);
	let pinnedWorkerId = $state<string | null>(null);

	return {
		get focused() {
			return focused;
		},
		get pinnedWorkerId() {
			return pinnedWorkerId;
		},
		pin(id) {
			pinnedWorkerId = id;
		},
		togglePin(id) {
			pinnedWorkerId = pinnedWorkerId === id ? null : id;
		},
		toggle() {
			focused = !focused;
			if (!focused) pinnedWorkerId = null;
		},
		blur() {
			focused = false;
			pinnedWorkerId = null;
		},
		resetOnEntranceAnimation() {
			if (!host.isOverview()) return;
			focused = false;
			pinnedWorkerId = null;
		},
		handleKeydown(event: KeyboardEvent) {
			if (event.key !== 'Escape' || !focused || event.defaultPrevented) return;
			focused = false;
			pinnedWorkerId = null;
		}
	};
}

const overviewFocusKey = Symbol('overview-focus');

/** Set by the shell, once, before any page renders. */
export function setOverviewFocus(focus: OverviewFocus): void {
	setContext(overviewFocusKey, focus);
}

/** Read by the edge control, the dashboard and the chart backdrop. */
export function overviewFocus(): OverviewFocus {
	return getContext<OverviewFocus>(overviewFocusKey);
}
