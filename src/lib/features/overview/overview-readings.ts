import { assessedOptions, type AssessmentOption } from '#lib/domain-vocabulary.ts';

/** The population a reading's denominator counts: every Worker, or one named group. */
export type ReadingPopulation = { kind: 'worksite' } | { kind: 'filter'; name: string };

/** The Worksite when no name is given, otherwise the named group or filter. */
export function populationOf(name?: string): ReadingPopulation {
	return name === undefined ? { kind: 'worksite' } : { kind: 'filter', name };
}

/** Every assessed level in order, then Unassessed, with its exact count (zeros kept). */
export function assessmentBreakdown(
	counts: Record<AssessmentOption, number>
): { option: AssessmentOption; count: number }[] {
	return [...assessedOptions, 'Unassessed' as const].map((option) => ({
		option,
		count: counts[option]
	}));
}
