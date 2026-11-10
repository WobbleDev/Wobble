/**
 * The aligned two-group comparison and the stable identity both pagers jump by.
 *
 * Every group on the Overview is a region of one Attribute's frontier, so one key
 * names it in every reading: `frontier:<frontierId>`, with
 * `frontierId = <attributeId>/<region identity>`. The region identity is the
 * answer id, the exact-remainder identity (`#self:<attributeId>:<answerId>`), or
 * `#none` for the system group of Workers holding no answer. The key never
 * depends on row order, so the Support rows and the Agitations columns, which
 * order the same groups differently, resolve it independently.
 *
 * All arithmetic reads the support-summary readings; shares only add the labeled
 * population they divide by.
 */
import { remainderIdentity } from '#lib/shared/answer-hierarchy.ts';
import type { AssessmentOption } from '#lib/domain-vocabulary.ts';
import type { GroupPredicate } from './group-drilldown.ts';
import { assessmentBreakdown, populationOf, type ReadingPopulation } from './overview-readings.ts';
import type { AgitationMatrixRow, GroupReading } from './support-summary.ts';

/** The frontier identity of one region: stable across pages, order and detail. */
export function frontierId(group: GroupPredicate): string {
	const identity = group.noValue
		? '#none'
		: group.remainder
			? remainderIdentity(group.attributeId, group.answerId)
			: group.answerId;
	return `${group.attributeId}/${identity}`;
}

/** The stable key of one group: `frontier:<frontierId>`. */
export function frontierKey(group: GroupPredicate): string {
	return `frontier:${frontierId(group)}`;
}

/** The Attribute a frontier key belongs to. */
export function frontierKeyAttribute(key: string): string | null {
	const match = /^frontier:([^/]+)\//.exec(key);
	return match ? match[1] : null;
}

/** A count against the population it is divided by; no share when that is empty. */
export type Figure = {
	count: number;
	of: number;
	population: ReadingPopulation;
	share: number | null;
};

export function figure(count: number, of: number, population: ReadingPopulation): Figure {
	return { count, of, population, share: of === 0 ? null : count / of };
}

export type GroupColumn = {
	key: string;
	label: string;
	/** Share of the Worksite's Workers. */
	workers: Figure;
	/** Leader, Activist and Supporter against the group's Workers. */
	support: Figure;
	/** Assessed Workers against the group's Workers. */
	assessed: Figure;
	leaders: { leaders: number; needed: number };
	levels: { option: AssessmentOption; figure: Figure }[];
	/** One entry per held Agitation, in comparison order. */
	agitations: Figure[];
};

export type GroupComparison = {
	columns: [GroupColumn, GroupColumn];
	/** Agitations held in either group, most-held overall first, with their texts. */
	agitations: { id: string; text: string }[];
};

type ComparisonInput = {
	groups: readonly GroupReading[];
	matrix: { columns: { id: string; text: string; count: number }[]; rows: AgitationMatrixRow[] };
	/** Workers in the whole Worksite. */
	worksiteTotal: number;
};

/**
 * The two named groups side by side. Null unless both exist, differ, and belong
 * to the same Attribute frontier, so every quantity compares like with like.
 */
export function compareGroups(
	input: ComparisonInput,
	firstKey: string,
	secondKey: string
): GroupComparison | null {
	if (firstKey === secondKey) return null;
	if (frontierKeyAttribute(firstKey) !== frontierKeyAttribute(secondKey)) return null;
	const first = input.groups.find((group) => frontierKey(group) === firstKey);
	const second = input.groups.find((group) => frontierKey(group) === secondKey);
	if (!first || !second) return null;
	const rowOf = (key: string) => input.matrix.rows.find((row) => frontierKey(row) === key);
	const rows = [rowOf(firstKey), rowOf(secondKey)];
	const heldIndexes = input.matrix.columns
		.map((_, index) => index)
		.filter((index) => rows.some((row) => (row?.counts[index] ?? 0) > 0));
	const column = (group: GroupReading, key: string, row?: AgitationMatrixRow): GroupColumn => {
		const own = populationOf(group.value);
		return {
			key,
			label: group.value,
			workers: figure(group.total, input.worksiteTotal, populationOf()),
			support: figure(group.support, group.total, own),
			assessed: figure(group.total - group.counts.Unassessed, group.total, own),
			leaders: { leaders: group.leaders, needed: group.needed },
			levels: assessmentBreakdown(group.counts).map(({ option, count }) => ({
				option,
				figure: figure(count, group.total, own)
			})),
			agitations: heldIndexes.map((index) => figure(row?.counts[index] ?? 0, group.total, own))
		};
	};
	return {
		columns: [column(first, firstKey, rows[0]), column(second, secondKey, rows[1])],
		agitations: heldIndexes.map((index) => ({
			id: input.matrix.columns[index].id,
			text: input.matrix.columns[index].text
		}))
	};
}
