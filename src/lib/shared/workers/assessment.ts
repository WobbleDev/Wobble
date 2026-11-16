/**
 * The Assessment scale's colours (as references to the theme's `--assess-*` tokens, so
 * the dark theme's lifted steps reach every consumer), and the rule for which standings count as
 * Support. The hex values are set on those `--assess-*` tokens in the theme.
 */
import type { Worker } from '#lib/domain-vocabulary.ts';

const assessmentColors: Record<Worker['assessment'], string> = {
	Unassessed: 'var(--assess-unassessed)',
	Leader: 'var(--assess-leader)',
	Activist: 'var(--assess-activist)',
	Supporter: 'var(--assess-supporter)',
	Disengaged: 'var(--assess-disengaged)',
	Hostile: 'var(--assess-hostile)'
};

export function isSupportAssessment(assessment: Worker['assessment']): boolean {
	return assessment === 'Leader' || assessment === 'Activist' || assessment === 'Supporter';
}

export function assessmentColorKey(assessment: Worker['assessment']): string {
	return `assessment-${assessment.toLowerCase().replaceAll(' ', '-')}`;
}

export function assessmentColorFor(assessment: Worker['assessment']): string {
	return assessmentColors[assessment];
}

/**
 * True when a plain string is one of the six standings. A renderer that receives
 * its options as strings — a filter list, say — can name an Assessment colour
 * without asserting the type.
 */
export function isAssessment(value: string): value is Worker['assessment'] {
	return Object.hasOwn(assessmentColors, value);
}
