import type { EntranceAnimationState } from './overview-entrance-animation.svelte.ts';

/**
 * The entrance guard's decisions, pure: which generation the route holds, when a
 * claim is dropped, and what the dashboard reads while it holds one. The factory
 * applies these to the shell's entrance animation controller.
 */

export interface EntranceAnimationSnapshot {
	readonly generation: number;
	readonly pending: boolean;
	readonly state: EntranceAnimationState;
	readonly elapsed: number;
}

/** Drop the held generation once the controller has moved past it, and reset a stale pending entrance animation. */
export function reconcileClaim(
	claimed: number | null,
	entranceAnimation: Pick<EntranceAnimationSnapshot, 'generation' | 'pending' | 'state'>
): { claimed: number | null; reset: boolean } {
	const next = claimed !== null && claimed !== entranceAnimation.generation ? null : claimed;
	return {
		claimed: next,
		reset: next === null && entranceAnimation.pending && entranceAnimation.state !== 'idle'
	};
}

/** Under reduced motion a running entrance animation settles at once. */
export function shouldSettle(reducedMotion: boolean, state: EntranceAnimationState): boolean {
	return reducedMotion && state === 'running';
}

/** The entrance animation the dashboard reads: only the generation the route claimed is its own. */
export function entranceAnimationFor(
	claimed: number | null,
	entranceAnimation: EntranceAnimationSnapshot,
	durationMs: number
): { state: EntranceAnimationState; elapsed: number } {
	if (claimed === entranceAnimation.generation)
		return { state: entranceAnimation.state, elapsed: entranceAnimation.elapsed };
	return { state: 'idle', elapsed: durationMs };
}
