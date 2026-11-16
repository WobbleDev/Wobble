import { describe, expect, it } from 'vitest';
import type { AttributeAnswer, WorkerAttributeKind } from '#lib/domain-vocabulary.ts';
import {
	canHoldSeveral,
	enforceModes,
	groupMode,
	heldIds,
	pickAnswer,
	resolveIds,
	shapeValue,
	storesList
} from './select-mode.ts';

const answers: AttributeAnswer[] = [
	{ id: 'foh', value: 'Front of House', mode: 'multi' },
	{ id: 'server', value: 'Server', parentId: 'foh' },
	{ id: 'host', value: 'Host', parentId: 'foh' },
	{ id: 'boh', value: 'Back of House', mode: 'single' },
	{ id: 'cook', value: 'Cook', parentId: 'boh' },
	{ id: 'dish', value: 'Dish', parentId: 'boh' }
];

function plainAnswers(): AttributeAnswer[] {
	return answers.map((answer) => ({
		id: answer.id,
		value: answer.value,
		...(answer.parentId ? { parentId: answer.parentId } : {})
	}));
}

function subject(kind: WorkerAttributeKind, list: AttributeAnswer[] = answers) {
	return { kind, answers: list };
}

describe('the group mode of a value', () => {
	it('is its own mode, and otherwise the Attribute kind', () => {
		expect(groupMode(subject('category'), 'foh')).toBe('multi');
		expect(groupMode(subject('tag'), 'boh')).toBe('single');
		expect(groupMode(subject('category'), 'server')).toBe('single');
		expect(groupMode(subject('tag'))).toBe('multi');
	});
});

describe('which shape an Attribute stores', () => {
	it('stores a list for a Multi-Select Attribute or a Multi-Select group with sub-values', () => {
		expect(storesList(subject('tag', []))).toBe(true);
		expect(storesList(subject('category'))).toBe(true);
		expect(canHoldSeveral(subject('category'))).toBe(true);
	});

	it('stores a single id for a plain Single-Select Attribute, even if a childless value says multi', () => {
		expect(storesList(subject('category', [{ id: 'a', value: 'A', mode: 'multi' }]))).toBe(false);
		expect(storesList(subject('category', plainAnswers()))).toBe(false);
		expect(shapeValue(subject('category', [{ id: 'a', value: 'A' }]), ['a'])).toBe('a');
		expect(shapeValue(subject('category', [{ id: 'a', value: 'A' }]), [])).toBe('');
		expect(shapeValue(subject('category'), ['server'])).toEqual(['server']);
	});
});

describe('reading a stored value', () => {
	it('reads both shapes as the same set', () => {
		expect(heldIds('server')).toEqual(['server']);
		expect(heldIds('')).toEqual([]);
		expect(heldIds(['server', 'host'])).toEqual(['server', 'host']);
		expect(heldIds(undefined)).toEqual([]);
	});
});

describe('enforcing the modes', () => {
	it('lets a Multi-Select group hold several sub-values and the Attribute govern the top', () => {
		expect(enforceModes(subject('category'), ['server', 'host']).dropped).toEqual([]);
		expect(enforceModes(subject('category'), ['server', 'cook'])).toEqual({
			kept: ['server'],
			dropped: ['cook']
		});
		expect(enforceModes(subject('tag'), ['server', 'cook']).dropped).toEqual([]);
	});

	it('keeps the first branch in value order and a held parent beside it', () => {
		expect(enforceModes(subject('tag'), ['dish', 'cook'])).toEqual({
			kept: ['cook'],
			dropped: ['dish']
		});
		expect(enforceModes(subject('tag'), ['boh', 'dish']).dropped).toEqual([]);
	});

	it('keeps only the first id for a single-id Attribute', () => {
		expect(resolveIds(subject('category', plainAnswers()), ['boh', 'cook'])).toEqual({
			kept: ['boh'],
			dropped: ['cook']
		});
	});
});

describe('picking an answer', () => {
	it('adds within a Multi-Select group and replaces within a Single-Select group', () => {
		expect(pickAnswer(subject('category'), ['server'], 'host')).toEqual(['server', 'host']);
		expect(pickAnswer(subject('tag'), ['cook'], 'dish')).toEqual(['dish']);
	});

	it('clears the other top-level branches of a Single-Select Attribute', () => {
		expect(pickAnswer(subject('category'), ['server', 'host'], 'cook')).toEqual(['cook']);
	});

	it('removes an answer that is already held', () => {
		expect(pickAnswer(subject('category'), ['server', 'host'], 'server')).toEqual(['host']);
	});
});
