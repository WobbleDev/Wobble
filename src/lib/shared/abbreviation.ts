/** A Abbreviation is at most this many graphemes (ADR 0046); the core enforces it on save. */
export const ABBREVIATION_LIMIT = 10;

import type { AbbreviationOrigin } from '#lib/client/generated/AbbreviationOrigin.ts';

export type { AbbreviationOrigin };

export function isAbbreviationOrigin(value: unknown): value is AbbreviationOrigin {
	return value === 'generated' || value === 'edited';
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The length of `text` in user-perceived characters. */
export function graphemeCount(text: string): number {
	return [...segmenter.segment(text)].length;
}

/** Whether `value` is a stored Abbreviation: 1 to 10 graphemes. */
export function isAbbreviation(value: unknown): value is string {
	return (
		typeof value === 'string' && value.length > 0 && graphemeCount(value) <= ABBREVIATION_LIMIT
	);
}
