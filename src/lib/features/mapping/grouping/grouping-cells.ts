/**
 * How a displayed Worker becomes a Grouping cell: the frontier of displayed regions, each
 * answer's region, and the collapse of several held answers to their deepest shared ancestor.
 */
import type { AttributeAnswer, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import {
	frontier,
	normalizeExpansion,
	parseRemainderIdentity,
	remainderIdentity,
	remainderReading,
	type HierarchyRegion
} from '#lib/shared/workers/answer-hierarchy.ts';
import { answerDisplayLabel } from '#lib/shared/workers/answer-path.ts';
import { noValueReading } from '#lib/shared/text/no-value-reading.ts';
import { NO_VALUE_REGION, regionIdentity } from '#lib/shared/workers/region-identity.ts';
import { heldAnswerIds } from '#lib/shared/workers/worker-population.ts';
import type { WorkerGraphNode } from '../canvas/worker-relationship-map-model.ts';
import type { Cell, FrontierView } from './grouping-types.ts';

/**
 * Reads the region a key shows: a configured answer, No plus the Attribute's name for a
 * Worker's no answer, or the exact direct-parent remainder. A real answer whose text
 * matches the system no-answer reading keeps its own label and only the system region
 * gains the explanatory description.
 */
export function regionReading(
	attribute: WorkerAttributeDefinition,
	key: string
): { label: string; description: string | null } {
	const identity = regionIdentity(key);

	if (identity === 'no-value') return noValueReading(attribute);
	if (identity === 'answer') {
		return { label: answerDisplayLabel(attribute.answers, key), description: null };
	}
	// A remainder is the exact direct-parent reading: the parent's current label and the
	// shared further-detail-unknown wording, never a re-derived branch meaning (ticket 19).
	const remainder = parseRemainderIdentity(key);
	const answerId = remainder?.attributeId === attribute.id ? remainder.answerId : '';
	return answerId ? remainderReading(attribute, answerId) : { label: key, description: null };
}

export function cellFor(attribute: WorkerAttributeDefinition, key: string): Cell {
	return { key, identity: regionIdentity(key), ...regionReading(attribute, key) };
}

/** The reading of one frontier region, which already carries its own label and description. */
export function cellFromRegion(region: HierarchyRegion): Cell {
	return {
		key: region.identity,
		identity: regionIdentity(region.identity),
		label: region.label,
		description: region.description
	};
}

function childrenByParent(attribute: WorkerAttributeDefinition): Map<string, AttributeAnswer[]> {
	const children = new Map<string, AttributeAnswer[]>();
	for (const answer of attribute.answers) {
		if (!answer.parentId) continue;
		const siblings = children.get(answer.parentId);
		if (siblings) siblings.push(answer);
		else children.set(answer.parentId, [answer]);
	}
	return children;
}

/** Whether a strict ancestor is expanded; used to reach an answer through its branch once. */
function hasExpandedAncestor(
	byId: ReadonlyMap<string, AttributeAnswer>,
	expanded: ReadonlySet<string>,
	answerId: string
): boolean {
	const self = byId.get(answerId);
	let current = self?.parentId ? byId.get(self.parentId) : undefined;
	let guard = 0;
	while (current) {
		guard += 1;
		if (guard > byId.size) return true; // a decoded cycle is untrusted data
		if (expanded.has(current.id)) return true;
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return false;
}

/** Whether the answer or one of its ancestors is expanded, so it is not a flat region. */
function hasExpandedAncestorOrSelf(
	byId: ReadonlyMap<string, AttributeAnswer>,
	expanded: ReadonlySet<string>,
	answerId: string
): boolean {
	let current = byId.get(answerId);
	let guard = 0;
	while (current) {
		guard += 1;
		if (guard > byId.size) return true;
		if (expanded.has(current.id)) return true;
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return false;
}

/**
 * The order Mapping's detail lists regions in: unexpanded answers in configured order,
 * and an expanded branch's children pre-order followed by its exact remainder. Only
 * detail roots start a walk, so an answer inside an expanded branch appears once.
 */
function displayedRegionPositions(
	attribute: WorkerAttributeDefinition,
	byId: ReadonlyMap<string, AttributeAnswer>,
	expanded: ReadonlySet<string>
): Map<string, number> {
	const children = childrenByParent(attribute);
	const keys: string[] = [];

	function emit(answer: AttributeAnswer): void {
		const kids = children.get(answer.id) ?? [];
		if (kids.length > 0 && expanded.has(answer.id)) {
			for (const child of kids) emit(child);
			keys.push(remainderIdentity(attribute.id, answer.id));
			return;
		}
		keys.push(answer.id);
	}

	for (const answer of attribute.answers) {
		if (hasExpandedAncestor(byId, expanded, answer.id)) continue;
		emit(answer);
	}
	return new Map(keys.map((key, index) => [key, index]));
}

export function frontierView(
	attribute: WorkerAttributeDefinition,
	expandedIds: Iterable<string>
): FrontierView {
	const expanded = normalizeExpansion(attribute, expandedIds);
	const byId = new Map(attribute.answers.map((answer) => [answer.id, answer]));
	const hierarchy = frontier(attribute, expanded);
	return {
		regionsByKey: new Map(hierarchy.regions.map((region) => [region.identity, region])),
		expandableIds: hierarchy.expandable,
		expandedIds: new Set(expanded),
		positions: displayedRegionPositions(attribute, byId, new Set(expanded))
	};
}

/** The exact-answer region ticket 22 displays for a held answer outside any expansion. */
export function exactAnswerRegion(
	attribute: WorkerAttributeDefinition,
	view: FrontierView,
	answerId: string
): HierarchyRegion {
	return {
		identity: answerId,
		answerId,
		kind: 'answer',
		label: answerDisplayLabel(attribute.answers, answerId),
		description: null,
		depth: 0,
		expandable: view.expandableIds.has(answerId),
		expanded: false
	};
}

/**
 * The displayed region of one held answer. A held answer is expanded itself → the
 * shared frontier's exact remainder for that branch; a descendant of an expanded branch
 * → the direct child region that includes it; anything else → itself.
 */
function detailRegion(
	attribute: WorkerAttributeDefinition,
	view: FrontierView,
	byId: ReadonlyMap<string, AttributeAnswer>,
	heldId: string
): HierarchyRegion | undefined {
	if (!byId.has(heldId)) return undefined;
	let walk = byId.get(heldId);
	let child: AttributeAnswer | undefined;
	let guard = 0;
	while (walk && guard <= attribute.answers.length) {
		guard += 1;
		if (view.expandedIds.has(walk.id)) {
			if (!child) {
				return view.regionsByKey.get(remainderIdentity(attribute.id, walk.id));
			}
			return view.regionsByKey.get(child.id) ?? exactAnswerRegion(attribute, view, child.id);
		}
		child = walk;
		walk = walk.parentId ? byId.get(walk.parentId) : undefined;
	}
	return exactAnswerRegion(attribute, view, heldId);
}

/** The root-to-answer path, or undefined when an ancestor is gone or the data cycles. */
function answerPath(
	byId: ReadonlyMap<string, AttributeAnswer>,
	answerId: string
): AttributeAnswer[] | undefined {
	const path: AttributeAnswer[] = [];
	const seen = new Set<string>();
	let current = byId.get(answerId);
	while (current) {
		if (seen.has(current.id)) return undefined;
		seen.add(current.id);
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path.length > 0 ? path : undefined;
}

/** The deepest answer shared by every id, or undefined when they sit under different roots. */
function lowestCommonAncestor(
	byId: ReadonlyMap<string, AttributeAnswer>,
	answerIds: readonly string[]
): string | undefined {
	const paths = answerIds.map((id) => answerPath(byId, id));
	if (paths.some((path) => path === undefined)) return undefined;
	const [first, ...rest] = paths as AttributeAnswer[][];
	let depth = 0;
	while (depth < first.length && rest.every((path) => path[depth]?.id === first[depth].id)) {
		depth += 1;
	}
	return depth > 0 ? first[depth - 1].id : undefined;
}

/**
 * Ticket 22's collapse, kept at the new detail: several held answers under one displayed
 * ancestor still form one region, but an expanded ancestor is no longer displayed, so the
 * same facts become several regions (which the expansion is refused for).
 */
function collapseAnswerCells(
	attribute: WorkerAttributeDefinition,
	view: FrontierView,
	byId: ReadonlyMap<string, AttributeAnswer>,
	cells: readonly Cell[]
): Cell[] {
	if (cells.length <= 1) return [...cells];
	if (cells.some((cell) => cell.identity !== 'answer')) return [...cells];
	const shared = lowestCommonAncestor(
		byId,
		cells.map((cell) => cell.key)
	);
	if (!shared) return [...cells];
	if (hasExpandedAncestorOrSelf(byId, view.expandedIds, shared)) return [...cells];
	return [cellFromRegion(exactAnswerRegion(attribute, view, shared))];
}

/**
 * One displayed Worker's cells for an Attribute, read from the answers it holds. A
 * Worker holding no answer has the Attribute's one no-value region; several held
 * answers inside one displayed region stay one cell, and several regions make the
 * Worker ambiguous rather than choosing a first answer.
 */
export function cellsForWorker(
	node: WorkerGraphNode,
	attribute: WorkerAttributeDefinition,
	byId: ReadonlyMap<string, AttributeAnswer>,
	view: FrontierView
): { cells: Cell[]; unresolved: string[] } {
	const ids = heldAnswerIds(node, attribute).filter((id) => id !== '');
	if (ids.length === 0) return { cells: [cellFor(attribute, NO_VALUE_REGION)], unresolved: [] };

	const cells: Cell[] = [];
	const unresolved: string[] = [];
	for (const held of ids) {
		if (!byId.has(held)) {
			unresolved.push(held);
			continue;
		}
		const region = detailRegion(attribute, view, byId, held);
		if (!region) {
			unresolved.push(held);
			continue;
		}
		// One displayed region is one cell: several held answers inside the same
		// unexpanded region do not make the Worker ambiguous.
		addCell(cells, cellFromRegion(region));
	}

	return { cells: collapseAnswerCells(attribute, view, byId, cells), unresolved };
}

/** Adds a cell unless that region is already the Worker's cell: one region is one cell. */
function addCell(cells: Cell[], cell: Cell): void {
	if (!cells.some(({ key }) => key === cell.key)) cells.push(cell);
}

/**
 * The order regions are listed and seeded in: no-value first, then the frontier's own
 * pre-order (children before their branch's remainder), then any other configured answer.
 */
export function regionOrder(
	attribute: WorkerAttributeDefinition,
	view: FrontierView,
	key: string
): number {
	const identity = regionIdentity(key);
	if (identity === 'no-value') return -2;
	return view.positions.get(key) ?? attribute.answers.length;
}
