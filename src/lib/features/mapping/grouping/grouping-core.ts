/** The raw Grouping and Sub-grouping readings, before suggestions and refusal wording are added. */
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { regionIdentity } from '#lib/shared/workers/region-identity.ts';
import type { PopulationFilters } from '#lib/shared/workers/worker-population.ts';
import type {
	GroupingCell,
	PairedCell,
	AvailableGrouping,
	GroupingInput,
	Cell,
	RawReading,
	RawSubReading
} from './grouping-types.ts';
import {
	cellFor,
	cellFromRegion,
	frontierView,
	exactAnswerRegion,
	cellsForWorker,
	regionOrder
} from './grouping-cells.ts';

export function readCore(
	input: GroupingInput,
	attributeId: string,
	expandedIds: Iterable<string> = []
): RawReading {
	const attribute = input.attributes.find(({ id }) => id === attributeId);
	if (!attribute) throw new Error(`Unknown Grouping Attribute: ${attributeId}`);

	const byId = new Map(attribute.answers.map((answer) => [answer.id, answer]));
	const view = frontierView(attribute, expandedIds);
	const membersOf = new Map<string, string[]>();
	const counts = new Map<string, number>();
	const regionOf = new Map<string, GroupingCell>();
	const ambiguous = new Map<string, GroupingCell[]>();
	const regionCells = new Map<string, Cell>();
	const unresolvedAnswerIds = new Set<string>();
	const unresolvedWorkerIds = new Set<string>();

	for (const node of input.nodes) {
		const { cells, unresolved } = cellsForWorker(node, attribute, byId, view);
		if (unresolved.length > 0) {
			for (const answerId of unresolved) unresolvedAnswerIds.add(answerId);
			unresolvedWorkerIds.add(node.id);
			continue;
		}
		for (const cell of cells) regionCells.set(cell.key, cell);
		if (cells.length !== 1) {
			ambiguous.set(
				node.id,
				cells.map((cell) => ({ group: cell.key }))
			);
			continue;
		}

		const key = cells[0].key;
		regionOf.set(node.id, { group: key });
		const members = membersOf.get(key);
		if (members) members.push(node.id);
		else membersOf.set(key, [node.id]);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	if (unresolvedAnswerIds.size > 0) {
		return {
			status: 'unavailable',
			attributeId,
			reason: {
				code: 'unresolved-answer',
				attributeId,
				answerIds: [...unresolvedAnswerIds],
				workerIds: [...unresolvedWorkerIds]
			},
			ambiguous
		};
	}
	if (ambiguous.size > 0) {
		return {
			status: 'unavailable',
			attributeId,
			reason: {
				code: 'multiple-regions',
				attributeId,
				workers: [...ambiguous].map(([workerId, cells]) => ({
					workerId,
					keys: cells.map(({ group }) => group)
				}))
			},
			ambiguous
		};
	}

	const regions = [...regionCells.values()]
		.sort(
			(first, second) =>
				regionOrder(attribute, view, first.key) - regionOrder(attribute, view, second.key) ||
				first.key.localeCompare(second.key)
		)
		.map((cell) => ({ ...cell, outlined: regionIdentity(cell.key) === 'answer' }));

	return { status: 'available', attributeId, regions, regionOf, membersOf, counts };
}

/** The same filters with one candidate condition added, for a simulated narrow. */
export function withCandidate(
	filters: PopulationFilters | undefined,
	candidate: { attributeId: string; answerId: string; missing: boolean }
): PopulationFilters {
	const answers = new Map(filters?.answers ?? []);
	const missing = new Set(filters?.missing ?? []);

	if (candidate.missing) missing.add(candidate.attributeId);
	else {
		answers.set(candidate.attributeId, [
			...(answers.get(candidate.attributeId) ?? []),
			candidate.answerId
		]);
	}

	return { ...filters, answers, missing };
}

export function attributePosition(
	attributes: readonly WorkerAttributeDefinition[],
	id: string
): number {
	const position = attributes.findIndex((attribute) => attribute.id === id);
	return position === -1 ? Number.MAX_SAFE_INTEGER : position;
}

export function answerPosition(
	attributes: readonly WorkerAttributeDefinition[],
	candidate: { attributeId: string; answerIds: string[]; missing: boolean }
): number {
	const attribute = attributes.find(({ id }) => id === candidate.attributeId);
	if (!attribute || candidate.missing) return Number.MAX_SAFE_INTEGER;
	const answerId = candidate.answerIds[0] ?? '';
	const position = attribute.answers.findIndex(({ id }) => id === answerId);
	return position === -1 ? attribute.answers.length : position;
}

/** Identical primary/secondary pairs describe one pair, however many held values produced them. */
function dedupePairs(pairs: readonly PairedCell[]): PairedCell[] {
	const seen = new Set<string>();
	return pairs.filter(([group, subGroup]) => {
		const key = `${group}\u0001${subGroup}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Reads the paired Sub-grouping. Each displayed Worker has one primary region and one
 * secondary cell (or several held answers collapsed to one); a Worker whose secondary
 * answers occupy several displayed regions has no single pair, so the pairing is
 * refused rather than choosing one. Identical pairs collapse before the one-pair-per-
 * Worker rule decides availability, and a child in two secondary regions still leaves
 * one dot: the primary Grouping is untouched.
 */
export function readSubCore(
	input: GroupingInput,
	primary: AvailableGrouping,
	primaryAttributeId: string,
	subAttributeId: string,
	expandedSubIds: Iterable<string> = []
): RawSubReading {
	const primaryAttribute = input.attributes.find(({ id }) => id === primaryAttributeId);
	if (!primaryAttribute) throw new Error(`Unknown Grouping Attribute: ${primaryAttributeId}`);
	const subAttribute = input.attributes.find(({ id }) => id === subAttributeId);
	if (!subAttribute) throw new Error(`Unknown Sub-grouping Attribute: ${subAttributeId}`);

	const byId = new Map(subAttribute.answers.map((answer) => [answer.id, answer]));
	const view = frontierView(subAttribute, expandedSubIds);
	const pairsOf = new Map<string, PairedCell[]>();
	const unresolvedAnswerIds = new Set<string>();
	const unresolvedWorkerIds = new Set<string>();

	for (const node of input.nodes) {
		const group = primary.regionOf.get(node.id)?.group ?? '';
		const { cells, unresolved } = cellsForWorker(node, subAttribute, byId, view);
		for (const answerId of unresolved) {
			unresolvedAnswerIds.add(answerId);
			unresolvedWorkerIds.add(node.id);
		}
		pairsOf.set(node.id, dedupePairs(cells.map((cell): PairedCell => [group, cell.key])));
	}

	if (unresolvedAnswerIds.size > 0) {
		return {
			status: 'unavailable',
			attributeId: subAttribute.id,
			reason: {
				code: 'unresolved-answer',
				attributeId: primaryAttribute.id,
				subAttributeId: subAttribute.id,
				answerIds: [...unresolvedAnswerIds],
				workerIds: [...unresolvedWorkerIds]
			},
			pairs: pairsOf
		};
	}

	const ambiguous = new Map(
		[...pairsOf].filter(([, pairs]) => pairs.length !== 1) as [string, PairedCell[]][]
	);
	if (ambiguous.size > 0) {
		return {
			status: 'unavailable',
			attributeId: subAttribute.id,
			reason: {
				code: 'paired-regions-differ',
				attributeId: primaryAttribute.id,
				subAttributeId: subAttribute.id,
				workers: [...ambiguous].map(([workerId, pairs]) => ({ workerId, pairs }))
			},
			pairs: pairsOf
		};
	}

	const membersOf = new Map<string, string[]>();
	const counts = new Map<string, number>();
	const regionOf = new Map<string, string>();
	const regionCells = new Map<string, Cell>();

	for (const [workerId, pairs] of pairsOf) {
		const key = pairs[0][1];
		regionOf.set(workerId, key);
		const region =
			view.regionsByKey.get(key) ??
			(regionIdentity(key) === 'answer' ? exactAnswerRegion(subAttribute, view, key) : undefined);
		regionCells.set(key, region ? cellFromRegion(region) : cellFor(subAttribute, key));
		const members = membersOf.get(key);
		if (members) members.push(workerId);
		else membersOf.set(key, [workerId]);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	const regions = [...regionCells.values()]
		.sort(
			(first, second) =>
				regionOrder(subAttribute, view, first.key) - regionOrder(subAttribute, view, second.key) ||
				first.key.localeCompare(second.key)
		)
		.map((cell) => ({ ...cell, outlined: regionIdentity(cell.key) === 'answer' }));

	return {
		status: 'available',
		attributeId: subAttribute.id,
		regions,
		regionOf,
		membersOf,
		counts
	};
}
