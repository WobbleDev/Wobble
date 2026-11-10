import { describe, expect, it } from 'vitest';
import { matchSections } from './settings-search.ts';

const sections = [
	{ id: 'data', label: 'Data', text: 'Database file Copy path' },
	{ id: 'theme', label: 'Theme', text: 'Light Dark System' },
	{ id: 'region', label: 'Región', text: 'Date format Time format' }
];

describe('matchSections', () => {
	it('keeps every section for an empty query', () => {
		expect(matchSections('  ', sections)).toEqual(sections);
	});

	it('matches label or contents, ignoring case', () => {
		expect(matchSections('COPY', sections).map((s) => s.id)).toEqual(['data']);
		expect(matchSections('theme', sections).map((s) => s.id)).toEqual(['theme']);
	});

	it('needs every word and ignores accents', () => {
		expect(matchSections('region date', sections).map((s) => s.id)).toEqual(['region']);
		expect(matchSections('copy dark', sections)).toEqual([]);
	});
});
