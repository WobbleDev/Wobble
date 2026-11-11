/**
 * The map's hover, selection and ghosting state, kept apart from what is drawn.
 */
import { replaceCurrentUrl } from '#lib/shared/navigation.ts';
import { stripPersonParams, type PersonPartition } from '#lib/shared/person-state.svelte.ts';
import { untrack } from 'svelte';
import type { Agitation, Language, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import {
	copyContextualFilters,
	emptyContextualFilters,
	toggleContextAnswer,
	toggleContextMissing,
	withoutContextAnswer,
	withoutContextMissing,
	type ContextualFilters
} from '#lib/shared/contextual-filters.ts';
import { normalizeExpansion } from '#lib/shared/answer-hierarchy.ts';
import { isIsolateInEffect, type MapLayoutMode } from './map-view-model.ts';
import { groupGapDefault } from './layout/graph-group-physics.ts';
import {
	decodeHighlightQuery,
	emptyHighlightQuery,
	encodeHighlightQuery,
	legacyLanguageQuery,
	pruneHighlightQuery,
	type HighlightVocabulary
} from './map-highlight-query-codec.ts';
import type { HighlightGroup } from './map-highlight-query.ts';
import {
	dropObsoleteViewParams,
	knownHiddenLanguages,
	knownHiddenValues,
	readExpansionIds,
	readMapViewSnapshot,
	readSubGroup,
	snapshotToSearchParams,
	writeExpansionEntries,
	type MapViewSnapshot
} from './map-view-snapshot.ts';

/** The view plus the private person state, so an undo takes back a clear or a reset whole. */
export type MapViewCapture = MapViewSnapshot & { query: string; selected: string };

export type { MapLayoutMode };
export { readMapViewSnapshot, type MapViewSnapshot };

/** The ids one Attribute's detail can honour: existing parents, ancestor-closed, configured order. */
function normalizeIds(
	attribute: WorkerAttributeDefinition | undefined,
	ids: Iterable<string>
): string[] {
	return attribute ? normalizeExpansion(attribute, ids) : [];
}

/** The detail entries from the address, normalized against the Attribute they name. */
function normalizedExpansion(
	attribute: WorkerAttributeDefinition | undefined,
	entries: readonly string[]
): string[] {
	return attribute ? normalizeIds(attribute, readExpansionIds(entries, attribute.id)) : [];
}

function sameIds(first: readonly string[], second: readonly string[]): boolean {
	return first.length === second.length && first.every((id, index) => id === second[index]);
}

/**
 * Rewrites only the address's branch detail to the normalized entries, keeping every
 * other parameter as it arrived. A no-op when the address already names the same detail.
 */
function canonicalizeExpansionAddress(
	expanded: readonly string[],
	expandedSub: readonly string[]
): void {
	replaceCurrentUrl((params) => {
		const sameX = params.getAll('x').join('\n') === expanded.join('\n');
		const sameXs = params.getAll('xs').join('\n') === expandedSub.join('\n');
		if (sameX && sameXs) return false;
		params.delete('x');
		params.delete('xs');
		for (const entry of expanded) params.append('x', entry);
		for (const entry of expandedSub) params.append('xs', entry);
	});
}

export class MapViewState {
	readonly #person: PersonPartition;
	attributes = $state<readonly WorkerAttributeDefinition[]>([]);
	languages = $state<readonly Language[]>([]);
	agitations = $state<readonly Agitation[]>([]);
	/**
	 * Every question a Grouping or paired Sub-grouping may use. Either kind may group:
	 * a Single-Select holds one answer, a Multi-Select several, and the reading decides
	 * whether those cells still leave every displayed Worker in exactly one region.
	 * Whether the control then enables the choice is the reading's decision, not this
	 * filter's.
	 */
	groupableAttributes = $derived(this.attributes);

	groupBy = $state('');
	subGroupBy = $state('');
	/**
	 * The chosen detail of the current Grouping, by answer identity. It is normalized
	 * against the Attribute it belongs to, so a stale leaf, a removed answer, a foreign
	 * id or a branch whose ancestors are not expanded drops without changing the view.
	 */
	expanded = $state<string[]>([]);
	/** The same detail for the paired Sub-grouping, normalized against its own Attribute. */
	expandedSub = $state<string[]>([]);
	layout = $state<MapLayoutMode>('grouped');
	/** The Isolate focus over either layout; it moves no dot. */
	isolated = $state(false);
	/** The gap between group bodies, user-adjustable; the physics reads it. */
	groupGap = $state(groupGapDefault);
	/** The person-name search: private renderer memory, never in the address. */
	get query() {
		return this.#person.mapQuery;
	}
	set query(value: string) {
		this.#person.mapQuery = value;
	}
	hiddenAssessments = $state<string[]>([]);
	hiddenValues = $state<Record<string, string[]>>({});
	hiddenLanguages = $state<string[]>([]);
	/** The highlight query: every Worker it does not select is faded. An empty query fades nothing. */
	highlight = $state<HighlightGroup>(emptyHighlightQuery());
	/** The vocabulary a query is read and pruned against: the configuration as it stands. */
	highlightVocabulary = $derived({
		attributes: this.attributes,
		languages: this.languages,
		agitations: this.agitations
	} satisfies HighlightVocabulary);
	/** The selected Worker: private renderer memory, never in the address. */
	get selectedId() {
		return this.#person.mapSelectedId;
	}
	set selectedId(value: string) {
		this.#person.mapSelectedId = value;
	}
	hoveredId = $state('');
	/**
	 * The contextual population filter. It is the same selection the Workers view
	 * reads from the same address, so both views select the same Workers.
	 */
	contextFilters = $state<ContextualFilters>(emptyContextualFilters());

	/** An empty selection is None, so no Attribute means the map is ungrouped. */
	groupingAttribute = $derived(
		this.groupBy === '' ? undefined : this.groupableAttributes.find(({ id }) => id === this.groupBy)
	);

	/** Isolate needs a selected Worker; without one the whole map is drawn. */
	isolatedInEffect = $derived(isIsolateInEffect(this.isolated, this.selectedId));

	/** The Attributes still available for a second, nested partition. */
	subGroupingAttributes = $derived(
		this.groupableAttributes.filter(({ id }) => id !== this.groupBy)
	);

	/**
	 * At least two Attributes exist, so a second, nested partition is possible.
	 * Whether the control is then shown — and whether it is enabled — is the
	 * panel's decision: with None it stays visible but disabled.
	 */
	canSubGroup = $derived(this.groupableAttributes.length > 1);

	/** A stale sub-grouping never applies without a primary grouping. */
	subGroupingAttribute = $derived(
		this.subGroupBy === '' || this.groupingAttribute === undefined
			? undefined
			: this.groupableAttributes.find(({ id }) => id === this.subGroupBy)
	);

	constructor(options: {
		attributes: readonly WorkerAttributeDefinition[];
		languages: readonly Language[];
		agitations: readonly Agitation[];
		initial: Partial<MapViewSnapshot>;
		person: PersonPartition;
	}) {
		const { attributes, languages, agitations, initial } = options;
		this.#person = options.person;

		this.attributes = attributes;
		this.languages = languages;
		this.agitations = agitations;
		this.groupBy =
			initial.group && this.groupableAttributes.some(({ id }) => id === initial.group)
				? initial.group
				: '';
		this.subGroupBy = readSubGroup(
			initial.subGroup,
			this.groupableAttributes.map(({ id }) => id),
			this.groupBy
		);
		this.layout = initial.layout ?? 'grouped';
		this.hiddenAssessments = initial.hiddenAssessments ?? [];
		this.hiddenValues = knownHiddenValues(initial.hiddenValues ?? {}, attributes);
		this.hiddenLanguages = knownHiddenLanguages(initial.hiddenLanguages ?? [], languages);
		// A link with a highlight query reads it; an older link reads its lang as one clause.
		this.highlight = initial.highlightQuery
			? decodeHighlightQuery(initial.highlightQuery, this.highlightVocabulary)
			: legacyLanguageQuery(initial.highlightLanguage, this.highlightVocabulary);
		this.isolated = (initial.isolated ?? false) && this.selectedId !== '';
		this.contextFilters = copyContextualFilters(initial.contextFilters ?? emptyContextualFilters());
		// Restored detail is read by identity and normalized against the live configuration,
		// so a renamed branch opens and a removed or leaf one leaves no stale detail behind.
		this.expanded = normalizedExpansion(this.groupingAttribute, initial.expanded ?? []);
		this.expandedSub = normalizedExpansion(this.subGroupingAttribute, initial.expandedSub ?? []);

		$effect(() => {
			// None is a choice, not a stale value, so only a vanished question is cleared.
			if (this.groupBy !== '' && !this.groupableAttributes.some(({ id }) => id === this.groupBy)) {
				this.groupBy = '';
			}
		});

		$effect(() => {
			// A deleted Attribute, value, Language or Agitation leaves the query, never a stale rule.
			const next = pruneHighlightQuery(this.highlight, this.highlightVocabulary);
			if (next !== this.highlight) this.highlight = next;
		});

		$effect(() => {
			const next = readSubGroup(
				this.subGroupBy,
				this.groupableAttributes.map(({ id }) => id),
				this.groupBy
			);
			if (next !== this.subGroupBy) this.subGroupBy = next;
		});

		// Detail belongs to the Attribute that names it: changing the Grouping (or deleting
		// the question) drops the branches the new reading cannot honour, never reinterprets
		// the old ids against a different hierarchy.
		$effect(() => {
			const next = normalizeIds(this.groupingAttribute, this.expanded);
			if (!sameIds(next, this.expanded)) this.expanded = next;
		});

		$effect(() => {
			const next = normalizeIds(this.subGroupingAttribute, this.expandedSub);
			if (!sameIds(next, this.expandedSub)) this.expandedSub = next;
		});

		// First run mirrors the URL state, so skip the write until the user changes
		// something (and the router is ready). Restored branch detail is canonicalized
		// separately, after mount, so a rewrite never races the first route effect flush.
		let urlSyncReady = false;
		$effect(() => {
			const snapshot: MapViewSnapshot = {
				group: this.groupBy,
				subGroup: this.subGroupBy,
				layout: this.layout,
				isolated: this.isolated,
				hiddenAssessments: this.hiddenAssessments,
				hiddenValues: this.hiddenValues,
				hiddenLanguages: this.hiddenLanguages,
				highlightLanguage: '',
				highlightQuery: encodeHighlightQuery(this.highlight),
				contextFilters: this.contextFilters,
				expanded: writeExpansionEntries(this.groupBy, this.expanded),
				expandedSub: writeExpansionEntries(this.subGroupBy, this.expandedSub)
			};

			if (!urlSyncReady) {
				urlSyncReady = true;
				return;
			}

			untrack(() => {
				const snapshotParams = snapshotToSearchParams(snapshot);
				const search = snapshotParams.toString();
				replaceCurrentUrl((params) => {
					if ((search ? `?${search}` : '') === window.location.search) return false;
					for (const key of [...params.keys()]) params.delete(key);
					for (const [key, value] of snapshotParams) params.append(key, value);
				});
			});
		});
	}

	toggleAssessment(assessment: string) {
		this.hiddenAssessments = this.hiddenAssessments.includes(assessment)
			? this.hiddenAssessments.filter((value) => value !== assessment)
			: [...this.hiddenAssessments, assessment];
	}

	toggleValue(attributeId: string, value: string) {
		const current = this.hiddenValues[attributeId] ?? [];
		const next = current.includes(value)
			? current.filter((entry) => entry !== value)
			: [...current, value];
		this.hiddenValues = { ...this.hiddenValues, [attributeId]: next };
	}

	toggleLanguage(languageId: string) {
		this.hiddenLanguages = this.hiddenLanguages.includes(languageId)
			? this.hiddenLanguages.filter((id) => id !== languageId)
			: [...this.hiddenLanguages, languageId];
	}

	/** Replaces the whole highlight query; the map fades live from it. */
	setHighlight(group: HighlightGroup) {
		this.highlight = group;
	}

	/** Empties the highlight query. */
	clearHighlight() {
		this.highlight = emptyHighlightQuery();
	}

	clearFilters() {
		this.hiddenAssessments = [];
		this.hiddenValues = {};
		this.hiddenLanguages = [];
		this.contextFilters = emptyContextualFilters();
	}

	/**
	 * Rewrites restored branch detail that normalization changed to the canonical address,
	 * and drops a retired mapping predicate (`assignments=none`) left behind by an old
	 * link, after the router is ready. A no-op when the address already names the applied
	 * detail and carries no stale predicate.
	 */
	canonicalizeAddress(): void {
		canonicalizeExpansionAddress(
			writeExpansionEntries(this.groupBy, this.expanded),
			writeExpansionEntries(this.subGroupBy, this.expandedSub)
		);
		replaceCurrentUrl((params) => {
			const dropped = dropObsoleteViewParams(params);
			// A legacy link's person parameters are ignored and stripped once, then never re-emitted.
			return stripPersonParams(params) || dropped;
		});
	}

	/**
	 * The explicit way out of an unavailable Grouping: the state and the address lose
	 * the choice, and the map stays Free. Leaving it alone never rewrites the address.
	 */
	clearGrouping() {
		this.groupBy = '';
		this.subGroupBy = '';
		this.expanded = [];
		this.expandedSub = [];
	}

	/**
	 * Toggles one answer in an Attribute's Include filter, keeping the rest of the
	 * contextual reading. The Attribute's answers are alternatives, so the predicates
	 * are the same ones the Workers view reads from the same address.
	 */
	toggleContextAnswer(attributeId: string, answerId: string, checked: boolean) {
		this.contextFilters = toggleContextAnswer(this.contextFilters, attributeId, answerId, checked);
	}

	/** Toggles one Attribute's no-answer reading in the Include filter. */
	toggleContextMissing(attributeId: string, checked: boolean) {
		this.contextFilters = toggleContextMissing(this.contextFilters, attributeId, checked);
	}

	/** Removes one selected answer, keeping the rest of the contextual reading. */
	removeContextAnswer(attributeId: string, answerId: string) {
		this.contextFilters = withoutContextAnswer(this.contextFilters, attributeId, answerId);
	}

	/** Removes one Attribute's no-answer reading, keeping the rest. */
	removeContextMissing(attributeId: string) {
		this.contextFilters = withoutContextMissing(this.contextFilters, attributeId);
	}

	select(workerId: string) {
		this.selectedId = this.selectedId === workerId ? '' : workerId;

		// Isolate needs a selected worker, so clearing the selection ends it.
		if (!this.selectedId) this.isolated = false;
	}

	reset() {
		this.groupBy = '';
		this.subGroupBy = '';
		this.expanded = [];
		this.expandedSub = [];
		this.layout = 'grouped';
		this.isolated = false;
		this.query = '';
		this.hiddenAssessments = [];
		this.hiddenValues = {};
		this.hiddenLanguages = [];
		this.highlight = emptyHighlightQuery();
		this.selectedId = '';
		this.contextFilters = emptyContextualFilters();
	}

	/** The view as it stands, so a clear or a reset can be taken back. */
	capture(): MapViewCapture {
		return {
			group: this.groupBy,
			subGroup: this.subGroupBy,
			layout: this.layout,
			isolated: this.isolated,
			query: this.query,
			hiddenAssessments: this.hiddenAssessments,
			hiddenValues: this.hiddenValues,
			hiddenLanguages: this.hiddenLanguages,
			highlightLanguage: '',
			highlightQuery: encodeHighlightQuery(this.highlight),
			selected: this.selectedId,
			contextFilters: copyContextualFilters(this.contextFilters),
			expanded: writeExpansionEntries(this.groupBy, this.expanded),
			expandedSub: writeExpansionEntries(this.subGroupBy, this.expandedSub)
		};
	}

	restore(snapshot: MapViewCapture) {
		this.groupBy =
			snapshot.group && this.groupableAttributes.some(({ id }) => id === snapshot.group)
				? snapshot.group
				: '';
		this.subGroupBy = readSubGroup(
			snapshot.subGroup,
			this.groupableAttributes.map(({ id }) => id),
			this.groupBy
		);
		this.layout = snapshot.layout;
		this.isolated = snapshot.isolated;
		this.query = snapshot.query;
		this.hiddenAssessments = [...snapshot.hiddenAssessments];
		this.hiddenValues = { ...snapshot.hiddenValues };
		this.hiddenLanguages = [...snapshot.hiddenLanguages];
		this.highlight = snapshot.highlightQuery
			? decodeHighlightQuery(snapshot.highlightQuery, this.highlightVocabulary)
			: legacyLanguageQuery(snapshot.highlightLanguage, this.highlightVocabulary);
		this.selectedId = snapshot.selected;
		this.contextFilters = copyContextualFilters(
			snapshot.contextFilters ?? emptyContextualFilters()
		);
		// Detail is restored against the Attribute it names, exactly like the address.
		this.expanded = normalizedExpansion(this.groupingAttribute, snapshot.expanded);
		this.expandedSub = normalizedExpansion(this.subGroupingAttribute, snapshot.expandedSub);
	}
}
