/**
 * An Attribute cell of an imported CSV: the grammar it is read with, and what it names in
 * an Attribute that already exists. Import never creates a value; a token that names
 * nothing, or names it ambiguously, is a problem for the review to put to the organizer.
 *
 * Grammar (ticket 22, Decisions):
 *
 *   trailing lone backslash   = error
 *   \\ before ;             = literal backslash, then split
 *   \; (backslash semicolon) = literal semicolon
 *   empty token               = no answer for that position
 *   tokens are trimmed
 *
 * Choices beyond that block: a nested path is its steps joined by `>` (\> is a literal
 * `>`); a backslash before any other character is an error; the cell is read whole, so one
 * error refuses the cell and imports nothing from it; a blank cell is no answers.
 */
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { resolveIds, shapeValue } from '#lib/shared/select-mode.ts';

/** One token: its one-based position in the cell, and its path steps (none when empty). */
export type CellToken = { position: number; segments: string[] };

export type CellSyntaxError = 'trailing_backslash' | 'invalid_escape' | 'empty_path_segment';

export type CellParse =
	{ ok: true; tokens: CellToken[] } | { ok: false; error: CellSyntaxError; position?: number };

export function parseAttributeCell(cell: string): CellParse {
	if (cell.trim() === '') return { ok: true, tokens: [] };

	const tokens: CellToken[] = [];
	let segments: string[] = [];
	let current = '';
	let sawSeparator = false;

	const endSegment = () => {
		segments.push(current.trim());
		current = '';
	};
	const endToken = (): CellSyntaxError | null => {
		endSegment();
		const position = tokens.length + 1;
		if (segments.length === 1 && segments[0] === '' && !sawSeparator) {
			tokens.push({ position, segments: [] });
		} else if (segments.some((segment) => segment === '')) {
			return 'empty_path_segment';
		} else {
			tokens.push({ position, segments });
		}
		segments = [];
		sawSeparator = false;
		return null;
	};

	for (let index = 0; index < cell.length; index += 1) {
		const char = cell[index];
		if (char === '\\') {
			const next = cell[index + 1];
			if (next === undefined) return { ok: false, error: 'trailing_backslash' };
			if (next !== '\\' && next !== ';' && next !== '>') {
				return { ok: false, error: 'invalid_escape' };
			}
			current += next;
			index += 1;
		} else if (char === ';') {
			const error = endToken();
			if (error) return { ok: false, error, position: tokens.length + 1 };
		} else if (char === '>') {
			endSegment();
			sawSeparator = true;
		} else {
			current += char;
		}
	}
	const error = endToken();
	if (error) return { ok: false, error, position: tokens.length + 1 };
	return { ok: true, tokens };
}

export type CellProblemCode =
	| CellSyntaxError
	| 'unknown_value'
	| 'ambiguous_value'
	/** The answers named cannot be held together under the Attribute's select modes. */
	| 'select_mode';

/**
 * `position` is the token's place in the cell; `text` is the token as the organizer wrote
 * it, for the review to show beside the problem. It never reaches a download.
 */
export type CellProblem = { code: CellProblemCode; position?: number; text?: string };

export type AttributeCellReading = {
	/** The answer ids the cell names that are fine to import, in cell order. */
	ids: string[];
	/** Positions of empty tokens: no answer there. */
	emptyPositions: number[];
	problems: CellProblem[];
};

function key(text: string) {
	return text.normalize('NFC').trim().toLocaleLowerCase();
}

export function readAttributeCell(
	cell: string,
	attribute: WorkerAttributeDefinition
): AttributeCellReading {
	const parsed = parseAttributeCell(cell);
	if (!parsed.ok) {
		return {
			ids: [],
			emptyPositions: [],
			problems: [
				{
					code: parsed.error,
					...(parsed.position === undefined ? {} : { position: parsed.position })
				}
			]
		};
	}

	const ids: string[] = [];
	const emptyPositions: number[] = [];
	const problems: CellProblem[] = [];

	for (const token of parsed.tokens) {
		if (token.segments.length === 0) {
			emptyPositions.push(token.position);
			continue;
		}
		const text = token.segments.join(' > ');
		let parentId: string | undefined;
		let resolved: string | null = null;
		let failed: CellProblemCode | null = null;
		for (const segment of token.segments) {
			const matches = attribute.answers.filter(
				(answer) => answer.parentId === parentId && key(answer.value) === key(segment)
			);
			if (matches.length !== 1) {
				failed = matches.length === 0 ? 'unknown_value' : 'ambiguous_value';
				break;
			}
			resolved = matches[0].id;
			parentId = resolved;
		}
		if (failed || resolved === null) {
			problems.push({ code: failed ?? 'unknown_value', position: token.position, text });
		} else if (!ids.includes(resolved)) {
			ids.push(resolved);
		}
	}

	// Which answer wins a conflict is the organizer's to say, so neither goes in: every answer
	// that cannot be held with another named one is left out and reported.
	const { dropped } = resolveIds(attribute, ids);
	const involved = new Set<string>(dropped);
	for (const id of dropped) {
		for (const other of ids) {
			if (resolveIds(attribute, [other, id]).dropped.length > 0) involved.add(other);
		}
	}
	for (const id of ids.filter((candidate) => involved.has(candidate))) {
		const label = attribute.answers.find((answer) => answer.id === id)?.value ?? id;
		problems.push({ code: 'select_mode', text: label });
	}

	return { ids: ids.filter((id) => !involved.has(id)), emptyPositions, problems };
}

/** The value a Worker is created with for the ids a cell names, as the Attribute stores it. */
export function attributeValue(attribute: WorkerAttributeDefinition, ids: readonly string[]) {
	return shapeValue(attribute, ids);
}
