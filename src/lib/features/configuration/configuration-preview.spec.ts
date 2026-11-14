import { describe, expect, it } from 'vitest';
import type { ConfigurationPreview, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { decodeConfigurationPreview } from '#lib/client/api-decode.ts';
import { ApiError } from '#lib/client/api-error.ts';
import { fromWorkerAttributeDefinitions, type AttributeDraft } from './attribute-draft.ts';
import type { ConfigurationDraft } from './configuration-draft.ts';
import {
	buildResolutionGroups,
	hasPreviewableAttributeChanges,
	hasPreviewableConfigurationChanges,
	hasPreviewableSharedChanges,
	configurationSaveFailureMessage,
	holderKey,
	previewFailureMessage,
	previewRequest,
	previewRequestKey,
	previewRequiresConfirmation,
	previewSummarySentence,
	resolutionsComplete,
	resolutionsFromPreview,
	summarizePreview,
	type PreviewHolderChoices,
	type PreviewVocabulary
} from './configuration-preview.ts';

const department: WorkerAttributeDefinition = {
	id: 'dept',
	name: 'Department',
	kind: 'category',
	answers: [
		{ id: 'packing', value: 'Packing' },
		{ id: 'delivery', value: 'Delivery' }
	]
};

const roles: WorkerAttributeDefinition = {
	id: 'roles',
	name: 'Roles',
	kind: 'tag',
	answers: [
		{ id: 'trainer', value: 'Trainer' },
		{ id: 'steward', value: 'Steward' }
	]
};

const saved: WorkerAttributeDefinition[] = [department, roles];

function draftOf(overrides: Partial<ConfigurationDraft> = {}): ConfigurationDraft {
	return {
		worksiteName: 'Worksite',
		savedWorksiteName: 'Worksite',
		draftCommitteeGoal: '5',
		savedCommitteeGoal: 5,
		draftAttributes: fromWorkerAttributeDefinitions(saved),
		savedConfiguration: saved,
		draftAgitations: [{ id: 'equipment', text: 'Equipment' }],
		savedAgitations: [{ id: 'equipment', text: 'Equipment' }],
		draftLanguages: [{ id: 'english', name: 'English' }],
		savedLanguages: [{ id: 'english', name: 'English' }],
		addFormOpen: false,
		newAgitationText: '',
		newLanguageName: '',
		...overrides
	};
}

function drafts(attributes: WorkerAttributeDefinition[]): AttributeDraft[] {
	return fromWorkerAttributeDefinitions(attributes);
}

function draftWith(
	attribute: WorkerAttributeDefinition,
	answers: AttributeDraft['answers']
): AttributeDraft {
	const draft = fromWorkerAttributeDefinitions([attribute])[0];
	return { ...draft, answers };
}

/** The department draft with changed answers, keeping the untouched Roles draft beside it. */
function departmentDraft(answers: AttributeDraft['answers']): AttributeDraft[] {
	return [draftWith(department, answers), drafts([roles])[0]];
}

function totalsOf(affectedWorkers = 0, lossyWorkers = 0, discardedValues = 0, affectedDrafts = 0) {
	return { affectedWorkers, lossyWorkers, discardedValues, affectedDrafts };
}

function previewOf(overrides: Partial<ConfigurationPreview> = {}): ConfigurationPreview {
	return {
		base: 'base-1',
		changes: [],
		totals: totalsOf(),
		removedAnswers: [],
		removedAttributes: [],
		cardinality: [],
		moves: [],
		attributeMoves: [],
		modeChanges: [],
		shortForms: [],
		abbreviations: [],
		...overrides
	};
}

function workerHolder(overrides: Record<string, unknown> = {}) {
	return {
		workerId: 'w1',
		workerName: 'Ada',
		kind: 'worker' as const,
		emptyIfUnanswered: true,
		value: 'packing',
		replacements: [{ answerId: 'delivery', resultingValue: 'delivery' }],
		...overrides
	};
}

function draftHolder(overrides: Record<string, unknown> = {}) {
	return {
		workerId: 'w2',
		workerName: 'Bea',
		kind: 'workerDraft' as const,
		surface: 'base' as const,
		emptyIfUnanswered: true,
		value: ['packing', 'delivery'],
		replacements: [{ answerId: 'delivery', resultingValue: ['delivery'] }],
		...overrides
	};
}

function removedAnswer(overrides: Record<string, unknown> = {}) {
	return {
		attributeId: 'dept',
		answerId: 'packing',
		affectedWorkers: 2,
		affectedDrafts: 1,
		removedValues: 2,
		holders: [workerHolder(), draftHolder()],
		...overrides
	};
}

const vocabulary: PreviewVocabulary = {
	savedAgitations: [{ id: 'equipment', text: 'Equipment' }],
	draftAgitations: [{ id: 'equipment', text: 'Equipment' }],
	savedLanguages: [{ id: 'english', name: 'English' }],
	draftLanguages: [{ id: 'english', name: 'English' }]
};

describe('Product gap 12 preview decoding', () => {
	it('Product gap 12 decodes every change field and the totals', () => {
		const decoded = decodeConfigurationPreview({
			base: 'base-1',
			removedAnswers: [],
			moves: [],
			changes: [
				{
					entity: 'attribute',
					id: 'dept',
					operation: 'remove',
					affectedWorkers: 3,
					lossyWorkers: 3,
					discardedValues: 3
				},
				{
					entity: 'answer',
					id: 'trainer',
					attributeId: 'roles',
					operation: 'merge',
					survivorId: 'steward',
					affectedWorkers: 2,
					lossyWorkers: 0,
					discardedValues: 0
				},
				{
					entity: 'attribute',
					id: 'roles',
					operation: 'convert',
					affectedWorkers: 3,
					lossyWorkers: 1,
					discardedValues: 1
				}
			],
			totals: totalsOf(3, 1, 1, 2)
		});

		expect(decoded.changes).toEqual([
			{
				entity: 'attribute',
				id: 'dept',
				operation: 'remove',
				affectedWorkers: 3,
				lossyWorkers: 3,
				discardedValues: 3
			},
			{
				entity: 'answer',
				id: 'trainer',
				attributeId: 'roles',
				operation: 'merge',
				survivorId: 'steward',
				affectedWorkers: 2,
				lossyWorkers: 0,
				discardedValues: 0
			},
			{
				entity: 'attribute',
				id: 'roles',
				operation: 'convert',
				affectedWorkers: 3,
				lossyWorkers: 1,
				discardedValues: 1
			}
		]);
		expect(decoded.totals).toEqual(totalsOf(3, 1, 1, 2));
		expect(decoded.base).toBe('base-1');
		expect(decoded.removedAnswers).toEqual([]);
	});

	it('Product gap 12 decodes a Worker value holder and a Worker draft surface', () => {
		const decoded = decodeConfigurationPreview({
			...previewOf(),
			removedAnswers: [removedAnswer()]
		});

		expect(decoded.removedAnswers[0].holders).toEqual([
			{
				workerId: 'w1',
				workerName: 'Ada',
				kind: 'worker',
				emptyIfUnanswered: true,
				value: 'packing',
				replacements: [{ answerId: 'delivery', resultingValue: 'delivery' }]
			},
			{
				workerId: 'w2',
				workerName: 'Bea',
				kind: 'workerDraft',
				surface: 'base',
				emptyIfUnanswered: true,
				value: ['packing', 'delivery'],
				replacements: [{ answerId: 'delivery', resultingValue: ['delivery'] }]
			}
		]);
		expect(decoded.removedAnswers[0].affectedDrafts).toBe(1);
	});
});

describe('Product gap 12 preview request', () => {
	it('Product gap 12 sends all three sets in their Save shapes with merge markers', () => {
		const draft = draftOf({
			draftAttributes: [
				draftWith(roles, [
					{ id: 'trainer', value: 'Trainer' },
					{ id: 'steward', value: 'Steward' },
					{ id: 'folded', value: 'Old', mergedInto: 'steward' }
				])
			],
			draftAgitations: [{ id: 'equipment', text: 'Equipment', mergedInto: 'parking' }],
			draftLanguages: [{ id: 'english', name: 'English' }]
		});

		const request = previewRequest(draft);

		expect(request.attributes).toEqual([
			{
				id: 'roles',
				name: 'Roles',
				kind: 'tag',
				options: [
					{ id: 'trainer', value: 'Trainer' },
					{ id: 'steward', value: 'Steward' },
					{ id: 'folded', value: 'Old', mergedInto: 'steward' }
				]
			}
		]);
		// AC14: a Save payload carries no scope or inference metadata.
		expect(Object.keys(request.attributes[0]).sort()).toEqual(['id', 'kind', 'name', 'options']);
		expect(request.agitations).toEqual([
			{ id: 'equipment', text: 'Equipment', mergedInto: 'parking' }
		]);
		expect(request.languages).toEqual([{ id: 'english', name: 'English' }]);
		expect(previewRequestKey(request)).toBe(JSON.stringify(request));
	});
});

describe('Product gap 12 preview trigger and confirmation', () => {
	it('Product gap 12 only previews stored removals, merges, type changes and moves', () => {
		expect(hasPreviewableAttributeChanges(draftOf())).toBe(false);
		// A change to an answer's label, order or a new answer is harmless.
		expect(
			hasPreviewableAttributeChanges(
				draftOf({
					draftAttributes: departmentDraft([
						{ id: 'delivery', value: 'Delivery' },
						{ id: 'packing', value: 'Packaging' },
						{ id: 'extra', value: 'Extra' }
					])
				})
			)
		).toBe(false);
		expect(
			hasPreviewableAttributeChanges(
				draftOf({
					draftAttributes: [{ ...drafts([department])[0], type: 'tag' }, drafts([roles])[0]]
				})
			)
		).toBe(true);
		expect(
			hasPreviewableAttributeChanges(
				draftOf({
					draftAttributes: departmentDraft([{ id: 'packing', value: 'Packing' }])
				})
			)
		).toBe(true);
		expect(
			hasPreviewableAttributeChanges(
				draftOf({
					draftAttributes: departmentDraft([
						{ id: 'packing', value: 'Packing', parentId: 'delivery' },
						{ id: 'delivery', value: 'Delivery' }
					])
				})
			)
		).toBe(true);
		expect(
			hasPreviewableAttributeChanges(
				draftOf({
					draftAttributes: departmentDraft([
						{ id: 'packing', value: 'Packing', mergedInto: 'delivery' },
						{ id: 'delivery', value: 'Delivery' }
					])
				})
			)
		).toBe(true);
	});

	it('Product gap 13 previews saved shared removals and merges, not harmless edits', () => {
		expect(
			hasPreviewableSharedChanges(
				draftOf({ draftAgitations: [{ id: 'equipment', text: 'Equipment!' }] })
			)
		).toBe(false);
		expect(hasPreviewableSharedChanges(draftOf({ draftAgitations: [] }))).toBe(true);
		expect(
			hasPreviewableSharedChanges(
				draftOf({
					draftLanguages: [{ id: 'english', name: 'English', mergedInto: 'spanish' }]
				})
			)
		).toBe(true);
		expect(
			hasPreviewableConfigurationChanges(
				draftOf({ draftLanguages: [{ id: 'english', name: 'English!' }] })
			)
		).toBe(false);
		expect(
			hasPreviewableConfigurationChanges(
				draftOf({
					draftAttributes: departmentDraft([{ id: 'packing', value: 'Packing' }])
				})
			)
		).toBe(true);
	});

	it('Product gap 12 requires confirmation only when values are actually lost', () => {
		expect(previewRequiresConfirmation(previewOf())).toBe(false);
		expect(previewRequiresConfirmation(previewOf({ totals: totalsOf(2, 0, 0) }))).toBe(false);
		expect(previewRequiresConfirmation(previewOf({ totals: totalsOf(2, 1, 0) }))).toBe(true);
		expect(previewRequiresConfirmation(previewOf({ totals: totalsOf(2, 0, 1) }))).toBe(true);
	});
});

describe('Product gap 12 preview presentation', () => {
	it('Product gap 12 resolves current labels from ids and states preservation', () => {
		const preview = previewOf({
			changes: [
				{
					entity: 'answer',
					id: 'trainer',
					attributeId: 'roles',
					operation: 'merge',
					survivorId: 'steward',
					affectedWorkers: 2,
					lossyWorkers: 0,
					discardedValues: 0
				},
				{
					entity: 'attribute',
					id: 'dept',
					operation: 'convert',
					affectedWorkers: 0,
					lossyWorkers: 0,
					discardedValues: 0
				}
			]
		});

		const rows = summarizePreview(preview, saved, drafts(saved));

		expect(rows[0].title).toContain('Trainer');
		expect(rows[0].title).toContain('Steward');
		expect(rows[0].lossy).toBe(false);
		expect(rows[1].title).toContain('Department');
		expect(rows[1].detail).toContain('No values are discarded.');
	});

	it('Product gap 12 states the overall effect with deduplicated totals', () => {
		expect(
			previewSummarySentence(totalsOf(3, 0, 0), [
				{
					entity: 'attribute',
					id: 'dept',
					operation: 'remove',
					affectedWorkers: 3,
					lossyWorkers: 0,
					discardedValues: 0
				}
			])
		).toContain('No Worker values are discarded');
		expect(
			previewSummarySentence(totalsOf(3, 2, 2), [
				{
					entity: 'answer',
					id: 'packing',
					attributeId: 'dept',
					operation: 'remove',
					affectedWorkers: 2,
					lossyWorkers: 2,
					discardedValues: 2
				}
			])
		).toContain('would be discarded');
		expect(previewSummarySentence(totalsOf(0, 0, 0), [])).toContain('No Worker values');
	});

	it('Product gap 12 explains a failed preview in UI words, never the diagnostic', () => {
		expect(
			previewFailureMessage(new ApiError(400, 'diagnostic', 'invalid_configuration_preview'))
		).toBe(
			'Wobble could not check these changes. Your draft is still here — review it and try again.'
		);
	});

	it('Product gap 13 resolves shared labels and states removal and preservation', () => {
		const preview = previewOf({
			changes: [
				{
					entity: 'agitation',
					id: 'equipment',
					operation: 'remove',
					affectedWorkers: 2,
					lossyWorkers: 2,
					discardedValues: 2
				},
				{
					entity: 'language',
					id: 'english',
					operation: 'merge',
					survivorId: 'spanish',
					affectedWorkers: 1,
					lossyWorkers: 0,
					discardedValues: 0
				}
			]
		});

		const rows = summarizePreview(preview, saved, drafts(saved), vocabulary);

		expect(rows[0].title).toContain('Equipment');
		expect(rows[0].detail).toContain('discards');
		expect(rows[1].title).toContain('English');
		expect(rows[1].title).toContain('spanish');
		expect(rows[1].detail).toContain('nothing is discarded');
	});

	it('Product gap 13 falls back to ids without the draft vocabulary', () => {
		const preview = previewOf({
			changes: [
				{
					entity: 'language',
					id: 'unlisted',
					operation: 'remove',
					affectedWorkers: 0,
					lossyWorkers: 0,
					discardedValues: 0
				}
			]
		});

		expect(summarizePreview(preview, saved, drafts(saved))[0].title).toContain('unlisted');
	});

	it('Product gap 13 phrases shared-only, mixed and Attribute-only totals', () => {
		const sharedChange = {
			entity: 'agitation' as const,
			id: 'equipment',
			operation: 'merge' as const,
			survivorId: 'parking',
			affectedWorkers: 2,
			lossyWorkers: 0,
			discardedValues: 2
		};
		expect(previewSummarySentence(totalsOf(2, 0, 0), [sharedChange])).toContain(
			'No saved values are discarded'
		);
		expect(previewSummarySentence(totalsOf(2, 0, 2), [sharedChange])).toContain(
			'would be discarded'
		);
		const attributeChange = {
			entity: 'attribute' as const,
			id: 'dept',
			operation: 'convert' as const,
			affectedWorkers: 2,
			lossyWorkers: 0,
			discardedValues: 0
		};
		expect(previewSummarySentence(totalsOf(2, 0, 0), [sharedChange, attributeChange])).toContain(
			'No saved values are discarded'
		);
		expect(previewSummarySentence(totalsOf(2, 0, 2), [sharedChange, attributeChange])).toContain(
			'would be discarded'
		);
	});
});

describe('Product gap 12 — preview failure copy', () => {
	it('maps the preview code to UI copy instead of showing the core diagnostic', () => {
		expect(previewFailureMessage(new ApiError(409, 'nope', 'configuration_merge_invalid'))).toBe(
			'Only a leaf value can merge into a kept leaf of the same Attribute.'
		);
		expect(
			previewFailureMessage(new ApiError(409, 'nope', 'configuration_sibling_label_conflict'))
		).toContain('already uses this name');
		expect(
			previewFailureMessage(new ApiError(409, 'nope', 'configuration_answer_has_children'))
		).toContain('children');
	});

	it('stays generic for an unmapped failure', () => {
		expect(previewFailureMessage(new Error('offline'))).toBe(
			'Could not check these changes. Your draft is still here.'
		);
	});

	it('names a refused relocation in UI words on preview and Save', () => {
		const error = new ApiError(409, 'nope', 'configuration_hierarchy_invalid');
		expect(previewFailureMessage(error)).toContain('hierarchy');
		expect(configurationSaveFailureMessage(error)).toContain('hierarchy');
	});

	it('maps the Save refusals, including the lost-resolution codes', () => {
		expect(
			configurationSaveFailureMessage(
				new ApiError(409, 'nope', 'configuration_resolution_required')
			)
		).toContain('resolution');
		expect(
			configurationSaveFailureMessage(new ApiError(409, 'nope', 'stale_configuration_preview'))
		).toContain('changed');
		expect(
			configurationSaveFailureMessage(
				new ApiError(400, 'nope', 'configuration_replacement_invalid')
			)
		).toContain('replacement');
		expect(configurationSaveFailureMessage(new Error('offline'))).toBe(
			'Could not save these Configuration changes. Your draft is still here.'
		);
	});
});

describe('Ticket 11 moved branch preview', () => {
	const move = {
		attributeId: 'dept',
		answerId: 'packing',
		parentId: 'delivery',
		previousPath: ['Packing'],
		path: ['Delivery', 'Packing'],
		subtreeAnswerIds: ['packing'],
		affectedWorkers: 2,
		holders: [
			{
				workerId: 'w1',
				workerName: 'Ada',
				kind: 'worker' as const,
				heldAnswerId: 'packing',
				previousPath: ['Packing'],
				path: ['Delivery', 'Packing']
			}
		]
	};

	it('decodes every moved branch field, including a Worker holder', () => {
		const decoded = decodeConfigurationPreview({
			...previewOf(),
			moves: [move]
		});

		expect(decoded.moves).toEqual([move]);
	});

	it('states the destination, preserved holders and both paths', () => {
		const preview = previewOf({
			changes: [
				{
					entity: 'answer',
					id: 'packing',
					attributeId: 'dept',
					operation: 'move',
					affectedWorkers: 2,
					lossyWorkers: 0,
					discardedValues: 0
				}
			],
			moves: [move],
			totals: totalsOf(2, 0, 0)
		});

		const rows = summarizePreview(preview, saved, drafts(saved));

		expect(rows[0].title).toContain('Delivery');
		expect(rows[0].detail).toContain('Packing');
		expect(rows[0].detail).toContain('Delivery / Packing');
		expect(rows[0].detail).toContain('2 Workers');
	});

	it('reads a move-only summary as lossless', () => {
		const preview = previewOf({
			changes: [
				{
					entity: 'answer',
					id: 'packing',
					attributeId: 'dept',
					operation: 'move',
					affectedWorkers: 2,
					lossyWorkers: 0,
					discardedValues: 0
				}
			],
			moves: [move],
			totals: totalsOf(2, 0, 0)
		});

		expect(previewSummarySentence(preview.totals, preview.changes, [], [], [])).toContain(
			'No values are discarded'
		);
	});
});

describe('Ticket 09 removed value resolutions', () => {
	it('groups every affected holder with the current labels', () => {
		const preview = previewOf({
			removedAnswers: [removedAnswer()],
			changes: [
				{
					entity: 'answer',
					id: 'packing',
					attributeId: 'dept',
					operation: 'remove',
					affectedWorkers: 2,
					lossyWorkers: 2,
					discardedValues: 2
				}
			],
			totals: totalsOf(2, 2, 2, 1)
		});

		const groups = buildResolutionGroups(preview, saved, drafts(saved), {});

		expect(groups).toHaveLength(1);
		expect(groups[0].title).toContain('Packing');
		expect(groups[0].detail).toContain('2 Workers');
		expect(groups[0].rows).toHaveLength(2);
		expect(groups[0].rows[0]).toMatchObject({
			workerId: 'w1',
			workerName: 'Ada',
			kind: 'worker',
			emptyIfUnanswered: true,
			summary: 'Department: Packing',
			replacements: [{ answerId: 'delivery', label: 'Delivery' }]
		});
		expect(groups[0].rows[0].key).not.toBe(groups[0].rows[1].key);
		expect(groups[0].rows[1]).toMatchObject({
			kind: 'workerDraft',
			surface: 'base',
			summary: 'Department: Packing, Delivery'
		});
		expect(holderKey('dept', 'packing', 'w1', 'worker')).not.toBe(
			holderKey('dept', 'packing', 'w1', 'draft')
		);
	});

	it('requires an explicit resolution for each holder, including no answer', () => {
		const preview = previewOf({ removedAnswers: [removedAnswer()] });
		const groups = buildResolutionGroups(preview, saved, drafts(saved), {});
		expect(resolutionsComplete(groups)).toBe(false);
		// A replacement that the preview never offered is not an explicit resolution.
		const invalid: PreviewHolderChoices = {};
		for (const row of groups[0].rows) invalid[row.key] = { replacement: 'unknown' };
		expect(resolutionsComplete(buildResolutionGroups(preview, saved, drafts(saved), invalid))).toBe(
			false
		);

		const choices: PreviewHolderChoices = {};
		for (const row of groups[0].rows) choices[row.key] = { replacement: 'delivery' };
		expect(resolutionsComplete(buildResolutionGroups(preview, saved, drafts(saved), choices))).toBe(
			true
		);

		const emptied = { ...choices };
		emptied[groups[0].rows[0].key] = { replacement: null };
		expect(resolutionsComplete(buildResolutionGroups(preview, saved, drafts(saved), emptied))).toBe(
			true
		);
	});

	it('sends one Worker resolution per holder and no retired bookkeeping', () => {
		const preview = previewOf({ removedAnswers: [removedAnswer()] });
		const groups = buildResolutionGroups(preview, saved, drafts(saved), {});
		const choices: PreviewHolderChoices = {};
		for (const row of groups[0].rows) choices[row.key] = { replacement: 'delivery' };

		const resolutions = resolutionsFromPreview(
			preview,
			buildResolutionGroups(preview, saved, drafts(saved), choices)
		);

		expect(resolutions.removedAnswers).toEqual([
			{
				attributeId: 'dept',
				answerId: 'packing',
				holders: [
					{ workerId: 'w1', replacement: 'delivery' },
					{ workerId: 'w2', surface: 'base', replacement: 'delivery' }
				]
			}
		]);
		expect(resolutions).not.toHaveProperty('consolidations');
	});

	it('states the resolution workload in the overall summary', () => {
		expect(previewSummarySentence(totalsOf(2, 2, 2, 1), [], [removedAnswer()], [], [])).toContain(
			'2 Workers'
		);
	});
});

describe('Ticket 10 merged value resolutions', () => {
	it('presents the surviving value as the only merge outcome, selected by default', () => {
		const preview = previewOf({
			removedAnswers: [removedAnswer({ mergeInto: 'delivery' })]
		});

		const groups = buildResolutionGroups(preview, saved, drafts(saved), {});

		expect(groups[0].mergeInto).toBe('delivery');
		expect(groups[0].title).toContain('Packing');
		expect(groups[0].title).toContain('Delivery');
		expect(groups[0].detail).toContain('follow the surviving Delivery value');
		expect(groups[0].rows[0].choice).toEqual({ replacement: 'delivery' });
		expect(resolutionsComplete(groups)).toBe(true);
		expect(resolutionsFromPreview(preview, groups).removedAnswers[0].holders).toEqual([
			{ workerId: 'w1', replacement: 'delivery' },
			{ workerId: 'w2', surface: 'base', replacement: 'delivery' }
		]);
	});
});

describe('Ticket 14 whole-Attribute removal resolutions', () => {
	it('groups every holder of the removed Attribute and acknowledges it', () => {
		const preview = previewOf({
			removedAttributes: [
				{
					attributeId: 'dept',
					answerIds: ['packing', 'delivery'],
					affectedWorkers: 1,
					affectedDrafts: 0,
					removedValues: 1,
					holders: [workerHolder({ value: ['packing', 'delivery'] })]
				}
			]
		});

		const groups = buildResolutionGroups(preview, saved, drafts(saved), {});

		expect(groups).toHaveLength(1);
		expect(groups[0].removedAttributeId).toBe('dept');
		expect(groups[0].detail).toContain('1 Worker affected');
		expect(groups[0].rows[0].attributeRemoval).toBe(true);
		expect(groups[0].rows[0].summary).toBe('Department: Packing, Delivery');
		expect(resolutionsComplete(groups)).toBe(true);
		expect(resolutionsFromPreview(preview, groups).removedAttributes).toEqual([
			{ attributeId: 'dept' }
		]);
	});

	it('states the Attribute removal workload in the overall summary', () => {
		expect(
			previewSummarySentence(
				totalsOf(2, 2, 2, 1),
				[],
				[],
				[
					{
						attributeId: 'dept',
						answerIds: ['packing'],
						affectedWorkers: 2,
						affectedDrafts: 1,
						removedValues: 2,
						holders: []
					}
				],
				[]
			)
		).toContain('2 Workers');
	});

	it('names an unused Attribute removal as clean, with no resolution workload', () => {
		const summary = previewSummarySentence(
			totalsOf(0, 0, 0),
			[],
			[],
			[
				{
					attributeId: 'shifts',
					answerIds: ['days'],
					affectedWorkers: 0,
					affectedDrafts: 0,
					removedValues: 0,
					holders: []
				}
			],
			[]
		);

		expect(summary).toContain('No Worker values are discarded');
		expect(summary).not.toContain('explicit resolution');
	});
});

describe('Ticket 15 Multi-Select to Single-Select resolutions', () => {
	const cardinality = {
		attributeId: 'roles',
		from: 'tag' as const,
		to: 'category' as const,
		holders: [
			{
				workerId: 'ada',
				workerName: 'Ada',
				surface: 'value' as const,
				held: ['trainer', 'steward'],
				hasDraft: true
			},
			{
				workerId: 'bea',
				workerName: 'Bea',
				surface: 'draft' as const,
				held: ['trainer', 'steward'],
				hasDraft: true
			}
		]
	};

	it('names each lossy Worker value, draft update, and draft base with its values', () => {
		const preview = previewOf({ cardinality: [cardinality] });
		const groups = buildResolutionGroups(preview, saved, drafts(saved), {});

		expect(groups).toHaveLength(1);
		expect(groups[0].cardinalityAttributeId).toBe('roles');
		expect(groups[0].rows[0]).toMatchObject({
			kind: 'worker',
			cardinalitySurface: 'value',
			summary: 'Roles: Trainer, Steward',
			heldAnswers: [
				{ answerId: 'trainer', label: 'Trainer' },
				{ answerId: 'steward', label: 'Steward' }
			]
		});
		expect(groups[0].rows[1]).toMatchObject({
			kind: 'workerDraft',
			surface: 'draft',
			cardinalitySurface: 'draft'
		});
	});

	it('requires one explicit retained value or no value on every surface', () => {
		const preview = previewOf({ cardinality: [cardinality] });
		const groups = buildResolutionGroups(preview, saved, drafts(saved), {});
		expect(resolutionsComplete(groups)).toBe(false);

		const partial: PreviewHolderChoices = { [groups[0].rows[0].key]: { retained: 'trainer' } };
		expect(resolutionsComplete(buildResolutionGroups(preview, saved, drafts(saved), partial))).toBe(
			false
		);

		const complete: PreviewHolderChoices = {
			[groups[0].rows[0].key]: { retained: 'trainer' },
			[groups[0].rows[1].key]: { retained: null }
		};
		expect(
			resolutionsComplete(buildResolutionGroups(preview, saved, drafts(saved), complete))
		).toBe(true);
	});

	it('sends one retained choice per surface', () => {
		const preview = previewOf({ cardinality: [cardinality] });
		const groups = buildResolutionGroups(preview, saved, drafts(saved), {});
		const choices: PreviewHolderChoices = {
			[groups[0].rows[0].key]: { retained: 'steward' },
			[groups[0].rows[1].key]: { retained: null }
		};

		const resolutions = resolutionsFromPreview(
			preview,
			buildResolutionGroups(preview, saved, drafts(saved), choices)
		);

		expect(resolutions.cardinality).toEqual([
			{
				attributeId: 'roles',
				holders: [
					{ workerId: 'ada', surface: 'value', retained: 'steward' },
					{ workerId: 'bea', surface: 'draft', retained: null }
				]
			}
		]);
		expect(resolutions.removedAnswers).toEqual([]);
	});

	it('summarizes the discarded values and the choices the change needs', () => {
		expect(previewSummarySentence(totalsOf(2, 2, 2, 1), [], [], [], [cardinality])).toContain(
			'2 Workers'
		);
	});
});

describe('Attribute move preview', () => {
	/** Packing moves from Department to Roles; Ada and Bea both lose the value. */
	const moveImpact = {
		sourceAttributeId: 'dept',
		answerId: 'packing',
		targetAttributeId: 'roles',
		promoted: false,
		subtreeAnswerIds: ['packing'],
		affectedWorkers: 2,
		holders: [
			{ workerId: 'w1', workerName: 'Ada', lostAnswerIds: ['packing'], keptAnswerIds: [] },
			{ workerId: 'w2', workerName: 'Bea', lostAnswerIds: ['packing'], keptAnswerIds: [] }
		]
	};

	/** Delivery is promoted to its own Attribute; Ada loses it there and keeps Packing. */
	const promotionImpact = {
		sourceAttributeId: 'dept',
		answerId: 'delivery',
		targetAttributeId: 'delivery-line',
		promoted: true,
		subtreeAnswerIds: ['delivery'],
		affectedWorkers: 1,
		holders: [{ workerId: 'w1', workerName: 'Ada', lostAnswerIds: ['delivery'], keptAnswerIds: [] }]
	};

	/** The draft after the move: Packing has left Department and is not added to Roles. */
	const movedDraft = (): AttributeDraft[] => [
		draftWith(department, [{ id: 'delivery', value: 'Delivery' }]),
		drafts([roles])[0]
	];

	it('decodes every attribute move field', () => {
		expect(
			decodeConfigurationPreview({ ...previewOf(), attributeMoves: [moveImpact] }).attributeMoves
		).toEqual([moveImpact]);
	});

	it('groups a lossy move with one row per holder, naming what is lost from the source Attribute', () => {
		const preview = previewOf({ attributeMoves: [moveImpact], totals: totalsOf(2, 2, 2) });

		const groups = buildResolutionGroups(preview, saved, movedDraft(), {});
		const group = groups.find((candidate) => candidate.attributeMove);

		expect(group).toMatchObject({
			key: 'dept:packing:attributeMove',
			attributeId: 'dept',
			answerId: 'packing'
		});
		expect(group?.title).toBe('Move Packing to Roles');
		expect(group?.rows).toHaveLength(2);
		expect(group?.rows[0]).toMatchObject({
			workerId: 'w1',
			workerName: 'Ada',
			summary: 'Ada loses Packing',
			acknowledgement: true
		});
		expect(group?.rows[0].keeps).toBeUndefined();
	});

	it('names what a promoted holder keeps and where, beside what is lost', () => {
		const preview = previewOf({
			attributeMoves: [
				{
					...promotionImpact,
					holders: [
						{
							workerId: 'w1',
							workerName: 'Ada',
							lostAnswerIds: ['delivery'],
							keptAnswerIds: ['packing']
						}
					]
				}
			],
			totals: totalsOf(1, 1, 1)
		});
		const draft = [
			...movedDraft(),
			...drafts([
				{
					id: 'delivery-line',
					name: 'Delivery Line',
					kind: 'category',
					answers: [{ id: 'packing', value: 'Packing' }]
				}
			])
		];

		const group = buildResolutionGroups(preview, saved, draft, {}).find(
			(candidate) => candidate.attributeMove
		);

		expect(group?.title).toBe('Promote Delivery to its own Attribute');
		expect(group?.rows[0].summary).toBe('Ada loses Delivery');
		expect(group?.rows[0].keeps).toBe('Ada keeps Packing in Delivery Line');
	});

	it('is complete without a choice and sends one resolution per lossy impact only', () => {
		const emptyMove = { ...moveImpact, answerId: 'steward', holders: [] };
		const preview = previewOf({
			attributeMoves: [moveImpact, emptyMove],
			totals: totalsOf(2, 2, 2)
		});
		const groups = buildResolutionGroups(preview, saved, movedDraft(), {});

		expect(resolutionsComplete(groups)).toBe(true);
		const resolutions = resolutionsFromPreview(preview, groups);
		expect(resolutions.attributeMoves).toEqual([
			{ sourceAttributeId: 'dept', answerId: 'packing' }
		]);
		expect(resolutions.removedAnswers).toEqual([]);
	});

	it('summarizes each move as its own row, lossy only when a value is lost', () => {
		const preview = previewOf({
			attributeMoves: [moveImpact, { ...promotionImpact, holders: [] }],
			changes: [
				{
					entity: 'answer',
					id: 'packing',
					attributeId: 'dept',
					operation: 'moveToAttribute',
					affectedWorkers: 2,
					lossyWorkers: 2,
					discardedValues: 2
				},
				{
					entity: 'answer',
					id: 'delivery',
					attributeId: 'dept',
					operation: 'promote',
					affectedWorkers: 0,
					lossyWorkers: 0,
					discardedValues: 0
				}
			],
			totals: totalsOf(2, 2, 2)
		});

		const rows = summarizePreview(preview, saved, movedDraft());

		expect(rows[0]).toMatchObject({ title: 'Move Packing to Roles', lossy: true });
		expect(rows[0].detail).toContain('not added to Roles');
		expect(rows[1]).toMatchObject({
			title: 'Promote Delivery to its own Attribute',
			lossy: false
		});
	});

	it('states that the values leave the Attribute and are not added to the target', () => {
		const sentence = previewSummarySentence(
			totalsOf(2, 2, 2),
			[
				{
					entity: 'answer',
					id: 'packing',
					attributeId: 'dept',
					operation: 'moveToAttribute',
					affectedWorkers: 2,
					lossyWorkers: 2,
					discardedValues: 2
				}
			],
			[],
			[],
			[]
		);

		expect(sentence).toContain('2 Workers');
		expect(sentence).toContain('not added to the target');
	});

	it('previews a cross-Attribute move and a promotion, since the source loses the saved answer', () => {
		const crossMove = draftOf({
			draftAttributes: [
				draftWith(department, [{ id: 'delivery', value: 'Delivery' }]),
				draftWith(roles, [
					{ id: 'trainer', value: 'Trainer' },
					{ id: 'steward', value: 'Steward' },
					{ id: 'packing', value: 'Packing' }
				])
			]
		});
		const promotion = draftOf({
			draftAttributes: [
				draftWith(department, [{ id: 'delivery', value: 'Delivery' }]),
				drafts([roles])[0],
				...drafts([
					{
						id: 'packing-line',
						name: 'Packing Line',
						kind: 'category',
						answers: [{ id: 'packing', value: 'Packing' }]
					}
				])
			]
		});

		expect(hasPreviewableAttributeChanges(crossMove)).toBe(true);
		expect(hasPreviewableAttributeChanges(promotion)).toBe(true);
	});
});

describe('Select-mode (ADR 0043) preview', () => {
	const modeChange = {
		attributeId: 'dept',
		holders: [
			{
				workerId: 'ada',
				workerName: 'Ada',
				surface: 'value' as const,
				held: ['packing', 'delivery'],
				kept: ['packing'],
				dropped: ['delivery']
			}
		]
	};

	const station: WorkerAttributeDefinition = {
		id: 'station',
		name: 'Station',
		kind: 'category',
		answers: [
			{ id: 'foh', value: 'Front of House' },
			{ id: 'server', value: 'Server', parentId: 'foh' }
		]
	};

	it('names each trimmed Worker with what it keeps and loses, and needs no choice', () => {
		const preview = previewOf({ modeChanges: [modeChange] });
		const groups = buildResolutionGroups(preview, saved, drafts(saved), {});

		expect(groups).toHaveLength(1);
		expect(groups[0].modeChangeAttributeId).toBe('dept');
		expect(groups[0].rows).toHaveLength(1);
		expect(groups[0].rows[0]).toMatchObject({ workerName: 'Ada', acknowledgement: true });
		expect(groups[0].rows[0].summary).toContain('Packing');
		expect(groups[0].rows[0].summary).toContain('Delivery');
		expect(resolutionsComplete(groups)).toBe(true);
	});

	it('sends the changed Attribute as a select-mode resolution, and none without a change', () => {
		const preview = previewOf({ modeChanges: [modeChange] });
		const groups = buildResolutionGroups(preview, saved, drafts(saved), {});

		expect(resolutionsFromPreview(preview, groups).modeChanges).toEqual([{ attributeId: 'dept' }]);
		expect(resolutionsFromPreview(previewOf(), []).modeChanges).toEqual([]);
	});

	it('summarizes a select-mode change as a lossy row that names the Attribute', () => {
		const preview = previewOf({
			changes: [
				{
					entity: 'attribute',
					id: 'dept',
					operation: 'selectMode',
					affectedWorkers: 1,
					lossyWorkers: 1,
					discardedValues: 1
				}
			],
			modeChanges: [modeChange]
		});

		const rows = summarizePreview(preview, saved, drafts(saved));

		expect(rows[0].title).toContain('Department');
		expect(rows[0].detail).toContain('first branch in value order');
		expect(rows[0].lossy).toBe(true);
	});

	it('counts a changed select mode on a value with sub-values as a previewable change', () => {
		const draft = draftOf({
			savedConfiguration: [station],
			draftAttributes: [
				{
					...fromWorkerAttributeDefinitions([station])[0],
					answers: [
						{ id: 'foh', value: 'Front of House', mode: 'multi' },
						{ id: 'server', value: 'Server', parentId: 'foh' }
					]
				}
			]
		});

		expect(hasPreviewableAttributeChanges(draft)).toBe(true);
	});

	it('does not count a mode that stays effectively the same', () => {
		// An explicit single on a category is the kind's default, so omitting it changes nothing.
		const explicitSingle = draftOf({
			savedConfiguration: [
				{
					...station,
					answers: [
						{ id: 'foh', value: 'Front of House', mode: 'single' },
						{ id: 'server', value: 'Server', parentId: 'foh' }
					]
				}
			],
			draftAttributes: fromWorkerAttributeDefinitions([station])
		});
		// An omitted mode on a tag is multi, the same as an explicit multi.
		const tag: WorkerAttributeDefinition = {
			id: 'roles',
			name: 'Roles',
			kind: 'tag',
			answers: [
				{ id: 'lead', value: 'Lead' },
				{ id: 'lead-cover', value: 'Cover', parentId: 'lead' }
			]
		};
		const explicitMulti = draftOf({
			savedConfiguration: [tag],
			draftAttributes: [
				{
					...fromWorkerAttributeDefinitions([tag])[0],
					answers: [
						{ id: 'lead', value: 'Lead', mode: 'multi' },
						{ id: 'lead-cover', value: 'Cover', parentId: 'lead' }
					]
				}
			]
		});

		expect(hasPreviewableAttributeChanges(explicitSingle)).toBe(false);
		expect(hasPreviewableAttributeChanges(explicitMulti)).toBe(false);
	});
});
