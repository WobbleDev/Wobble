import { describe, expect, it } from 'vitest';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { attributeDefinition } from '#lib/testing/builders.ts';
import { attributeWrites } from '#lib/client/workers-api.ts';
import {
	fromWorkerAttributeDefinitions,
	toWorkerAttributeDefinition,
	toWorkerAttributeDefinitions,
	type AttributeDraft
} from './attribute-draft.ts';
import {
	canSave,
	canSaveWorksiteName,
	checkValueText,
	findDuplicateValue,
	getCommitteeGoalError,
	getDirtyState,
	hasUnsavedDraft,
	canPersistAttributes,
	mergeValue,
	moveValue,
	planConfigurationSave,
	removeValue,
	renameValue,
	swapValues,
	visibleValues,
	type ConfigurationDraft
} from './configuration-draft.ts';

function attribute(overrides: Partial<AttributeDraft> = {}): AttributeDraft {
	return {
		id: 'role',
		name: 'Role',
		type: 'category',
		answers: [{ id: 'role-option-0', value: 'Server' }],
		newOption: '',
		newOptionError: '',
		removalError: '',
		moveError: '',
		...overrides
	};
}

const definition = (overrides: Partial<WorkerAttributeDefinition> = {}) =>
	attributeDefinition({
		id: 'role',
		name: 'Role',
		answers: [{ id: 'role-option-0', value: 'Server' }],
		...overrides
	});

/** A draft that is entirely in sync with what was last saved. */
function cleanDraft(overrides: Partial<ConfigurationDraft> = {}): ConfigurationDraft {
	return {
		worksiteName: 'Downtown',
		savedWorksiteName: 'Downtown',
		draftCommitteeGoal: '5',
		savedCommitteeGoal: 5,
		draftAttributes: [attribute()],
		savedConfiguration: [definition()],
		draftAgitations: [{ id: 'ag-1', text: 'Picketing' }],
		savedAgitations: [{ id: 'ag-1', text: 'Picketing' }],
		draftLanguages: [{ id: 'lang-1', name: 'Spanish' }],
		savedLanguages: [{ id: 'lang-1', name: 'Spanish' }],
		addFormOpen: false,
		newAgitationText: '',
		newLanguageName: '',
		...overrides
	};
}

describe('getDirtyState', () => {
	it('reports nothing dirty when every section matches what was saved', () => {
		expect(getDirtyState(cleanDraft())).toEqual({
			name: false,
			committeeGoal: false,
			attributes: false,
			agitations: false,
			languages: false,
			sections: []
		});
	});

	it('names the worksite name when only it changed', () => {
		const dirty = getDirtyState(cleanDraft({ worksiteName: 'Uptown' }));

		expect(dirty.name).toBe(true);
		expect(dirty.attributes).toBe(false);
		expect(dirty.agitations).toBe(false);
		expect(dirty.sections).toEqual(['worksite name']);
	});

	it('ignores whitespace-only changes to the worksite name', () => {
		expect(getDirtyState(cleanDraft({ worksiteName: ' Downtown ' })).sections).toEqual([]);
	});

	it('names the committee coverage goal when only it changed', () => {
		const dirty = getDirtyState(cleanDraft({ draftCommitteeGoal: '8' }));

		expect(dirty.committeeGoal).toBe(true);
		expect(dirty.sections).toEqual(['committee coverage goal']);
	});

	it('labels the attributes section with how many attributes the draft holds', () => {
		const dirty = getDirtyState(
			cleanDraft({
				draftAttributes: [
					attribute(),
					attribute({
						id: 'shift',
						name: 'Shift',
						answers: [{ id: 'shift-option-0', value: 'Day' }]
					})
				]
			})
		);

		expect(dirty.attributes).toBe(true);
		expect(dirty.sections).toEqual(['attributes (2)']);
	});

	it('reports the attributes section when only their configured order changed', () => {
		const saved = [
			definition(),
			definition({
				id: 'shift',
				name: 'Shift',
				answers: [{ id: 'shift-option-0', value: 'Day' }]
			})
		];
		const reordered = fromWorkerAttributeDefinitions(saved).reverse();
		const dirty = getDirtyState(
			cleanDraft({ draftAttributes: reordered, savedConfiguration: saved })
		);

		expect(dirty.attributes).toBe(true);
		expect(dirty.sections).toEqual(['attributes (2)']);
	});

	it('reports the agitations section when the shared list changed', () => {
		const dirty = getDirtyState(
			cleanDraft({
				draftAgitations: [
					{ id: 'ag-1', text: 'Picketing' },
					{ id: 'ag-2', text: 'Strike' }
				]
			})
		);

		expect(dirty.agitations).toBe(true);
		expect(dirty.sections).toEqual(['agitations']);
	});

	it('reports the languages section when the shared list changed', () => {
		const dirty = getDirtyState(
			cleanDraft({
				draftLanguages: [
					{ id: 'lang-1', name: 'Spanish' },
					{ id: 'lang-2', name: 'Polish' }
				]
			})
		);

		expect(dirty.languages).toBe(true);
		expect(dirty.sections).toEqual(['languages']);
	});

	it('lists every dirty section in display order', () => {
		const dirty = getDirtyState(
			cleanDraft({
				worksiteName: 'Uptown',
				draftAttributes: [
					attribute(),
					attribute({
						id: 'shift',
						name: 'Shift',
						answers: [{ id: 'shift-option-0', value: 'Day' }]
					})
				],
				draftAgitations: [
					{ id: 'ag-1', text: 'Picketing' },
					{ id: 'ag-2', text: 'Strike' }
				]
			})
		);

		expect(dirty.sections).toEqual(['worksite name', 'attributes (2)', 'agitations']);
	});
});

describe('getCommitteeGoalError', () => {
	it('accepts whole numbers from 1 to 100', () => {
		expect(getCommitteeGoalError('1')).toBe('');
		expect(getCommitteeGoalError('5')).toBe('');
		expect(getCommitteeGoalError('100')).toBe('');
	});

	it('rejects empty, non-integer, and out-of-range input', () => {
		expect(getCommitteeGoalError('')).not.toBe('');
		expect(getCommitteeGoalError('   ')).not.toBe('');
		expect(getCommitteeGoalError('1.5')).not.toBe('');
		expect(getCommitteeGoalError('ten')).not.toBe('');
		expect(getCommitteeGoalError('0')).not.toBe('');
		expect(getCommitteeGoalError('101')).not.toBe('');
	});
});

describe('hasUnsavedDraft', () => {
	it('is false for a draft that matches what was saved', () => {
		expect(hasUnsavedDraft(cleanDraft())).toBe(false);
	});

	it('counts an open add-attribute form as unsaved work', () => {
		expect(hasUnsavedDraft(cleanDraft({ addFormOpen: true }))).toBe(true);
	});

	it('counts text typed into an attribute option field as unsaved work', () => {
		expect(
			hasUnsavedDraft(cleanDraft({ draftAttributes: [attribute({ newOption: '  Day  ' })] }))
		).toBe(true);
	});

	it('counts text typed into the agitation field as unsaved work', () => {
		expect(hasUnsavedDraft(cleanDraft({ newAgitationText: 'Strike' }))).toBe(true);
	});

	it('ignores whitespace-only pending text', () => {
		expect(hasUnsavedDraft(cleanDraft({ newAgitationText: '   ' }))).toBe(false);
		expect(
			hasUnsavedDraft(cleanDraft({ draftAttributes: [attribute({ newOption: '   ' })] }))
		).toBe(false);
	});
});

describe('canSaveWorksiteName', () => {
	it('allows a clean name', () => {
		expect(canSaveWorksiteName(cleanDraft())).toBe(true);
	});

	it('allows a changed, non-empty name', () => {
		expect(canSaveWorksiteName(cleanDraft({ worksiteName: 'Uptown' }))).toBe(true);
	});

	it('blocks a changed name that is empty', () => {
		expect(canSaveWorksiteName(cleanDraft({ worksiteName: '   ' }))).toBe(false);
	});
});

describe('canPersistAttributes', () => {
	it('accepts attribute drafts whose names and options are filled in', () => {
		expect(canPersistAttributes(cleanDraft())).toBe(true);
	});

	it('rejects an attribute that is still missing an option value', () => {
		expect(
			canPersistAttributes(
				cleanDraft({
					draftAttributes: [attribute({ answers: [{ id: 'role-option-0', value: '' }] })]
				})
			)
		).toBe(false);
	});

	it('rejects a draft while the add-attribute form is open', () => {
		expect(canPersistAttributes(cleanDraft({ addFormOpen: true }))).toBe(false);
	});
});

describe('canSave', () => {
	it('blocks saving when nothing changed', () => {
		expect(canSave(cleanDraft())).toBe(false);
	});

	it('allows saving a changed worksite name', () => {
		expect(canSave(cleanDraft({ worksiteName: 'Uptown' }))).toBe(true);
	});

	it('allows saving changed agitations', () => {
		expect(canSave(cleanDraft({ draftAgitations: [{ id: 'ag-2', text: 'Strike' }] }))).toBe(true);
	});

	it('allows saving a valid changed committee goal', () => {
		expect(canSave(cleanDraft({ draftCommitteeGoal: '8' }))).toBe(true);
	});

	it('blocks saving an invalid committee goal', () => {
		expect(canSave(cleanDraft({ draftCommitteeGoal: '0' }))).toBe(false);
		expect(canSave(cleanDraft({ draftCommitteeGoal: '1.5' }))).toBe(false);
		expect(canSave(cleanDraft({ draftCommitteeGoal: '' }))).toBe(false);
	});

	it('allows saving valid changed attributes', () => {
		expect(
			canSave(
				cleanDraft({
					draftAttributes: [
						attribute(),
						attribute({
							id: 'shift',
							name: 'Shift',
							answers: [{ id: 'shift-option-0', value: 'Day' }]
						})
					]
				})
			)
		).toBe(true);
	});
});

describe('planConfigurationSave', () => {
	it('marks every clean section as not needing a save', () => {
		const plan = planConfigurationSave(cleanDraft());

		expect(plan.worksiteName.dirty).toBe(false);
		expect(plan.committeeGoal.dirty).toBe(false);
		expect(plan.attributes.dirty).toBe(false);
		expect(plan.agitations.dirty).toBe(false);
		expect(plan.languages.dirty).toBe(false);
	});

	it('saves only the changed sections and freezes their snapshots', () => {
		const plan = planConfigurationSave(
			cleanDraft({
				worksiteName: ' Uptown ',
				draftAttributes: [
					attribute(),
					attribute({
						id: 'shift',
						name: 'Shift',
						answers: [{ id: 'shift-option-0', value: 'Day' }]
					})
				],
				draftAgitations: [
					{ id: 'ag-1', text: 'Picketing' },
					{ id: 'ag-2', text: 'Strike' }
				],
				draftLanguages: [
					{ id: 'lang-1', name: 'Spanish' },
					{ id: 'lang-2', name: 'Polish' }
				]
			})
		);

		expect(plan.worksiteName).toEqual({ dirty: true, snapshot: 'Uptown' });
		expect(plan.attributes).toEqual({
			dirty: true,
			snapshot: [
				{
					id: 'role',
					name: 'Role',
					kind: 'category',
					answers: [{ id: 'role-option-0', value: 'Server' }]
				},
				{
					id: 'shift',
					name: 'Shift',
					kind: 'category',
					answers: [{ id: 'shift-option-0', value: 'Day' }]
				}
			]
		});
		expect(plan.agitations).toEqual({
			dirty: true,
			snapshot: [
				{ id: 'ag-1', text: 'Picketing' },
				{ id: 'ag-2', text: 'Strike' }
			]
		});
		expect(plan.languages).toEqual({
			dirty: true,
			snapshot: [
				{ id: 'lang-1', name: 'Spanish' },
				{ id: 'lang-2', name: 'Polish' }
			]
		});
	});

	it('plans a changed committee goal as a number', () => {
		const plan = planConfigurationSave(cleanDraft({ draftCommitteeGoal: ' 12 ' }));

		expect(plan.committeeGoal).toEqual({ dirty: true, snapshot: 12 });
	});

	it('trims attribute names and option values into the snapshot', () => {
		const plan = planConfigurationSave(
			cleanDraft({
				draftAttributes: [
					attribute({ name: ' Role ', answers: [{ id: 'role-option-0', value: ' Server ' }] })
				],
				savedConfiguration: [definition({ name: 'Something else' })]
			})
		);

		expect(plan.attributes.snapshot).toEqual([
			{
				id: 'role',
				name: 'Role',
				kind: 'category',
				answers: [{ id: 'role-option-0', value: 'Server' }]
			}
		]);
	});

	it('copies the agitation snapshot so later draft edits stay unsaved', () => {
		const agitations = [
			{ id: 'ag-1', text: 'Picketing' },
			{ id: 'ag-2', text: 'Strike' }
		];
		const plan = planConfigurationSave(cleanDraft({ draftAgitations: agitations }));

		agitations.push({ id: 'ag-3', text: 'March' });

		expect(plan.agitations.snapshot).toEqual([
			{ id: 'ag-1', text: 'Picketing' },
			{ id: 'ag-2', text: 'Strike' }
		]);
		expect(plan.agitations.snapshot[0]).not.toBe(agitations[0]);
	});
});

describe('value list edits', () => {
	const agitations = () => [
		{ id: 'ag-1', text: 'Picketing' },
		{ id: 'ag-2', text: 'Strike' },
		{ id: 'ag-3', text: 'Boycott' }
	];

	it('renames an entry by id and keeps its position and id', () => {
		const list = renameValue(agitations(), 'text', 'ag-2', '  Walkout ');

		expect(list).toEqual([
			{ id: 'ag-1', text: 'Picketing' },
			{ id: 'ag-2', text: 'Walkout' },
			{ id: 'ag-3', text: 'Boycott' }
		]);
	});

	it('chains two renames of the same entry, finding it by id each time', () => {
		const once = renameValue(agitations(), 'text', 'ag-2', 'Walkout');
		const twice = renameValue(once, 'text', 'ag-2', 'Work stoppage');

		expect(twice.find((entry) => entry.id === 'ag-2')?.text).toBe('Work stoppage');
		expect(twice).toHaveLength(3);
	});

	it('lets an entry be renamed to its own text with different capitals', () => {
		const list = renameValue(agitations(), 'text', 'ag-1', 'picketing');

		expect(list[0]).toEqual({ id: 'ag-1', text: 'picketing' });
	});

	it('swaps two entries texts by identity, keeping ids and positions', () => {
		const list = swapValues(agitations(), 'text', 'ag-1', 'ag-3');

		expect(list).toEqual([
			{ id: 'ag-1', text: 'Boycott' },
			{ id: 'ag-2', text: 'Strike' },
			{ id: 'ag-3', text: 'Picketing' }
		]);
	});

	it('rejects a blank rename and leaves the list unchanged', () => {
		const list = agitations();

		expect(checkValueText(list, 'text', 'ag-1', '   ')).toEqual({ status: 'blank' });
		expect(renameValue(list, 'text', 'ag-1', '   ')).toEqual(agitations());
	});

	it('detects a case-insensitive duplicate, excluding the entry itself', () => {
		const list = agitations();

		expect(checkValueText(list, 'text', 'ag-1', 'STRIKE')).toEqual({
			status: 'duplicate',
			survivorId: 'ag-2'
		});
		expect(checkValueText(list, 'text', 'ag-2', 'strike')).toEqual({ status: 'ok' });
		expect(renameValue(list, 'text', 'ag-1', 'STRIKE')).toEqual(agitations());
		expect(findDuplicateValue(list, 'text', null, ' boycott ')?.id).toBe('ag-3');
	});

	it('marks the folded entry with the survivor id and keeps the survivor in place', () => {
		const list = mergeValue(agitations(), 'ag-1', 'ag-3');

		expect(list).toEqual([
			{ id: 'ag-1', text: 'Picketing', mergedInto: 'ag-3' },
			{ id: 'ag-2', text: 'Strike' },
			{ id: 'ag-3', text: 'Boycott' }
		]);
		expect(visibleValues(list).map((entry) => entry.id)).toEqual(['ag-2', 'ag-3']);
	});

	it('does not match folded entries as duplicates, and refuses to merge into one', () => {
		const merged = mergeValue(agitations(), 'ag-1', 'ag-3');

		expect(checkValueText(merged, 'text', null, 'picketing')).toEqual({ status: 'ok' });
		expect(mergeValue(merged, 'ag-2', 'ag-1')).toEqual(merged);
		expect(mergeValue(agitations(), 'ag-1', 'ag-1')).toEqual(agitations());
	});

	it('removing the survivor also removes what was merged into it', () => {
		const merged = mergeValue(agitations(), 'ag-1', 'ag-3');

		expect(removeValue(merged, 'ag-3').map((entry) => entry.id)).toEqual(['ag-2']);
	});

	it('reports a merge as a draft change, and a merge then Discard as clean again', () => {
		const saved = [
			{ id: 'ag-1', text: 'Picketing' },
			{ id: 'ag-2', text: 'Strike' }
		];
		const merged = cleanDraft({
			draftAgitations: mergeValue(saved, 'ag-1', 'ag-2'),
			savedAgitations: saved
		});
		const discarded = cleanDraft({ draftAgitations: [...saved], savedAgitations: saved });

		expect(getDirtyState(merged).agitations).toBe(true);
		expect(getDirtyState(discarded).agitations).toBe(false);
	});

	it('reports a rename as dirty, and a rename back to the saved text as clean', () => {
		const saved = agitations();
		const renamed = renameValue(saved, 'text', 'ag-1', 'Protest');
		const renamedBack = renameValue(renamed, 'text', 'ag-1', 'Picketing');

		expect(
			getDirtyState(cleanDraft({ draftAgitations: renamed, savedAgitations: saved })).agitations
		).toBe(true);
		expect(
			getDirtyState(cleanDraft({ draftAgitations: renamedBack, savedAgitations: saved })).agitations
		).toBe(false);
	});

	it('saves folded entries in the payload so Workers can be remapped', () => {
		const merged = mergeValue(agitations(), 'ag-1', 'ag-3');
		const plan = planConfigurationSave(cleanDraft({ draftAgitations: merged }));

		expect(plan.agitations.dirty).toBe(true);
		expect(plan.agitations.snapshot).toEqual([
			{ id: 'ag-1', text: 'Picketing', mergedInto: 'ag-3' },
			{ id: 'ag-2', text: 'Strike' },
			{ id: 'ag-3', text: 'Boycott' }
		]);
	});

	it('renames and merges languages by name with the same rules', () => {
		const languages = [
			{ id: 'lang-1', name: 'Spanish' },
			{ id: 'lang-2', name: 'Polish' }
		];

		expect(renameValue(languages, 'name', 'lang-2', 'Polski')[1]).toEqual({
			id: 'lang-2',
			name: 'Polski'
		});
		expect(checkValueText(languages, 'name', 'lang-2', 'spanish')).toEqual({
			status: 'duplicate',
			survivorId: 'lang-1'
		});
		expect(mergeValue(languages, 'lang-2', 'lang-1')[1]).toEqual({
			id: 'lang-2',
			name: 'Polish',
			mergedInto: 'lang-1'
		});
	});
});

describe('moveValue', () => {
	const entries = () => [
		{ id: 'a-1', value: 'Server' },
		{ id: 'a-2', value: 'Cook' },
		{ id: 'a-3', value: 'Host' }
	];

	it('moves one entry one place up or down, keeping every entry', () => {
		expect(moveValue(entries(), 'a-2', -1)).toEqual([
			{ id: 'a-2', value: 'Cook' },
			{ id: 'a-1', value: 'Server' },
			{ id: 'a-3', value: 'Host' }
		]);
		expect(moveValue(entries(), 'a-2', 1)).toEqual([
			{ id: 'a-1', value: 'Server' },
			{ id: 'a-3', value: 'Host' },
			{ id: 'a-2', value: 'Cook' }
		]);
	});

	it('leaves the list unchanged at either end and for an unknown id', () => {
		expect(moveValue(entries(), 'a-1', -1)).toEqual(entries());
		expect(moveValue(entries(), 'a-3', 1)).toEqual(entries());
		expect(moveValue(entries(), 'missing', -1)).toEqual(entries());
	});

	it('copies the list so the draft replaces its array instead of mutating it', () => {
		const list = entries();
		const moved = moveValue(list, 'a-2', -1);

		expect(moved).not.toBe(list);
		expect(list.map((entry) => entry.id)).toEqual(['a-1', 'a-2', 'a-3']);
	});
});

describe('attribute answer edits', () => {
	const answers = () => [
		{ id: 'a-1', value: 'Server' },
		{ id: 'a-2', value: 'Cook' },
		{ id: 'a-3', value: 'Host' }
	];

	it('renames an answer by id and keeps its position', () => {
		const list = renameValue(answers(), 'value', 'a-2', ' Chef ');

		expect(list).toEqual([
			{ id: 'a-1', value: 'Server' },
			{ id: 'a-2', value: 'Chef' },
			{ id: 'a-3', value: 'Host' }
		]);
	});

	it('chains two renames of one answer', () => {
		const once = renameValue(answers(), 'value', 'a-2', 'Chef');
		const twice = renameValue(once, 'value', 'a-2', 'Sous chef');

		expect(twice[1]).toEqual({ id: 'a-2', value: 'Sous chef' });
	});

	it('swaps two answers through a temporary name', () => {
		const first = renameValue(answers(), 'value', 'a-1', 'tmp');
		const second = renameValue(first, 'value', 'a-3', 'Server');
		const third = renameValue(second, 'value', 'a-1', 'Host');

		expect(third.map((answer) => answer.value)).toEqual(['Host', 'Cook', 'Server']);
		expect(swapValues(answers(), 'value', 'a-1', 'a-3')[0]).toEqual({ id: 'a-1', value: 'Host' });
	});

	it('rejects a blank answer and a case-insensitive duplicate of another answer', () => {
		expect(checkValueText(answers(), 'value', 'a-1', '  ')).toEqual({ status: 'blank' });
		expect(checkValueText(answers(), 'value', 'a-1', 'cook')).toEqual({
			status: 'duplicate',
			survivorId: 'a-2'
		});
		expect(checkValueText(answers(), 'value', 'a-1', 'server')).toEqual({ status: 'ok' });
	});

	it('marks a folded answer with the survivor id and keeps the survivor in place', () => {
		const list = mergeValue(answers(), 'a-3', 'a-1');

		expect(list).toEqual([
			{ id: 'a-1', value: 'Server' },
			{ id: 'a-2', value: 'Cook' },
			{ id: 'a-3', value: 'Host', mergedInto: 'a-1' }
		]);
		expect(visibleValues(list).map((answer) => answer.id)).toEqual(['a-1', 'a-2']);
	});

	it('ignores folded answers when checking duplicates', () => {
		const merged = mergeValue(answers(), 'a-3', 'a-1');

		expect(checkValueText(merged, 'value', 'a-2', 'host')).toEqual({ status: 'ok' });
	});

	it('removing a survivor also drops the answers merged into it', () => {
		const merged = mergeValue(answers(), 'a-3', 'a-1');

		expect(removeValue(merged, 'a-1').map((answer) => answer.id)).toEqual(['a-2']);
	});

	it('is dirty after a merge and clean again once discarded to the saved form', () => {
		const saved = [definition({ answers: answers() })];
		const merged = [
			{
				...attribute(),
				answers: mergeValue(answers(), 'a-3', 'a-1')
			}
		];
		const dirty = cleanDraft({ draftAttributes: merged, savedConfiguration: saved });

		expect(getDirtyState(dirty).attributes).toBe(true);
		expect(
			getDirtyState(
				cleanDraft({
					draftAttributes: fromWorkerAttributeDefinitions(saved),
					savedConfiguration: saved
				})
			).attributes
		).toBe(false);
	});

	it('sends kept answers as id and value, and folded answers with mergedInto', () => {
		const draft = [
			{
				...attribute(),
				answers: mergeValue(answers(), 'a-3', 'a-1')
			}
		];

		expect(toWorkerAttributeDefinitions(draft)[0].answers).toEqual([
			{ id: 'a-1', value: 'Server' },
			{ id: 'a-2', value: 'Cook' },
			{ id: 'a-3', value: 'Host', mergedInto: 'a-1' }
		]);
	});

	it('keeps each answer parent and position through a rename', () => {
		const hierarchy = [
			{ id: 'a-1', value: 'Central' },
			{ id: 'a-2', value: 'Store A', parentId: 'a-1' },
			{ id: 'a-3', value: 'Packing', parentId: 'a-1' }
		];
		const renamed = [
			{
				...attribute(),
				answers: hierarchy.map((answer) =>
					answer.id === 'a-1' ? { ...answer, value: 'Downtown' } : answer
				)
			}
		];

		expect(toWorkerAttributeDefinitions(renamed)[0].answers).toEqual([
			{ id: 'a-1', value: 'Downtown' },
			{ id: 'a-2', value: 'Store A', parentId: 'a-1' },
			{ id: 'a-3', value: 'Packing', parentId: 'a-1' }
		]);
		expect(
			getDirtyState(
				cleanDraft({
					draftAttributes: renamed,
					savedConfiguration: [definition({ answers: hierarchy })]
				})
			).attributes
		).toBe(true);
	});

	describe('saving an answer select mode (ADR 0043)', () => {
		it('keeps the mode of a value that still has a child', () => {
			const saved = toWorkerAttributeDefinition(
				attribute({
					answers: [
						{ id: 'p', value: 'Packing', mode: 'multi' },
						{ id: 'd', value: 'Delivery', parentId: 'p' }
					]
				})
			);

			expect(saved.answers[0]).toEqual({ id: 'p', value: 'Packing', mode: 'multi' });
		});

		it('drops the mode of a childless value', () => {
			const saved = toWorkerAttributeDefinition(
				attribute({ answers: [{ id: 'p', value: 'Packing', mode: 'multi' }] })
			);

			expect(saved.answers[0]).toEqual({ id: 'p', value: 'Packing' });
			expect(saved.answers[0]).not.toHaveProperty('mode');
		});

		it('drops the mode when the only child is merged away, and keeps the merge link', () => {
			const saved = toWorkerAttributeDefinition(
				attribute({
					answers: [
						{ id: 'p', value: 'Packing', mode: 'multi' },
						{ id: 'd', value: 'Delivery', parentId: 'p', mergedInto: 'x' }
					]
				})
			);

			expect(saved.answers[0]).not.toHaveProperty('mode');
			expect(saved.answers[1]).toEqual({
				id: 'd',
				value: 'Delivery',
				parentId: 'p',
				mergedInto: 'x'
			});
		});
	});
});

describe('Abbreviations through the Configuration draft (ADR 0046)', () => {
	const stored = [
		{
			id: 'a',
			value: 'Customer Service',
			abbreviation: 'Cust. Svc.',
			abbreviationOrigin: 'generated'
		},
		{ id: 'b', value: 'Maintenance', abbreviation: 'MX', abbreviationOrigin: 'edited' }
	] as const;

	it('leaves a generated form to the core and sends an edited one with its origin', () => {
		const draft = fromWorkerAttributeDefinitions([definition({ answers: [...stored] })]);

		expect(toWorkerAttributeDefinitions(draft)[0].answers).toEqual([
			{ id: 'a', value: 'Customer Service' },
			{ id: 'b', value: 'Maintenance', abbreviation: 'MX', abbreviationOrigin: 'edited' }
		]);
	});

	it('reaches the preview and save request unchanged, and a reload reads the same draft', () => {
		const saved = definition({ answers: [...stored] });
		const draft = fromWorkerAttributeDefinitions([saved]);
		const sent = attributeWrites(toWorkerAttributeDefinitions(draft));

		expect(sent[0].options).toEqual([
			{ id: 'a', value: 'Customer Service' },
			{ id: 'b', value: 'Maintenance', abbreviation: 'MX', abbreviationOrigin: 'edited' }
		]);
		// The core answers the same Abbreviations on reload, so the reloaded draft is still clean.
		const reloaded = fromWorkerAttributeDefinitions([saved]);
		expect(
			getDirtyState(
				cleanDraft({
					draftAttributes: reloaded,
					savedConfiguration: toWorkerAttributeDefinitions(reloaded)
				})
			).attributes
		).toBe(false);
	});

	it('is dirty when a form is edited, and clean again when it is cleared back', () => {
		const savedDraft = fromWorkerAttributeDefinitions([definition({ answers: [...stored] })]);
		const savedConfiguration = toWorkerAttributeDefinitions(savedDraft);
		const edited = savedDraft.map((attr) => ({
			...attr,
			answers: attr.answers.map((answer) =>
				answer.id === 'a'
					? { ...answer, abbreviation: 'CS', abbreviationOrigin: 'edited' as const }
					: answer
			)
		}));

		expect(
			getDirtyState(cleanDraft({ draftAttributes: edited, savedConfiguration })).attributes
		).toBe(true);
		expect(
			getDirtyState(cleanDraft({ draftAttributes: savedDraft, savedConfiguration })).attributes
		).toBe(false);
	});

	it('trims an edited form it sends', () => {
		const draft = [
			attribute({
				answers: [{ id: 'a', value: 'Server', abbreviation: '  SV ', abbreviationOrigin: 'edited' }]
			})
		];

		expect(toWorkerAttributeDefinitions(draft)[0].answers[0].abbreviation).toBe('SV');
	});

	it('blocks Save while an edited form is beyond ten graphemes', () => {
		const long = [
			attribute({
				answers: [
					{ id: 'a', value: 'Server', abbreviation: 'Eleven char', abbreviationOrigin: 'edited' }
				]
			})
		];

		expect(canPersistAttributes(cleanDraft({ draftAttributes: long }))).toBe(false);
	});
});
