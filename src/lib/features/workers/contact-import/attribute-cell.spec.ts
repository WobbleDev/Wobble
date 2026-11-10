import { describe, expect, it } from 'vitest';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { parseAttributeCell, readAttributeCell } from './attribute-cell.ts';

const bs = (text: string) => text.replaceAll('¦', String.fromCharCode(92));

const tokens = (marked: string) => {
	const cell = bs(marked);
	const parsed = parseAttributeCell(cell);
	if (!parsed.ok) throw new Error(`expected ${JSON.stringify(cell)} to parse`);
	return parsed.tokens.map((token) => token.segments);
};

const failure = (marked: string) => {
	const parsed = parseAttributeCell(bs(marked));
	return parsed.ok ? null : parsed;
};

describe('the attribute cell grammar', () => {
	it('splits on semicolons and trims every token', () => {
		expect(tokens('Cook;Server')).toEqual([['Cook'], ['Server']]);
		expect(tokens('  Cook ;\tServer  ')).toEqual([['Cook'], ['Server']]);
	});

	it('reads a blank cell as no answers at all', () => {
		expect(tokens('')).toEqual([]);
		expect(tokens('   ')).toEqual([]);
	});

	it('keeps the position of an empty token and counts it as no answer', () => {
		const parsed = parseAttributeCell('Cook;;Server');
		expect(parsed).toEqual({
			ok: true,
			tokens: [
				{ position: 1, segments: ['Cook'] },
				{ position: 2, segments: [] },
				{ position: 3, segments: ['Server'] }
			]
		});
		expect(parseAttributeCell(';')).toEqual({
			ok: true,
			tokens: [
				{ position: 1, segments: [] },
				{ position: 2, segments: [] }
			]
		});
		expect(parseAttributeCell(' ; a')).toMatchObject({
			ok: true,
			tokens: [
				{ position: 1, segments: [] },
				{ position: 2, segments: ['a'] }
			]
		});
	});

	it('reads a backslash-semicolon as a literal semicolon', () => {
		expect(tokens('Cook¦; Prep;Server')).toEqual([['Cook; Prep'], ['Server']]);
	});

	it('reads a doubled backslash before a semicolon as a literal backslash, then splits', () => {
		expect(tokens('Cook¦¦;Server')).toEqual([['Cook' + bs('¦')], ['Server']]);
	});

	it('reads an escaped backslash followed by an escaped semicolon as both literals', () => {
		expect(tokens('Cook¦¦¦;Server')).toEqual([['Cook' + bs('¦;Server')]]);
	});

	it('refuses a trailing lone backslash, never reading it as a literal', () => {
		expect(failure('Cook¦')).toEqual({ ok: false, error: 'trailing_backslash' });
		expect(failure('Cook;Server¦')).toEqual({ ok: false, error: 'trailing_backslash' });
		// An escaped backslash then a lone one.
		expect(failure('Cook¦¦¦')).toEqual({ ok: false, error: 'trailing_backslash' });
		expect(failure('¦')).toEqual({ ok: false, error: 'trailing_backslash' });
	});

	it('refuses a backslash before any other character', () => {
		expect(failure('Co¦ok')).toEqual({ ok: false, error: 'invalid_escape' });
		expect(failure('Cook¦ ;Server')).toEqual({ ok: false, error: 'invalid_escape' });
	});

	it('splits a nested path on greater-than and trims each step', () => {
		expect(tokens('Kitchen > Cook')).toEqual([['Kitchen', 'Cook']]);
		expect(tokens('Kitchen>Cook;Floor')).toEqual([['Kitchen', 'Cook'], ['Floor']]);
	});

	it('reads a backslash-greater-than as a literal greater-than inside one step', () => {
		expect(tokens('A¦>B')).toEqual([['A>B']]);
	});

	it('refuses a path with an empty step', () => {
		expect(failure('Kitchen >')).toEqual({ ok: false, error: 'empty_path_segment', position: 1 });
		expect(failure('> Cook')).toEqual({ ok: false, error: 'empty_path_segment', position: 1 });
		expect(failure('A;Kitchen >> Cook')).toEqual({
			ok: false,
			error: 'empty_path_segment',
			position: 2
		});
	});
});

function answer(id: string, value: string, parentId?: string, mode?: 'single' | 'multi') {
	return { id, value, ...(parentId ? { parentId } : {}), ...(mode ? { mode } : {}) };
}

const department: WorkerAttributeDefinition = {
	id: 'department',
	name: 'Department',
	kind: 'category',
	answers: [
		answer('kitchen', 'Kitchen'),
		answer('cook', 'Cook', 'kitchen'),
		answer('prep', 'Prep', 'kitchen'),
		answer('floor', 'Floor'),
		answer('host', 'Host', 'floor')
	]
};

const skills: WorkerAttributeDefinition = {
	id: 'skills',
	name: 'Skills',
	kind: 'tag',
	answers: [
		answer('spanish', 'Spanish'),
		answer('forklift', 'Forklift'),
		answer('first-aid', 'First aid')
	]
};

describe('reading a cell against an Attribute', () => {
	it('resolves a nested path to the answer id it ends on', () => {
		expect(readAttributeCell('Kitchen > Cook', department)).toEqual({
			ids: ['cook'],
			emptyPositions: [],
			problems: []
		});
	});

	it('matches ignoring case and surrounding space', () => {
		expect(readAttributeCell('  kitchen>COOK ', department).ids).toEqual(['cook']);
	});

	it('resolves a top-level answer on its own', () => {
		expect(readAttributeCell('Floor', department).ids).toEqual(['floor']);
	});

	it('reads several tokens of a Multi-Select Attribute in cell order, once each', () => {
		expect(readAttributeCell('Spanish; Forklift; spanish', skills).ids).toEqual([
			'spanish',
			'forklift'
		]);
	});

	it('reports an empty token as no answer for its position, and imports nothing for it', () => {
		const reading = readAttributeCell('Spanish;;Forklift', skills);
		expect(reading.ids).toEqual(['spanish', 'forklift']);
		expect(reading.emptyPositions).toEqual([2]);
		expect(reading.problems).toEqual([]);
	});

	it('reads a blank cell as nothing, with no problem', () => {
		expect(readAttributeCell('  ', skills)).toEqual({ ids: [], emptyPositions: [], problems: [] });
	});

	it('never creates vocabulary: an unknown value is a problem and imports nothing for it', () => {
		const reading = readAttributeCell('Spanish; Welding', skills);
		expect(reading.ids).toEqual(['spanish']);
		expect(reading.problems).toEqual([{ code: 'unknown_value', position: 2, text: 'Welding' }]);
	});

	it('does not resolve a step that is not under the step before it', () => {
		const reading = readAttributeCell('Kitchen > Host', department);
		expect(reading.ids).toEqual([]);
		expect(reading.problems).toEqual([
			{ code: 'unknown_value', position: 1, text: 'Kitchen > Host' }
		]);
	});

	it('does not resolve a nested answer by its name alone', () => {
		expect(readAttributeCell('Cook', department).problems).toEqual([
			{ code: 'unknown_value', position: 1, text: 'Cook' }
		]);
	});

	it('reports a label that two answers share at one level as ambiguous', () => {
		const twins: WorkerAttributeDefinition = {
			...skills,
			answers: [answer('a', 'Lead'), answer('b', 'lead')]
		};
		const reading = readAttributeCell('Lead', twins);
		expect(reading.ids).toEqual([]);
		expect(reading.problems).toEqual([{ code: 'ambiguous_value', position: 1, text: 'Lead' }]);
	});

	it('reports a Single-Select Attribute given two answers, keeping neither', () => {
		const reading = readAttributeCell('Floor; Kitchen', department);
		expect(reading.ids).toEqual([]);
		expect(reading.problems).toEqual([
			{ code: 'select_mode', text: 'Floor' },
			{ code: 'select_mode', text: 'Kitchen' }
		]);
	});

	it('reports two branches of one Single-Select group, keeping neither', () => {
		const reading = readAttributeCell('Kitchen > Cook; Floor > Host', department);
		expect(reading.ids).toEqual([]);
		expect(reading.problems).toEqual([
			{ code: 'select_mode', text: 'Cook' },
			{ code: 'select_mode', text: 'Host' }
		]);
	});

	it('refuses a malformed cell whole, with the grammar error as the problem', () => {
		expect(readAttributeCell(bs('Spanish¦'), skills)).toEqual({
			ids: [],
			emptyPositions: [],
			problems: [{ code: 'trailing_backslash' }]
		});
		expect(readAttributeCell('Kitchen >', department).problems).toEqual([
			{ code: 'empty_path_segment', position: 1 }
		]);
	});
});
