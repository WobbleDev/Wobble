import { MediaQuery } from 'svelte/reactivity';
import { reducedMotion } from '#lib/shell/motion.svelte.ts';

/**
 * Whether the draggable bullseye chart backdrop may run: a fine pointer to drag with, and
 * motion the reader has not asked to reduce. When either is false, the fitted
 * chart is drawn in the page instead — nothing is off-screen, so every dot is
 * reachable without a drag.
 *
 * The server cannot know either capability, so the fallbacks choose what a
 * first paint shows: the chart backdrop (a fine pointer is the common case, so there is
 * no flash on a desktop load) and motion allowed.
 */
export class PanCapability {
	readonly pointer = new MediaQuery('(pointer: fine)', true);

	/** Reads the shared motion decision, so the Reduce motion setting applies here too. */
	get reducedMotion(): boolean {
		return reducedMotion();
	}

	get allowed(): boolean {
		return this.pointer.current && !this.reducedMotion;
	}
}
