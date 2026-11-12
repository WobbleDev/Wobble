import { onMount } from 'svelte';
import { ENTRANCE_ANIMATION_DURATION_MS } from './overview-entrance-animation-lifecycle.ts';
import type { OverviewEntranceAnimationController } from './overview-entrance-animation.svelte.ts';
import { entranceAnimationFor, reconcileClaim, shouldSettle } from './overview-entrance-guard.ts';

/**
 * The Overview route's claim on the shell's entrance animation: once mounted it claims the active
 * Worksite's entrance animation, starts or settles it (reduced motion settles at once), and drops a
 * claim the controller has moved past. The host supplies mounting and effects, so the
 * spec drives the claim through a literal host; the route wires the real ones below.
 */
export interface OverviewEntranceGuardHost {
	readonly entranceAnimation: OverviewEntranceAnimationController;
	worksiteId(): string | undefined;
	reducedMotion(): boolean;
	/** Runs once the route has mounted. */
	mounted(run: () => void): void;
	/** Runs `setup` and re-runs it when its reads change. */
	effect(setup: () => void): void;
}

export function createOverviewEntranceGuard(host: OverviewEntranceGuardHost) {
	let mounted = $state(false);
	let claimedGeneration = $state<number | null>(null);

	host.mounted(() => {
		mounted = true;
	});

	host.effect(() => {
		const worksiteId = host.worksiteId();
		if (!mounted || !worksiteId || claimedGeneration !== null) return;
		const claim = host.entranceAnimation.claim(worksiteId);
		if (!claim) return;
		claimedGeneration = claim.generation;
		if (host.reducedMotion()) host.entranceAnimation.settle();
		else host.entranceAnimation.start(claim.generation);
	});

	host.effect(() => {
		if (shouldSettle(host.reducedMotion(), host.entranceAnimation.state))
			host.entranceAnimation.settle();
	});

	host.effect(() => {
		const next = reconcileClaim(claimedGeneration, host.entranceAnimation);
		claimedGeneration = next.claimed;
		if (next.reset) host.entranceAnimation.reset();
	});

	const view = $derived(
		entranceAnimationFor(claimedGeneration, host.entranceAnimation, ENTRANCE_ANIMATION_DURATION_MS)
	);

	return {
		get claimedGeneration() {
			return claimedGeneration;
		},
		get entranceAnimationState() {
			return view.state;
		},
		get entranceAnimationElapsed() {
			return view.elapsed;
		}
	};
}

/** The route's claim, wired to Svelte's mount and effects. */
export function overviewEntranceGuard(route: {
	entranceAnimation: OverviewEntranceAnimationController;
	worksiteId(): string | undefined;
	reducedMotion(): boolean;
}) {
	return createOverviewEntranceGuard({
		...route,
		mounted: (run) => {
			onMount(run);
		},
		effect: (setup) => {
			$effect(setup);
		}
	});
}
