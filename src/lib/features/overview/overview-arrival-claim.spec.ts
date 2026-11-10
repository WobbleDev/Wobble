import { describe, expect, it } from 'vitest';
import { ARRIVAL_DURATION_MS } from './overview-arrival-lifecycle.ts';
import { arrivalFor, reconcileClaim, shouldSettle } from './overview-arrival-claim.ts';

describe('reconcileClaim', () => {
	it('keeps a claim the controller still holds', () => {
		expect(reconcileClaim(3, { generation: 3, pending: true, state: 'running' })).toEqual({
			claimed: 3,
			reset: false
		});
	});

	it('drops a claim the controller has moved past', () => {
		expect(reconcileClaim(3, { generation: 4, pending: false, state: 'complete' })).toEqual({
			claimed: null,
			reset: false
		});
	});

	it('resets a pending, started arrival that no longer has a claim', () => {
		expect(reconcileClaim(null, { generation: 4, pending: true, state: 'running' })).toEqual({
			claimed: null,
			reset: true
		});
	});

	it('does not reset an idle or unclaimed arrival', () => {
		expect(reconcileClaim(null, { generation: 4, pending: true, state: 'idle' }).reset).toBe(false);
		expect(reconcileClaim(null, { generation: 4, pending: false, state: 'running' }).reset).toBe(
			false
		);
	});
});

describe('shouldSettle', () => {
	it('settles a running arrival under reduced motion only', () => {
		expect(shouldSettle(true, 'running')).toBe(true);
		expect(shouldSettle(false, 'running')).toBe(false);
		expect(shouldSettle(true, 'complete')).toBe(false);
	});
});

describe('arrivalFor', () => {
	const arrival = { generation: 2, pending: false, state: 'running' as const, elapsed: 900 };

	it('reads the controller only for the generation the route claimed', () => {
		expect(arrivalFor(2, arrival, ARRIVAL_DURATION_MS)).toEqual({ state: 'running', elapsed: 900 });
	});

	it('reads idle and the full duration when the route holds no claim on this generation', () => {
		expect(arrivalFor(null, arrival, ARRIVAL_DURATION_MS)).toEqual({
			state: 'idle',
			elapsed: ARRIVAL_DURATION_MS
		});
		expect(arrivalFor(1, arrival, ARRIVAL_DURATION_MS).state).toBe('idle');
	});
});

/**
 * The claim factory through a literal host: mounting and effects are recorded and run
 * by the spec, and the controller is a plain object the spec moves by hand.
 */
import { createOverviewArrivalClaim } from './overview-arrival-claim.svelte.ts';
import type { OverviewArrivalController } from './overview-arrival.svelte.ts';
import { vi } from 'vitest';

function literalRoute(
	options: {
		worksiteId?: string;
		reduced?: boolean;
		arrival?: Partial<Record<string, unknown>>;
	} = {}
) {
	const controller = {
		generation: 3,
		pending: false,
		state: 'idle',
		elapsed: 0,
		claim: vi.fn((worksiteId: string) =>
			worksiteId ? { generation: controller.generation } : null
		),
		start: vi.fn(),
		settle: vi.fn(),
		reset: vi.fn(),
		...options.arrival
	};
	const mounts: (() => void)[] = [];
	const setups: (() => void)[] = [];
	const host = {
		arrival: controller as unknown as OverviewArrivalController,
		worksiteId: () => options.worksiteId,
		reducedMotion: () => options.reduced ?? false,
		mounted: (run: () => void) => mounts.push(run),
		effect: (setup: () => void) => setups.push(setup)
	};
	const claim = createOverviewArrivalClaim(host);
	return {
		claim,
		controller,
		mount() {
			for (const run of mounts) run();
		},
		flush() {
			for (const setup of setups) setup();
		}
	};
}

describe('createOverviewArrivalClaim', () => {
	it('claims nothing before the route mounts', () => {
		const route = literalRoute({ worksiteId: 'ws' });
		route.flush();
		expect(route.controller.claim).not.toHaveBeenCalled();
		expect(route.claim.claimedGeneration).toBeNull();
	});

	it('claims the Worksite once mounted and starts the arrival it was given', () => {
		const route = literalRoute({ worksiteId: 'ws' });
		route.mount();
		route.flush();
		expect(route.controller.claim).toHaveBeenCalledWith('ws');
		expect(route.controller.start).toHaveBeenCalledWith(3);
		expect(route.claim.claimedGeneration).toBe(3);
	});

	it('settles at once under reduced motion instead of starting', () => {
		const route = literalRoute({ worksiteId: 'ws', reduced: true });
		route.mount();
		route.flush();
		expect(route.controller.settle).toHaveBeenCalled();
		expect(route.controller.start).not.toHaveBeenCalled();
	});

	it('claims nothing without a Worksite', () => {
		const route = literalRoute({ worksiteId: undefined });
		route.mount();
		route.flush();
		expect(route.controller.claim).not.toHaveBeenCalled();
	});

	it('reads the controller only for the generation it holds, and idle otherwise', () => {
		const route = literalRoute({ worksiteId: 'ws', arrival: { state: 'running', elapsed: 900 } });
		route.mount();
		route.flush();
		expect(route.claim.arrivalState).toBe('running');
		expect(route.claim.arrivalElapsed).toBe(900);

		route.controller.generation = 4;
		route.flush();
		expect(route.claim.claimedGeneration).toBeNull();
		expect(route.claim.arrivalState).toBe('idle');
	});

	it('drops a claim the controller has moved past, so a new Worksite can claim again', () => {
		const route = literalRoute({ worksiteId: 'ws' });
		route.mount();
		route.flush();
		route.controller.generation = 4;
		route.flush();
		expect(route.claim.claimedGeneration).toBeNull();
		// The claim effect re-runs once the claim is dropped, and claims the new generation.
		route.flush();
		expect(route.controller.claim).toHaveBeenCalledTimes(2);
		expect(route.claim.claimedGeneration).toBe(4);
	});

	it('resets a pending arrival that the route no longer holds', () => {
		const route = literalRoute({
			worksiteId: undefined,
			arrival: { generation: 5, pending: true, state: 'running' }
		});
		route.mount();
		route.flush();
		expect(route.controller.reset).toHaveBeenCalled();
	});

	it('settles a running arrival under reduced motion when the motion setting changes', () => {
		const route = literalRoute({
			worksiteId: undefined,
			reduced: true,
			arrival: { state: 'running' }
		});
		route.mount();
		route.flush();
		expect(route.controller.settle).toHaveBeenCalled();
	});
});
