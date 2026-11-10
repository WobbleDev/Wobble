/**
 * What the CSV review shows and sends: each row's disposition and problems, the
 * Problems-only filter and its pages, the mapping samples, the accepted rows the commit
 * carries, and the two downloads. The downloads are built from row numbers, field roles
 * and problem codes only: no cell value can reach them.
 */
import type { ImportRowContact } from '#lib/client/workers-api.ts';
import type { WorkerAttributeDefinition, WorkerAttributeValues } from '#lib/domain-vocabulary.ts';
import {
	attributeValue,
	readAttributeCell,
	type AttributeCellReading,
	type CellProblemCode
} from './attribute-cell.ts';
import type { ContactCsvRow } from './csv-import-utils.ts';
import { duplicateFinder, type DuplicateSuggestion } from './duplicate-signals.ts';

export type ImportProblemColumn = 'name' | 'phone' | 'attribute';
export type ImportProblemCode =
	'name_required' | 'phone_not_ten_digits' | 'possible_duplicate' | CellProblemCode;
export type ImportProblem = {
	column: ImportProblemColumn;
	code: ImportProblemCode;
	/** The Attribute a cell problem belongs to. */
	attributeId?: string;
};

/**
 * `import`: the row comes in as read. `blank-phone`: it comes in with Phone left blank.
 * `skip`: it does not come in at all. `undecided`: the row has an Attribute problem or a
 * duplicate suggestion the organizer has not answered; nothing is decided for them.
 */
export type ImportDisposition = 'import' | 'blank-phone' | 'skip' | 'undecided';

/** What to do with a row whose Attribute cells have problems: leave those answers out, or skip the row. */
export type AttributeDecision = 'omit' | 'skip';
/** What to do with a row that may duplicate a Worker already there: skip it, or create it separately. */
export type DuplicateDecision = 'skip' | 'create';

export type RowDecisions = {
	attribute?: AttributeDecision;
	duplicate?: DuplicateDecision;
};

/** What one mapped Attribute reads from a row's cell. A blank cell is not listed. */
export type AttributeReading = {
	attributeId: string;
	reading: AttributeCellReading;
};

export type ReviewRow = ContactCsvRow & {
	disposition: ImportDisposition;
	problems: ImportProblem[];
	attributes: AttributeReading[];
	/** Workers already in the Worksite this row may be, with the reasons and nothing else. */
	duplicates: DuplicateSuggestion[];
	decisions: RowDecisions;
};

export type ReviewContext = {
	attributes: readonly WorkerAttributeDefinition[];
	/** The CSV column read for each Attribute, by Attribute id; absent or negative is not imported. */
	attributeColumns: Readonly<Record<string, number>>;
	/** The file's rows below the header, in file order. */
	csvRows: readonly (readonly string[])[];
	existing: readonly { id: string; name: string; email: string; phone: string }[];
	decisions: ReadonlyMap<number, RowDecisions>;
};

export type ReviewFilter = 'all' | 'problems';

export const reviewPageSize = 25;

export function reviewRows(rows: readonly ContactCsvRow[], context?: ReviewContext): ReviewRow[] {
	const find = context ? duplicateFinder(context.existing) : () => [];
	return rows.map((row) => {
		const problems: ImportProblem[] = [];
		if (!row.valid) problems.push({ column: 'name', code: 'name_required' });
		if (row.phoneProblem) problems.push({ column: 'phone', code: 'phone_not_ten_digits' });

		const attributes: AttributeReading[] = [];
		for (const attribute of context?.attributes ?? []) {
			const column = context?.attributeColumns[attribute.id] ?? -1;
			const cell = column < 0 ? '' : (context?.csvRows[row.rowNumber - 2]?.[column] ?? '');
			if (cell.trim() === '') continue;
			const reading = readAttributeCell(cell, attribute);
			attributes.push({ attributeId: attribute.id, reading });
			for (const problem of reading.problems) {
				problems.push({ column: 'attribute', code: problem.code, attributeId: attribute.id });
			}
		}

		const duplicates = row.valid ? find(row) : [];
		if (duplicates.length > 0) problems.push({ column: 'name', code: 'possible_duplicate' });

		const decisions = context?.decisions.get(row.rowNumber) ?? {};
		const hasAttributeProblem = attributes.some((entry) => entry.reading.problems.length > 0);
		const skipped = !row.valid || decisions.attribute === 'skip' || decisions.duplicate === 'skip';
		const undecided =
			(hasAttributeProblem && decisions.attribute === undefined) ||
			(duplicates.length > 0 && decisions.duplicate === undefined);

		return {
			...row,
			problems,
			attributes,
			duplicates,
			decisions,
			disposition: skipped
				? 'skip'
				: undecided
					? 'undecided'
					: row.phoneProblem
						? 'blank-phone'
						: 'import'
		};
	});
}

/**
 * The rows the commit carries: every row that comes in, each with its source row number
 * and the answers its cells name. A cell's problem tokens are never in them; the organizer
 * has chosen to leave those out.
 */
export function acceptedRows(
	rows: readonly ReviewRow[],
	attributes: readonly WorkerAttributeDefinition[] = []
): ImportRowContact[] {
	return rows
		.filter((row) => row.disposition === 'import' || row.disposition === 'blank-phone')
		.map(({ rowNumber, name, email, phone, disposition, attributes: readings }) => {
			const values: WorkerAttributeValues = {};
			for (const { attributeId, reading } of readings) {
				const attribute = attributes.find((candidate) => candidate.id === attributeId);
				if (attribute && reading.ids.length > 0) {
					values[attributeId] = attributeValue(attribute, reading.ids);
				}
			}
			return {
				row: rowNumber,
				name,
				email,
				phone: disposition === 'blank-phone' ? '' : phone,
				...(Object.keys(values).length > 0 ? { attributes: values } : {})
			};
		});
}

export type ReviewPage = {
	rows: ReviewRow[];
	/** One-based, clamped into the range. */
	page: number;
	pageCount: number;
	/** Rows in the chosen view, over every page. */
	total: number;
};

export function reviewPage(
	rows: readonly ReviewRow[],
	filter: ReviewFilter,
	page: number,
	size = reviewPageSize
): ReviewPage {
	const shown = filter === 'problems' ? rows.filter((row) => row.problems.length > 0) : rows;
	const pageCount = Math.max(1, Math.ceil(shown.length / size));
	const at = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
	return {
		rows: shown.slice((at - 1) * size, at * size),
		page: at,
		pageCount,
		total: shown.length
	};
}

/** The first few non-empty cells of a mapped column, so the choice can be checked against the file. */
export function mappingSamples(
	csvRows: readonly (readonly string[])[],
	column: number,
	limit = 3
): string[] {
	if (column < 0) return [];
	const samples: string[] = [];
	for (const row of csvRows) {
		const cell = (row[column] ?? '').trim();
		if (cell) samples.push(cell);
		if (samples.length === limit) break;
	}
	return samples;
}

export type DiagnosticLabels = {
	row: string;
	column: string;
	problem: string;
	columns: Record<Exclude<ImportProblemColumn, 'attribute'>, string>;
	/** An Attribute's name, for the column of a cell problem. */
	attributeName: (attributeId: string) => string;
	problems: Record<ImportProblemCode, string>;
};

/** One line of the problems download. It has no field for a cell value. */
export type DiagnosticEntry = { row: number; column: string; problem: string };

export function diagnosticEntries(
	rows: readonly ReviewRow[],
	labels: DiagnosticLabels
): DiagnosticEntry[] {
	return rows.flatMap((row) =>
		row.problems.map((problem) => ({
			row: row.rowNumber,
			column:
				problem.column === 'attribute'
					? labels.attributeName(problem.attributeId ?? '')
					: labels.columns[problem.column],
			problem: labels.problems[problem.code]
		}))
	);
}

function csvCell(text: string) {
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The problems download: row number, column and problem. */
export function diagnosticsCsv(rows: readonly ReviewRow[], labels: DiagnosticLabels): string {
	const lines = [
		[labels.row, labels.column, labels.problem].map(csvCell).join(','),
		...diagnosticEntries(rows, labels).map((entry) =>
			[String(entry.row), entry.column, entry.problem].map(csvCell).join(',')
		)
	];
	return lines.join('\r\n') + '\r\n';
}

/** The template download: the headers the mapping recognises, and no row. */
export function templateCsv(headers: readonly string[]): string {
	return headers.map(csvCell).join(',') + '\r\n';
}
