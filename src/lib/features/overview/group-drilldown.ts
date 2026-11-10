/**
 * From an Overview row to the Workers reading it opens (spec: Filtering, hierarchy,
 * and readings). A drilldown keeps the current population conditions and narrows this
 * Attribute's own condition to the displayed row, so an earlier OR selection on the
 * same Attribute cannot broaden the cohort.
 *
 * The row predicate is intersected with the active same-Attribute condition rather
 * than replacing it. Two regions of one hierarchy are nested or disjoint, so:
 * - a row that contains the active condition (a parent region above a descendant
 *   filter) keeps the active condition and never widens;
 * - a row inside the active condition is already the narrower predicate;
 * - a row disjoint from the active condition opens nobody, never the broader row.
 *
 * The direct-parent remainder is an exact-parent predicate, not the parent's subtree:
 * a Worker holding Store A beneath Central is in Central's broad row, but Central's
 * further-detail-unknown remainder opens Casey (who holds Central itself) only.
 */
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import type { WorkerFilters } from '#lib/shared/worker-filters.ts';
import { answerIsInSubtree } from '#lib/shared/worker-population.ts';
import type { GroupReading } from './support-summary.ts';

/** The same filters with every collection mutable, so one condition can be replaced. */
export type MutableWorkerFilters = {
	answers: Map<string, string[]>;
	missing: Set<string>;
	exactAnswers: Map<string, string[]>;
	columns: Map<string, string[]>;
	agitations: Set<string>;
};

function copyMap(
	source: ReadonlyMap<string, readonly string[]> | undefined
): Map<string, string[]> {
	return new Map([...(source ?? [])].map(([id, values]) => [id, [...values]]));
}

/** A copy of the current filters that one row's predicate can be written into. */
export function cloneWorkerFilters(source: WorkerFilters): MutableWorkerFilters {
	return {
		answers: copyMap(source.answers),
		missing: new Set(source.missing),
		exactAnswers: copyMap(source.exactAnswers),
		columns: copyMap(source.columns),
		agitations: new Set(source.agitations)
	};
}

function clearAttribute(next: MutableWorkerFilters, attributeId: string): void {
	next.answers.delete(attributeId);
	next.missing.delete(attributeId);
	next.exactAnswers.delete(attributeId);
}

/**
 * The identity of one displayed group: enough to write its exact predicate, and
 * shared by the Support rows and the Agitations headings so both drill the same
 * cohort.
 */
export type GroupPredicate = Pick<
	GroupReading,
	'attributeId' | 'answerId' | 'noValue' | 'remainder'
>;

/** One Attribute's active condition, in the shape the shared population reads it. */
type AttributeConditions = {
	/** Ordinary selected answers: each stands for its subtree. */
	ordinary: string[];
	/** Direct-parent remainder answers: each stands for itself only. */
	exact: string[];
	/** The no-answer reading: No plus the Attribute's current name. */
	missing: boolean;
};

/** One row's predicate after intersecting it with the active condition. */
type RowPredicate = AttributeConditions;

function readActiveConditions(
	filters: MutableWorkerFilters,
	attributeId: string
): AttributeConditions {
	return {
		ordinary: [...(filters.answers.get(attributeId) ?? [])],
		exact: [...(filters.exactAnswers.get(attributeId) ?? [])],
		missing: filters.missing.has(attributeId)
	};
}

function hasCondition(conditions: AttributeConditions): boolean {
	return conditions.ordinary.length > 0 || conditions.exact.length > 0 || conditions.missing;
}

/**
 * The condition the shared population projection really applies. Selected answers
 * and the no-answer reading are alternatives within one Attribute, while an exact
 * remainder is its own conjunctive predicate: where both appear, only the
 * remainders the selected answers still admit survive, and a no-answer reading
 * beside a remainder admits nobody.
 */
function appliedCondition(
	attribute: WorkerAttributeDefinition,
	active: AttributeConditions
): AttributeConditions | undefined {
	if (active.exact.length === 0) return active;
	if (active.ordinary.length === 0) {
		return active.missing ? undefined : { ordinary: [], exact: [...active.exact], missing: false };
	}
	const exact = active.exact.filter((answerId) =>
		active.ordinary.some((selected) => answerIsInSubtree(attribute.answers, selected, answerId))
	);
	if (exact.length === 0) return undefined;
	return { ordinary: [], exact, missing: false };
}

/**
 * The row's region intersected with the active condition: a narrower answer list, an
 * exact list, the no-answer reading, or a disjoint (empty) cohort.
 */
function intersectRow(
	attribute: WorkerAttributeDefinition,
	active: AttributeConditions,
	reading: GroupPredicate
): RowPredicate | 'empty' {
	if (reading.noValue) {
		return active.missing ? { ordinary: [], exact: [], missing: true } : 'empty';
	}
	const rowId = reading.answerId;
	if (reading.remainder) {
		// The remainder is the exact answer: only an active region that already admits
		// that answer can intersect it.
		const admitted =
			active.exact.includes(rowId) ||
			active.ordinary.some((answerId) => answerIsInSubtree(attribute.answers, answerId, rowId));
		return admitted ? { ordinary: [], exact: [rowId], missing: false } : 'empty';
	}
	// The row region contains the active condition: the row is the narrower predicate,
	// so keep the row instead of widening to the active selection.
	if (active.ordinary.some((answerId) => answerIsInSubtree(attribute.answers, answerId, rowId))) {
		return { ordinary: [rowId], exact: [], missing: false };
	}
	const ordinary = active.ordinary.filter((answerId) =>
		answerIsInSubtree(attribute.answers, rowId, answerId)
	);
	const exact = active.exact.filter((answerId) =>
		answerIsInSubtree(attribute.answers, rowId, answerId)
	);
	if (ordinary.length === 0 && exact.length === 0) return 'empty';
	return { ordinary, exact, missing: false };
}

/** Writes one Attribute's narrowed conditions, leaving every other one intact. */
function setConditions(next: MutableWorkerFilters, attributeId: string, row: RowPredicate): void {
	clearAttribute(next, attributeId);
	if (row.ordinary.length > 0) next.answers.set(attributeId, row.ordinary);
	if (row.exact.length > 0) next.exactAnswers.set(attributeId, row.exact);
	if (row.missing) next.missing.add(attributeId);
}

/**
 * A cohort no Worker can satisfy. Naming an exact remainder and the no-answer
 * reading of the same Attribute is an impossible conjunction in the shared
 * projection, and both are real identities of this Attribute, so a reloaded
 * address cannot drop one and fall back to the row's broader region. A holder of
 * either cardinality cannot both hold an answer and hold none, so the two readings
 * cannot both be satisfied.
 */
function setEmptyCohort(
	next: MutableWorkerFilters,
	attributeId: string,
	reading: GroupPredicate,
	attribute: WorkerAttributeDefinition | undefined,
	active: AttributeConditions
): void {
	clearAttribute(next, attributeId);
	const answerId =
		reading.answerId || active.ordinary[0] || active.exact[0] || attribute?.answers[0]?.id || '';
	if (!answerId) return;
	next.exactAnswers.set(attributeId, [answerId]);
	next.missing.add(attributeId);
}

/** The row's own predicate, used when this Attribute has no active condition. */
function replaceWithRow(next: MutableWorkerFilters, reading: GroupPredicate): void {
	const attributeId = reading.attributeId;
	clearAttribute(next, attributeId);

	if (reading.noValue) {
		next.missing.add(attributeId);
		return;
	}

	if (reading.remainder) {
		next.exactAnswers.set(attributeId, [reading.answerId]);
		return;
	}

	next.answers.set(attributeId, [reading.answerId]);
}

/**
 * The filters one row opens in Workers: the current conditions stay, and this
 * Attribute's own condition is narrowed to the displayed row. A row that contains
 * the active condition keeps it, a narrower row replaces it, and a disjoint row opens
 * nobody.
 */
export function groupDrilldownFilters(
	filters: WorkerFilters,
	attribute: WorkerAttributeDefinition | undefined,
	reading: GroupPredicate
): MutableWorkerFilters {
	const next = cloneWorkerFilters(filters);
	const attributeId = reading.attributeId;
	const active = readActiveConditions(next, attributeId);

	if (!attribute || !hasCondition(active)) {
		replaceWithRow(next, reading);
		return next;
	}

	const applied = appliedCondition(attribute, active);
	const row = applied ? intersectRow(attribute, applied, reading) : 'empty';
	if (row === 'empty') {
		setEmptyCohort(next, attributeId, reading, attribute, active);
		return next;
	}
	setConditions(next, attributeId, row);
	return next;
}

/**
 * The filters one Agitation row opens: the current context stays, the group's own
 * Attribute is narrowed to the displayed group's exact predicate (the same rule as
 * a Support row, so a remainder or system group cannot reopen an unrelated
 * cohort), and the row's Agitation is the only Agitation selected.
 */
export function agitationDrilldownFilters(
	filters: WorkerFilters,
	attribute: WorkerAttributeDefinition | undefined,
	group: GroupPredicate | undefined,
	agitationId: string
): MutableWorkerFilters {
	const next =
		group && attribute
			? groupDrilldownFilters(filters, attribute, group)
			: cloneWorkerFilters(filters);
	next.agitations = new Set([agitationId]);
	return next;
}
