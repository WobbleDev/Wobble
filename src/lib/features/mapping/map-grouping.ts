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
import type { AttributeAnswer, Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import {
	expandBranch,
	frontier,
	normalizeExpansion,
	parseRemainderIdentity,
	remainderIdentity,
	remainderReading,
	type HierarchyRegion
} from '#lib/shared/answer-hierarchy.ts';
import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
import { noValueReading } from '#lib/shared/no-value-reading.ts';
import {
	NO_VALUE_REGION,
	regionIdentity,
	type RegionIdentity
} from '#lib/shared/region-identity.ts';
import {
	heldAnswerIds,
	selectWorkerPopulation,
	type PopulationFilters
} from '#lib/shared/worker-population.ts';
import type { WorkerGraphNode } from './worker-relationship-map-model.ts';

export type DisplayedRegion = {
	/** The region's typed key: an answer id or a system identity. */
	key: string;
	identity: RegionIdentity;
	/** The reading shown beside the region, without its collision description. */
	label: string;
	/** The secondary text that separates a system reading from a matching real answer. */
	description: string | null;
	/** Whether the region gets its own outline; a system region never does. */
	outlined: boolean;
};

/**
 * One displayed Worker's single placed region. `subGroup` carries the paired
 * secondary region only while a Sub-grouping is available: an unavailable secondary
 * leaves the primary placement untouched.
 */
export type GroupingCell = { group: string; subGroup?: string };

/** A primary/secondary region pair read from one displayed Worker. */
export type PairedCell = [group: string, subGroup: string];

/** One filter that would make the Grouping available, or strictly reduce its ambiguity. */
export type NarrowingSuggestion = {
	attributeId: string;
	answerIds: string[];
	/** The suggestion selects the Attribute's no-value reading. */
	missing: boolean;
	/** How many otherwise ambiguous Workers the filter resolves. */
	resolves: number;
};

export type GroupingRefusal =
	| {
			code: 'multiple-regions';
			attributeId: string;
			workers: { workerId: string; keys: string[] }[];
	  }
	| {
			code: 'unresolved-answer';
			attributeId: string;
			answerIds: string[];
			workerIds: string[];
	  }
	| {
			/**
			 * An attempted branch expansion would put a displayed Worker in more than one
			 * resulting region, so it is refused and the coarser view stays. The active
			 * reading never carries this code: it is not a Free fallback, it is a rejected
			 * action that leaves state and address untouched.
			 */
			code: 'expansion-breaks-partition';
			attributeId: string;
			/** The branch the organizer asked to expand. */
			branchId: string;
			workers: { workerId: string; keys: string[] }[];
	  };

export type ExpansionRefusal = Extract<GroupingRefusal, { code: 'expansion-breaks-partition' }>;

/** One branch the detail control can open or close, named by the reading that owns it. */
export type ExpansionBranch = { answerId: string; label: string; expanded: boolean };

export type AvailableGrouping = {
	status: 'available';
	attributeId: string;
	/** The occupied regions, in frontier/configured order with system regions after. */
	regions: DisplayedRegion[];
	/** Each displayed Worker's one region. */
	regionOf: Map<string, GroupingCell>;
	/** The single source of membership for counts, the Map table and drilldowns. */
	membersOf: Map<string, string[]>;
	counts: Map<string, number>;
	/**
	 * The requested nested partition. When unavailable, the primary placement above
	 * stays exactly as it is and the map draws the primary regions without sub-groups.
	 */
	subGrouping?: SubGroupingReading;
};

export type UnavailableGrouping = {
	status: 'unavailable';
	attributeId: string;
	reason: GroupingRefusal;
	/** Each ambiguous Worker's attempted cells, in held order. */
	ambiguous: Map<string, GroupingCell[]>;
	/** The narrowing filters worth offering; empty unless guidance was asked for. */
	suggestions: NarrowingSuggestion[];
};

/** The second, nested partition inside the primary regions. */
export type AvailableSubGrouping = {
	status: 'available';
	/** The secondary Attribute these regions partition. */
	attributeId: string;
	/** The occupied secondary regions, in configured order with system regions after. */
	regions: DisplayedRegion[];
	/** Each displayed Worker's one secondary region. */
	regionOf: Map<string, string>;
	membersOf: Map<string, string[]>;
	counts: Map<string, number>;
};

export type PairedRefusal =
	| {
			code: 'paired-regions-differ';
			/** The primary Attribute the pairs sit inside. */
			attributeId: string;
			subAttributeId: string;
			/** Each Worker whose held answers produced more than one pair. */
			workers: { workerId: string; pairs: PairedCell[] }[];
	  }
	| {
			code: 'unresolved-answer';
			attributeId: string;
			subAttributeId: string;
			answerIds: string[];
			workerIds: string[];
	  };

/**
 * The paired Sub-grouping. Its unavailability never changes the primary Grouping:
 * the map keeps drawing the primary regions and simply draws no sub-groups.
 */
export type UnavailableSubGrouping = {
	status: 'unavailable';
	/** The secondary Attribute the pairing attempted. */
	attributeId: string;
	reason: PairedRefusal;
	/** Each Worker's deduplicated attempted pairs, for the explanation. */
	pairs: Map<string, PairedCell[]>;
	/** Narrowing filters that reduce the pairing ambiguity; empty unless asked for. */
	suggestions: NarrowingSuggestion[];
};

export type SubGroupingReading = AvailableSubGrouping | UnavailableSubGrouping;

export type GroupingReading = AvailableGrouping | UnavailableGrouping;

/** The detail a reading is taken at: expanded branches by identity, per question. */
export type GroupingOptions = {
	guidance?: boolean;
	subAttributeId?: string;
	/** The primary Attribute's expanded branch ids, normalized here (ticket 24). */
	expandedIds?: Iterable<string>;
	/** The secondary Attribute's expanded branch ids, normalized against its own Attribute. */
	expandedSubIds?: Iterable<string>;
};

/**
 * The result of one attempted expansion. Either the candidate detail was committed
 * by the caller, or the action is refused and the caller keeps the coarser reading.
 */
export type ExpansionAttempt =
	| { status: 'available'; expandedIds: string[]; reading: AvailableGrouping }
	| { status: 'refused'; reason: ExpansionRefusal };

export type GroupingInput = {
	/** The displayed Workers: the layout set, never the Isolate-drawn set. */
	nodes: readonly WorkerGraphNode[];
	/** Every Worker in the Worksite, so a narrowing candidate can be simulated. */
	workers: readonly Worker[];
	attributes: readonly WorkerAttributeDefinition[];
	/** The contextual population conditions currently selecting the layout set. */
	filters?: PopulationFilters;
};

type Cell = Pick<DisplayedRegion, 'key' | 'identity' | 'label' | 'description'>;

type RawReading =
	| {
			status: 'available';
			attributeId: string;
			regions: DisplayedRegion[];
			regionOf: Map<string, GroupingCell>;
			membersOf: Map<string, string[]>;
			counts: Map<string, number>;
	  }
	| {
			status: 'unavailable';
			attributeId: string;
			reason: GroupingRefusal;
			ambiguous: Map<string, GroupingCell[]>;
	  };

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

function cellFor(attribute: WorkerAttributeDefinition, key: string): Cell {
	return { key, identity: regionIdentity(key), ...regionReading(attribute, key) };
}

/** The reading of one frontier region, which already carries its own label and description. */
function cellFromRegion(region: HierarchyRegion): Cell {
	return {
		key: region.identity,
		identity: regionIdentity(region.identity),
		label: region.label,
		description: region.description
	};
}

/**
 * The detail a Mapping reading shows. Ticket 22 keeps its shipped detail — a held answer
 * displays itself, and several matching answers collapse to their deepest shared ancestor
 * — and ticket 24 expands one displayed branch into the shared frontier's child regions
 * plus its exact remainder (`answer-hierarchy.ts`, ticket 19). A held answer below an
 * expanded branch reads as the direct child region that now includes it, and a held answer
 * that is itself expanded reads as that branch's remainder. Only the expanded branch's
 * regions come from the shared frontier; an answer outside every expanded branch keeps
 * ticket 22's exact-answer identity, which this ticket must not reinterpret.
 */
type FrontierView = {
	/** The shared frontier's regions for the expanded branches: children and remainders. */
	regionsByKey: ReadonlyMap<string, HierarchyRegion>;
	/** Every answer that has children, so a displayed answer can offer expansion. */
	expandableIds: ReadonlySet<string>;
	expandedIds: ReadonlySet<string>;
	/** The displayed region order: exact answers, and each branch's children then remainder. */
	positions: ReadonlyMap<string, number>;
};

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

function frontierView(
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
function exactAnswerRegion(
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
function cellsForWorker(
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
function regionOrder(
	attribute: WorkerAttributeDefinition,
	view: FrontierView,
	key: string
): number {
	const identity = regionIdentity(key);
	if (identity === 'no-value') return -2;
	return view.positions.get(key) ?? attribute.answers.length;
}

function readCore(
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
function withCandidate(
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

function attributePosition(attributes: readonly WorkerAttributeDefinition[], id: string): number {
	const position = attributes.findIndex((attribute) => attribute.id === id);
	return position === -1 ? Number.MAX_SAFE_INTEGER : position;
}

function answerPosition(
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

type RawSubReading =
	| AvailableSubGrouping
	| {
			status: 'unavailable';
			attributeId: string;
			reason: PairedRefusal;
			pairs: Map<string, PairedCell[]>;
	  };

/**
 * Reads the paired Sub-grouping. Each displayed Worker has one primary region and one
 * secondary cell (or several held answers collapsed to one); a Worker whose secondary
 * answers occupy several displayed regions has no single pair, so the pairing is
 * refused rather than choosing one. Identical pairs collapse before the one-pair-per-
 * Worker rule decides availability, and a child in two secondary regions still leaves
 * one dot: the primary Grouping is untouched.
 */
function readSubCore(
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

/** The filter candidates worth offering beside a refusal, ranked and capped at three. */
function narrowingSuggestions(
	input: GroupingInput,
	ambiguous: ReadonlyMap<string, readonly string[]>,
	stillAmbiguous: (narrowed: GroupingInput) => ReadonlySet<string>
): NarrowingSuggestion[] {
	const candidates = new Map<string, { attributeId: string; answerId: string; missing: boolean }>();
	const add = (candidate: { attributeId: string; answerId: string; missing: boolean }) => {
		const key = `${candidate.attributeId}\u0001${candidate.missing ? 'missing' : 'answer'}\u0001${candidate.answerId}`;
		if (!candidates.has(key)) candidates.set(key, candidate);
	};

	// A narrowing condition can only name an answer a displayed Worker holds, or an
	// Attribute it holds no answer to: the shared projection keeps the Workers whose
	// reading still says so.
	for (const workerId of ambiguous.keys()) {
		const node = input.nodes.find(({ id }) => id === workerId);
		if (!node) continue;
		for (const attribute of input.attributes) {
			const held = heldAnswerIds(node, attribute);
			if (held.length === 0) {
				add({ attributeId: attribute.id, answerId: '', missing: true });
				continue;
			}
			for (const answerId of held) {
				if (!attribute.answers.some((answer) => answer.id === answerId)) continue;
				add({ attributeId: attribute.id, answerId, missing: false });
			}
		}
	}

	const displayed = new Set(input.nodes.map(({ id }) => id));
	const suggestions: NarrowingSuggestion[] = [];

	for (const candidate of candidates.values()) {
		const projection = selectWorkerPopulation(
			input.workers,
			input.attributes,
			withCandidate(input.filters, candidate)
		);
		const layoutIds = new Set(
			projection.workers.map(({ id }) => id).filter((id) => displayed.has(id))
		);
		const narrowed = { ...input, nodes: input.nodes.filter(({ id }) => layoutIds.has(id)) };
		const still = stillAmbiguous(narrowed);
		const resolves = [...ambiguous.keys()].filter((id) => !still.has(id)).length;
		if (resolves === 0) continue;
		suggestions.push({
			attributeId: candidate.attributeId,
			answerIds: [candidate.answerId],
			missing: candidate.missing,
			resolves
		});
	}

	return suggestions
		.sort(
			(first, second) =>
				second.resolves - first.resolves ||
				attributePosition(input.attributes, first.attributeId) -
					attributePosition(input.attributes, second.attributeId) ||
				answerPosition(input.attributes, first) - answerPosition(input.attributes, second) ||
				first.answerIds[0].localeCompare(second.answerIds[0])
		)
		.slice(0, 3);
}

/** The filters that would let the primary Grouping place the ambiguous Workers. */
function groupingSuggestions(
	input: GroupingInput,
	attributeId: string,
	ambiguous: ReadonlyMap<string, GroupingCell[]>,
	expandedIds: Iterable<string>
): NarrowingSuggestion[] {
	return narrowingSuggestions(
		input,
		new Map([...ambiguous].map(([workerId, cells]) => [workerId, cells.map(({ group }) => group)])),
		(narrowed) => {
			const reading = readCore(narrowed, attributeId, expandedIds);
			return reading.status === 'available' ? new Set() : new Set(reading.ambiguous.keys());
		}
	);
}

/** The filters that would let the paired Sub-grouping place the ambiguous Workers. */
function subGroupingSuggestions(
	input: GroupingInput,
	primaryAttributeId: string,
	subAttributeId: string,
	pairs: ReadonlyMap<string, PairedCell[]>,
	expandedIds: Iterable<string>,
	expandedSubIds: Iterable<string>
): NarrowingSuggestion[] {
	// Only a Worker with more than one pair is ambiguous; the rest need no guidance.
	const ambiguous = new Map([...pairs].filter(([, entries]) => entries.length !== 1));
	return narrowingSuggestions(
		input,
		new Map([...ambiguous].map(([workerId, entries]) => [workerId, entries.map(([, sub]) => sub)])),
		(narrowed) => {
			const reading = readCore(narrowed, primaryAttributeId, expandedIds);
			if (reading.status !== 'available') return new Set(ambiguous.keys());
			const sub = readSubCore(
				narrowed,
				reading,
				primaryAttributeId,
				subAttributeId,
				expandedSubIds
			);
			if (sub.status === 'available') return new Set();
			return sub.reason.code === 'paired-regions-differ'
				? new Set(sub.reason.workers.map(({ workerId }) => workerId))
				: new Set(sub.reason.workerIds);
		}
	);
}

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

export type ProjectedLayout = {
	nodes: WorkerGraphNode[];
	/** The view-only synthetic definition whose answers are the displayed regions. */
	groupingAttribute: WorkerAttributeDefinition;
	/**
	 * The synthetic secondary definition, present only while the paired Sub-grouping is
	 * available. Without it the solver draws the primary regions and no sub-groups.
	 */
	subGroupingAttribute?: WorkerAttributeDefinition;
};

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
