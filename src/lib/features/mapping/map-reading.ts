/**
 * What the map reads from the Workers table: Assessment and Support counts, and how many
 * Workers each region holds.
 */
import { isSupportAssessment } from '#lib/shared/assessment.ts';
import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { buildBucketTree } from './layout/graph-analysis.ts';
import { regionKey, subRegionKey } from './layout/graph-layout.ts';
import type { WorkerGraphNode } from './canvas/worker-relationship-map-model.ts';

/**
 * The Mapping's organizing reading, counted in one place.
 *
 * The key, the region labels and any other surface that states a distribution
 * read these functions, so the arithmetic cannot drift between them. Support is
 * the glossary's reading: Leader, Activist and Supporter counted against every
 * worker, the Unassessed included.
 */

type Assessed = Pick<Worker, 'assessment'>;

export type AssessmentCounts = Record<string, number>;

/** How many workers hold each standing, including Unassessed. */
export function assessmentCounts(workers: readonly Assessed[]): AssessmentCounts {
	const counts: AssessmentCounts = {};
	for (const worker of workers) {
		counts[worker.assessment] = (counts[worker.assessment] ?? 0) + 1;
	}
	return counts;
}

export type SupportReading = {
	total: number;
	support: number;
	unassessed: number;
	other: number;
};

/** The worksite read as support, unassessed, and other, against every worker. */
export function supportReading(workers: readonly Assessed[]): SupportReading {
	let support = 0;
	let unassessed = 0;

	for (const worker of workers) {
		if (worker.assessment === 'Unassessed') unassessed += 1;
		else if (isSupportAssessment(worker.assessment)) support += 1;
	}

	return {
		total: workers.length,
		support,
		unassessed,
		other: workers.length - support - unassessed
	};
}

/**
 * The member count of every drawn region and sub-region, keyed the way the
 * layout keys them. The Unanswered region is a region like any other, so a group
 * with no answer still carries its own count.
 */
export function regionCounts(
	nodes: readonly WorkerGraphNode[],
	groupingAttribute: WorkerAttributeDefinition | undefined,
	subGroupingAttribute: WorkerAttributeDefinition | undefined
): Map<string, number> {
	const counts = new Map<string, number>();
	if (!groupingAttribute) return counts;

	for (const group of buildBucketTree(nodes, groupingAttribute, subGroupingAttribute)) {
		counts.set(regionKey(group.value), group.count);
		if (!subGroupingAttribute) continue;
		for (const subGroup of group.subGroups) {
			counts.set(subRegionKey(group.value, subGroup.value), subGroup.count);
		}
	}

	return counts;
}
