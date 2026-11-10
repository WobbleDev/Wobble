import { describe, expect, it } from 'vitest';
import { mapContactCsvRow, parseContactCsv, type ContactCsvColumns } from './csv-import-utils.ts';

const columns: ContactCsvColumns = { name: 0, email: 1, phone: 2 };

describe('parseContactCsv', () => {
	it('reads the header row and the data rows', async () => {
		const parsed = await parseContactCsv(
			'Name,Email,Phone\nMary Anning,mary@example.com,555-0100\n'
		);
		expect(parsed.headers).toEqual(['Name', 'Email', 'Phone']);
		expect(parsed.rows).toEqual([['Mary Anning', 'mary@example.com', '555-0100']]);
	});

	it('guesses the name, email and phone columns from common header spellings', async () => {
		const parsed = await parseContactCsv(
			'Full Name,E-mail Address,Mobile Number\nMary,mary@example.com,555\n'
		);
		expect(parsed.suggestedColumns).toEqual({ name: 0, email: 1, phone: 2 });
	});

	it('finds the alternative spellings of each guessed column', async () => {
		const parsed = await parseContactCsv('Worker Name,Telephone,Email\nMary,555,mary@x.com\n');
		expect(parsed.suggestedColumns).toEqual({ name: 0, email: 2, phone: 1 });
	});

	it('suggests -1 for a column it cannot match', async () => {
		const parsed = await parseContactCsv('Nickname,Shift\nMo,Early\n');
		expect(parsed.suggestedColumns).toEqual({ name: -1, email: -1, phone: -1 });
	});

	it('strips a byte-order mark and surrounding spaces from headers', async () => {
		const parsed = await parseContactCsv('﻿  Name , Email \nMary,mary@x.com\n');
		expect(parsed.headers).toEqual(['Name', 'Email']);
		expect(parsed.suggestedColumns.name).toBe(0);
	});

	it('names a blank header by its column number', async () => {
		const parsed = await parseContactCsv('Name,,Phone\nMary,x,555\n');
		expect(parsed.headers).toEqual(['Name', 'Column 2', 'Phone']);
	});

	it('skips empty lines between rows', async () => {
		const parsed = await parseContactCsv('Name,Email\n\nMary,m@x.com\n\nSam,s@x.com\n\n');
		expect(parsed.rows).toEqual([
			['Mary', 'm@x.com'],
			['Sam', 's@x.com']
		]);
	});

	// Pinned as found: papaparse reports a single column as an UndetectableDelimiter
	// warning, and the parser treats any reported error as fatal, so a one-column
	// list of names is refused. See ## Comments in the ticket.
	it('pins the refusal of a single-column file', async () => {
		await expect(parseContactCsv('Name\nMary\nSam\n')).rejects.toThrow(
			"Could not parse CSV near row 1: Unable to auto-detect delimiting character; defaulted to ','"
		);
	});

	it('keeps a quoted cell that contains a comma as one value', async () => {
		const parsed = await parseContactCsv('Name,Email\n"Shaw, Mary",mary@x.com\n');
		expect(parsed.rows).toEqual([['Shaw, Mary', 'mary@x.com']]);
	});

	it('rejects a file with only a header row', async () => {
		await expect(parseContactCsv('Name,Email\n')).rejects.toThrow(
			'The CSV must include a header row and at least one contact row.'
		);
	});

	// Pinned as found: an empty file fails in papaparse's delimiter check before the
	// header check runs, so it gets the parser message, not the header message.
	it('rejects an empty file with the parser message', async () => {
		await expect(parseContactCsv('')).rejects.toThrow(
			'Could not parse CSV near row 1: Unable to auto-detect delimiting character'
		);
	});

	it('names the row of a fatal parse error, counting from 1', async () => {
		await expect(parseContactCsv('Name,Email\n"Mary,m@x\n')).rejects.toThrow(
			'Could not parse CSV near row 2: Quoted field unterminated'
		);
	});

	// Pinned as found: a ragged row is not an error. A short row keeps the fields it has,
	// and a long row keeps its extra cells; mapContactCsvRow then reads missing cells as ''.
	it('accepts ragged rows without an error', async () => {
		const parsed = await parseContactCsv('Name,Email\nMary,m@x.com\nSam\nLee,l@x.com,extra\n');
		expect(parsed.rows).toEqual([['Mary', 'm@x.com'], ['Sam'], ['Lee', 'l@x.com', 'extra']]);
	});
});

describe('mapContactCsvRow', () => {
	it('numbers a row from 2, after the header row', () => {
		expect(mapContactCsvRow(['Mary', 'm@x.com', '555'], 0, columns).rowNumber).toBe(2);
		expect(mapContactCsvRow(['Sam', '', ''], 4, columns).rowNumber).toBe(6);
	});

	it('maps each mapped column to its field', () => {
		expect(mapContactCsvRow(['Mary Anning', 'mary@x.com', '5550100100'], 0, columns)).toEqual({
			rowNumber: 2,
			name: 'Mary Anning',
			email: 'mary@x.com',
			phone: '(555) 010-0100',
			phoneProblem: false,
			valid: true
		});
	});

	it('trims whitespace from each cell', () => {
		const mapped = mapContactCsvRow(['  Mary  ', ' m@x.com ', '\t555 '], 0, columns);
		expect(mapped).toMatchObject({ name: 'Mary', email: 'm@x.com', phone: '555' });
	});

	it('reads an unmapped column (-1) as an empty string', () => {
		const unmapped = mapContactCsvRow(['Mary', 'm@x.com'], 0, { name: 0, email: -1, phone: -1 });
		expect(unmapped).toMatchObject({ name: 'Mary', email: '', phone: '' });
	});

	it('reads a cell past the end of a short row as an empty string', () => {
		const short = mapContactCsvRow(['Mary'], 0, columns);
		expect(short).toMatchObject({ name: 'Mary', email: '', phone: '' });
	});

	it('marks a row valid only when it has a name', () => {
		expect(mapContactCsvRow(['Mary', '', ''], 0, columns).valid).toBe(true);
		expect(mapContactCsvRow(['', 'm@x.com', '555'], 0, columns).valid).toBe(false);
	});

	it('treats a whitespace-only name as missing', () => {
		expect(mapContactCsvRow(['   ', 'm@x.com', ''], 0, columns).valid).toBe(false);
	});

	it('marks a row with no name column as invalid', () => {
		const noName = mapContactCsvRow(['Mary'], 0, { name: -1, email: -1, phone: -1 });
		expect(noName).toMatchObject({ name: '', valid: false });
	});
});

describe('mapContactCsvRow phone cleaning', () => {
	it('stores a clean number formatted', () => {
		const mapped = mapContactCsvRow(['Mary', 'm@x.com', '555.010.0100'], 0, columns);
		expect(mapped).toMatchObject({ phone: '(555) 010-0100', phoneProblem: false });
	});

	it('drops a leading 1 when 11 digits remain', () => {
		const mapped = mapContactCsvRow(['Mary', 'm@x.com', '+1 555 010 0100'], 0, columns);
		expect(mapped).toMatchObject({ phone: '(555) 010-0100', phoneProblem: false });
	});

	it('flags a wrong-length number and keeps its trimmed text', () => {
		const short = mapContactCsvRow(['Mary', 'm@x.com', ' 555-0101 '], 0, columns);
		expect(short).toMatchObject({ phone: '555-0101', phoneProblem: true });

		// 11 digits is not a clean number when the first one is not a country prefix.
		const long = mapContactCsvRow(['Mary', 'm@x.com', '25550100100'], 0, columns);
		expect(long).toMatchObject({ phone: '25550100100', phoneProblem: true });
	});

	it('flags text with no digits', () => {
		const mapped = mapContactCsvRow(['Mary', 'm@x.com', 'abc'], 0, columns);
		expect(mapped).toMatchObject({ phone: 'abc', phoneProblem: true });
	});

	it('leaves an empty cell empty and unflagged', () => {
		const mapped = mapContactCsvRow(['Mary', 'm@x.com', ''], 0, columns);
		expect(mapped).toMatchObject({ phone: '', phoneProblem: false });
	});
});
