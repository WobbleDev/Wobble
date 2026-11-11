// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { emptyContextualFilters, type ContextualFilters } from '#lib/shared/contextual-filters.ts';
import {
	contextFilterChips,
	contextFilterGroupCount,
	contextFilterLabels,
	includeFilterChoices
} from './map-contextual-filters.ts';
import { answerIdOf, attributeFixture } from '#lib/testing/mapping/answer-fixtures.ts';

const position = attributeFixture({
	id: 'position',
	name: 'Position',
	kind: 'category',
	options: ['Cashier', 'Stocker']
});
const territory = attributeFixture({
	id: 'territory',
	name: 'Territory',
	kind: 'tag',
	options: ['Store A', 'Store B']
});
const team = attributeFixture({
	id: 'team',
	name: 'Team',
	kind: 'category',
	options: ['Team A', 'Team B']
});
const attributes = [position, territory, team];

function filters(overrides: Partial<ContextualFilters> = {}): ContextualFilters {
	return { ...emptyContextualFilters(), ...overrides };
}

describe('contextFilterChips', () => {
	it('names an active value by the current configuration', () => {
		const chips = contextFilterChips(
			filters({ answers: { territory: [answerIdOf('territory', 'Store B')] } }),
			attributes
		);

		expect(chips).toEqual([
			{
				key: 'answer:territory:' + answerIdOf('territory', 'Store B'),
				attributeId: 'territory',
				attribute: 'Territory',
				value: answerIdOf('territory', 'Store B'),
				label: 'Store B',
				description: null,
				missing: false
			}
		]);
	});

	it('names the no-answer reading as a system condition', () => {
		const chips = contextFilterChips(filters({ missing: ['position'] }), attributes);

		expect(chips).toEqual([
			{
				key: 'missing:position:',
				attributeId: 'position',
				attribute: 'Position',
				value: '',
				label: 'No Position',
				description: null,
				missing: true
			}
		]);
	});

	it('keeps several values of one Attribute as separate conditions', () => {
		const chips = contextFilterChips(
			filters({
				answers: {
					position: [answerIdOf('position', 'Cashier'), answerIdOf('position', 'Stocker')]
				}
			}),
			attributes
		);

		expect(chips.map((chip) => chip.label)).toEqual(['Cashier', 'Stocker']);
		expect(new Set(chips.map((chip) => chip.key)).size).toBe(2);
	});

	it('names a Multi-Select condition and its no-answer reading', () => {
		const chips = contextFilterChips(
			filters({ answers: { territory: [answerIdOf('territory', 'Store A')] }, missing: ['team'] }),
			attributes
		);

		expect(chips.map((chip) => chip.label)).toEqual(['No Team', 'Store A']);
		expect(chips[0].missing).toBe(true);
	});

	it('explains a system reading whose label a real value also uses', () => {
		const colliding = attributeFixture({
			id: 'job',
			name: 'Job',
			kind: 'category',
			options: ['Cashier', 'No Job']
		});
		const chips = contextFilterChips(filters({ missing: ['job'] }), [colliding]);

		expect(chips[0].label).toBe('No Job');
		expect(chips[0].description).toBe('No selection');
	});
});

describe('contextFilterLabels', () => {
	it('names each filtered question once', () => {
		const labels = contextFilterLabels(
			filters({
				answers: {
					position: [answerIdOf('position', 'Cashier'), answerIdOf('position', 'Stocker')],
					territory: [answerIdOf('territory', 'Store B')]
				},
				missing: ['team']
			}),
			attributes
		);

		expect(labels).toEqual(['Position', 'Team', 'Territory']);
		expect(contextFilterGroupCount(filters(), attributes)).toBe(0);
	});
});

describe('includeFilterChoices', () => {
	it('lists each value by id, then the no-answer reading for a Single-Select Attribute', () => {
		const choices = includeFilterChoices(position);

		expect(choices.map((choice) => choice.id)).toEqual([
			answerIdOf('position', 'Cashier'),
			answerIdOf('position', 'Stocker'),
			''
		]);
		expect(choices.at(-1)).toEqual({
			id: '',
			label: 'No Position',
			description: null
		});
	});

	it('offers the same no-answer reading for a Multi-Select Attribute', () => {
		const roles = attributeFixture({
			id: 'roles',
			name: 'Roles',
			kind: 'tag',
			options: ['Trainer']
		});

		expect(includeFilterChoices(roles)).toEqual([
			{ id: answerIdOf('roles', 'Trainer'), label: 'Trainer' },
			{ id: '', label: 'No Roles', description: null }
		]);
	});
});
