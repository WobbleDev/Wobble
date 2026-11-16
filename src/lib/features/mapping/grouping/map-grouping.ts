/**
 * Mapping's contextual Grouping reading (spec: Filtering, hierarchy, and readings).
 *
 * One ledger, one predicate. The displayed Workers are the layout set. Each displayed
 * Worker yields one cell for a Grouping: the answers it holds for that Attribute, with
 * several held answers collapsed to their deepest shared displayed ancestor, so one
 * person is never counted twice for holding a parent and a child (AC11). A Grouping is
 * available only when every displayed Worker occupies exactly one region, system
 * regions included. Otherwise the choice keeps its state, the map falls back to Free,
 * and this reading explains why and which narrower filters would resolve it.
 */
import type { AttributeAnswer, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { expandBranch } from '#lib/shared/workers/answer-hierarchy.ts';
import { NO_VALUE_REGION } from '#lib/shared/workers/region-identity.ts';
import type { WorkerGraphNode } from '../canvas/worker-relationship-map-model.ts';
import type {
	DisplayedRegion,
	AvailableGrouping,
	GroupingReading,
	GroupingOptions,
	ExpansionAttempt,
	GroupingInput,
	ProjectedLayout
} from './grouping-types.ts';
import { readCore, readSubCore } from './grouping-core.ts';
import { groupingSuggestions, subGroupingSuggestions } from './grouping-suggestions.ts';

/**
 * Reads a whole Grouping, and its paired Sub-grouping when a secondary question is
 * named. Guidance is off by default so the control can test every choice's
 * availability cheaply; only the refusal on screen asks for suggestions.
 */
export function readGrouping(
	input: GroupingInput,
	attributeId: string,
	options: GroupingOptions = {}
): GroupingReading {
	const expandedIds = options.expandedIds ?? [];
	const reading = readCore(input, attributeId, expandedIds);
	if (reading.status === 'unavailable') {
		return {
			...reading,
			suggestions: options.guidance
				? groupingSuggestions(input, attributeId, reading.ambiguous, expandedIds)
				: []
		};
	}

	if (!options.subAttributeId) return reading;

	const sub = readSubCore(
		input,
		reading,
		attributeId,
		options.subAttributeId,
		options.expandedSubIds ?? []
	);
	if (sub.status === 'available') {
		const regionOf = new Map(
			[...reading.regionOf].map(([workerId, cell]) => {
				const subGroup = sub.regionOf.get(workerId);
				return [workerId, subGroup === undefined ? cell : { ...cell, subGroup }] as const;
			})
		);
		return { ...reading, regionOf, subGrouping: sub };
	}
	return {
		...reading,
		subGrouping: {
			...sub,
			suggestions: options.guidance
				? subGroupingSuggestions(
						input,
						attributeId,
						options.subAttributeId,
						sub.pairs,
						expandedIds,
						options.expandedSubIds ?? []
					)
				: []
		}
	};
}

/**
 * Attempts one branch expansion against the current detail. The candidate id list is
 * normalized (ancestors included, stale ids dropped) and read before anything commits,
 * so a refusal leaves state and address exactly as they were and the coarser view stays.
 */
export function attemptExpansion(
	input: GroupingInput,
	attributeId: string,
	expandedIds: Iterable<string>,
	branchId: string
): ExpansionAttempt {
	const attribute = input.attributes.find(({ id }) => id === attributeId);
	if (!attribute) throw new Error(`Unknown Grouping Attribute: ${attributeId}`);

	const candidate = expandBranch(attribute, expandedIds, branchId);
	const reading = readCore(input, attributeId, candidate);
	if (reading.status === 'available') {
		return { status: 'available', expandedIds: candidate, reading };
	}

	// An expansion can only split an existing partition; an unresolved answer would
	// already have made the coarser reading unavailable.
	return {
		status: 'refused',
		reason: {
			code: 'expansion-breaks-partition',
			attributeId,
			branchId,
			workers: reading.reason.code === 'multiple-regions' ? reading.reason.workers : []
		}
	};
}

/** The synthetic answers for a region list, in the order the map draws them. */
function projectedAnswers(regions: readonly DisplayedRegion[]): AttributeAnswer[] {
	return (
		regions
			// The empty key is rendered from the Attribute's name by bucketLabel; carrying it
			// as an answer would make bucketDescription mistake it for a colliding real answer.
			.filter((region) => region.key !== NO_VALUE_REGION)
			.map((region) => ({
				id: region.key,
				value: region.description ? `${region.label} (${region.description})` : region.label
			}))
	);
}

/**
 * Hands the solver the region keys without rewriting its algorithms: each node carries
 * its one region at the Attribute's slot, and the synthetic definition's answers are the
 * ordered regions. The real definition stays authoritative for every predicate; the
 * synthetic one is view-only and never persisted or sent in a request.
 *
 * When the paired Sub-grouping is available, the same projection carries its key and a
 * second synthetic definition. When it is refused, only the primary key is projected:
 * the primary Grouping is unchanged and simply draws no sub-groups.
 */
export function projectLayoutInput(
	nodes: readonly WorkerGraphNode[],
	reading: AvailableGrouping,
	attribute: WorkerAttributeDefinition,
	subAttribute?: WorkerAttributeDefinition
): ProjectedLayout {
	const subReading =
		subAttribute && reading.subGrouping?.status === 'available' ? reading.subGrouping : undefined;

	return {
		nodes: nodes.map((node) => ({
			...node,
			attributes: {
				...node.attributes,
				[attribute.id]: reading.regionOf.get(node.id)?.group ?? '',
				...(subReading && subAttribute
					? { [subAttribute.id]: subReading.regionOf.get(node.id) ?? '' }
					: {})
			}
		})),
		groupingAttribute: { ...attribute, answers: projectedAnswers(reading.regions) },
		...(subReading && subAttribute
			? {
					subGroupingAttribute: {
						...subAttribute,
						answers: projectedAnswers(subReading.regions)
					}
				}
			: {})
	};
}
