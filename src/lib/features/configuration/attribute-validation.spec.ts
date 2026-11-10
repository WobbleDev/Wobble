import { describe, expect, it } from 'vitest';
import { createAttribute, type AttributeDraft } from './attribute-draft.ts';
import {
	findDuplicateSiblingOption,
	getAttributeNameError,
	getAttributeOptionError,
	hasChildAnswers,
	hasDuplicateOptionValue,
	isAnswerInSubtree,
	isAttributeValid
} from './attribute-validation.ts';

function draft(overrides: Partial<AttributeDraft> = {}): AttributeDraft {
	return { ...createAttribute('role', 'Role', 'category'), ...overrides };
}

describe('getAttributeNameError', () => {
	it('accepts a name no other Attribute uses', () => {
		expect(getAttributeNameError('Shift', [draft()])).toBe('');
	});

	it('rejects an empty or whitespace-only name', () => {
		expect(getAttributeNameError('', [])).toBe('Enter an attribute name.');
		expect(getAttributeNameError('   ', [])).toBe('Enter an attribute name.');
	});

	it('rejects a name another Attribute already has, ignoring case and surrounding spaces', () => {
		expect(getAttributeNameError('  role ', [draft()])).toBe(
			'An attribute with this name already exists.'
		);
	});

	it('lets an Attribute keep its own name when it is excluded by id', () => {
		expect(getAttributeNameError('Role', [draft()], 'role')).toBe('');
	});

	it('still rejects a clash with a different Attribute when one is excluded', () => {
		const others = [draft(), draft({ id: 'shift', name: 'Shift' })];
		expect(getAttributeNameError('shift', others, 'role')).toBe(
			'An attribute with this name already exists.'
		);
	});
});

describe('hasDuplicateOptionValue', () => {
	const shifts = draft({
		answers: [
			{ id: 'a1', value: 'Morning' },
			{ id: 'a2', value: 'Evening' }
		]
	});

	it('finds an existing option, ignoring case and surrounding spaces', () => {
		expect(hasDuplicateOptionValue(shifts, '  morning ')).toBe(true);
	});

	it('finds nothing for a value no option has', () => {
		expect(hasDuplicateOptionValue(shifts, 'Night')).toBe(false);
	});

	it('does not count the option being edited against itself', () => {
		expect(hasDuplicateOptionValue(shifts, 'Morning', 'a1')).toBe(false);
		expect(hasDuplicateOptionValue(shifts, 'Morning', 'a2')).toBe(true);
	});

	it('ignores options that are folded into another', () => {
		const folded = draft({
			answers: [
				{ id: 'a1', value: 'AM', mergedInto: 'a2' },
				{ id: 'a2', value: 'Morning' }
			]
		});
		expect(hasDuplicateOptionValue(folded, 'am')).toBe(false);
	});

	it('never reports a blank value as a duplicate', () => {
		const blank = draft({ answers: [{ id: 'a1', value: '' }] });
		expect(hasDuplicateOptionValue(blank, '   ')).toBe(false);
	});
});

describe('sibling-scoped value labels', () => {
	const location = draft({
		answers: [
			{ id: 'central', value: 'Central' },
			{ id: 'central-packing', value: 'Packing', parentId: 'central' },
			{ id: 'other', value: 'Other' },
			{ id: 'other-packing', value: 'Packing', parentId: 'other' }
		]
	});

	it('allows the same label under different parents', () => {
		expect(hasDuplicateOptionValue(location, 'packing', undefined, 'other')).toBe(true);
		expect(hasDuplicateOptionValue(location, 'Packing', 'other-packing', 'other')).toBe(false);
		expect(getAttributeOptionError(location, location.answers[1])).toBe('');
		expect(getAttributeOptionError(location, location.answers[3])).toBe('');
	});

	it('still rejects two values under one parent with the same label', () => {
		expect(hasDuplicateOptionValue(location, 'packing', undefined, 'central')).toBe(true);
		expect(hasDuplicateOptionValue(location, 'packing', 'central-packing', 'central')).toBe(false);
	});

	it('finds the sibling a rename would merge into, never a cousin', () => {
		expect(findDuplicateSiblingOption(location, 'other-packing', 'Packing', 'central')).toEqual(
			location.answers[1]
		);
		expect(
			findDuplicateSiblingOption(location, 'central-packing', 'Packing', 'central')
		).toBeUndefined();
		expect(
			findDuplicateSiblingOption(location, 'other-packing', 'Packing', 'other')
		).toBeUndefined();
	});

	it('knows which values still have children', () => {
		expect(hasChildAnswers(location, 'central')).toBe(true);
		expect(hasChildAnswers(location, 'central-packing')).toBe(false);
	});

	it('knows a value and its descendants, so a move below itself is detectable', () => {
		const nested = draft({
			answers: [
				{ id: 'central', value: 'Central' },
				{ id: 'store-a', value: 'Store A', parentId: 'central' },
				{ id: 'dock', value: 'Loading dock', parentId: 'store-a' },
				{ id: 'other', value: 'Other' }
			]
		});
		expect(isAnswerInSubtree(nested.answers, 'store-a', 'store-a')).toBe(true);
		expect(isAnswerInSubtree(nested.answers, 'dock', 'store-a')).toBe(true);
		expect(isAnswerInSubtree(nested.answers, 'central', 'store-a')).toBe(false);
		expect(isAnswerInSubtree(nested.answers, 'other', 'store-a')).toBe(false);
	});
});

describe('getAttributeOptionError', () => {
	const shifts = draft({
		answers: [
			{ id: 'a1', value: 'Morning' },
			{ id: 'a2', value: 'Evening' }
		]
	});

	it('passes an option with a unique value', () => {
		expect(getAttributeOptionError(shifts, { id: 'a2', value: 'Evening' })).toBe('');
	});

	it('asks for a value when the option is blank', () => {
		expect(getAttributeOptionError(shifts, { id: 'a3', value: '  ' })).toBe('Enter an option.');
	});

	it('rejects a value another option already has', () => {
		expect(getAttributeOptionError(shifts, { id: 'a2', value: 'morning' })).toBe(
			'Values under the same parent must be unique.'
		);
	});
});

describe('isAttributeValid', () => {
	it('accepts a named Attribute with unique options', () => {
		const valid = draft({ answers: [{ id: 'a1', value: 'Morning' }] });
		expect(isAttributeValid(valid, [valid])).toBe(true);
	});

	it('rejects an Attribute whose name clashes with another', () => {
		const valid = draft({ id: 'shift', name: 'role' });
		expect(isAttributeValid(valid, [draft(), valid])).toBe(false);
	});

	it('rejects an Attribute with a blank option', () => {
		const blank = draft({ answers: [{ id: 'a1', value: '' }] });
		expect(isAttributeValid(blank, [blank])).toBe(false);
	});

	it('ignores a folded option even when its value is blank or repeated', () => {
		const folded = draft({
			answers: [
				{ id: 'a1', value: 'Morning' },
				{ id: 'a2', value: 'Morning', mergedInto: 'a1' }
			]
		});
		expect(isAttributeValid(folded, [folded])).toBe(true);
	});

	it('rejects an Attribute with text still typed into the new option field', () => {
		expect(isAttributeValid(draft({ newOption: 'Night' }), [draft()])).toBe(false);
	});

	it('does not reject for whitespace left in the new option field', () => {
		expect(isAttributeValid(draft({ newOption: '   ' }), [draft()])).toBe(true);
	});

	it('rejects an Attribute that has a new-option error set', () => {
		expect(
			isAttributeValid(draft({ newOptionError: 'Values under the same parent must be unique.' }), [
				draft()
			])
		).toBe(false);
	});
});

describe('five-level Attribute answers', () => {
	// Central > Store A > Floor > Aisle > Shelf: l1 is the root, l5 is five levels deep.
	const deep = draft({
		answers: [
			{ id: 'l1', value: 'Central' },
			{ id: 'l2', value: 'Store A', parentId: 'l1' },
			{ id: 'l3', value: 'Floor', parentId: 'l2' },
			{ id: 'l4', value: 'Aisle', parentId: 'l3' },
			{ id: 'l5', value: 'Shelf', parentId: 'l4' }
		]
	});

	it('accepts a valid five-level tree', () => {
		expect(isAttributeValid(deep, [deep])).toBe(true);
		expect(getAttributeOptionError(deep, deep.answers[4])).toBe('');
	});

	it('knows the parents at levels 1 to 4, and that the level-5 answer has no children', () => {
		expect(hasChildAnswers(deep, 'l1')).toBe(true);
		expect(hasChildAnswers(deep, 'l4')).toBe(true);
		expect(hasChildAnswers(deep, 'l5')).toBe(false);
	});

	it('finds a level-5 answer in the subtree of levels 1 and 2, and not the reverse', () => {
		expect(isAnswerInSubtree(deep.answers, 'l5', 'l1')).toBe(true);
		expect(isAnswerInSubtree(deep.answers, 'l5', 'l2')).toBe(true);
		expect(isAnswerInSubtree(deep.answers, 'l1', 'l2')).toBe(false);
	});

	it('refuses a second level-5 label that repeats a sibling under the same level-4 parent', () => {
		const clash = draft({
			answers: [...deep.answers, { id: 'l5b', value: 'shelf', parentId: 'l4' }]
		});

		expect(findDuplicateSiblingOption(clash, undefined, 'SHELF', 'l4')?.id).toBe('l5');
		expect(getAttributeOptionError(clash, clash.answers[5])).toBe(
			'Values under the same parent must be unique.'
		);
		expect(isAttributeValid(clash, [clash])).toBe(false);
	});

	it('allows the same level-5 label under a different level-4 parent', () => {
		const other = draft({
			answers: [
				...deep.answers,
				{ id: 'm4', value: 'Dock', parentId: 'l3' },
				{ id: 'm5', value: 'Shelf', parentId: 'm4' }
			]
		});

		expect(getAttributeOptionError(other, other.answers[5])).toBe('');
		expect(isAttributeValid(other, [other])).toBe(true);
	});

	it('terminates on a cycle between levels 4 and 5, and reports the root is not above them', () => {
		const cyclic = draft({
			answers: [
				{ id: 'l1', value: 'Central' },
				{ id: 'l4', value: 'Aisle', parentId: 'l5' },
				{ id: 'l5', value: 'Shelf', parentId: 'l4' }
			]
		});

		expect(isAnswerInSubtree(cyclic.answers, 'l5', 'l1')).toBe(false);
		expect(hasChildAnswers(cyclic, 'l5')).toBe(true);
	});
});
