/**
 * The contextual filter selection Workers, Overview and Mapping share (spec: Filtering,
 * hierarchy, and readings): how the address carries answer and no-answer conditions, and
 * what those conditions mean for the shared population projection.
 *
 * The address names Attributes and answers by id, so a rename never changes a reading.
 * A stale id — an Attribute, answer or no-answer reading the Worksite no longer
 * configures — is dropped here, so a restored link never reads a condition the current
 * vocabulary cannot express.
 */
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { parseRemainderIdentity, remainderIdentity } from '#lib/shared/answer-hierarchy.ts';
import { parseColonPair } from '#lib/shared/colon-pair.ts';
import type { PopulationFilters } from '#lib/shared/worker-population.ts';

/**
 * The filters that select a population, in the address's own serializable shape so a
 * restored view can hold them before they become predicates.
 */
export type ContextualFilters = {
	/** Answer ids, OR within one Attribute. */
	answers: Record<string, string[]>;
	/** No-answer readings: No plus the Attribute's current name. */
	missing: string[];
	/**
	 * Direct-parent remainder readings: the Worker holds exactly this answer, not a
	 * descendant. It is the exact remainder, never a subtree.
	 */
	exactAnswers?: Record<string, string[]>;
};

/** An `f` entry that names no configured answer, which the caller reads for itself. */
export type UnmatchedFilterEntry = { id: string; value: string };

export type ParsedContextualFilters = {
	filters: ContextualFilters;
	/** Entries that name no Attribute answer, such as the Workers table's own columns. */
	other: UnmatchedFilterEntry[];
};

/** No conditions: every Worker is in the population. */
export function emptyContextualFilters(): ContextualFilters {
	return {
		answers: {},
		missing: []
	};
}

/** The same filters, copied so a snapshot or an Undo owns its own values. */
export function copyContextualFilters(filters: ContextualFilters): ContextualFilters {
	return {
		answers: Object.fromEntries(
			Object.entries(filters.answers).map(([id, values]) => [id, [...values]])
		),
		missing: [...filters.missing],
		...(filters.exactAnswers
			? {
					exactAnswers: Object.fromEntries(
						Object.entries(filters.exactAnswers).map(([id, values]) => [id, [...values]])
					)
				}
			: {})
	};
}

/** Whether any condition is active. */
export function hasContextualFilters(filters: ContextualFilters): boolean {
	return (
		Object.values(filters.answers).some((values) => values.length > 0) ||
		filters.missing.length > 0 ||
		Object.values(filters.exactAnswers ?? {}).some((values) => values.length > 0)
	);
}

/** The answer ids each Attribute offers, for validating a restored link by identity. */
export function knownAnswerIds(
	attributes: readonly WorkerAttributeDefinition[]
): ReadonlyMap<string, ReadonlySet<string>> {
	return new Map(
		attributes.map((attribute) => [
			attribute.id,
			new Set(attribute.answers.map((answer) => answer.id))
		])
	);
}

function addToRecord(record: Record<string, string[]>, id: string, value: string): void {
	record[id] = [...(record[id] ?? []), value];
}

/**
 * Reads the `f` and `missing` parameters against the current vocabulary. Unknown
 * Attributes, answers and readings are dropped; a retired `assignments` parameter is not
 * read at all, so an old link normalizes to ordinary no-selection semantics.
 */
export function parseContextualFilters(
	searchParams: URLSearchParams,
	attributes: readonly WorkerAttributeDefinition[] = []
): ParsedContextualFilters {
	const byId = new Map(attributes.map((attribute) => [attribute.id, attribute]));
	const knownAnswers = knownAnswerIds(attributes);
	const filters = emptyContextualFilters();
	const other: UnmatchedFilterEntry[] = [];
	const missing = new Set<string>();
	const exactAnswers: Record<string, string[]> = {};

	for (const raw of searchParams.getAll('f')) {
		const pair = parseColonPair(raw);
		if (!pair) continue;

		const offered = knownAnswers.get(pair.id);
		// A remainder is a system identity, never an answer id: it must name the same
		// Attribute it is scoped to and an answer that Attribute still configures.
		const remainder = parseRemainderIdentity(pair.value);
		if (remainder && remainder.attributeId === pair.id) {
			if (!offered?.has(remainder.answerId)) continue;
			addToRecord(exactAnswers, pair.id, remainder.answerId);
			continue;
		}

		if (!offered) {
			other.push(pair);
			continue;
		}
		if (!offered.has(pair.value)) continue;

		addToRecord(filters.answers, pair.id, pair.value);
	}

	// A missing-value link works for either cardinality: the current Attribute name
	// supplies the reading's label.
	for (const raw of searchParams.getAll('missing')) {
		if (!raw) continue;
		if (!byId.has(raw)) continue;
		missing.add(raw);
	}

	filters.missing = [...missing];
	if (Object.keys(exactAnswers).length > 0) filters.exactAnswers = exactAnswers;
	return { filters, other };
}

/** Writes the contextual conditions into an address, in the order they were read. */
export function writeContextualFilters(
	searchParams: URLSearchParams,
	filters: ContextualFilters
): URLSearchParams {
	for (const [id, values] of Object.entries(filters.answers)) {
		for (const value of values) searchParams.append('f', `${id}:${value}`);
	}
	for (const [id, values] of Object.entries(filters.exactAnswers ?? {})) {
		for (const value of values) {
			searchParams.append('f', `${id}:${remainderIdentity(id, value)}`);
		}
	}
	for (const id of filters.missing) searchParams.append('missing', id);
	return searchParams;
}

/**
 * The shared predicates for a selection: answers are tested on the Worker, and both
 * no-answer readings travel as system identities. This projection is the one Workers,
 * Overview and Mapping all use.
 */
export function toPopulationFilters(filters: ContextualFilters): PopulationFilters {
	const answers = new Map(
		Object.entries(filters.answers).filter(([, values]) => values.length > 0)
	);
	return {
		answers,
		...(filters.exactAnswers && Object.keys(filters.exactAnswers).length > 0
			? { exactAnswers: new Map(Object.entries(filters.exactAnswers)) }
			: {}),
		missing: new Set(filters.missing)
	};
}

/** Toggles one answer in an Attribute's alternatives, leaving its no-answer reading alone. */
export function toggleContextAnswer(
	filters: ContextualFilters,
	attributeId: string,
	answerId: string,
	checked: boolean
): ContextualFilters {
	const next = copyContextualFilters(filters);
	const selected = new Set(next.answers[attributeId] ?? []);
	if (checked) selected.add(answerId);
	else selected.delete(answerId);
	if (selected.size > 0) next.answers[attributeId] = [...selected];
	else delete next.answers[attributeId];
	return next;
}

/** Toggles an Attribute's no-answer reading beside its answers. */
export function toggleContextMissing(
	filters: ContextualFilters,
	attributeId: string,
	checked: boolean
): ContextualFilters {
	const next = copyContextualFilters(filters);
	const missing = new Set(next.missing);
	if (checked) missing.add(attributeId);
	else missing.delete(attributeId);
	next.missing = [...missing];
	return next;
}

/** Removes one selected answer, normal or exact, keeping the rest. */
export function withoutContextAnswer(
	filters: ContextualFilters,
	attributeId: string,
	answerId: string
): ContextualFilters {
	const next = copyContextualFilters(filters);
	for (const record of [next.answers, next.exactAnswers]) {
		if (!record) continue;
		const remaining = (record[attributeId] ?? []).filter((id) => id !== answerId);
		if (remaining.length > 0) record[attributeId] = remaining;
		else delete record[attributeId];
	}
	return next;
}

/** Removes one Attribute's no-answer reading, keeping the rest. */
export function withoutContextMissing(
	filters: ContextualFilters,
	attributeId: string
): ContextualFilters {
	const next = copyContextualFilters(filters);
	next.missing = next.missing.filter((id) => id !== attributeId);
	return next;
}
