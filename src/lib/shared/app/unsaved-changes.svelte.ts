/**
 * The gate every way out of a dirty Configuration draft goes through: a nav
 * link, the browser's Back button, a Worksite switch, a new Worksite. It exists
 * so there is one prompt and never a second one behind it — a Discard that then
 * trips the same guard again is the bug this class is shaped to prevent.
 *
 * The draft itself does not live here; the caller supplies `isDirty`, so the
 * guard stays a decision about leaving rather than a second copy of the state.
 */
import { getContext } from 'svelte';

export type UnsavedIntent = {
	/** Prompt heading, e.g. "Discard unsaved changes?". */
	title: string;
	/** What is about to happen and what it costs. */
	description: string;
	/** The action button's label, phrased as the outcome. */
	confirmLabel: string;
	/** What to do once the draft may be abandoned. */
	run: () => void | Promise<void>;
};

export const unsavedChangesContextKey = Symbol('unsaved-changes');

/** The guard, from any component under the layout that provides it. */
export function getUnsavedChanges(): UnsavedChanges {
	return getContext<UnsavedChanges>(unsavedChangesContextKey);
}

export class UnsavedChanges {
	#pending: UnsavedIntent | null = null;
	/**
	 * How many Discards are mid-flight. A released navigation is already paid for
	 * by the prompt the reader just answered, so it must not be asked about again.
	 * It is a count rather than a flag so a nested or repeated Discard cannot
	 * clear a release another one still needs.
	 */
	#released = 0;
	readonly #isDirty: () => boolean;

	/** Whether the prompt is showing. */
	open = $state(false);
	title = $state('');
	description = $state('');
	confirmLabel = $state('');

	constructor(isDirty: () => boolean) {
		this.#isDirty = isDirty;
	}

	/** True while a Discard's own navigation is in flight, so the guard stands down. */
	get released(): boolean {
		return this.#released > 0;
	}

	/**
	 * Runs `intent` now when there is nothing to lose, and otherwise holds it
	 * behind the prompt. While a prompt is already up, a further request is
	 * dropped rather than queued: the reader is answering the first one.
	 */
	async request(intent: UnsavedIntent): Promise<void> {
		if (this.open) return;

		if (!this.#isDirty()) {
			await intent.run();
			return;
		}

		this.#pending = intent;
		this.title = intent.title;
		this.description = intent.description;
		this.confirmLabel = intent.confirmLabel;
		this.open = true;
	}

	/** Keep the draft: nothing runs, and the held intent is forgotten. */
	stay(): void {
		this.#pending = null;
		this.open = false;
	}

	/** Abandon the draft and do the held thing, exactly once, without re-asking. */
	async discard(): Promise<void> {
		const intent = this.#pending;
		this.#pending = null;
		this.open = false;
		if (!intent) return;

		this.#released += 1;
		try {
			await intent.run();
		} finally {
			this.#released -= 1;
		}
	}
}
