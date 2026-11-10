import { onMount } from 'svelte';
import { ARRIVAL_DURATION_MS } from './overview-arrival-lifecycle.ts';
import type { OverviewArrivalController } from './overview-arrival.svelte.ts';
import { arrivalFor, reconcileClaim, shouldSettle } from './overview-arrival-claim.ts';

/**
 * The Overview route's claim on the shell's arrival: once mounted it claims the active
 * Worksite's arrival, starts or settles it (reduced motion settles at once), and drops a
 * claim the controller has moved past. The host supplies mounting and effects, so the
 * spec drives the claim through a literal host; the route wires the real ones below.
 */
export interface OverviewArrivalClaimHost {
	readonly arrival: OverviewArrivalController;
	worksiteId(): string | undefined;
	reducedMotion(): boolean;
	/** Runs once the route has mounted. */
	mounted(run: () => void): void;
	/** Runs `setup` and re-runs it when its reads change. */
	effect(setup: () => void): void;
}

export function createOverviewArrivalClaim(host: OverviewArrivalClaimHost) {
	let mounted = $state(false);
	let claimedGeneration = $state<number | null>(null);

	host.mounted(() => {
		mounted = true;
	});

	host.effect(() => {
		const worksiteId = host.worksiteId();
		if (!mounted || !worksiteId || claimedGeneration !== null) return;
		const claim = host.arrival.claim(worksiteId);
		if (!claim) return;
		claimedGeneration = claim.generation;
		if (host.reducedMotion()) host.arrival.settle();
		else host.arrival.start(claim.generation);
	});

	host.effect(() => {
		if (shouldSettle(host.reducedMotion(), host.arrival.state)) host.arrival.settle();
	});

	host.effect(() => {
		const next = reconcileClaim(claimedGeneration, host.arrival);
		claimedGeneration = next.claimed;
		if (next.reset) host.arrival.reset();
	});

	const view = $derived(arrivalFor(claimedGeneration, host.arrival, ARRIVAL_DURATION_MS));

	return {
		get claimedGeneration() {
			return claimedGeneration;
		},
		get arrivalState() {
			return view.state;
		},
		get arrivalElapsed() {
			return view.elapsed;
		}
	};
}

/** The route's claim, wired to Svelte's mount and effects. */
export function overviewArrivalClaim(route: {
	arrival: OverviewArrivalController;
	worksiteId(): string | undefined;
	reducedMotion(): boolean;
}) {
	return createOverviewArrivalClaim({
		...route,
		mounted: (run) => {
			onMount(run);
		},
		effect: (setup) => {
			$effect(setup);
		}
	});
}
