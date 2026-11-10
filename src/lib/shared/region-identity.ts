/**
 * The typed identities a Mapping region can carry (spec: Filtering, hierarchy,
 * and readings). A region key is not a label and not a preference: an answer's id and
 * a Worker's no-value reading are two different facts, and a real answer that reads
 * like a system region keeps its own key so the two can never impersonate one another.
 *
 * Core-minted answer ids never contain '#', so a system key is the empty string or
 * one of the '#' families. The exact direct-parent remainder is the shared hierarchy
 * frontier's identity (`answer-hierarchy.ts`, ticket 19), never a Mapping-specific
 * one, so both views read one branch meaning. The layout's 'unassigned' rendering key
 * is derived from the empty key elsewhere (graph-layout.ts's `regionKey`); it is not
 * a region id.
 */
import { isRemainderIdentity } from './answer-hierarchy.ts';

/** The system reading for a Worker who holds no answer to the question. */
export const NO_VALUE_REGION = '';

export type RegionIdentity = 'answer' | 'no-value' | 'remainder';

/** The typed identity a region key stands for. */
export function regionIdentity(key: string): RegionIdentity {
	if (key === NO_VALUE_REGION) return 'no-value';
	if (isRemainderIdentity(key)) return 'remainder';
	if (key.startsWith('#')) {
		// Only this module mints '#' keys; an unknown one is a bug, not an answer id.
		throw new Error(`Unknown system region identity: ${key}`);
	}
	return 'answer';
}

/** Whether a region is a system reading rather than a configured answer. */
export function isSystemRegion(key: string): boolean {
	return regionIdentity(key) !== 'answer';
}
