import { getContext, setContext } from 'svelte';
import {
	ARRIVAL_DURATION_MS,
	createArrivalLifecycle,
	type OverviewArrival
} from './overview-arrival-lifecycle.ts';

export type ArrivalState = 'idle' | 'running' | 'complete';

export type OverviewArrivalController = {
	readonly generation: number;
	readonly pending: boolean;
	readonly state: ArrivalState;
	readonly elapsed: number;
	observe(worksiteId: string | null): void;
	claim(worksiteId: string): OverviewArrival | null;
	start(generation: number): void;
	settle(): void;
	reset(): void;
};

const overviewArrivalContextKey = Symbol('overview-arrival');

/** Creates the shell-owned, in-memory arrival controller for the active Worksite. */
export function createOverviewArrivalController(
	initialWorksiteId: string | null
): OverviewArrivalController {
	const lifecycle = createArrivalLifecycle(initialWorksiteId);
	let generation = $state(lifecycle.generation);
	let state = $state<ArrivalState>('idle');
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
			elapsed = wasRunning ? ARRIVAL_DURATION_MS : 0;
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
				elapsed = Math.min(now - startedAt, ARRIVAL_DURATION_MS);
				if (elapsed >= ARRIVAL_DURATION_MS) {
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
				elapsed = ARRIVAL_DURATION_MS;
				state = 'complete';
			}
		},
		settle() {
			cancelFrame();
			activeGeneration = null;
			elapsed = ARRIVAL_DURATION_MS;
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

export function overviewArrivalController(): OverviewArrivalController {
	const controller = getContext<OverviewArrivalController | undefined>(overviewArrivalContextKey);
	if (!controller) throw new Error('Overview arrival controller is unavailable.');
	return controller;
}

export function setOverviewArrivalController(controller: OverviewArrivalController): void {
	setContext(overviewArrivalContextKey, controller);
}
