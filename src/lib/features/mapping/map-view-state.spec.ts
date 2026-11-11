// @module-tag mapping
/**
 * The Mapping view state, specced through the class every control on the page uses:
 * what a link restores, which choices the configuration can still honour, the
 * filter and highlight toggles, and the snapshot a clear or a reset is undone from.
 *
 * Node's Svelte compiles runes to plain values with no effects, so the constructor's
 * effect-driven reconciliation is not exercised here; the address rewrite that is a
 * public method is, against a stubbed navigation boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agitation, Language } from '#lib/domain-vocabulary.ts';
import { attributeDefinition } from '#lib/testing/builders.ts';
import { emptyContextualFilters } from '#lib/shared/contextual-filters.ts';
import { answerIdOf, attributeFixture } from '#lib/testing/mapping/answer-fixtures.ts';
import { groupGapDefault } from './layout/graph-group-physics.ts';
import { PersonPartition } from '#lib/shared/person-state.svelte.ts';
import { emptyHighlightQuery, encodeHighlightQuery } from './map-highlight-query-codec.ts';
import { MapViewState, type MapViewCapture } from './map-view-state.svelte.ts';
import { snapshotToSearchParams, type MapViewSnapshot } from './map-view-snapshot.ts';
import {
	captureMappingView,
	mappingViewToSnapshot
} from '#lib/features/saved-views/mapping-view-state.ts';

const navigation = vi.hoisted(() => {
	const state = { search: '', applied: 0 };
	const replaceCurrentUrl = vi.fn((edit: (params: URLSearchParams) => boolean | void) => {
		const params = new URLSearchParams(state.search);
		if (edit(params) === false) return false;
		state.search = params.toString();
		state.applied += 1;
		return true;
	});
	return { state, replaceCurrentUrl };
});
vi.mock('#lib/shared/navigation.ts', () => ({ replaceCurrentUrl: navigation.replaceCurrentUrl }));

const department = attributeDefinition({
	id: 'department',
	name: 'Department',
	answers: [
		{ id: 'shipping', value: 'Shipping' },
		{ id: 'packing', value: 'Packing', parentId: 'shipping' },
		{ id: 'shelf', value: 'Shelf', parentId: 'packing' },
		{ id: 'receiving', value: 'Receiving' }
	]
});
const location = attributeDefinition({
	id: 'location',
	name: 'Location',
	answers: [
		{ id: 'central', value: 'Central' },
		{ id: 'dock', value: 'Dock', parentId: 'central' }
	]
});
const team = attributeFixture({
	id: 'team',
	name: 'Team',
	kind: 'category',
	options: ['Alpha', 'Beta']
});
const attributes = [department, location, team];
const languages: Language[] = [
	{ id: 'en', name: 'English' },
	{ id: 'pl', name: 'Polish' }
];
const agitations: Agitation[] = [
	{ id: 'noise', text: 'Noise' },
	{ id: 'delay', text: 'Delay' }
];

const alpha = answerIdOf('team', 'Alpha');
const beta = answerIdOf('team', 'Beta');
/** A valid highlight query in the address's own wire shape: any English speaker. */
const HIGHLIGHT = JSON.stringify({ v: 1, m: 'all', r: [{ f: 'l', o: 'any', v: ['en'] }] });

beforeEach(() => {
	navigation.state.search = '';
	navigation.state.applied = 0;
	navigation.replaceCurrentUrl.mockClear();
});

afterEach(() => {
	navigation.replaceCurrentUrl.mockClear();
});

type ViewOptions = {
	attributes?: typeof attributes;
	languages?: readonly Language[];
	agitations?: readonly Agitation[];
};

function view(
	initial: Partial<MapViewSnapshot> & { query?: string; selected?: string } = {},
	options: ViewOptions = {}
) {
	const { query, selected, ...rest } = initial;
	const person = new PersonPartition();
	person.mapQuery = query ?? '';
	person.mapSelectedId = selected ?? '';
	return new MapViewState({
		person,
		attributes: options.attributes ?? attributes,
		languages: options.languages ?? languages,
		agitations: options.agitations ?? agitations,
		initial: rest
	});
}

function snapshot(overrides: Partial<MapViewCapture> = {}): MapViewCapture {
	return {
		group: '',
		subGroup: '',
		layout: 'grouped',
		isolated: false,
		query: '',
		hiddenAssessments: [],
		hiddenValues: {},
		hiddenLanguages: [],
		highlightLanguage: '',
		highlightQuery: '',
		selected: '',
		contextFilters: emptyContextualFilters(),
		expanded: [],
		expandedSub: [],
		...overrides
	};
}

describe('constructor', () => {
	it('fills every choice with its default when the address names none', () => {
		const state = view();
		expect(state.attributes).toEqual(attributes);
		expect(state.languages).toBe(languages);
		expect(state.agitations).toBe(agitations);
		expect(state.groupBy).toBe('');
		expect(state.subGroupBy).toBe('');
		expect(state.expanded).toEqual([]);
		expect(state.expandedSub).toEqual([]);
		expect(state.layout).toBe('grouped');
		expect(state.isolated).toBe(false);
		expect(state.groupGap).toBe(groupGapDefault);
		expect(state.query).toBe('');
		expect(state.hiddenAssessments).toEqual([]);
		expect(state.hiddenValues).toEqual({});
		expect(state.hiddenLanguages).toEqual([]);
		expect(state.highlight.rules).toEqual([]);
		expect(state.selectedId).toBe('');
		expect(state.hoveredId).toBe('');
		expect(state.contextFilters).toEqual(emptyContextualFilters());
	});

	it('restores a whole view snapshot by identity', () => {
		const state = view({
			group: 'department',
			subGroup: 'location',
			layout: 'free',
			isolated: true,
			query: 'dock',
			hiddenAssessments: ['Hostile'],
			hiddenValues: { team: [alpha] },
			hiddenLanguages: ['en'],
			highlightQuery: HIGHLIGHT,
			selected: 'w1',
			contextFilters: { answers: { team: [alpha] }, missing: ['department'] },
			expanded: ['department:packing'],
			expandedSub: ['location:central']
		});

		expect(state.groupBy).toBe('department');
		expect(state.subGroupBy).toBe('location');
		expect(state.layout).toBe('free');
		expect(state.isolated).toBe(true);
		expect(state.query).toBe('dock');
		expect(state.hiddenAssessments).toEqual(['Hostile']);
		expect(state.hiddenValues).toEqual({ team: [alpha] });
		expect(state.hiddenLanguages).toEqual(['en']);
		expect(state.highlight.rules).toMatchObject([
			{ type: 'clause', field: { kind: 'languages' }, operator: 'any', values: ['en'] }
		]);
		expect(state.selectedId).toBe('w1');
		expect(state.contextFilters).toEqual({ answers: { team: [alpha] }, missing: ['department'] });
		expect(state.expanded).toEqual(['shipping', 'packing']);
		expect(state.expandedSub).toEqual(['central']);
	});

	it('reads a legacy lang link as a one-clause query and drops an unknown one', () => {
		expect(view({ highlightLanguage: 'pl' }).highlight.rules).toMatchObject([
			{ type: 'clause', field: { kind: 'languages' }, operator: 'any', values: ['pl'] }
		]);
		expect(view({ highlightLanguage: 'ghost' }).highlight.rules).toEqual([]);
		expect(view({ highlightQuery: 'not json' }).highlight.rules).toEqual([]);
	});

	it('drops a restored Grouping and Sub-grouping the configuration cannot honour', () => {
		expect(view({ group: 'ghost' }).groupBy).toBe('');
		expect(view({ group: 'department', subGroup: 'department' }).subGroupBy).toBe('');
		expect(view({ group: 'department', subGroup: 'ghost' }).subGroupBy).toBe('');
		expect(view({ subGroup: 'location' }).subGroupBy).toBe('');
		expect(view({ group: 'department', subGroup: 'location' }).subGroupBy).toBe('location');
	});

	it('keeps only the hidden values, languages and detail the configuration holds', () => {
		const state = view({
			group: 'department',
			subGroup: 'location',
			hiddenValues: { department: ['shipping', 'ghost'], team: [alpha, 'ghost'], ghost: ['x'] },
			hiddenLanguages: ['en', 'ghost'],
			expanded: ['department:packing', 'department:shelf', 'team:Alpha'],
			expandedSub: ['location:central', 'department:shipping']
		});

		expect(state.hiddenValues).toEqual({ department: ['shipping'], team: [alpha] });
		expect(state.hiddenLanguages).toEqual(['en']);
		// Expanding a branch keeps the ancestors it needs; a leaf and a foreign id drop.
		expect(state.expanded).toEqual(['shipping', 'packing']);
		expect(state.expandedSub).toEqual(['central']);
	});

	it('reads Isolate only while a Worker is selected', () => {
		expect(view({ isolated: true }).isolatedInEffect).toBe(false);
		expect(view({ isolated: true, selected: 'w1' }).isolatedInEffect).toBe(true);
		expect(view({ isolated: false, selected: 'w1' }).isolatedInEffect).toBe(false);
	});

	it('copies the restored contextual filters instead of sharing them', () => {
		const filters = { answers: { team: [alpha] }, missing: ['location'] };
		const state = view({ contextFilters: filters });
		filters.answers.team.push(beta);
		filters.missing.push('department');

		expect(state.contextFilters).toEqual({ answers: { team: [alpha] }, missing: ['location'] });
	});
});

describe('hover and gap', () => {
	it('keeps the hovered Worker and the gap between group bodies', () => {
		const state = view();
		state.hoveredId = 'w2';
		state.groupGap = 240;

		expect(state.hoveredId).toBe('w2');
		expect(state.groupGap).toBe(240);
	});
});

describe('grouping getters', () => {
	it('names the grouping Attribute and the ones still available beneath it', () => {
		const state = view({ group: 'department', subGroup: 'location' });
		expect(state.groupableAttributes).toEqual(attributes);
		expect(state.groupingAttribute).toBe(department);
		expect(state.subGroupingAttributes).toEqual([location, team]);
		expect(state.subGroupingAttribute).toBe(location);
		expect(state.canSubGroup).toBe(true);
		expect(state.highlightVocabulary).toEqual({ attributes, languages, agitations });
	});

	it('offers no Sub-grouping with one Attribute, and no stale one without a Grouping', () => {
		const single = view({}, { attributes: [department] });
		expect(single.canSubGroup).toBe(false);
		expect(single.subGroupingAttributes).toEqual([department]);

		const stale = view({ subGroup: 'location' });
		expect(stale.subGroupingAttribute).toBeUndefined();
	});

	it('answers no Grouping for an empty or vanished choice', () => {
		const state = view();
		expect(state.groupingAttribute).toBeUndefined();

		state.groupBy = 'ghost';
		expect(state.groupingAttribute).toBeUndefined();
		expect(state.subGroupingAttribute).toBeUndefined();
	});
});

describe('filter toggles', () => {
	it('toggles one Assessment reading, keeping the rest', () => {
		const state = view();
		state.toggleAssessment('Hostile');
		state.toggleAssessment('Leader');
		expect(state.hiddenAssessments).toEqual(['Hostile', 'Leader']);

		state.toggleAssessment('Hostile');
		expect(state.hiddenAssessments).toEqual(['Leader']);
	});

	it('toggles one Attribute answer, keeping the other Attributes', () => {
		const state = view();
		state.toggleValue('team', alpha);
		state.toggleValue('team', beta);
		state.toggleValue('location', 'dock');
		expect(state.hiddenValues).toEqual({ team: [alpha, beta], location: ['dock'] });

		state.toggleValue('team', alpha);
		expect(state.hiddenValues).toEqual({ team: [beta], location: ['dock'] });
	});

	it('toggles one Language, keeping the rest', () => {
		const state = view();
		state.toggleLanguage('en');
		state.toggleLanguage('pl');
		expect(state.hiddenLanguages).toEqual(['en', 'pl']);

		state.toggleLanguage('en');
		expect(state.hiddenLanguages).toEqual(['pl']);
	});

	it('clears every reading without touching the configuration or the grouping', () => {
		const state = view({ group: 'department', query: 'dock', selected: 'w1' });
		state.toggleAssessment('Hostile');
		state.toggleValue('team', alpha);
		state.toggleLanguage('en');
		state.toggleContextAnswer('team', alpha, true);

		state.clearFilters();
		expect(state.hiddenAssessments).toEqual([]);
		expect(state.hiddenValues).toEqual({});
		expect(state.hiddenLanguages).toEqual([]);
		expect(state.contextFilters).toEqual(emptyContextualFilters());
		expect(state.groupBy).toBe('department');
		expect(state.query).toBe('dock');
		expect(state.selectedId).toBe('w1');
	});
});

describe('highlight', () => {
	it('replaces the whole query and empties it again', () => {
		const state = view();
		const group = emptyHighlightQuery();
		group.rules = [
			{ type: 'clause', id: 'r1', field: { kind: 'languages' }, operator: 'any', values: ['en'] }
		];

		state.setHighlight(group);
		expect(state.highlight).toBe(group);
		expect(encodeHighlightQuery(state.highlight)).toBe(HIGHLIGHT);

		state.clearHighlight();
		expect(state.highlight.rules).toEqual([]);
		expect(encodeHighlightQuery(state.highlight)).toBe('');
	});
});

describe('contextual filters', () => {
	it('toggles one answer in an Attribute and keeps the other conditions', () => {
		const state = view();
		state.toggleContextAnswer('team', alpha, true);
		state.toggleContextAnswer('team', beta, true);
		state.toggleContextMissing('location', true);
		expect(state.contextFilters).toEqual({
			answers: { team: [alpha, beta] },
			missing: ['location']
		});

		state.toggleContextAnswer('team', alpha, false);
		expect(state.contextFilters).toEqual({ answers: { team: [beta] }, missing: ['location'] });
	});

	it('toggles an Attribute no-answer reading and removes it again', () => {
		const state = view();
		state.toggleContextMissing('team', true);
		state.toggleContextMissing('location', true);
		expect(state.contextFilters.missing).toEqual(['team', 'location']);

		state.removeContextMissing('team');
		expect(state.contextFilters.missing).toEqual(['location']);
	});

	it('removes one selected answer and keeps the rest, exact readings included', () => {
		const state = view({
			contextFilters: {
				answers: { team: [alpha, beta] },
				missing: [],
				exactAnswers: { team: [alpha] }
			}
		});

		state.removeContextAnswer('team', alpha);
		expect(state.contextFilters.answers).toEqual({ team: [beta] });
		expect(state.contextFilters.exactAnswers).toEqual({});

		state.removeContextAnswer('team', beta);
		expect(state.contextFilters.answers).toEqual({});
	});
});

describe('selection and grouping choices', () => {
	it('selects a Worker and clears the choice on the same Worker again', () => {
		const state = view();
		state.select('w1');
		expect(state.selectedId).toBe('w1');

		state.select('w1');
		expect(state.selectedId).toBe('');
	});

	it('ends Isolate when the selection is cleared', () => {
		const state = view({ selected: 'w1', isolated: true });
		state.select('w1');
		expect(state.selectedId).toBe('');
		expect(state.isolated).toBe(false);
		expect(state.isolatedInEffect).toBe(false);
	});

	it('clears the Grouping and its detail while keeping the rest of the view', () => {
		const state = view({
			group: 'department',
			subGroup: 'location',
			expanded: ['department:packing'],
			expandedSub: ['location:central'],
			query: 'dock',
			selected: 'w1'
		});

		state.clearGrouping();
		expect(state.groupBy).toBe('');
		expect(state.subGroupBy).toBe('');
		expect(state.expanded).toEqual([]);
		expect(state.expandedSub).toEqual([]);
		expect(state.query).toBe('dock');
		expect(state.selectedId).toBe('w1');
	});
});

describe('capture and restore', () => {
	const restored = () =>
		view({
			group: 'department',
			subGroup: 'location',
			layout: 'free',
			isolated: true,
			query: 'dock',
			hiddenAssessments: ['Hostile'],
			hiddenValues: { team: [alpha] },
			hiddenLanguages: ['en'],
			highlightQuery: HIGHLIGHT,
			selected: 'w1',
			contextFilters: { answers: { team: [alpha] }, missing: ['location'] },
			expanded: ['department:packing'],
			expandedSub: ['location:central']
		});

	it('captures the view as a snapshot in the address wire shape', () => {
		const state = restored();
		const captured = state.capture();

		expect(captured).toMatchObject({
			group: 'department',
			subGroup: 'location',
			layout: 'free',
			isolated: true,
			query: 'dock',
			hiddenAssessments: ['Hostile'],
			hiddenValues: { team: [alpha] },
			hiddenLanguages: ['en'],
			selected: 'w1',
			contextFilters: { answers: { team: [alpha] }, missing: ['location'] }
		});
		expect(captured.highlightQuery).toBe(HIGHLIGHT);
		expect(captured.expanded).toEqual(['department:shipping', 'department:packing']);
		expect(captured.expandedSub).toEqual(['location:central']);
	});

	it('takes a reset back by restoring the captured snapshot', () => {
		const state = restored();
		const captured = state.capture();

		state.reset();
		expect(state.groupBy).toBe('');
		expect(state.layout).toBe('grouped');
		expect(state.selectedId).toBe('');
		expect(state.highlight.rules).toEqual([]);
		expect(state.attributes).toEqual(attributes);

		state.restore(captured);
		expect(state.capture()).toEqual(captured);
	});

	it('reads restored detail against the Attribute it names', () => {
		const state = view();
		state.restore(
			snapshot({
				group: 'department',
				subGroup: 'location',
				selected: 'w1',
				isolated: true,
				expanded: ['department:packing', 'department:shelf'],
				expandedSub: ['location:dock']
			})
		);

		expect(state.expanded).toEqual(['shipping', 'packing']);
		expect(state.expandedSub).toEqual([]);
		expect(state.selectedId).toBe('w1');
		expect(state.isolated).toBe(true);
	});

	it('restores a snapshot with no contextual filters as an empty selection', () => {
		const state = view();
		const bare = snapshot({ query: 'dock' });
		delete (bare as Partial<MapViewSnapshot>).contextFilters;

		state.restore(bare);
		expect(state.contextFilters).toEqual(emptyContextualFilters());
		expect(state.query).toBe('dock');
	});
});

describe('canonicalizeAddress', () => {
	it('rewrites restored detail to the canonical entries and drops retired params', () => {
		navigation.state.search = 'assignments=none&group=department';
		const state = view({
			group: 'department',
			subGroup: 'location',
			expanded: ['department:packing'],
			expandedSub: ['location:central']
		});

		state.canonicalizeAddress();

		const params = new URLSearchParams(navigation.state.search);
		expect(params.getAll('x')).toEqual(['department:shipping', 'department:packing']);
		expect(params.getAll('xs')).toEqual(['location:central']);
		expect(params.getAll('group')).toEqual(['department']);
		expect(params.has('assignments')).toBe(false);
		expect(navigation.state.applied).toBe(2);
	});

	it('leaves an address that already names the applied detail alone', () => {
		navigation.state.search = 'x=department%3Ashipping&x=department%3Apacking';
		const state = view({ group: 'department', expanded: ['department:packing'] });

		state.canonicalizeAddress();
		expect(navigation.state.applied).toBe(0);
		expect(navigation.state.search).toBe('x=department%3Ashipping&x=department%3Apacking');
	});

	it('strips legacy q, sel and worker once, keeps view params and ignores them as state', () => {
		navigation.state.search = 'q=Ada&sel=w1&worker=w2&group=department&hq=abc';
		const state = view({ group: 'department' });

		state.canonicalizeAddress();

		const params = new URLSearchParams(navigation.state.search);
		expect(params.has('q')).toBe(false);
		expect(params.has('sel')).toBe(false);
		expect(params.has('worker')).toBe(false);
		expect(params.get('group')).toBe('department');
		expect(params.get('hq')).toBe('abc');
		expect(state.query).toBe('');
		expect(state.selectedId).toBe('');
	});
});

describe('private person state', () => {
	it('keeps the search and selection in the partition so a new view over it restores them', () => {
		const person = new PersonPartition();
		const first = new MapViewState({ attributes, languages, agitations, initial: {}, person });
		first.query = 'dock';
		first.select('w1');

		const returned = new MapViewState({ attributes, languages, agitations, initial: {}, person });
		expect(returned.query).toBe('dock');
		expect(returned.selectedId).toBe('w1');
	});

	it('never puts the search or selection in the snapshot address', () => {
		const state = view({ query: 'dock', selected: 'w1', group: 'department' });
		const { query, selected, ...address } = state.capture();
		expect([query, selected]).toEqual(['dock', 'w1']);
		expect(snapshotToSearchParams(address).toString()).toBe('group=department');
	});
});

describe('opening a saved view', () => {
	it('sets the question and leaves the search, selection and Isolate as the organizer had them', () => {
		const state = view({ query: 'Worker 07', selected: 'w1', isolated: true });
		const saved = captureMappingView(state.capture());
		expect(Object.keys(saved)).not.toContain('query');

		const target = view({ group: 'team', hiddenAssessments: ['Leader'] });
		target.query = 'Worker 03';
		target.selectedId = 'w2';
		target.isolated = true;
		target.restore({
			...mappingViewToSnapshot(
				{
					...saved,
					grouping: { group: 'team', subGroup: '' },
					layout: 'free',
					visibility: { assessments: [], values: {}, languages: ['pl'] },
					population: { answers: { team: [alpha] }, exactAnswers: {}, missing: [] }
				},
				target.isolated
			),
			query: target.query,
			selected: target.selectedId
		});

		expect(target.groupBy).toBe('team');
		expect(target.layout).toBe('free');
		expect(target.hiddenAssessments).toEqual([]);
		expect(target.hiddenLanguages).toEqual(['pl']);
		expect(target.contextFilters.answers).toEqual({ team: [alpha] });
		expect(target.query).toBe('Worker 03');
		expect(target.selectedId).toBe('w2');
		expect(target.isolated).toBe(true);
	});
});
