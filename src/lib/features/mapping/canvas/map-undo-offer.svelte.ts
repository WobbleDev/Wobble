/**
 * The last clear or reset, held briefly so a wrong click can be taken back. The map owns the
 * view; this owns the offer: what to restore, its label, and the time it stays on offer. A
 * pointer over the offer pauses the clock, and leaving it starts the clock again.
 */

/** How long an offer stays before it lapses on its own. */
export const UNDO_OFFER_MS = 6000;

/** What the offer reads from the map: the view to capture now and to put back later. */
export type UndoOfferHost<Snapshot> = {
	capture: () => Snapshot;
	restore: (snapshot: Snapshot) => void;
};

export function createUndoOffer<Snapshot>(host: UndoOfferHost<Snapshot>) {
	let current = $state<{ snapshot: Snapshot; label: string } | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function start() {
		clearTimeout(timer);
		timer = setTimeout(() => (current = null), UNDO_OFFER_MS);
	}

	return {
		/** The offer on screen, or null. */
		get current() {
			return current;
		},
		/** Holds the view as it is now for a short while, under this label. */
		offer(label: string) {
			current = { snapshot: host.capture(), label };
			start();
		},
		pause() {
			clearTimeout(timer);
		},
		resume() {
			if (current) start();
		},
		dismiss() {
			current = null;
			clearTimeout(timer);
		},
		/** Puts the held view back and clears the offer. */
		apply() {
			if (!current) return;
			host.restore(current.snapshot);
			current = null;
			clearTimeout(timer);
		},
		/** The map is going away: nothing may fire after it. */
		dispose() {
			clearTimeout(timer);
		}
	};
}
