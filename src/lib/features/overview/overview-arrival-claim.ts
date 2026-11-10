import type { ArrivalState } from './overview-arrival.svelte.ts';

/**
 * The arrival claim's decisions, pure: which generation the route holds, when a
 * claim is dropped, and what the dashboard reads while it holds one. The factory
 * applies these to the shell's arrival controller.
 */

export interface ArrivalSnapshot {
	readonly generation: number;
	readonly pending: boolean;
	readonly state: ArrivalState;
	readonly elapsed: number;
}

/** Drop the held generation once the controller has moved past it, and reset a stale pending arrival. */
export function reconcileClaim(
	claimed: number | null,
	arrival: Pick<ArrivalSnapshot, 'generation' | 'pending' | 'state'>
): { claimed: number | null; reset: boolean } {
	const next = claimed !== null && claimed !== arrival.generation ? null : claimed;
	return {
		claimed: next,
		reset: next === null && arrival.pending && arrival.state !== 'idle'
	};
}

/** Under reduced motion a running arrival settles at once. */
export function shouldSettle(reducedMotion: boolean, state: ArrivalState): boolean {
	return reducedMotion && state === 'running';
}

/** The arrival the dashboard reads: only the generation the route claimed is its own. */
export function arrivalFor(
	claimed: number | null,
	arrival: ArrivalSnapshot,
	durationMs: number
): { state: ArrivalState; elapsed: number } {
	if (claimed === arrival.generation) return { state: arrival.state, elapsed: arrival.elapsed };
	return { state: 'idle', elapsed: durationMs };
}
