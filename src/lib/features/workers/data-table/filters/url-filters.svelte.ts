/**
 * The Workers table's filters and the address: reading what the table is filtered by,
 * encoding it into the URL, and normalizing a stale address on mount. The table
 * component keeps the filter state in its columns; this reads it off and writes it back
 * to the address without touching params it does not own (the selected Worker, say).
 */
import { tick, untrack } from 'svelte';
import { SvelteMap, SvelteSet, SvelteURL } from 'svelte/reactivity';
import { page } from '$app/state';
import { replaceCurrentUrl } from '#lib/shared/navigation.ts';
import { personParams, stripPersonParams } from '#lib/shared/person-state.svelte.ts';
import {
	readAnswerFilter,
	writeWorkerFilters,
	type AnswerFilterValue,
	type WorkerFilters
} from '#lib/shared/worker-filters.ts';
import type { Agitation, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { m } from '#lib/paraglide/messages.js';

/** Reads one column's current filter value; undefined when the column is absent. */
export type FilterReader = (columnId: string) => unknown;

/** What the url filters read from the table and the surrounding data. */
export type WorkersUrlFiltersHost = {
	filterValue: FilterReader;
	attributes: () => readonly WorkerAttributeDefinition[];
	agitations: () => readonly Agitation[];
};

/** The filter parameters this table owns; anything else in the address is left alone. */
const managedFilterParams = ['f', 'missing', 'agitation'] as const;

/**
 * Parameters a retired filter left behind. `assignments=none` named the removed
 * zero-assignment predicate: mount normalization drops it, so an old link neither
 * keeps a predicate the table cannot read nor round-trips it forever.
 */
const obsoleteFilterParams = ['assignments'] as const;

/**
 * The filter state as a comparable value. Order inside a parameter does not change
 * its meaning, so a stale reference is the only thing that makes the loaded address
 * differ from the normalized one.
 */
export function filterParamsKey(params: URLSearchParams): string {
	return managedFilterParams
		.map((key) => key + '=' + [...params.getAll(key)].sort().join(','))
		.join('&');
}

/**
 * Drops the filter parameters this table no longer owns, answering whether the
 * address changed. Mount normalization uses it so an old zero-assignment link is
 * rewritten rather than left in place.
 */
export function dropObsoleteFilterParams(params: URLSearchParams): boolean {
	let dropped = false;
	for (const key of obsoleteFilterParams) {
		if (!params.has(key)) continue;
		params.delete(key);
		dropped = true;
	}
	return dropped;
}

/** What the Workers table is filtered by, in the operator's own words. */
export function activeFilterNamesFrom(
	read: FilterReader,
	attributes: readonly WorkerAttributeDefinition[],
	agitations: readonly Agitation[]
): string[] {
	const names: string[] = [];
	const search = read('name');
	if (typeof search === 'string' && search) names.push(`“${search}”`);

	const languageFilter = read('languages');
	if (Array.isArray(languageFilter) && languageFilter.length)
		names.push(m.workers_column_languages());

	const selection = read('assessment');
	if (Array.isArray(selection) && selection.length) names.push(m.workers_column_assessment());

	for (const attribute of attributes) {
		const value: AnswerFilterValue = readAnswerFilter(read(attribute.id));
		if (value.answers.length > 0 || value.missing || (value.exact?.length ?? 0) > 0) {
			names.push(attribute.name);
		}
	}

	const agitationFilter = read('agitations');
	if (Array.isArray(agitationFilter)) {
		for (const agitationId of agitationFilter) {
			const agitation = agitations.find((entry) => entry.id === agitationId);
			if (agitation) names.push(agitation.text);
		}
	}

	return names;
}

/** The explicit filters as the address encodes them, read off the table's columns. */
export function collectWorkerFiltersFrom(
	read: FilterReader,
	attributes: readonly WorkerAttributeDefinition[]
): WorkerFilters {
	const answers = new SvelteMap<string, string[]>();
	const exactAnswers = new SvelteMap<string, string[]>();
	const missing = new SvelteSet<string>();
	const columns = new SvelteMap<string, string[]>();
	const selectedAgitations = new SvelteSet<string>();

	for (const attribute of attributes) {
		const value = readAnswerFilter(read(attribute.id));
		if (value.answers.length > 0) answers.set(attribute.id, [...new SvelteSet(value.answers)]);
		if (value.exact && value.exact.length > 0) {
			exactAnswers.set(attribute.id, [...new SvelteSet(value.exact)]);
		}
		if (value.missing) missing.add(attribute.id);
	}
	for (const columnId of ['languages', 'assessment']) {
		const value = read(columnId);
		const values = Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === 'string')
			: [];
		if (values.length > 0) columns.set(columnId, values);
	}

	const agitationFilter = read('agitations');
	if (Array.isArray(agitationFilter)) {
		for (const agitationId of agitationFilter) {
			if (typeof agitationId === 'string') selectedAgitations.add(agitationId);
		}
	}

	return {
		answers,
		missing,
		...(exactAnswers.size > 0 ? { exactAnswers } : {}),
		columns,
		agitations: selectedAgitations
	};
}

/** Call during component init: it registers the address-sync effect. */
export function createWorkersUrlFilters(host: WorkersUrlFiltersHost) {
	const collectWorkerFilters = () => collectWorkerFiltersFrom(host.filterValue, host.attributes());

	const activeFilterNames = $derived(
		activeFilterNamesFrom(host.filterValue, host.attributes(), host.agitations())
	);

	/**
	 * Interactive filter changes replace the current history entry rather than pushing
	 * one: the address stays reloadable, Back is not filled with filter steps, and
	 * unrelated state such as the selected Worker is preserved. A loaded address that
	 * names a deleted Attribute, a no longer valid system predicate, or a retired
	 * parameter is normalized on mount, so a stale URL does not keep claiming a filter
	 * it no longer applies.
	 */
	let urlSyncReady = false;
	$effect(() => {
		const filters = collectWorkerFilters();
		const current = new SvelteURL(window.location.href);
		const next = new SvelteURL(current);
		writeWorkerFilters(next.searchParams, filters);
		if (!urlSyncReady) {
			urlSyncReady = true;
			// Legacy person parameters (q, sel, worker) are stripped in the same rewrite.
			const obsolete = [...obsoleteFilterParams, ...personParams].some((key) =>
				current.searchParams.has(key)
			);
			if (
				!obsolete &&
				filterParamsKey(next.searchParams) === filterParamsKey(current.searchParams)
			) {
				return;
			}
			// The router installs its root after the first mount, so shallow routing is not
			// callable yet. Defer the normalization and re-read the live state first: a
			// filter change in the meantime owns the address.
			void tick().then(() => {
				replaceCurrentUrl(
					(params) => {
						const droppedObsolete = [
							dropObsoleteFilterParams(params),
							stripPersonParams(params)
						].some(Boolean);
						const liveKey = filterParamsKey(params);
						writeWorkerFilters(params, collectWorkerFilters());
						return droppedObsolete || filterParamsKey(params) !== liveKey;
					},
					untrack(() => page.state)
				);
			});
			return;
		}

		if (next.search !== current.search) {
			replaceCurrentUrl(
				(params) => {
					writeWorkerFilters(params, filters);
				},
				untrack(() => page.state)
			);
		}
	});

	return {
		get activeFilterNames() {
			return activeFilterNames;
		}
	};
}
