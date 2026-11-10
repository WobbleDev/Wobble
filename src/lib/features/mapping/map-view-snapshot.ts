/**
 * Writing the map's view into the URL and reading it back, so a Mapping link opens
 * the same picture.
 */
import { encodeColonPair, parseColonPair } from '#lib/shared/colon-pair.ts';
import type { Language, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import {
	emptyContextualFilters,
	parseContextualFilters,
	writeContextualFilters,
	type ContextualFilters
} from '#lib/shared/contextual-filters.ts';
import type { MapLayoutMode } from './map-view-model.ts';

export type MapViewSnapshot = {
	group: string;
	subGroup: string;
	layout: MapLayoutMode;
	/** The Isolate focus; it needs a selected Worker to take effect. */
	isolated: boolean;
	hiddenAssessments: string[];
	hiddenValues: Record<string, string[]>;
	/** Language ids the filter hides. */
	hiddenLanguages: string[];
	/**
	 * The legacy single-Language highlight, read from the old `lang` parameter only. It is
	 * never written again: the highlight query in `highlightQuery` replaces it, and a
	 * legacy link opens as a one-clause query.
	 */
	highlightLanguage: string;
	/** The raw highlight query text (the `hq` parameter), or '' for no highlight. */
	highlightQuery: string;
	/**
	 * The contextual population filter: the same ordinary Worker answer and no-answer
	 * conditions the Workers view reads, so both views select the same Workers.
	 */
	contextFilters: ContextualFilters;
	/**
	 * The primary Grouping's expanded branches, as repeated `<attributeId>:<answerId>`
	 * entries (the `x` parameter). The view state normalizes them against the current
	 * Attribute, so a stale or foreign entry never reinterprets another question.
	 */
	expanded: string[];
	/** The paired Sub-grouping's expanded branches (the `xs` parameter). */
	expandedSub: string[];
};

function readLayout(value: string | null): MapLayoutMode {
	return value === 'free' ? 'free' : 'grouped';
}

/**
 * A sub-grouping is only usable while a primary grouping exists and the value
 * names a live Attribute other than the primary one. A second, nested partition
 * needs at least two Attributes, so None (or a lone Attribute) clears it.
 */
export function readSubGroup(
	value: string | undefined,
	attributeIds: readonly string[],
	groupBy: string
): string {
	if (!groupBy || !value || value === groupBy) return '';
	return attributeIds.includes(value) ? value : '';
}

function readHiddenValues(params: URLSearchParams): Record<string, string[]> {
	const hidden: Record<string, string[]> = {};

	for (const entry of params.getAll('hid')) {
		const pair = parseColonPair(entry);
		if (!pair) continue;
		hidden[pair.id] = [...(hidden[pair.id] ?? []), pair.value];
	}

	return hidden;
}

/**
 * Keeps only the hidden answers the Attributes still hold, by id. A link from before
 * answers had ids carries text, which names no answer here, so it drops silently.
 */
export function knownHiddenValues(
	hidden: Record<string, string[]>,
	attributes: readonly WorkerAttributeDefinition[]
): Record<string, string[]> {
	const known: Record<string, string[]> = {};

	for (const attribute of attributes) {
		// Hiding an answer is a Worker-level reading, so every Attribute can be hidden.
		const ids = new Set(attribute.answers.map((answer) => answer.id));
		const kept = (hidden[attribute.id] ?? []).filter((id) => ids.has(id));
		if (kept.length > 0) known[attribute.id] = kept;
	}

	return known;
}

/** Keeps only the hidden Language ids the worksite still lists. */
export function knownHiddenLanguages(
	hidden: readonly string[],
	languages: readonly Language[]
): string[] {
	const ids = new Set(languages.map(({ id }) => id));
	return hidden.filter((id) => ids.has(id));
}

/**
 * Parameters a retired mapping predicate left behind. `assignments=none` named the
 * removed zero-assignment condition: mount normalization drops it, so an old link
 * neither keeps a predicate the map cannot read nor round-trips it forever. The map
 * owns the same filter parameters the Workers view does (`f`, `missing`) plus the
 * retired `assignments`; everything else in the address is left alone.
 */
const obsoleteViewParams = ['assignments'] as const;

/**
 * Drops the mapping's retired parameters in place, answering whether the address
 * changed. Used by mount normalization so an old zero-assignment link is rewritten
 * through `replaceCurrentUrl` instead of being left to read as an empty selection.
 */
export function dropObsoleteViewParams(params: URLSearchParams): boolean {
	let dropped = false;
	for (const key of obsoleteViewParams) {
		if (!params.has(key)) continue;
		params.delete(key);
		dropped = true;
	}
	return dropped;
}

export function readMapViewSnapshot(
	params: URLSearchParams,
	attributes: readonly WorkerAttributeDefinition[] = []
): Partial<MapViewSnapshot> {
	const { filters } = parseContextualFilters(params, attributes);

	return {
		group: params.get('group') ?? undefined,
		subGroup: params.get('sub') ?? undefined,
		layout: params.has('layout') ? readLayout(params.get('layout')) : undefined,
		// A link from before Isolate became a focus names it as a layout.
		isolated: params.get('iso') === '1' || params.get('layout') === 'isolated',
		hiddenAssessments: params.getAll('no').filter(Boolean),
		hiddenValues: readHiddenValues(params),
		hiddenLanguages: params.getAll('nolang').filter(Boolean),
		highlightLanguage: params.get('lang') ?? undefined,
		highlightQuery: params.get('hq') ?? undefined,
		contextFilters: filters,
		expanded: params.getAll('x').filter(Boolean),
		expandedSub: params.getAll('xs').filter(Boolean)
	};
}

/** The answer ids one Attribute's `x` or `xs` entries name; malformed or foreign ones drop. */
export function readExpansionIds(entries: readonly string[], attributeId: string): string[] {
	if (!attributeId) return [];
	return entries.flatMap((entry) => {
		const pair = parseColonPair(entry);
		return pair && pair.id === attributeId ? [pair.value] : [];
	});
}

/** Writes one Attribute's expanded branch ids as `x`/`xs` entries, in the given order. */
export function writeExpansionEntries(attributeId: string, answerIds: readonly string[]): string[] {
	if (!attributeId) return [];
	return answerIds.map((answerId) => encodeColonPair(attributeId, answerId));
}

export function snapshotToSearchParams(snapshot: MapViewSnapshot): URLSearchParams {
	const params = new URLSearchParams();
	if (snapshot.group) params.set('group', snapshot.group);
	if (snapshot.subGroup) params.set('sub', snapshot.subGroup);
	if (snapshot.layout !== 'grouped') params.set('layout', snapshot.layout);
	if (snapshot.isolated) params.set('iso', '1');
	for (const assessment of snapshot.hiddenAssessments) {
		params.append('no', assessment);
	}
	for (const [attributeId, values] of Object.entries(snapshot.hiddenValues)) {
		for (const value of values) params.append('hid', encodeColonPair(attributeId, value));
	}
	for (const languageId of snapshot.hiddenLanguages) params.append('nolang', languageId);
	if (snapshot.highlightQuery) params.set('hq', snapshot.highlightQuery);
	for (const entry of snapshot.expanded) params.append('x', entry);
	for (const entry of snapshot.expandedSub) params.append('xs', entry);
	writeContextualFilters(params, snapshot.contextFilters ?? emptyContextualFilters());
	return params;
}
