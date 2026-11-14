/**
 * The Overview summary's arithmetic: how a Worksite's support is spread across
 * the Workers table, across one Attribute's values, and across its Agitations.
 *
 * Every function is pure and reads the workers it is handed; the caller decides
 * the population — the whole Worksite, or a filtered subset — so the frozen
 * overall reading and the breakdown can share one reading.
 */

import { isSupportAssessment } from '#lib/shared/assessment.ts';
import { frontier } from '#lib/shared/answer-hierarchy.ts';
import { noValueReading } from '#lib/shared/no-value-reading.ts';
import {
	answerIsInSubtree,
	heldAnswerIds,
	type PopulationProjection
} from '#lib/shared/worker-population.ts';
import {
	assessmentOptions,
	emptyValue,
	type Agitation,
	type AssessmentOption,
	type AttributeAnswer,
	type Worker,
	type WorkerAttributeDefinition,
	type WorkerAttributeValue
} from '#lib/domain-vocabulary.ts';

/** A population's support: how many are with us, out of how many, as a fraction. */
export type SupportReading = { support: number; total: number; rate: number };

/** One group's support, Leaders against the worksite target, and standing counts. */
export type GroupReading = {
	/** The Attribute this row groups by (ADR 0030). */
	attributeId: string;
	/** The answer's id (ADR 0030): what the row is keyed and grouped on. Empty for the system no-value group. */
	answerId: string;
	/** True only for the system group of Workers holding no answer; never a configured answer. */
	noValue?: boolean;
	/** True only for the exact direct-parent remainder of an expanded branch. */
	remainder?: boolean;
	/** True when this row's answer has children, so the branch can be expanded. */
	expandable?: boolean;
	/** True when this row is the remainder of a branch that is currently expanded. */
	expanded?: boolean;
	/** The answer's current text, shown as the row's label; for the no-value group, the shared reading. */
	value: string;
	/** The secondary description a colliding real answer forces on the system reading. */
	description?: string;
	support: number;
	total: number;
	rate: number;
	leaders: number;
	needed: number;
	/** Leaders minus needed: a surplus is positive, a shortfall negative. */
	gap: number;
	counts: Record<AssessmentOption, number>;
};

/** One Agitation and how many workers in the population hold it. */
export type AgitationCount = { id: string; text: string; count: number };

/** One Attribute value's most-held Agitations. */
export type AgitationGroup = {
	/** The Attribute this group is part of. */
	attributeId: string;
	/** The answer's id; empty for a system group. */
	answerId: string;
	/** True only for the system no-answer group. */
	noValue?: boolean;
	/** True only for the exact direct-parent remainder of an expanded branch. */
	remainder?: boolean;
	/** True when this group's answer has children, so the branch can be expanded. */
	expandable?: boolean;
	/** True when this group is the remainder of a branch that is currently expanded. */
	expanded?: boolean;
	/** The secondary description a system reading or remainder adds. */
	description?: string;
	value: string;
	workers: number;
	/** The group's top Agitations, most-held first. */
	agitations: AgitationCount[];
	/** How many distinct Agitations the group holds in all. */
	held: number;
};

/** The answers an Attribute offers, in list order, with their ids. */
function answersOf(attribute: WorkerAttributeDefinition): AttributeAnswer[] {
	return attribute.answers;
}

/** True when a Worker holds the answer with this id for one Attribute (ADR 0030). */
export function holdsAnswer(worker: Worker, attributeId: string, answerId: string): boolean {
	const held = worker.attributes[attributeId];
	if (held === undefined) return false;
	return Array.isArray(held) ? held.includes(answerId) : held === answerId;
}

/**
 * The text a Worker's answer reads as, looked up from the answer ids: a string for
 * a Category, a list for a Tag, shaped as the Attribute's text was.
 */
export function answerLabels(
	worker: Worker,
	attribute: WorkerAttributeDefinition
): WorkerAttributeValue {
	const held = worker.attributes[attribute.id];
	const labelOf = (id: string) => answersOf(attribute).find((answer) => answer.id === id)?.value;
	if (held === undefined) return emptyValue(attribute.kind);
	if (!Array.isArray(held)) return labelOf(held) ?? '';
	return held.flatMap((id) => labelOf(id) ?? []);
}

/** How many workers hold each standing. */
export function assessmentCounts(workers: readonly Worker[]): Record<AssessmentOption, number> {
	const counts = Object.fromEntries(assessmentOptions.map((option) => [option, 0])) as Record<
		AssessmentOption,
		number
	>;
	for (const worker of workers) counts[worker.assessment] += 1;
	return counts;
}

/** A population's support share, with Unassessed workers held in the denominator. */
export function supportReading(workers: readonly Worker[]): SupportReading {
	const total = workers.length;
	const support = workers.filter((worker) => isSupportAssessment(worker.assessment)).length;
	return { support, total, rate: total === 0 ? 0 : support / total };
}

const defaultTarget = 5;

/**
 * The effective Committee coverage goal: the given number of workers per
 * Leader when it is a positive whole number, otherwise the default.
 */
export function leaderTarget(target: number): number {
	return Number.isInteger(target) && target >= 1 ? target : defaultTarget;
}

/** The whole Worksite's Committee coverage: its Leaders against the target. */
export function coverageReading(
	workers: readonly Worker[],
	target: number = defaultTarget
): { leaders: number; needed: number; gap: number } {
	const perLeader = leaderTarget(target);
	const needed = workers.length === 0 ? 0 : Math.ceil(workers.length / perLeader);
	const leaders = workers.filter((worker) => worker.assessment === 'Leader').length;
	return { leaders, needed, gap: leaders - needed };
}

function readGroup(
	attributeId: string,
	answerId: string,
	value: string,
	members: readonly Worker[],
	perLeader: number,
	extra: {
		noValue?: true;
		remainder?: true;
		expandable?: boolean;
		expanded?: boolean;
		description?: string;
	} = {}
): GroupReading {
	const counts = assessmentCounts(members);
	const { support, total, rate } = supportReading(members);
	const needed = total === 0 ? 0 : Math.ceil(total / perLeader);
	return {
		attributeId,
		answerId,
		value,
		...extra,
		support,
		total,
		rate,
		leaders: counts.Leader,
		needed,
		gap: counts.Leader - needed,
		counts
	};
}

/**
 * True when a Worker holds no answer to an Attribute, for either cardinality: the
 * Attribute is absent, a Single-Select holds the empty answer, or a Multi-Select
 * holds an empty list. It reads the same helper as the shared population predicate,
 * so the system group and the filter cannot disagree.
 */
function holdsNoAnswer(worker: Worker, attribute: WorkerAttributeDefinition): boolean {
	return heldAnswerIds(worker, attribute).length === 0;
}

/**
 * One visible region of the shared population and the Workers it holds. Support,
 * Committee coverage and Agitations read the same memberships, so one frontier and
 * one projection serve every reading of the breakdown.
 */
type GroupMembership = {
	answerId: string;
	value: string;
	description?: string;
	remainder?: true;
	noValue?: true;
	expandable?: boolean;
	expanded?: boolean;
	members: Worker[];
};

/**
 * The memberships of one Attribute's visible regions (spec: Filtering, hierarchy,
 * and readings). Every Attribute is an ordinary Worker value now, so a Worker
 * counts once per region however many of its answers reach it, an ordinary region
 * includes descendants, and an expanded branch is replaced by its direct children
 * and an occupied exact-parent remainder. The system reading stays last and
 * distinct: No plus the Attribute's current name for a Worker holding no answer.
 */
function membershipsFor(
	projection: PopulationProjection,
	attribute: WorkerAttributeDefinition,
	expandedIds: readonly string[]
): GroupMembership[] {
	const heldByWorker = new Map<string, ReadonlySet<string>>();

	for (const worker of projection.workers) {
		heldByWorker.set(worker.id, new Set(heldAnswerIds(worker, attribute)));
	}

	const groups = frontier(attribute, expandedIds).regions.flatMap((region): GroupMembership[] => {
		const members = projection.workers.filter((worker) => {
			const held = heldByWorker.get(worker.id);
			if (!held) return false;
			// The remainder is the exact parent; an answer region includes its subtree.
			return region.kind === 'remainder'
				? held.has(region.answerId)
				: [...held].some((id) => answerIsInSubtree(attribute.answers, region.answerId, id));
		});
		if (members.length === 0) return [];
		return [
			{
				answerId: region.answerId,
				value: region.label,
				...(region.kind === 'remainder'
					? { remainder: true, description: region.description ?? undefined }
					: {}),
				expandable: region.expandable,
				expanded: region.expanded,
				members
			}
		];
	});

	// Every Worker is accounted for once: the Workers holding no answer follow the
	// configured groups as one system group.
	const missing = projection.workers.filter((worker) => holdsNoAnswer(worker, attribute));
	if (missing.length > 0) {
		const reading = noValueReading(attribute);
		groups.push({
			answerId: '',
			value: reading.label,
			noValue: true,
			...(reading.description ? { description: reading.description } : {}),
			members: missing
		});
	}
	return groups;
}

/** One GroupReading from its shared membership. */
function readingOf(
	attribute: WorkerAttributeDefinition,
	membership: GroupMembership,
	perLeader: number
): GroupReading {
	return readGroup(
		attribute.id,
		membership.answerId,
		membership.value,
		membership.members,
		perLeader,
		{
			...(membership.noValue ? { noValue: true } : {}),
			...(membership.remainder ? { remainder: true } : {}),
			...(membership.description ? { description: membership.description } : {}),
			...(membership.expandable !== undefined ? { expandable: membership.expandable } : {}),
			...(membership.expanded !== undefined ? { expanded: membership.expanded } : {})
		}
	);
}

/**
 * One reading per visible region that holds workers, most to least support, over
 * one Attribute. Readings start at the roots; an unexpanded region includes
 * its descendants, while an expanded branch is replaced by its direct children and an
 * occupied direct-parent remainder. Rows at equal support keep configured order.
 * The whole Worksite is not a group: the two frozen
 * figures above the breakdown state its readings, `coverageReading` among them.
 * The target falls back to 5 when it is not a positive whole number.
 */
export function groupReadings(
	workers: readonly Worker[],
	attribute: WorkerAttributeDefinition | undefined,
	target = defaultTarget,
	expandedIds: readonly string[] = []
): GroupReading[] {
	if (!attribute) return [];
	return contextualGroupReadings({ workers: [...workers] }, attribute, target, expandedIds);
}

/**
 * One reading per group of the shared contextual population (spec: Filtering,
 * hierarchy, and readings): the same regions, descendant inclusion and exact
 * remainders as `groupReadings`, read over the Workers the context filter selected.
 *
 * Each group counts a Worker once, however many of that Attribute's answers the
 * Worker holds. The group's own denominator includes its Unassessed Workers, so the
 * existing arithmetic reads Support and Committee coverage per group without summing
 * groups. A coarse answer includes its descendants, and a Worker holding no answer
 * follows them as the distinct system reading. Rows read most to least support;
 * rows at equal support keep configured order.
 */
export function contextualGroupReadings(
	projection: PopulationProjection,
	attribute: WorkerAttributeDefinition | undefined,
	target = defaultTarget,
	expandedIds: readonly string[] = []
): GroupReading[] {
	if (!attribute) return [];
	const perLeader = leaderTarget(target);
	return membershipsFor(projection, attribute, expandedIds)
		.map((membership) => readingOf(attribute, membership, perLeader))
		.sort((a, b) => b.rate - a.rate);
}

/**
 * Every Agitation someone holds, by holder count descending, then configured
 * order. Agitations nobody holds are left out.
 */
export function agitationReadings(
	workers: readonly Worker[],
	agitations: readonly Agitation[]
): AgitationCount[] {
	return agitations
		.map((agitation, index) => ({
			id: agitation.id,
			text: agitation.text,
			index,
			count: workers.filter((worker) => worker.agitations.includes(agitation.id)).length
		}))
		.filter((entry) => entry.count > 0)
		.sort((a, b) => b.count - a.count || a.index - b.index)
		.map(({ id, text, count }) => ({ id, text, count }));
}

/**
 * Agitations grouped under one Attribute's visible regions, in configured order:
 * each group's top `perGroup` Agitations and how many it holds in all. Groups that
 * hold no Agitations are left out. Membership is the same shared projection and
 * frontier the Support breakdown counts, so the two tabs cannot disagree about a
 * cohort, a remainder or a system reading.
 */
function agitationGroupsFor(
	projection: PopulationProjection,
	agitations: readonly Agitation[],
	attribute: WorkerAttributeDefinition,
	expandedIds: readonly string[],
	perGroup: number
): AgitationGroup[] {
	return membershipsFor(projection, attribute, expandedIds).flatMap(
		(membership): AgitationGroup[] => {
			const all = agitationReadings(membership.members, agitations);
			if (all.length === 0) return [];
			return [
				{
					attributeId: attribute.id,
					answerId: membership.answerId,
					value: membership.value,
					...(membership.noValue ? { noValue: true } : {}),
					...(membership.remainder ? { remainder: true } : {}),
					...(membership.description ? { description: membership.description } : {}),
					...(membership.expandable !== undefined ? { expandable: membership.expandable } : {}),
					...(membership.expanded !== undefined ? { expanded: membership.expanded } : {}),
					workers: membership.members.length,
					agitations: all.slice(0, Math.max(0, perGroup)),
					held: all.length
				}
			];
		}
	);
}

/**
 * The Agitations breakdown over the shared filtered population: the Worker's own
 * answers, the same expanded branches and exact remainders as Support, and the same
 * system reading. A Worker counts once per group, so a held Agitation is never
 * doubled inside one group.
 */
export function contextualAgitationsByGroup(
	projection: PopulationProjection,
	agitations: readonly Agitation[],
	attribute: WorkerAttributeDefinition | undefined,
	expandedIds: readonly string[] = [],
	perGroup = 3
): AgitationGroup[] {
	if (!attribute) return [];
	return agitationGroupsFor(projection, agitations, attribute, expandedIds, perGroup);
}

/**
 * The per-Worker Agitations breakdown, for callers that already hold the
 * Workers rather than a projection. It reads the same memberships as
 * `contextualAgitationsByGroup` with no contextual filter.
 */
export function agitationsByCategory(
	workers: readonly Worker[],
	agitations: readonly Agitation[],
	attribute: WorkerAttributeDefinition | undefined,
	perGroup = 3
): AgitationGroup[] {
	if (!attribute) return [];
	return agitationGroupsFor({ workers: [...workers] }, agitations, attribute, [], perGroup);
}

/** One held Agitation with its holders split across the six assessment levels. */
export type AgitationSplit = AgitationCount & { levels: Record<AssessmentOption, number> };

/**
 * Every held Agitation with its holders split by assessment, in the order of
 * `agitationReadings`, over the shared contextual population.
 */
export function agitationSplits(
	projection: PopulationProjection,
	agitations: readonly Agitation[]
): AgitationSplit[] {
	return agitationReadings(projection.workers, agitations).map((reading) => ({
		...reading,
		levels: assessmentCounts(
			projection.workers.filter((worker) => worker.agitations.includes(reading.id))
		)
	}));
}

/** The most-held Agitation as a share of every worker, Unassessed included. */
export type AgitationHeadline = {
	id: string;
	text: string;
	holders: number;
	total: number;
	share: number;
};

/** The top Agitation's headline reading, or null when nobody holds any. */
export function topAgitationHeadline(
	projection: PopulationProjection,
	agitations: readonly Agitation[]
): AgitationHeadline | null {
	const [top] = agitationReadings(projection.workers, agitations);
	if (!top) return null;
	const total = projection.workers.length;
	return { id: top.id, text: top.text, holders: top.count, total, share: top.count / total };
}

/** One group's holder count under each column Agitation. */
export type AgitationMatrixRow = Omit<AgitationGroup, 'agitations' | 'held'> & {
	/** Holder counts, one per column, in column order. */
	counts: number[];
};

/**
 * Groups of one Attribute against every held Agitation: the same memberships as
 * `contextualAgitationsByGroup`, columns in `agitationReadings` order, and the
 * table's highest count for shading.
 */
export function agitationGroupMatrix(
	projection: PopulationProjection,
	agitations: readonly Agitation[],
	attribute: WorkerAttributeDefinition | undefined,
	expandedIds: readonly string[] = []
): { columns: AgitationCount[]; rows: AgitationMatrixRow[]; max: number } {
	if (!attribute) return { columns: [], rows: [], max: 0 };
	const columns = agitationReadings(projection.workers, agitations);
	const rows = membershipsFor(projection, attribute, expandedIds).map(
		(membership): AgitationMatrixRow => ({
			attributeId: attribute.id,
			answerId: membership.answerId,
			value: membership.value,
			...(membership.noValue ? { noValue: true } : {}),
			...(membership.remainder ? { remainder: true } : {}),
			...(membership.description ? { description: membership.description } : {}),
			...(membership.expandable !== undefined ? { expandable: membership.expandable } : {}),
			...(membership.expanded !== undefined ? { expanded: membership.expanded } : {}),
			workers: membership.members.length,
			counts: columns.map(
				(column) => membership.members.filter((w) => w.agitations.includes(column.id)).length
			)
		})
	);
	return { columns, rows, max: Math.max(0, ...rows.flatMap((row) => row.counts)) };
}
