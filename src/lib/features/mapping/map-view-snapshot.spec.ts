// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { normalizeExpansion } from '#lib/shared/answer-hierarchy.ts';
import { encodeColonPair } from '#lib/shared/colon-pair.ts';
import { emptyContextualFilters, type ContextualFilters } from '#lib/shared/contextual-filters.ts';
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
import { answerIdOf, attributeFixture } from '#lib/testing/mapping/answer-fixtures.ts';

const team = attributeFixture({
	id: 'team',
	name: 'Team',
	kind: 'category',
	options: ['Team A', 'Team B']
});
const territory = attributeFixture({
	id: 'territory',
	name: 'Territory',
	kind: 'category',
	options: ['Store A', 'Store B']
});
const position = attributeFixture({
	id: 'position',
	name: 'Position',
	kind: 'category',
	options: ['Cashier']
});
const contextAttributes = [team, territory, position];

/** A highlight query as the address carries it: one clause, Languages any of la2. */
const QUERY = '{"v":1,"m":"all","r":[{"f":"l","o":"any","v":["la2"]}]}';

/** Builds a query string with every entry appended, so repeated keys survive. */
function params(entries: Record<string, string | string[]>): URLSearchParams {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(entries)) {
		for (const entry of Array.isArray(value) ? value : [value]) search.append(key, entry);
	}
	return search;
}

describe('readMapViewSnapshot', () => {
	it('reads the single-valued fields', () => {
		const snapshot = readMapViewSnapshot(params({ group: 'dept', sub: 'role' }));

		expect(snapshot.group).toBe('dept');
		expect(snapshot.subGroup).toBe('role');
	});

	it('ignores the legacy person parameters q, sel and worker', () => {
		const snapshot = readMapViewSnapshot(
			params({ group: 'dept', q: 'Ada', sel: 'w1', worker: 'w2' })
		);

		expect(snapshot).not.toHaveProperty('query');
		expect(snapshot).not.toHaveProperty('selected');
		expect(snapshot.group).toBe('dept');
	});

	it('leaves absent fields undefined and the collections empty', () => {
		const snapshot = readMapViewSnapshot(new URLSearchParams());

		expect(snapshot.group).toBeUndefined();
		expect(snapshot.subGroup).toBeUndefined();
		expect(snapshot.layout).toBeUndefined();
		expect(snapshot.hiddenAssessments).toEqual([]);
		expect(snapshot.hiddenValues).toEqual({});
		expect(snapshot.expanded).toEqual([]);
		expect(snapshot.expandedSub).toEqual([]);
		expect(snapshot.contextFilters).toEqual(emptyContextualFilters());
	});

	it('collects the branch detail as repeated x and xs entries', () => {
		const snapshot = readMapViewSnapshot(
			params({ x: ['loc:central', 'loc:store-a', ''], xs: ['dept:ops'] })
		);

		expect(snapshot.expanded).toEqual(['loc:central', 'loc:store-a']);
		expect(snapshot.expandedSub).toEqual(['dept:ops']);
	});

	it('keeps a known layout and falls back to grouped for anything else', () => {
		expect(readMapViewSnapshot(params({ layout: 'free' })).layout).toBe('free');
		// A link from before Isolate was a focus opens as Grouped with Isolate on.
		const old = readMapViewSnapshot(params({ layout: 'isolated' }));
		expect(old.layout).toBe('grouped');
		expect(old.isolated).toBe(true);
		expect(readMapViewSnapshot(params({ layout: 'grouped' })).layout).toBe('grouped');
		expect(readMapViewSnapshot(params({ layout: 'nonsense' })).layout).toBe('grouped');
	});

	it('collects hidden assessments in order and drops empty ones', () => {
		const snapshot = readMapViewSnapshot(params({ no: ['Leader', '', 'Hostile'] }));

		expect(snapshot.hiddenAssessments).toEqual(['Leader', 'Hostile']);
	});

	it('decodes hidden values, accumulating multiple values per attribute', () => {
		const snapshot = readMapViewSnapshot(
			params({
				hid: [
					encodeColonPair('dept', 'Front of House'),
					encodeColonPair('role', 'Server'),
					encodeColonPair('role', 'Cook')
				]
			})
		);

		expect(snapshot.hiddenValues).toEqual({
			dept: ['Front of House'],
			role: ['Server', 'Cook']
		});
	});

	it('Product gap 11 reads one chosen Language id from lang', () => {
		expect(readMapViewSnapshot(params({ lang: 'la2' })).highlightLanguage).toBe('la2');
		expect(readMapViewSnapshot(params({ lang: ['la1', 'la2'] })).highlightLanguage).toBe('la1');
		expect(readMapViewSnapshot(new URLSearchParams()).highlightLanguage).toBeUndefined();
	});

	it('reads the highlight query text from hq, and leaves it undefined when absent', () => {
		expect(readMapViewSnapshot(params({ hq: QUERY })).highlightQuery).toBe(QUERY);
		expect(readMapViewSnapshot(new URLSearchParams()).highlightQuery).toBeUndefined();
	});

	it('skips a malformed hidden-value entry', () => {
		const snapshot = readMapViewSnapshot(
			params({ hid: ['nocolon', encodeColonPair('dept', 'Front')] })
		);

		expect(snapshot.hiddenValues).toEqual({ dept: ['Front'] });
	});
});

describe('snapshotToSearchParams', () => {
	it('writes every set field', () => {
		const out = snapshotToSearchParams({
			group: 'dept',
			subGroup: 'role',
			layout: 'free',
			isolated: true,
			hiddenAssessments: ['Leader', 'Hostile'],
			hiddenValues: { dept: ['Front'], role: ['Server', 'Cook'] },
			hiddenLanguages: ['la1'],
			highlightLanguage: '',
			highlightQuery: QUERY,
			expanded: ['dept:front'],
			expandedSub: ['team:all'],
			contextFilters: {
				answers: {
					team: [answerIdOf('team', 'Team A')],
					territory: [answerIdOf('territory', 'Store B')]
				},
				missing: ['position']
			}
		});

		expect(out.get('group')).toBe('dept');
		expect(out.get('sub')).toBe('role');
		expect(out.get('layout')).toBe('free');
		expect(out.get('iso')).toBe('1');
		expect(out.has('q')).toBe(false);
		expect(out.has('sel')).toBe(false);
		expect(out.getAll('no')).toEqual(['Leader', 'Hostile']);
		expect(out.getAll('nolang')).toEqual(['la1']);
		// The highlight query is written as hq; the legacy lang is never written again.
		expect(out.get('hq')).toBe(QUERY);
		expect(out.has('lang')).toBe(false);
		expect(out.getAll('hid')).toEqual([
			encodeColonPair('dept', 'Front'),
			encodeColonPair('role', 'Server'),
			encodeColonPair('role', 'Cook')
		]);
		expect(out.getAll('f')).toEqual([
			'team:' + answerIdOf('team', 'Team A'),
			'territory:' + answerIdOf('territory', 'Store B')
		]);
		expect(out.getAll('missing')).toEqual(['position']);
		expect(out.getAll('x')).toEqual(['dept:front']);
		expect(out.getAll('xs')).toEqual(['team:all']);
	});

	it('omits empty fields and the default layout', () => {
		const out = snapshotToSearchParams({
			group: '',
			subGroup: '',
			layout: 'grouped',
			isolated: false,
			hiddenAssessments: [],
			hiddenValues: {},
			hiddenLanguages: [],
			highlightLanguage: '',
			highlightQuery: '',
			expanded: [],
			expandedSub: [],
			contextFilters: emptyContextualFilters()
		});

		expect(out.toString()).toBe('');
	});
});

describe('the highlight query in the address', () => {
	it('writes hq only when a highlight query is set', () => {
		expect(
			snapshotToSearchParams({ ...atDefaultSnapshot(), highlightQuery: QUERY }).get('hq')
		).toBe(QUERY);
		expect(snapshotToSearchParams(atDefaultSnapshot()).has('hq')).toBe(false);
	});

	it('never writes the legacy lang parameter, even while a legacy highlight is held', () => {
		const out = snapshotToSearchParams({ ...atDefaultSnapshot(), highlightLanguage: 'la2' });

		expect(out.has('lang')).toBe(false);
	});

	it('reads back a highlight query exactly as it was written', () => {
		const out = snapshotToSearchParams({ ...atDefaultSnapshot(), highlightQuery: QUERY });

		expect(readMapViewSnapshot(out).highlightQuery).toBe(QUERY);
	});
});

describe('round-trip', () => {
	it('reads back a fully populated snapshot', () => {
		const full: MapViewSnapshot = {
			group: 'dept',
			subGroup: 'role',
			layout: 'free',
			isolated: true,
			hiddenAssessments: ['Leader', 'Hostile'],
			hiddenValues: { dept: ['Front'], role: ['Server', 'Cook'] },
			hiddenLanguages: [],
			highlightLanguage: '',
			highlightQuery: QUERY,
			expanded: ['dept:front', 'dept:back'],
			expandedSub: ['team:all'],
			contextFilters: {
				answers: {
					team: [answerIdOf('team', 'Team A')],
					territory: [answerIdOf('territory', 'Store B')]
				},
				missing: ['team', 'position']
			}
		};

		expect(readMapViewSnapshot(snapshotToSearchParams(full), contextAttributes)).toEqual({
			...full,
			highlightLanguage: undefined
		});
	});

	it('reads back a fully populated grouped snapshot except the omitted layout', () => {
		const grouped: MapViewSnapshot = {
			group: 'dept',
			subGroup: 'role',
			layout: 'grouped',
			isolated: false,
			hiddenAssessments: ['Leader', 'Hostile'],
			hiddenValues: { dept: ['Front'], role: ['Server', 'Cook'] },
			hiddenLanguages: [],
			highlightLanguage: '',
			highlightQuery: '',
			expanded: [],
			expandedSub: [],
			contextFilters: emptyContextualFilters()
		};

		expect(readMapViewSnapshot(snapshotToSearchParams(grouped))).toEqual({
			...grouped,
			layout: undefined,
			highlightLanguage: undefined,
			highlightQuery: undefined
		});
	});

	it('reaches the canonical empty form when every field is default', () => {
		const atDefault = {
			group: '',
			subGroup: '',
			layout: 'grouped',
			isolated: false,
			hiddenAssessments: [],
			hiddenValues: {},
			hiddenLanguages: [],
			highlightLanguage: '',
			highlightQuery: '',
			expanded: [],
			expandedSub: [],
			contextFilters: emptyContextualFilters()
		} satisfies MapViewSnapshot;

		expect(readMapViewSnapshot(snapshotToSearchParams(atDefault))).toEqual({
			group: undefined,
			subGroup: undefined,
			layout: undefined,
			isolated: false,
			hiddenAssessments: [],
			hiddenValues: {},
			hiddenLanguages: [],
			highlightLanguage: undefined,
			expanded: [],
			expandedSub: [],
			contextFilters: emptyContextualFilters()
		});
	});
});

describe('knownHiddenLanguages', () => {
	it('keeps only Languages the worksite still lists', () => {
		const languages = [{ id: 'la1', name: 'Spanish' }];
		expect(knownHiddenLanguages(['la1', 'gone'], languages)).toEqual(['la1']);
	});
});

describe('knownHiddenValues', () => {
	const department = attributeFixture({
		id: 'dept',
		name: 'Department',
		kind: 'category',
		options: ['Kitchen', 'Floor']
	});

	it('keeps the hidden answers that the Attribute still holds, by id', () => {
		const kitchen = answerIdOf('dept', 'Kitchen');
		expect(knownHiddenValues({ dept: [kitchen] }, [department])).toEqual({ dept: [kitchen] });
	});

	it('drops a hidden value written as answer text, without an error', () => {
		// A link from before answers had ids carries the text, which names no answer.
		expect(knownHiddenValues({ dept: ['Kitchen'] }, [department])).toEqual({});
	});

	it('drops hidden values for an Attribute that is no longer configured', () => {
		expect(knownHiddenValues({ gone: [answerIdOf('gone', 'Any')] }, [department])).toEqual({});
	});

	it('keeps a hidden value of a second Attribute by id', () => {
		const storeB = answerIdOf('territory', 'Store B');
		expect(knownHiddenValues({ territory: [storeB] }, [department, territory])).toEqual({
			territory: [storeB]
		});
	});
});

describe('the contextual filters in the address', () => {
	it('reads the same ordinary Worker conditions the Workers view reads', () => {
		const snapshot = readMapViewSnapshot(
			params({
				f: [
					'team:' + answerIdOf('team', 'Team A'),
					'territory:' + answerIdOf('territory', 'Store B')
				],
				missing: ['team', 'position']
			}),
			contextAttributes
		);

		expect(snapshot.contextFilters).toEqual({
			answers: {
				team: [answerIdOf('team', 'Team A')],
				territory: [answerIdOf('territory', 'Store B')]
			},
			missing: ['team', 'position']
		});
	});

	it('drops a stale answer, Attribute or reading and keeps the valid conditions', () => {
		const snapshot = readMapViewSnapshot(
			params({
				f: ['team:gone', 'ghost:value', 'territory:' + answerIdOf('territory', 'Store B')],
				missing: ['gone']
			}),
			contextAttributes
		);

		expect(snapshot.contextFilters).toEqual({
			...emptyContextualFilters(),
			answers: { territory: [answerIdOf('territory', 'Store B')] }
		});
	});

	it('round-trips the conditions through the address', () => {
		const filters: ContextualFilters = {
			answers: {
				team: [answerIdOf('team', 'Team B')],
				territory: [answerIdOf('territory', 'Store A')]
			},
			missing: ['position']
		};
		const snapshot: MapViewSnapshot = {
			...atDefaultSnapshot(),
			contextFilters: filters
		};

		// The other fields are at their defaults, so the address omits them; the
		// conditions themselves must come back exactly.
		expect(
			readMapViewSnapshot(snapshotToSearchParams(snapshot), contextAttributes).contextFilters
		).toEqual(filters);
	});
});

/** The default view, so a test can vary one field. */
function atDefaultSnapshot(): MapViewSnapshot {
	return {
		group: '',
		subGroup: '',
		layout: 'grouped',
		isolated: false,
		hiddenAssessments: [],
		hiddenValues: {},
		hiddenLanguages: [],
		highlightLanguage: '',
		highlightQuery: '',
		expanded: [],
		expandedSub: [],
		contextFilters: emptyContextualFilters()
	};
}

describe('branch detail entries', () => {
	it('reads only the current Attribute’s ids, dropping malformed and foreign entries', () => {
		expect(readExpansionIds(['loc:central', 'job:cashier', 'nocolon', 'loc:'], 'loc')).toEqual([
			'central'
		]);
		expect(readExpansionIds(['loc:central'], '')).toEqual([]);
	});

	it('writes the ids in the given order and nothing for no Attribute', () => {
		expect(writeExpansionEntries('loc', ['central', 'store-a'])).toEqual([
			'loc:central',
			'loc:store-a'
		]);
		expect(writeExpansionEntries('', ['central'])).toEqual([]);
	});
});

describe('dropObsoleteViewParams', () => {
	it('drops the retired assignments parameter and reports the change', () => {
		const search = params({ group: 'dept', assignments: 'none', hq: 'x' });
		expect(dropObsoleteViewParams(search)).toBe(true);
		expect(search.get('assignments')).toBeNull();
		// Unrelated state survives in place.
		expect(search.get('group')).toBe('dept');
		expect(search.get('hq')).toBe('x');
	});

	it('reports no change when the parameter is absent', () => {
		const search = params({ group: 'dept', hq: 'x' });
		expect(dropObsoleteViewParams(search)).toBe(false);
		expect(search.toString()).toBe('group=dept&hq=x');
	});
});

describe('readSubGroup', () => {
	it('keeps a live Category other than the primary grouping', () => {
		expect(readSubGroup('role', ['dept', 'role'], 'dept')).toBe('role');
	});

	it('clears an empty, equal, unknown, or ungrouped value', () => {
		expect(readSubGroup('', ['dept', 'role'], 'dept')).toBe('');
		expect(readSubGroup('dept', ['dept', 'role'], 'dept')).toBe('');
		expect(readSubGroup('nope', ['dept', 'role'], 'dept')).toBe('');
		expect(readSubGroup('role', ['dept', 'role'], '')).toBe('');
	});
});

describe('E2 mapping hierarchy view state (e2e migration)', () => {
	it('normalizes a restored stale and foreign branch detail to the honoured branches', () => {
		// e2e/mapping-hierarchy-view-state.spec.ts › @ticket-07 a stale or foreign x entry normalizes away without an error or a false detail.
		const location = {
			id: 'loc',
			name: 'Location',
			kind: 'tag' as const,
			answers: [
				{ id: answerIdOf('loc', 'Central'), value: 'Central' },
				{
					id: answerIdOf('loc', 'Store A'),
					value: 'Store A',
					parentId: answerIdOf('loc', 'Central')
				},
				{
					id: answerIdOf('loc', 'Store B'),
					value: 'Store B',
					parentId: answerIdOf('loc', 'Central')
				}
			]
		};
		const entries = [
			encodeColonPair('loc', 'gone'),
			encodeColonPair('job', answerIdOf('job', 'Cashier'))
		];

		// The address keeps one entry per question: the foreign entry belongs to Job.
		expect(readExpansionIds(entries, 'loc')).toEqual(['gone']);
		expect(readExpansionIds(entries, 'job')).toEqual([answerIdOf('job', 'Cashier')]);
		// A removed answer normalizes away; a branch with children is honoured.
		expect(normalizeExpansion(location, readExpansionIds(entries, 'loc'))).toEqual([]);
		expect(normalizeExpansion(location, [answerIdOf('loc', 'Central')])).toEqual([
			answerIdOf('loc', 'Central')
		]);
	});
});
