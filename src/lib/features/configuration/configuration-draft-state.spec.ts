import { afterEach, describe, expect, it, vi } from 'vitest';

// The only seams mocked are system boundaries: SvelteKit's navigation refresh and
// Svelte's onDestroy, which needs a rendering component. The client encoding is real;
// the scripted fetch adapter answers it and records what the Rust core would receive.
// onDestroy needs a rendering component; the draft is built outside one here.
vi.mock('svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('svelte')>()),
	onDestroy: vi.fn()
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}) }));

import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { m } from '#lib/paraglide/messages.js';
import { UnsavedChanges } from '#lib/shared/unsaved-changes.svelte.ts';
import { scriptFetch } from '#lib/testing/http.ts';
import { ConfigurationDraftState } from './configuration-draft-state.svelte.ts';

function openDraft() {
	return new ConfigurationDraftState({
		attributes: [],
		agitations: [{ id: 'ag-1', text: 'Parking fees' }],
		languages: [{ id: 'lang-1', name: 'Spanish' }],
		worksite: { id: 'ws-1', name: 'Depot', committeeGoal: 10, committeeTarget: 10 },
		configurationDraft: { hasUnsavedChanges: false }
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('ConfigurationDraftState', () => {
	it('starts clean when opened on a saved Worksite', () => {
		const draft = openDraft();

		expect(draft.hasUnsavedDraft).toBe(false);
		expect(draft.dirtySections).toEqual([]);
	});

	it('is clean again when an edited name is typed back to the saved one', () => {
		const draft = openDraft();

		draft.worksiteName = 'Warehouse';
		expect(draft.hasUnsavedDraft).toBe(true);

		draft.worksiteName = 'Depot';
		expect(draft.hasUnsavedDraft).toBe(false);
	});

	it('is clean again when an added Agitation is removed', () => {
		const draft = openDraft();

		draft.newAgitationText = 'Short breaks';
		draft.addAgitation();
		expect(draft.hasUnsavedDraft).toBe(true);
		expect(draft.visibleAgitations.map((a) => a.text)).toEqual(['Parking fees', 'Short breaks']);

		const added = draft.visibleAgitations[1];
		draft.removeAgitation(added.id);
		expect(draft.hasUnsavedDraft).toBe(false);
	});

	it('discardAll puts every edit back to the saved Worksite', () => {
		const draft = openDraft();
		draft.worksiteName = 'Warehouse';
		draft.draftCommitteeGoal = '25';

		draft.discardAll();

		expect(draft.worksiteName).toBe('Depot');
		expect(draft.draftCommitteeGoal).toBe('10');
		expect(draft.hasUnsavedDraft).toBe(false);
	});

	it('keeps the draft and shows the error when a save fails', async () => {
		const { calls } = scriptFetch({
			'PUT /api/worksite': () => {
				throw new Error('disk full');
			}
		});
		const draft = openDraft();
		draft.worksiteName = 'Warehouse';

		await draft.saveAll();

		expect(draft.errorMessage).not.toBe('');
		expect(draft.worksiteName).toBe('Warehouse');
		expect(draft.hasUnsavedDraft).toBe(true);
		expect(draft.saving).toBe(false);
		// A failed save must not claim success; the error is announced by the bar instead.
		expect(draft.saveAnnouncement).toBe('');
		// The real client encoded the name the Rust core would have received.
		expect(calls).toEqual([{ method: 'PUT', path: '/api/worksite', body: { name: 'Warehouse' } }]);
	});

	it('retries a failed save with the same payload and clears the error on success', async () => {
		let attempts = 0;
		const { calls } = scriptFetch({
			'PUT /api/worksite': () => {
				attempts += 1;
				if (attempts === 1) throw new Error('disk full');
				return {};
			}
		});
		const draft = openDraft();
		draft.worksiteName = 'Warehouse';
		await draft.saveAll();

		await draft.saveAll();

		expect(calls).toEqual([
			{ method: 'PUT', path: '/api/worksite', body: { name: 'Warehouse' } },
			{ method: 'PUT', path: '/api/worksite', body: { name: 'Warehouse' } }
		]);
		expect(draft.errorMessage).toBe('');
		expect(draft.savedWorksiteName).toBe('Warehouse');
		expect(draft.hasUnsavedDraft).toBe(false);
		// The bar unmounts once the draft is clean, so the completion is recorded for the
		// persistent live region.
		expect(draft.saveAnnouncement).toBe(String(m.configuration_save_bar_saved()));
	});

	it('retries a failed Agitation save with the same Agitations, new one included', async () => {
		let attempts = 0;
		const { calls } = scriptFetch({
			'PUT /api/agitations': () => {
				attempts += 1;
				if (attempts === 1) throw new Error('offline');
				return {};
			}
		});
		const draft = openDraft();
		draft.newAgitationText = 'Short breaks';
		draft.addAgitation();
		await draft.saveAll();

		await draft.saveAll();

		const [first, second] = calls;
		expect(second).toEqual(first);
		expect(first.body).toEqual([
			{ id: 'ag-1', text: 'Parking fees' },
			{ id: expect.any(String), text: 'Short breaks' }
		]);
		expect(draft.hasUnsavedDraft).toBe(false);
	});

	it('asks before leaving a dirty draft, and cancelling keeps the draft', async () => {
		const draft = openDraft();
		const guard = new UnsavedChanges(() => draft.hasUnsavedDraft);
		draft.worksiteName = 'Warehouse';
		let switched = 0;

		await guard.request({
			title: 'Discard unsaved changes?',
			description: 'Switching Worksite.',
			confirmLabel: 'Switch',
			run: () => {
				switched += 1;
			}
		});
		expect(guard.open).toBe(true);
		expect(switched).toBe(0);

		guard.stay();

		expect(guard.open).toBe(false);
		expect(switched).toBe(0);
		expect(draft.worksiteName).toBe('Warehouse');
		expect(draft.hasUnsavedDraft).toBe(true);
	});

	it('switches Worksite without asking when the draft is clean', async () => {
		const draft = openDraft();
		const guard = new UnsavedChanges(() => draft.hasUnsavedDraft);
		let switched = 0;

		await guard.request({
			title: 't',
			description: 'd',
			confirmLabel: 'c',
			run: () => {
				switched += 1;
			}
		});

		expect(switched).toBe(1);
		expect(guard.open).toBe(false);
	});
});

describe('ConfigurationDraftState Attribute moves', () => {
	function openDraftWithAttributes(attributes: WorkerAttributeDefinition[]) {
		return new ConfigurationDraftState({
			attributes,
			agitations: [],
			languages: [],
			worksite: { id: 'ws-1', name: 'Depot', committeeGoal: 10, committeeTarget: 10 },
			configurationDraft: { hasUnsavedChanges: false }
		});
	}

	const savedAttributes: WorkerAttributeDefinition[] = [
		{
			id: 'region',
			name: 'Region',
			kind: 'category',
			answers: [
				{ id: 'central', value: 'Central' },
				{ id: 'store', value: 'Store A', parentId: 'central' },
				{ id: 'floor', value: 'Floor', parentId: 'store' },
				{ id: 'aisle', value: 'Aisle', parentId: 'floor' },
				{ id: 'shelf', value: 'Shelf', parentId: 'aisle' },
				{ id: 'north', value: 'North' }
			]
		},
		{
			id: 'site',
			name: 'Site',
			kind: 'tag',
			answers: [
				{ id: 'depot', value: 'Depot' },
				{ id: 'dock', value: 'Dock', parentId: 'depot' },
				{ id: 'bay', value: 'Bay 1', parentId: 'dock' }
			]
		}
	];

	function attributeIds(draft: ConfigurationDraftState) {
		return draft.draftAttributes.map((attribute) => attribute.id);
	}

	it('moves a deep branch into another Attribute, expands the target, and marks the draft dirty', () => {
		const draft = openDraftWithAttributes(savedAttributes);

		const moved = draft.moveAnswerToAttribute(
			{ attributeId: 'region', answerId: 'store' },
			{ attributeId: 'site', parentId: 'bay' }
		);

		expect(moved).toBe(true);
		expect(attributeIds(draft)).toEqual(['region', 'site']);
		expect(draft.draftAttributes[1].answers.map((answer) => answer.id)).toEqual([
			'depot',
			'dock',
			'bay',
			'store',
			'floor',
			'aisle',
			'shelf'
		]);
		expect(draft.expandedIds.has('site')).toBe(true);
		expect(draft.expandedIds.has('bay')).toBe(true);
		expect(draft.dirtyAttributes).toBe(true);
		expect(draft.hasUnsavedDraft).toBe(true);
	});

	it('refuses a move the core cannot take, names the reason on the source, and keeps the draft', () => {
		const draft = openDraftWithAttributes(savedAttributes);

		const moved = draft.moveAnswerToAttribute(
			{ attributeId: 'region', answerId: 'store' },
			{ attributeId: 'site', parentId: 'nope' }
		);

		expect(moved).toBe(false);
		expect(draft.draftAttributes[0].moveError).toBe(m.configuration_move_refused_target_missing());
		expect(draft.draftAttributes[0].answers).toHaveLength(6);
		expect(draft.hasUnsavedDraft).toBe(false);
	});

	it('does not move anything while a save is running', () => {
		const draft = openDraftWithAttributes(savedAttributes);
		draft.saving = true;

		const moved = draft.moveAnswerToAttribute(
			{ attributeId: 'region', answerId: 'store' },
			{ attributeId: 'site', parentId: 'bay' }
		);

		expect(moved).toBe(false);
		expect(attributeIds(draft)).toEqual(['region', 'site']);
		expect(draft.draftAttributes[0].answers).toHaveLength(6);
	});

	it('promotes a branch to a new Attribute after its source and expands it', () => {
		const draft = openDraftWithAttributes(savedAttributes);

		const promoted = draft.promoteAnswerToAttribute({ attributeId: 'region', answerId: 'store' });

		expect(promoted).toBe(true);
		expect(attributeIds(draft)).toEqual(['region', 'store', 'site']);
		expect(draft.expandedIds.has('store')).toBe(true);
		expect(draft.hasUnsavedDraft).toBe(true);
	});

	it('refuses a promotion whose label names an existing Attribute', () => {
		const draft = openDraftWithAttributes([
			{
				...savedAttributes[0],
				answers: [
					...savedAttributes[0].answers,
					{ id: 'site-label', value: 'site', parentId: 'north' }
				]
			},
			savedAttributes[1]
		]);

		const promoted = draft.promoteAnswerToAttribute({
			attributeId: 'region',
			answerId: 'site-label'
		});

		expect(promoted).toBe(false);
		expect(attributeIds(draft)).toEqual(['region', 'site']);
		expect(draft.draftAttributes[0].moveError).toBe(m.configuration_attribute_name_exists());
	});

	it('discardAll restores the saved configuration after a move and a promotion', () => {
		const draft = openDraftWithAttributes(savedAttributes);
		draft.moveAnswerToAttribute(
			{ attributeId: 'region', answerId: 'store' },
			{ attributeId: 'site', parentId: 'bay' }
		);
		draft.promoteAnswerToAttribute({ attributeId: 'region', answerId: 'north' });

		draft.discardAll();

		expect(attributeIds(draft)).toEqual(['region', 'site']);
		expect(draft.draftAttributes[0].answers.map((answer) => answer.id)).toEqual([
			'central',
			'store',
			'floor',
			'aisle',
			'shelf',
			'north'
		]);
		expect(draft.draftAttributes[1].answers.map((answer) => answer.id)).toEqual([
			'depot',
			'dock',
			'bay'
		]);
		expect(draft.expandedIds.size).toBe(0);
		expect(draft.hasUnsavedDraft).toBe(false);
	});
});

describe('ConfigurationDraftState five-level Attribute answers', () => {
	// Region: Central > Store A > Floor > Aisle > Shelf, and North > North 2 > North 3 > North 4 > North 5.
	const deepRegion: WorkerAttributeDefinition = {
		id: 'region',
		name: 'Region',
		kind: 'category',
		answers: [
			{ id: 'central', value: 'Central' },
			{ id: 'store', value: 'Store A', parentId: 'central' },
			{ id: 'floor', value: 'Floor', parentId: 'store' },
			{ id: 'aisle', value: 'Aisle', parentId: 'floor' },
			{ id: 'shelf', value: 'Shelf', parentId: 'aisle' },
			{ id: 'north', value: 'North' },
			{ id: 'north-2', value: 'North 2', parentId: 'north' },
			{ id: 'north-3', value: 'North 3', parentId: 'north-2' },
			{ id: 'north-4', value: 'North 4', parentId: 'north-3' },
			{ id: 'north-5', value: 'North 5', parentId: 'north-4' }
		]
	};

	function openDeep() {
		return new ConfigurationDraftState({
			attributes: [deepRegion],
			agitations: [],
			languages: [],
			worksite: { id: 'ws-1', name: 'Depot', committeeGoal: 10, committeeTarget: 10 },
			configurationDraft: { hasUnsavedChanges: false }
		});
	}

	function parentOf(draft: ConfigurationDraftState, answerId: string) {
		return draft.draftAttributes[0].answers.find((answer) => answer.id === answerId)?.parentId;
	}

	it('adds an answer at level 4 under level 3, and at level 5 under level 4', () => {
		const draft = openDeep();
		const region = draft.draftAttributes[0];

		region.newOption = 'Bay';
		expect(draft.addAttributeOption(region, 'floor')).not.toBeNull();
		region.newOption = 'Bin';
		expect(draft.addAttributeOption(region, 'aisle')).not.toBeNull();

		expect(region.answers.find((answer) => answer.value === 'Bay')?.parentId).toBe('floor');
		expect(region.answers.find((answer) => answer.value === 'Bin')?.parentId).toBe('aisle');
		expect(region.newOptionError).toBe('');
	});

	it('refuses a level-5 answer whose label repeats a sibling under the same level-4 parent', () => {
		const draft = openDeep();
		const region = draft.draftAttributes[0];
		region.newOption = 'Bin';
		draft.addAttributeOption(region, 'aisle');

		region.newOption = 'bin';
		expect(draft.addAttributeOption(region, 'aisle')).toBeNull();
		expect(region.newOptionError).toBe(m.configuration_option_exists());
		expect(region.answers.filter((answer) => answer.parentId === 'aisle')).toHaveLength(2);
	});

	it('renames a level-5 answer, and refuses a rename that repeats a level-5 sibling', () => {
		const draft = openDeep();
		const region = draft.draftAttributes[0];
		region.newOption = 'Bin';
		draft.addAttributeOption(region, 'aisle');
		const binId = region.answers.find((answer) => answer.value === 'Bin')?.id;

		expect(draft.renameAttributeAnswer('region', 'shelf', 'Shelf B')).toEqual({ status: 'ok' });
		expect(region.answers.find((answer) => answer.id === 'shelf')?.value).toBe('Shelf B');

		expect(draft.renameAttributeAnswer('region', 'shelf', 'bin')).toEqual({
			status: 'duplicate',
			survivorId: binId
		});
		expect(region.answers.find((answer) => answer.id === 'shelf')?.value).toBe('Shelf B');
	});

	it('renames a level-4 answer in place', () => {
		const draft = openDeep();

		expect(draft.renameAttributeAnswer('region', 'aisle', 'Aisle 2')).toEqual({ status: 'ok' });
		expect(draft.draftAttributes[0].answers.find((answer) => answer.id === 'aisle')?.value).toBe(
			'Aisle 2'
		);
	});

	it('moves a level-5 answer up to level 2 and accepts it', () => {
		const draft = openDeep();

		draft.moveAttributeAnswer('region', 'shelf', 'store');

		expect(parentOf(draft, 'shelf')).toBe('store');
		expect(draft.draftAttributes[0].moveError).toBe('');
		expect(draft.hasUnsavedDraft).toBe(true);
	});

	it('moves a level-2 branch under a level-5-deep answer outside it and accepts it', () => {
		const draft = openDeep();

		draft.moveAttributeAnswer('region', 'store', 'north-5');

		expect(parentOf(draft, 'store')).toBe('north-5');
		expect(parentOf(draft, 'floor')).toBe('store');
		expect(parentOf(draft, 'shelf')).toBe('aisle');
		expect(draft.draftAttributes[0].moveError).toBe('');
	});

	it('refuses to move an answer under its own level-5 descendant and keeps its parent', () => {
		const draft = openDeep();

		draft.moveAttributeAnswer('region', 'store', 'shelf');

		expect(draft.draftAttributes[0].moveError).toBe(m.configuration_move_below_descendant());
		expect(parentOf(draft, 'store')).toBe('central');
	});
});

describe('ConfigurationDraftState Short forms (ADR 0046)', () => {
	function openWith(answers: WorkerAttributeDefinition['answers']) {
		return new ConfigurationDraftState({
			attributes: [{ id: 'dept', name: 'Department', kind: 'category', answers }],
			agitations: [],
			languages: [],
			worksite: { id: 'ws-1', name: 'Depot', committeeGoal: 10, committeeTarget: 10 },
			configurationDraft: { hasUnsavedChanges: false }
		});
	}

	const stored = [
		{ id: 'a', value: 'Customer Service', shortForm: 'Cust. Svc.', shortFormOrigin: 'generated' },
		{ id: 'b', value: 'Maintenance', shortForm: 'MX', shortFormOrigin: 'edited' }
	] as const;

	it('editing a form makes the draft dirty and clearing it makes it clean again', () => {
		const draft = openWith([...stored]);

		draft.editShortForm('dept', 'a', 'CS');
		expect(draft.dirtyAttributes).toBe(true);
		expect(draft.draftAttributes[0].answers[0]).toMatchObject({
			shortForm: 'CS',
			shortFormOrigin: 'edited'
		});

		draft.editShortForm('dept', 'a', '');
		expect(draft.dirtyAttributes).toBe(false);
		expect(draft.draftAttributes[0].answers[0].shortFormOrigin).toBeUndefined();
	});

	it('clearing an edited form drops the stale suggestion until the core answers again', () => {
		const draft = openWith([...stored]);
		draft.suggestedShortForms.set('b', 'Maint.');

		draft.editShortForm('dept', 'b', '');

		expect(draft.shortFormShown(draft.draftAttributes[0].answers[1])).toBe('');
	});

	it('a rename drops a generated form and keeps an edited one', () => {
		const draft = openWith([...stored]);

		draft.renameAttributeAnswer('dept', 'a', 'Night Service');
		draft.renameAttributeAnswer('dept', 'b', 'Facilities');

		const [a, b] = draft.draftAttributes[0].answers;
		expect(a).toEqual({ id: 'a', value: 'Night Service' });
		expect(b).toMatchObject({ value: 'Facilities', shortForm: 'MX', shortFormOrigin: 'edited' });
	});

	it('shows the core suggestion for a generated value and the typed text for an edited one', () => {
		const draft = openWith([...stored]);
		draft.suggestedShortForms.set('a', 'Night Svc.');

		expect(draft.shortFormShown(draft.draftAttributes[0].answers[0])).toBe('Night Svc.');
		expect(draft.shortFormShown(draft.draftAttributes[0].answers[1])).toBe('MX');
	});

	it('blocks Save while an edited form is beyond the limit and allows it once it fits', () => {
		const draft = openWith([...stored]);

		draft.editShortForm('dept', 'a', 'Eleven char');
		expect(draft.canSave).toBe(false);

		draft.editShortForm('dept', 'a', 'Ten chars!!');
		expect(draft.canSave).toBe(false);
		draft.editShortForm('dept', 'a', 'Ten chars!');
		expect(draft.canSave).toBe(true);
	});

	it('saves an edited form with its origin and leaves a generated one to the core', async () => {
		const { calls } = scriptFetch({ 'PUT /api/attributes': () => ({}) });
		const draft = openWith([...stored]);
		draft.editShortForm('dept', 'a', 'CS');

		await draft.saveAll();

		expect(calls).toEqual([
			{
				method: 'PUT',
				path: '/api/attributes',
				body: [
					{
						id: 'dept',
						name: 'Department',
						kind: 'category',
						options: [
							{ id: 'a', value: 'Customer Service', shortForm: 'CS', shortFormOrigin: 'edited' },
							{ id: 'b', value: 'Maintenance', shortForm: 'MX', shortFormOrigin: 'edited' }
						]
					}
				]
			}
		]);
		// The saved configuration holds the edited forms, so the draft is clean afterwards.
		expect(draft.dirtyAttributes).toBe(false);
	});

	it('asks the core for suggestions without touching the save path', async () => {
		const { calls } = scriptFetch({
			'POST /api/configuration/short-forms': () => ({
				body: {
					shortForms: [
						{
							attributeId: 'dept',
							answerId: 'a',
							shortForm: 'Night Svc.',
							shortFormOrigin: 'generated'
						},
						{ attributeId: 'dept', answerId: 'b', shortForm: 'MX', shortFormOrigin: 'edited' }
					]
				}
			})
		});
		const draft = openWith([...stored]);
		draft.renameAttributeAnswer('dept', 'a', 'Night Service');

		await draft.loadSuggestions();

		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe('/api/configuration/short-forms');
		expect(draft.shortFormShown(draft.draftAttributes[0].answers[0])).toBe('Night Svc.');
		expect([...draft.suggestedShortForms.keys()]).toEqual(['a']);
	});
});
