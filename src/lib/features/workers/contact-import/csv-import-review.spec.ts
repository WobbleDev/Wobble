import { describe, expect, it } from 'vitest';
import {
	acceptedRows,
	diagnosticsCsv,
	mappingSamples,
	reviewPage,
	reviewRows,
	templateCsv,
	type DiagnosticLabels
} from './csv-import-review.ts';
import { mapContactCsvRow } from './csv-import-utils.ts';

const columns = { name: 0, email: 1, phone: 2 };
const labels: DiagnosticLabels = {
	row: 'Row',
	column: 'Column',
	problem: 'Problem',
	columns: { name: 'Name', phone: 'Phone' },
	attributeName: (id) => `Attribute ${id}`,
	problems: {
		name_required: 'Name required',
		phone_not_ten_digits: 'Not a 10-digit number',
		possible_duplicate: 'Possible duplicate',
		unknown_value: 'Unknown value',
		ambiguous_value: 'Ambiguous value',
		select_mode: 'Cannot be held together',
		trailing_backslash: 'Trailing backslash',
		invalid_escape: 'Invalid escape',
		empty_path_segment: 'Empty path step'
	}
};

function review(cells: string[][]) {
	return reviewRows(cells.map((row, index) => mapContactCsvRow(row, index, columns)));
}

describe('reviewing rows', () => {
	const rows = review([
		['Worker 01', 'w1@example.test', '5550100100'],
		['', '', 'abc'],
		['Worker 03', '', '555-0101']
	]);

	it('tells a skipped row from a row that imports with Phone blank', () => {
		expect(rows.map((row) => row.disposition)).toEqual(['import', 'skip', 'blank-phone']);
		// A skipped row still carries its phone problem: it is in the file.
		expect(rows[1]?.problems.map((problem) => problem.code)).toEqual([
			'name_required',
			'phone_not_ten_digits'
		]);
	});

	it('sends accepted rows with their source row numbers and blanks the bad phone', () => {
		expect(acceptedRows(rows)).toEqual([
			{ row: 2, name: 'Worker 01', email: 'w1@example.test', phone: '(555) 010-0100' },
			{ row: 4, name: 'Worker 03', email: '', phone: '' }
		]);
	});
});

describe('paging the review', () => {
	const many = review(Array.from({ length: 60 }, (_, i) => [i % 10 === 9 ? '' : `Worker ${i}`]));

	it('pages All rows and keeps the source row on each line', () => {
		const second = reviewPage(many, 'all', 2);
		expect(second.pageCount).toBe(3);
		expect(second.rows[0]?.rowNumber).toBe(27);
		expect(reviewPage(many, 'all', 99).page).toBe(3);
	});

	it('shows later problems, past the first page, under Problems only', () => {
		const problems = reviewPage(many, 'problems', 1);
		expect(problems.total).toBe(6);
		expect(problems.rows.map((row) => row.rowNumber)).toEqual([11, 21, 31, 41, 51, 61]);
	});
});

describe('mapping samples', () => {
	it('reads the first non-empty cells of the chosen column', () => {
		const csv = [
			['', 'a'],
			['Worker 02', ''],
			['Worker 03', ''],
			[' Worker 04 ', ''],
			['Worker 05']
		];
		expect(mappingSamples(csv, 0)).toEqual(['Worker 02', 'Worker 03', 'Worker 04']);
		expect(mappingSamples(csv, -1)).toEqual([]);
	});
});

describe('downloads', () => {
	const rows = review([
		['Ada Lovelace', 'ada@example.test', '5550100100'],
		['', 'grace@example.test', 'Phone 555-0101 secret'],
		['Katherine Johnson', '', '555-0102']
	]);

	it('carries the row number, column and problem and no cell value', () => {
		const csv = diagnosticsCsv(rows, labels);
		expect(csv).toBe(
			'Row,Column,Problem\r\n3,Name,Name required\r\n3,Phone,Not a 10-digit number\r\n4,Phone,Not a 10-digit number\r\n'
		);
		for (const value of [
			'Ada',
			'Lovelace',
			'grace',
			'example.test',
			'5550100100',
			'secret',
			'Katherine'
		]) {
			expect(csv).not.toContain(value);
		}
	});

	it('quotes a label that needs it', () => {
		const csv = diagnosticsCsv(rows, {
			...labels,
			problems: { ...labels.problems, name_required: 'Name, required' }
		});
		expect(csv).toContain('"Name, required"');
	});

	it('is a header row alone for the template', () => {
		expect(templateCsv(['Name', 'Phone', 'Email'])).toBe('Name,Phone,Email\r\n');
	});
});

describe('attribute cells and duplicates in the review', () => {
	const attribute = {
		id: 'skills',
		name: 'Skills',
		kind: 'tag' as const,
		answers: [
			{ id: 'spanish', value: 'Spanish' },
			{ id: 'forklift', value: 'Forklift' }
		]
	};
	const cells = [
		['Worker 01', '', '', 'Spanish'],
		['Worker 02', '', '', 'Welding; Forklift'],
		['Worker 03', '', '', 'Spanish;;Forklift'],
		['Ada Lovelace', 'ada@example.test', '', '']
	];
	const existing = [{ id: 'e1', name: 'Worker 99', email: 'ada@example.test', phone: '' }];
	const read = (decisions = new Map()) =>
		reviewRows(
			cells.map((row, index) => mapContactCsvRow(row, index, columns)),
			{
				attributes: [attribute],
				attributeColumns: { skills: 3 },
				csvRows: cells,
				existing,
				decisions
			}
		);

	it('holds a row with an unknown value, and a row that may duplicate, until decided', () => {
		expect(read().map((row) => row.disposition)).toEqual([
			'import',
			'undecided',
			'import',
			'undecided'
		]);
		expect(read()[1]?.problems).toEqual([
			{ column: 'attribute', code: 'unknown_value', attributeId: 'skills' }
		]);
	});

	it('imports only what the cell names and the Attribute holds, once the row is decided', () => {
		const rows = read(new Map([[3, { attribute: 'omit' as const }]]));
		expect(rows[1]?.disposition).toBe('import');
		const accepted = acceptedRows(rows, [attribute]);
		expect(accepted.find((row) => row.row === 3)?.attributes).toEqual({ skills: ['forklift'] });
		// An empty token is no answer; the others still come in.
		expect(accepted.find((row) => row.row === 4)?.attributes).toEqual({
			skills: ['spanish', 'forklift']
		});
		expect(accepted.find((row) => row.row === 2)?.attributes).toEqual({ skills: ['spanish'] });
	});

	it('leaves a skipped row out and carries no value in the diagnostics', () => {
		const rows = read(
			new Map([
				[3, { attribute: 'skip' as const }],
				[5, { duplicate: 'skip' as const }]
			])
		);
		expect(acceptedRows(rows, [attribute]).map((row) => row.row)).toEqual([2, 4]);
		const csv = diagnosticsCsv(rows, labels);
		expect(csv).toContain('3,Attribute skills,Unknown value');
		expect(csv).toContain('5,Name,Possible duplicate');
		expect(csv).not.toContain('Welding');
		expect(csv).not.toContain('ada@example.test');
	});
});
