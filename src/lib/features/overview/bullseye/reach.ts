/**
 * The Organizing Committee's reach, and the count it is read from.
 *
 * Both the chart and the page that draws it need the same sentence: the chart
 * carries it in its accessible description, and Overview prints it where the
 * chart is a chart backdrop. One owner keeps the two from drifting.
 */

import { assessmentOptions, type AssessmentOption, type Worker } from '#lib/domain-vocabulary.ts';
import { assessmentGroupLabel, assessmentLabel } from '#lib/i18n/assessment.ts';
import { m } from '#lib/paraglide/messages.js';
import { DRAWN_ASSESSMENTS } from './bullseye-geometry.ts';

/** How many workers hold each Assessment. */
export function assessmentCounts(workers: readonly Worker[]): Record<AssessmentOption, number> {
	const counts = Object.fromEntries(
		assessmentOptions.map((assessment) => [assessment, 0])
	) as Record<AssessmentOption, number>;

	for (const worker of workers) counts[worker.assessment] += 1;
	return counts;
}

/**
 * How far the Committee's influence reaches: the outermost drawn band holding
 * any worker. Hostile workers sit outside the drawn rings and is named as
 * opposition, never as reach. Unassessed workers are not plotted.
 */
export function committeeReach(counts: Record<AssessmentOption, number>): string {
	let reach: AssessmentOption | null = null;
	for (const assessment of [...DRAWN_ASSESSMENTS].reverse()) {
		if (counts[assessment] > 0) {
			reach = assessment;
			break;
		}
	}

	const hostile = counts.Hostile;

	if (reach === null) {
		return hostile > 0 ? m.overview_reach_none_opposed() : m.overview_reach_none();
	}

	if (reach === 'Leader') {
		if (hostile === 0) return m.overview_reach_alone();
		const standing = assessmentLabel('Hostile');
		return hostile === 1
			? m.overview_reach_alone_opposed_one({ count: hostile, assessment: standing })
			: m.overview_reach_alone_opposed_many({ count: hostile, assessment: standing });
	}

	return m.overview_reach_ring({ assessment: assessmentGroupLabel(reach) });
}
