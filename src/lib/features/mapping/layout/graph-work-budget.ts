/**
 * The per-solve allowance for composition work. A primitive is one
 * segment/disc, segment/box, segment/polygon-edge, segment/segment, point/edge
 * or pair-separation calculation. Helpers reserve their loops *before* running
 * them, so no candidate begins work it cannot finish: an exhausted candidate is
 * discarded whole, never returned partial.
 */
export type WorkKind = 'placement' | 'routing' | 'evaluation';

export const compositionWorkLimits: Readonly<Record<WorkKind, number>> = {
	placement: 250_000,
	routing: 500_000,
	evaluation: 250_000
};

export class WorkExhausted extends Error {
	readonly kind: WorkKind;
	constructor(kind: WorkKind) {
		super(`composition ${kind} work exhausted`);
		this.name = 'WorkExhausted';
		this.kind = kind;
	}
}

export type WorkBudget = {
	readonly used: Readonly<Record<WorkKind, number>>;
	readonly limits: Readonly<Record<WorkKind, number>>;
	/** Reserves `amount` primitives; throws {@link WorkExhausted} before any is spent past the limit. */
	spend(kind: WorkKind, amount: number): void;
	remaining(kind: WorkKind): number;
};

export function createWorkBudget(
	limits: Readonly<Record<WorkKind, number>> = compositionWorkLimits
): WorkBudget {
	const used: Record<WorkKind, number> = { placement: 0, routing: 0, evaluation: 0 };
	return {
		used,
		limits,
		spend(kind, amount) {
			const next = used[kind] + Math.max(0, Math.ceil(amount));
			if (next > limits[kind]) {
				used[kind] = limits[kind];
				throw new WorkExhausted(kind);
			}
			used[kind] = next;
		},
		remaining: (kind) => Math.max(0, limits[kind] - used[kind])
	};
}
