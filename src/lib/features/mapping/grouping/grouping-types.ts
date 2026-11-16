/** The types of Mapping's Grouping reading: regions, cells, refusals, suggestions and layout input. */
import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import type { HierarchyRegion } from '#lib/shared/workers/answer-hierarchy.ts';
import type { RegionIdentity } from '#lib/shared/workers/region-identity.ts';
import type { PopulationFilters } from '#lib/shared/workers/worker-population.ts';
import type { WorkerGraphNode } from '../canvas/worker-relationship-map-model.ts';

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

export type Cell = Pick<DisplayedRegion, 'key' | 'identity' | 'label' | 'description'>;

export type RawReading =
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
 * The detail a Mapping reading shows. Ticket 22 keeps its shipped detail — a held answer
 * displays itself, and several matching answers collapse to their deepest shared ancestor
 * — and ticket 24 expands one displayed branch into the shared frontier's child regions
 * plus its exact remainder (`answer-hierarchy.ts`, ticket 19). A held answer below an
 * expanded branch reads as the direct child region that now includes it, and a held answer
 * that is itself expanded reads as that branch's remainder. Only the expanded branch's
 * regions come from the shared frontier; an answer outside every expanded branch keeps
 * ticket 22's exact-answer identity, which this ticket must not reinterpret.
 */
export type FrontierView = {
	/** The shared frontier's regions for the expanded branches: children and remainders. */
	regionsByKey: ReadonlyMap<string, HierarchyRegion>;
	/** Every answer that has children, so a displayed answer can offer expansion. */
	expandableIds: ReadonlySet<string>;
	expandedIds: ReadonlySet<string>;
	/** The displayed region order: exact answers, and each branch's children then remainder. */
	positions: ReadonlyMap<string, number>;
};

export type RawSubReading =
	| AvailableSubGrouping
	| {
			status: 'unavailable';
			attributeId: string;
			reason: PairedRefusal;
			pairs: Map<string, PairedCell[]>;
	  };

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
