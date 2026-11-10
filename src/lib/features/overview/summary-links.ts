import { resolve } from '$app/paths';
import type { ResolvedPathname } from '$app/types';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { writeWorkerFilters, type WorkerFilters } from '#lib/shared/worker-filters.ts';
import { withQuery, withSearch } from '#lib/shared/navigation.ts';
import { remainderIdentity } from '#lib/shared/answer-hierarchy.ts';
import { agitationDrilldownFilters, type GroupPredicate } from './group-drilldown.ts';
import type { AgitationMatrixRow } from './support-summary.ts';

/**
 * One Support group's Workers: the recipe the group row uses, so a group name opens
 * exactly its cohort — a named answer by its id, the system no-value group by the
 * Attribute's no-answer condition, and the exact remainder by its system identity
 * rather than the parent's subtree. Display text never identifies the destination.
 */
export function groupHref(reading: GroupPredicate): ResolvedPathname {
	if (reading.noValue) return withQuery(resolve('/workers'), { missing: reading.attributeId });
	const value = reading.remainder
		? remainderIdentity(reading.attributeId, reading.answerId)
		: reading.answerId;
	return withQuery(resolve('/workers'), { f: `${reading.attributeId}:${value}` });
}

/** What an Agitation link needs: the Agitation and, for a matrix cell, its group. */
type AgitationItem = {
	agitationId: string;
	group?: { attributeId: string; answerId: string; noValue?: boolean; remainder?: boolean };
};

/**
 * One Agitation's holders: the current context stays, a grouped row replaces its
 * own Attribute's predicate with the displayed group's exact one (so a remainder or
 * no-value row cannot reopen an unrelated cohort), and the row's Agitation is the
 * only Agitation selected.
 */
export function agitationHref(
	item: AgitationItem,
	filters: WorkerFilters,
	attributes: readonly WorkerAttributeDefinition[]
): ResolvedPathname {
	const group = item.group;
	const attribute = group ? attributes.find((entry) => entry.id === group.attributeId) : undefined;
	const next = agitationDrilldownFilters(filters, attribute, group, item.agitationId);
	return withSearch(resolve('/workers'), writeWorkerFilters(new URLSearchParams(), next));
}

/**
 * The Overview dashboard reads the whole Worksite, so its Agitation links carry no
 * context filters: the matrix cells and the All column open the same holders the
 * reader would reach from the Workers page.
 */
const WHOLE_WORKSITE: WorkerFilters = {
	answers: new Map(),
	missing: new Set(),
	exactAnswers: new Map(),
	columns: new Map(),
	agitations: new Set()
};

/** An All cell opens the Agitation's full holder count. */
export function matrixAllHref(
	agitationId: string,
	attributes: readonly WorkerAttributeDefinition[]
): ResolvedPathname {
	return agitationHref({ agitationId }, WHOLE_WORKSITE, attributes);
}

/** A matrix cell opens its group's holders of one Agitation, as the summary's cells do. */
export function matrixCellHref(
	row: Pick<AgitationMatrixRow, 'attributeId' | 'answerId' | 'noValue' | 'remainder'>,
	agitationId: string,
	attributes: readonly WorkerAttributeDefinition[]
): ResolvedPathname {
	return agitationHref(
		{
			agitationId,
			group: {
				attributeId: row.attributeId,
				answerId: row.answerId,
				...(row.noValue ? { noValue: true } : {}),
				...(row.remainder ? { remainder: true } : {})
			}
		},
		WHOLE_WORKSITE,
		attributes
	);
}
