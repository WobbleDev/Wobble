/**
 * Reading a pasted or uploaded CSV into rows of Contacts: the header row, the
 * column guessing, and the per-cell cleanup.
 */
import type { WorkerImportContact } from '#lib/domain-vocabulary.ts';
import { normalizePhone } from '../phone.ts';

export type ContactCsvRow = WorkerImportContact & {
	rowNumber: number;
	valid: boolean;
	/** The phone cell cannot become a clean number, so the row imports with Phone blank. */
	phoneProblem: boolean;
};

export type ContactCsvColumns = {
	name: number;
	email: number;
	phone: number;
};

/** Why a CSV could not be read; the dialog words it, never the parser's text. */
export type ContactCsvErrorCode = 'parse' | 'empty';

export class ContactCsvError extends Error {
	readonly code: ContactCsvErrorCode;
	/** The one-based row a fatal parse error was found on. */
	readonly row?: number;

	constructor(code: ContactCsvErrorCode, message: string, row?: number) {
		super(message);
		this.name = 'ContactCsvError';
		this.code = code;
		this.row = row;
	}
}

/**
 * Async because papaparse is a 51KB parser that would otherwise ship in the
 * shell bundle on every route for a dialog most visits never open. It loads the
 * first time a file is actually read.
 */
export async function parseContactCsv(text: string) {
	const { default: Papa } = await import('papaparse');
	const result = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
	const parseError = result.errors[0];
	if (parseError) {
		const row = (parseError.row ?? 0) + 1;
		throw new ContactCsvError(
			'parse',
			`Could not parse CSV near row ${row}: ${parseError.message}`,
			row
		);
	}

	const [rawHeaders, ...rows] = result.data;
	if (!rawHeaders || rows.length === 0) {
		throw new ContactCsvError(
			'empty',
			'The CSV must include a header row and at least one contact row.'
		);
	}

	const headers = rawHeaders.map(
		(header, index) => header.replace(/^\uFEFF/, '').trim() || `Column ${index + 1}`
	);

	return {
		headers,
		rows,
		suggestedColumns: {
			name: findColumn(headers, ['name', 'fullname', 'contactname', 'workername']),
			email: findColumn(headers, ['email', 'emailaddress']),
			phone: findColumn(headers, ['phone', 'phonenumber', 'telephone', 'mobile', 'mobilenumber'])
		} satisfies ContactCsvColumns
	};
}

export function mapContactCsvRow(
	row: readonly string[],
	index: number,
	columns: ContactCsvColumns
): ContactCsvRow {
	const name = readCell(row, columns.name);
	const phone = readCell(row, columns.phone);
	const cleanPhone = normalizePhone(phone);

	return {
		rowNumber: index + 2,
		name,
		email: readCell(row, columns.email),
		phone: cleanPhone ?? phone,
		phoneProblem: cleanPhone === null,
		valid: name.length > 0
	};
}

function readCell(row: readonly string[], column: number) {
	return column < 0 ? '' : (row[column] ?? '').trim();
}

function findColumn(headers: readonly string[], aliases: readonly string[]) {
	return headers.findIndex((header) =>
		aliases.includes(header.toLowerCase().replace(/[^a-z0-9]/g, ''))
	);
}
