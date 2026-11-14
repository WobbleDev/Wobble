/**
 * Pins the Configuration draft's editing and save-protocol surface as it behaves today, ahead
 * of splitting `configuration-draft-state.svelte.ts` by concern: the Attribute list, answer
 * ordering, shared Agitation and Language lists, the saving lock, and the preview-then-save
 * flow. Specced through the class with a scripted `fetch`; synthetic names only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('svelte')>()),
	onDestroy: vi.fn()
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}) }));

import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { scriptFetch } from '#lib/testing/http.ts';
import { ConfigurationDraftState } from './configuration-draft-state.svelte.ts';

afterEach(() => vi.unstubAllGlobals());

const attributes: WorkerAttributeDefinition[] = [
	{
		id: 'dept',
		name: 'Department',
		kind: 'category',
		answers: [
			{ id: 'front', value: 'Front' },
			{ id: 'back', value: 'Back' },
			{ id: 'tills', value: 'Tills', parentId: 'front' }
		]
	},
	{ id: 'shifts', name: 'Shifts', kind: 'tag', answers: [{ id: 'day', value: 'Day' }] }
];

function open(initial: WorkerAttributeDefinition[] = attributes) {
	return new ConfigurationDraftState({
		attributes: initial,
		agitations: [
			{ id: 'pay', text: 'Pay' },
			{ id: 'hours', text: 'Hours' }
		],
		languages: [
			{ id: 'greek', name: 'Greek' },
			{ id: 'latin', name: 'Latin' }
		],
		worksite: { id: 'ws-1', name: 'Harbour Depot', committeeGoal: 10, committeeTarget: 10 },
		configurationDraft: { hasUnsavedChanges: false }
	});
}

const submit = () => ({ preventDefault: vi.fn() }) as unknown as SubmitEvent;

describe('Attribute list', () => {
	it('adds an Attribute through the form, expands it and closes the form', () => {
		vi.stubGlobal('document', { getElementById: () => null });
		const draft = open();
		draft.openAddForm();
		expect(draft.addFormOpen).toBe(true);
		draft.addAttributeName = '  Seniority ';
		draft.addAttributeType = 'tag';
		const event = submit();
		draft.submitAddAttribute(event);
		expect(event.preventDefault).toHaveBeenCalled();
		const added = draft.draftAttributes.at(-1)!;
		expect(added).toMatchObject({ name: 'Seniority', type: 'tag', answers: [] });
		expect(draft.expandedIds.has(added.id)).toBe(true);
		expect(draft.addFormOpen).toBe(false);
		expect(draft.dirtyAttributes).toBe(true);
	});

	it('keeps the form open and shows the name error after a blank or duplicate name', () => {
		const draft = open();
		draft.openAddForm();
		expect(draft.addAttributeNameError).toBe('');
		draft.submitAddAttribute(submit());
		expect(draft.addAttempted).toBe(true);
		expect(draft.addAttributeNameError).not.toBe('');
		expect(draft.draftAttributes).toHaveLength(2);
		draft.addAttributeName = 'department';
		draft.submitAddAttribute(submit());
		expect(draft.draftAttributes).toHaveLength(2);
		expect(draft.addFormOpen).toBe(true);
	});

	it('resets the add form each time it opens', () => {
		const draft = open();
		draft.addAttributeName = 'stale';
		draft.addAttributeType = 'tag';
		draft.addAttempted = true;
		draft.openAddForm();
		expect([draft.addAttributeName, draft.addAttributeType, draft.addAttempted]).toEqual([
			'',
			'category',
			false
		]);
	});

	it('toggles an Attribute open and closed', () => {
		const draft = open();
		draft.toggleExpanded('dept');
		expect(draft.expandedIds.has('dept')).toBe(true);
		draft.toggleExpanded('dept');
		expect(draft.expandedIds.has('dept')).toBe(false);
	});

	it('moves an Attribute one place and reports a move that changes nothing', () => {
		const draft = open();
		expect(draft.moveAttribute('dept', -1)).toBe(false);
		expect(draft.moveAttribute('dept', 1)).toBe(true);
		expect(draft.draftAttributes.map((a) => a.id)).toEqual(['shifts', 'dept']);
		expect(draft.moveAttribute('dept', 1)).toBe(false);
	});

	it('asks before deleting, then removes the Attribute and closes the dialog', () => {
		const draft = open();
		draft.expandedIds.add('dept');
		draft.requestDeleteAttribute('dept');
		expect(draft.deleteDialogOpen).toBe(true);
		expect(draft.pendingDeleteAttribute?.name).toBe('Department');
		draft.deleteAttribute('dept');
		expect(draft.draftAttributes.map((a) => a.id)).toEqual(['shifts']);
		expect(draft.expandedIds.has('dept')).toBe(false);
		expect(draft.deleteDialogOpen).toBe(false);
		expect(draft.pendingDeleteAttribute).toBeUndefined();
	});
});

describe('Attribute answers', () => {
	it('refuses to remove a parent answer unless its branch goes too', () => {
		const draft = open();
		draft.removeAttributeOption('dept', 'front');
		expect(draft.draftAttributes[0]!.removalError).not.toBe('');
		expect(draft.draftAttributes[0]!.answers.map((a) => a.id)).toEqual(['front', 'back', 'tills']);
		draft.removeAttributeOption('dept', 'front', true);
		expect(draft.draftAttributes[0]!.answers.map((a) => a.id)).toEqual(['back']);
		expect(draft.draftAttributes[0]!.removalError).toBe('');
	});

	it('removes a leaf answer, and ignores an unknown Attribute', () => {
		const draft = open();
		draft.removeAttributeOption('dept', 'tills');
		expect(draft.answerOrder('dept')).toEqual(['front', 'back']);
		draft.removeAttributeOption('nope', 'x');
		expect(draft.answerOrder('nope')).toEqual([]);
	});

	it('orders siblings: a step reports its new place, an end returns null', () => {
		const draft = open();
		expect(draft.answerSiblingPlace('dept', 'front')).toEqual({ position: 1, count: 2 });
		expect(draft.moveAnswerSibling('dept', 'front', -1)).toBeNull();
		expect(draft.moveAnswerSibling('dept', 'front', 1)).toEqual({ position: 2, count: 2 });
		expect(draft.answerOrder('dept').indexOf('back')).toBeLessThan(
			draft.answerOrder('dept').indexOf('front')
		);
	});

	it('puts a value before or after a sibling, and refuses a non-sibling', () => {
		const draft = open();
		expect(draft.moveAnswerBeside('dept', 'back', 'front', false)).toBe(true);
		expect(draft.answerOrder('dept').slice(0, 2)).toEqual(['back', 'front']);
		expect(draft.moveAnswerBeside('dept', 'back', 'tills', true)).toBe(false);
		expect(draft.moveAnswerBeside('dept', 'back', 'back', true)).toBe(false);
	});

	it('restores a remembered answer order', () => {
		const draft = open();
		const before = draft.answerOrder('dept');
		draft.moveAnswerSibling('dept', 'front', 1);
		expect(draft.answerOrder('dept')).not.toEqual(before);
		draft.restoreAnswerOrder('dept', before);
		expect(draft.answerOrder('dept')).toEqual(before);
	});

	it('folds an answer into a sibling and keeps the draft dirty until Discard', () => {
		const draft = open();
		draft.mergeAttributeAnswer('dept', 'back', 'front');
		expect(draft.dirtyAttributes).toBe(true);
		draft.discardAll();
		expect(draft.dirtyAttributes).toBe(false);
		expect(draft.answerOrder('dept')).toEqual(['front', 'back', 'tills']);
	});
});

describe('Agitations and Languages', () => {
	it('adds through the form and refuses a duplicate with an error', () => {
		const draft = open();
		draft.newAgitationText = ' Breaks ';
		const event = submit();
		draft.submitAgitation(event);
		expect(event.preventDefault).toHaveBeenCalled();
		expect(draft.visibleAgitations.map((a) => a.text)).toEqual(['Pay', 'Hours', 'Breaks']);
		expect(draft.newAgitationText).toBe('');
		draft.newAgitationText = 'pay';
		draft.addAgitation();
		expect(draft.agitationError).not.toBe('');
		expect(draft.visibleAgitations).toHaveLength(3);

		draft.newLanguageName = 'Coptic';
		draft.submitLanguage(submit());
		expect(draft.visibleLanguages.map((l) => l.name)).toEqual(['Greek', 'Latin', 'Coptic']);
		draft.newLanguageName = 'greek';
		draft.addLanguage();
		expect(draft.languageError).not.toBe('');
	});

	it('renames only to a new, non-blank text and says why otherwise', () => {
		const draft = open();
		expect(draft.renameAgitation('pay', 'Wages')).toEqual({ status: 'ok' });
		expect(draft.visibleAgitations[0]!.text).toBe('Wages');
		expect(draft.renameAgitation('pay', ' ')).toEqual({ status: 'blank' });
		expect(draft.renameAgitation('pay', 'Hours')).toMatchObject({
			status: 'duplicate',
			survivorId: 'hours'
		});
		expect(draft.renameLanguage('greek', 'Hellenic')).toEqual({ status: 'ok' });
		expect(draft.renameLanguage('greek', 'Latin')).toMatchObject({ status: 'duplicate' });
		expect(draft.visibleLanguages[0]!.name).toBe('Hellenic');
	});

	it('removes, and folds an entry out of sight until Save', () => {
		const draft = open();
		draft.removeAgitation('hours');
		expect(draft.visibleAgitations.map((a) => a.id)).toEqual(['pay']);
		draft.mergeAgitation('pay', 'hours');
		draft.removeLanguage('latin');
		expect(draft.visibleLanguages.map((l) => l.id)).toEqual(['greek']);
		draft.mergeLanguage('greek', 'latin');
		expect(draft.dirtyAgitations).toBe(true);
		expect(draft.dirtyLanguages).toBe(true);
		draft.discardAll();
		expect(draft.visibleAgitations).toHaveLength(2);
		expect(draft.visibleLanguages).toHaveLength(2);
	});
});

describe('the saving lock', () => {
	it('ignores edits while a save is running', () => {
		const draft = open();
		draft.saving = true;
		draft.removeAttributeOption('dept', 'tills');
		draft.editAbbreviation('dept', 'front', 'F');
		expect(draft.moveAnswerSibling('dept', 'front', 1)).toBeNull();
		expect(draft.moveAnswerBeside('dept', 'back', 'front', false)).toBe(false);
		expect(draft.moveAttribute('dept', 1)).toBe(false);
		draft.requestDeleteAttribute('dept');
		draft.deleteAttribute('dept');
		draft.removeAgitation('pay');
		draft.mergeAgitation('pay', 'hours');
		draft.removeLanguage('greek');
		draft.mergeLanguage('greek', 'latin');
		draft.mergeAttributeAnswer('dept', 'back', 'front');
		draft.discardAll();
		draft.saving = false;
		expect(draft.hasUnsavedDraft).toBe(false);
		expect(draft.deleteDialogOpen).toBe(false);
		expect(draft.draftAttributes).toHaveLength(2);
	});
});

describe('the preview-then-save flow', () => {
	const lossyPreview = {
		base: 'base-1',
		changes: [
			{
				entity: 'agitation',
				id: 'pay',
				operation: 'remove',
				affectedWorkers: 2,
				lossyWorkers: 2,
				discardedValues: 0
			}
		],
		totals: { affectedWorkers: 2, lossyWorkers: 2, discardedValues: 0, affectedDrafts: 0 },
		removedAnswers: [],
		removedAttributes: [],
		cardinality: [],
		moves: [],
		attributeMoves: [],
		modeChanges: [],
		shortForms: [],
		abbreviations: []
	};

	it('saves a harmless edit straight away, with no preview request', async () => {
		const { calls } = scriptFetch({ 'PUT /api/worksite': () => ({ body: { worksite: {} } }) });
		const draft = open();
		draft.worksiteName = 'Dockside Depot';
		await draft.saveAll();
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['PUT /api/worksite']);
		expect(draft.hasUnsavedDraft).toBe(false);
		expect(draft.saveAnnouncement).not.toBe('');
		expect(draft.saving).toBe(false);
	});

	it('previews a removal, holds it for confirmation, and cancel keeps the draft', async () => {
		const { calls } = scriptFetch({
			'POST /api/configuration/preview': () => ({ body: lossyPreview })
		});
		const draft = open();
		draft.removeAgitation('pay');
		await draft.saveAll();
		expect(calls.map((call) => call.path)).toEqual(['/api/configuration/preview']);
		expect(draft.previewOpen).toBe(true);
		expect(draft.previewRequiresConfirmation).toBe(true);
		expect(draft.previewSharedLoss).toBe(true);
		expect(draft.previewTotals).toEqual(lossyPreview.totals);
		expect(draft.previewing).toBe(false);
		draft.cancelPreview();
		expect(draft.previewOpen).toBe(false);
		expect(draft.preview).toBeNull();
		expect(draft.dirtyAgitations).toBe(true);
	});

	it('confirming a preview hands back to the same save', async () => {
		const { calls } = scriptFetch({
			'POST /api/configuration/preview': () => ({ body: lossyPreview }),
			'PUT /api/agitations': () => ({})
		});
		const draft = open();
		draft.removeAgitation('pay');
		await draft.saveAll();
		draft.confirmPreview();
		await vi.waitFor(() => expect(draft.saving).toBe(false));
		await vi.waitFor(() => expect(draft.dirtyAgitations).toBe(false));
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			'POST /api/configuration/preview',
			'PUT /api/agitations'
		]);
	});

	it('saves without asking when the preview finds nothing to confirm', async () => {
		const { calls } = scriptFetch({
			'POST /api/configuration/preview': () => ({
				body: { ...lossyPreview, changes: [], totals: { ...lossyPreview.totals, lossyWorkers: 0 } }
			}),
			'PUT /api/agitations': () => ({})
		});
		const draft = open();
		draft.removeAgitation('pay');
		await draft.saveAll();
		expect(draft.previewOpen).toBe(false);
		expect(calls.map((call) => call.path)).toEqual([
			'/api/configuration/preview',
			'/api/agitations'
		]);
	});

	it('keeps the draft and shows the failure when the preview is refused', async () => {
		scriptFetch({
			'POST /api/configuration/preview': () => ({ status: 500, body: { message: 'Core is busy.' } })
		});
		const draft = open();
		draft.removeAgitation('pay');
		await draft.saveAll();
		expect(draft.previewOpen).toBe(false);
		expect(draft.errorMessage).not.toBe('');
		expect(draft.showSaveBar).toBe(true);
		expect(draft.dirtyAgitations).toBe(true);
		expect(draft.previewing).toBe(false);
	});

	it('discarding closes an open preview and clears every error', async () => {
		scriptFetch({ 'POST /api/configuration/preview': () => ({ body: lossyPreview }) });
		const draft = open();
		draft.removeAgitation('pay');
		await draft.saveAll();
		draft.errorMessage = 'old';
		draft.discardAll();
		expect(draft.previewOpen).toBe(false);
		expect(draft.errorMessage).toBe('');
		expect(draft.hasUnsavedDraft).toBe(false);
	});

	it('keeps the save failure on screen and the draft intact', async () => {
		scriptFetch({ 'PUT /api/worksite': () => ({ status: 500, body: { message: 'Disk full.' } }) });
		const draft = open();
		draft.worksiteName = 'Dockside Depot';
		await draft.saveAll();
		expect(draft.errorMessage).not.toBe('');
		expect(draft.saving).toBe(false);
		expect(draft.hasUnsavedDraft).toBe(true);
	});

	it('retries only the data refresh', async () => {
		const draft = open();
		await draft.retryRefresh();
		expect(draft.saving).toBe(false);
		expect(draft.refreshErrorMessage).toBe('');
	});
});
