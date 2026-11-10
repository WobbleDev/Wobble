/**
 * The Workers view's explicit filters: how the address encodes them, and what they
 * mean for one Worker.
 */
import type { Agitation, Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { workerMatchesAnswerFilter } from '#lib/shared/worker-population.ts';
import {
	knownAnswerIds,
	parseContextualFilters,
	writeContextualFilters
} from '#lib/shared/contextual-filters.ts';
import { NO_SELECTION_CHOICE } from '#lib/shared/no-value-reading.ts';
import { heldIdsOf } from '#lib/shared/select-mode.ts';

export { NO_SELECTION_CHOICE };

export type AnswerFilterValue = {
	answers: string[];
	missing: boolean;
	/** Direct-parent remainder ids: the exact answer, not its subtree. */
	exact?: string[];
};

export type WorkerFilters = {
	answers: ReadonlyMap<string, readonly string[]>;
	/** No-answer readings: No plus the Attribute's current name. */
	missing: ReadonlySet<string>;
	/**
	 * Direct-parent remainder readings: the Worker holds exactly this answer, not a
	 * descendant. The address carries the same system identity as Overview's remainder.
	 */
	exactAnswers?: ReadonlyMap<string, readonly string[]>;
	columns: ReadonlyMap<string, readonly string[]>;
	/** Selected Agitation ids: their own facet, independent of the visible columns. */
	agitations: ReadonlySet<string>;
};

export type ColumnFilterEntry = { id: string; value: unknown };

/** The answer ids each Attribute offers; the shared parser validates a link with it. */
export { knownAnswerIds };

export function parseWorkerFilters(
	searchParams: URLSearchParams,
	attributes: readonly WorkerAttributeDefinition[] = [],
	agitations: readonly Agitation[] = []
): WorkerFilters {
	// The shared parser validates the contextual conditions by identity; an entry that
	// names no answer is a table column here.
	const { filters, other } = parseContextualFilters(searchParams, attributes);
	const columns = new Map<string, string[]>();
	for (const entry of other) {
		columns.set(entry.id, [...(columns.get(entry.id) ?? []), entry.value]);
	}

	const knownAgitations = new Set(agitations.map((agitation) => agitation.id));
	const selectedAgitations = new Set<string>();
	for (const raw of searchParams.getAll('agitation')) {
		if (!knownAgitations.has(raw)) continue;
		selectedAgitations.add(raw);
	}

	const exactAnswers = new Map(Object.entries(filters.exactAnswers ?? {}));
	return {
		answers: new Map(Object.entries(filters.answers)),
		missing: new Set(filters.missing),
		...(exactAnswers.size > 0 ? { exactAnswers } : {}),
		columns,
		agitations: selectedAgitations
	};
}

export function writeWorkerFilters(
	searchParams: URLSearchParams,
	filters: WorkerFilters
): URLSearchParams {
	searchParams.delete('f');
	searchParams.delete('missing');
	searchParams.delete('agitation');
	// The retired zero-assignments predicate is dropped rather than round-tripped, so an
	// old link normalizes to ordinary no-selection semantics.
	searchParams.delete('assignments');

	// The contextual conditions travel in the shared encoding, so Mapping reads the same
	// address into the same population; the Workers-only columns and Agitations follow.
	writeContextualFilters(searchParams, {
		answers: Object.fromEntries(
			[...filters.answers].map(([id, values]) => [id, [...values]] as const)
		),
		missing: [...filters.missing],
		...(filters.exactAnswers && filters.exactAnswers.size > 0
			? {
					exactAnswers: Object.fromEntries(
						[...filters.exactAnswers].map(([id, values]) => [id, [...values]] as const)
					)
				}
			: {})
	});
	for (const [id, values] of filters.columns) {
		for (const value of values) searchParams.append('f', id + ':' + value);
	}
	for (const id of filters.agitations) searchParams.append('agitation', id);

	return searchParams;
}

export function toColumnFilters(filters: WorkerFilters): ColumnFilterEntry[] {
	const entries: ColumnFilterEntry[] = [];
	for (const id of new Set([...filters.answers.keys(), ...(filters.exactAnswers?.keys() ?? [])])) {
		const exact = [...new Set(filters.exactAnswers?.get(id) ?? [])];
		entries.push({
			id,
			value: {
				answers: [...new Set(filters.answers.get(id) ?? [])],
				missing: filters.missing.has(id),
				...(exact.length > 0 ? { exact } : {})
			}
		});
	}
	for (const id of filters.missing) {
		if (!filters.answers.has(id) && !filters.exactAnswers?.has(id)) {
			entries.push({ id, value: { answers: [], missing: true } });
		}
	}
	for (const [id, values] of filters.columns) entries.push({ id, value: [...values] });
	// The Agitation facet carries its own column-filter entry, hidden from the
	// table's columns: it narrows the rows without adding a visible column.
	if (filters.agitations.size > 0) {
		entries.push({ id: 'agitations', value: [...filters.agitations] });
	}
	return entries;
}

/** Whether one Worker holds any of the selected Agitations (OR within the facet). */
export function agitationFilterMatches(worker: Worker, filterValue: unknown): boolean {
	const selected = Array.isArray(filterValue)
		? filterValue.filter((entry): entry is string => typeof entry === 'string')
		: [];
	if (selected.length === 0) return true;
	return worker.agitations.some((id) => selected.includes(id));
}

export function readAnswerFilter(value: unknown): AnswerFilterValue {
	if (Array.isArray(value)) {
		return {
			answers: value.filter((entry): entry is string => typeof entry === 'string'),
			missing: false
		};
	}
	if (value && typeof value === 'object') {
		const record = value as { answers?: unknown; missing?: unknown; exact?: unknown };
		const exact = Array.isArray(record.exact)
			? record.exact.filter((entry): entry is string => typeof entry === 'string')
			: [];
		return {
			answers: Array.isArray(record.answers)
				? record.answers.filter((entry): entry is string => typeof entry === 'string')
				: [],
			missing: record.missing === true,
			...(exact.length > 0 ? { exact } : {})
		};
	}
	return { answers: [], missing: false };
}

export function toggleAnswerFilter(
	value: unknown,
	choice: string,
	checked: boolean
): AnswerFilterValue | undefined {
	const current = readAnswerFilter(value);
	const exact = current.exact ?? [];
	const next: AnswerFilterValue =
		choice === NO_SELECTION_CHOICE
			? {
					answers: current.answers,
					missing: checked,
					...(exact.length > 0 ? { exact } : {})
				}
			: {
					answers: checked
						? [...new Set([...current.answers, choice])]
						: current.answers.filter((answer) => answer !== choice),
					missing: current.missing,
					...(exact.length > 0 ? { exact } : {})
				};

	return next.answers.length || next.missing || (next.exact?.length ?? 0) > 0 ? next : undefined;
}

/** Removes one direct-parent remainder reading from an Attribute's filter value. */
export function withoutExactAnswerFilter(
	value: unknown,
	answerId: string
): AnswerFilterValue | undefined {
	const current = readAnswerFilter(value);
	const exact = (current.exact ?? []).filter((id) => id !== answerId);
	const next: AnswerFilterValue = {
		answers: current.answers,
		missing: current.missing,
		...(exact.length > 0 ? { exact } : {})
	};
	return next.answers.length || next.missing || exact.length > 0 ? next : undefined;
}

/**
 * Whether one Worker satisfies its Attribute's filter: a selected answer (including
 * its descendants) or the no-answer reading, ORed within the Attribute.
 */
export function answerFilterMatches(
	worker: Worker,
	attribute: WorkerAttributeDefinition,
	filterValue: unknown
): boolean {
	const filter = readAnswerFilter(filterValue);
	if (filter.exact && filter.exact.length > 0) {
		if (
			heldIdsOf(attribute, worker.attributes[attribute.id]).some((id) => filter.exact?.includes(id))
		) {
			return true;
		}
		// The exact reading is the filter's only condition: a descendant holder does not
		// match, and falling through to the empty-ordinary "match everyone" would be wrong.
		if (filter.answers.length === 0 && !filter.missing) return false;
	}
	return workerMatchesAnswerFilter(worker, attribute, filter.answers, filter.missing);
}
