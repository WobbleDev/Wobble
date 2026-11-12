import { getContext, setContext } from 'svelte';
import {
	ENTRANCE_ANIMATION_DURATION_MS,
	createEntranceAnimationLifecycle,
	type OverviewEntranceAnimation
} from './overview-entrance-animation-lifecycle.ts';

export type EntranceAnimationState = 'idle' | 'running' | 'complete';

export type OverviewEntranceAnimationController = {
	readonly generation: number;
	readonly pending: boolean;
	readonly state: EntranceAnimationState;
	readonly elapsed: number;
	observe(worksiteId: string | null): void;
	claim(worksiteId: string): OverviewEntranceAnimation | null;
	start(generation: number): void;
	settle(): void;
	reset(): void;
};

const overviewEntranceAnimationContextKey = Symbol('overview-entrance-animation');

/** Creates the shell-owned, in-memory entrance animation controller for the active Worksite. */
export function createOverviewEntranceAnimationController(
	initialWorksiteId: string | null
): OverviewEntranceAnimationController {
	const lifecycle = createEntranceAnimationLifecycle(initialWorksiteId);
	let generation = $state(lifecycle.generation);
	let state = $state<EntranceAnimationState>('idle');
	let elapsed = $state(0);
	let activeGeneration: number | null = null;
	let frame: number | null = null;

	function cancelFrame() {
		if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
		frame = null;
	}

	return {
		get generation() {
			return generation;
		},
		get pending() {
			return lifecycle.pending;
		},
		get state() {
			return state;
		},
		get elapsed() {
			return elapsed;
		},
		observe(worksiteId: string | null) {
			const changed = lifecycle.observe(worksiteId);
			if (!changed) return;
			const wasRunning = activeGeneration !== null;
			cancelFrame();
			activeGeneration = null;
			generation = lifecycle.generation;
			elapsed = wasRunning ? ENTRANCE_ANIMATION_DURATION_MS : 0;
			state = wasRunning ? 'complete' : 'idle';
		},
		claim(worksiteId: string) {
			const claim = lifecycle.claim(worksiteId);
			return claim ? { generation } : null;
		},
		start(nextGeneration: number) {
			if (nextGeneration !== generation || activeGeneration === nextGeneration) return;
			cancelFrame();
			activeGeneration = nextGeneration;
			elapsed = 0;
			state = 'running';
			const startedAt = performance.now();
			const tick = (now: number) => {
				if (activeGeneration !== nextGeneration) return;
				elapsed = Math.min(now - startedAt, ENTRANCE_ANIMATION_DURATION_MS);
				if (elapsed >= ENTRANCE_ANIMATION_DURATION_MS) {
					cancelFrame();
					activeGeneration = null;
					state = 'complete';
				} else {
					frame = requestAnimationFrame(tick);
				}
			};
			if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(tick);
			else {
				activeGeneration = null;
				elapsed = ENTRANCE_ANIMATION_DURATION_MS;
				state = 'complete';
			}
		},
		settle() {
			cancelFrame();
			activeGeneration = null;
			elapsed = ENTRANCE_ANIMATION_DURATION_MS;
			state = 'complete';
		},
		reset() {
			cancelFrame();
			activeGeneration = null;
			elapsed = 0;
			state = 'idle';
		}
	};
}

export function overviewEntranceAnimationController(): OverviewEntranceAnimationController {
	const controller = getContext<OverviewEntranceAnimationController | undefined>(
		overviewEntranceAnimationContextKey
	);
	if (!controller) throw new Error('Overview entrance animation controller is unavailable.');
	return controller;
}

export function setOverviewEntranceAnimationController(
	controller: OverviewEntranceAnimationController
): void {
	setContext(overviewEntranceAnimationContextKey, controller);
}
