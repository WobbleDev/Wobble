/** A Short form is at most this many graphemes (ADR 0046); the core enforces it on save. */
export const SHORT_FORM_LIMIT = 10;

import type { ShortFormOrigin } from '#lib/client/generated/ShortFormOrigin.ts';

export type { ShortFormOrigin };

export function isShortFormOrigin(value: unknown): value is ShortFormOrigin {
	return value === 'generated' || value === 'edited';
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The length of `text` in user-perceived characters. */
export function graphemeCount(text: string): number {
	return [...segmenter.segment(text)].length;
}

/** Whether `value` is a stored Short form: 1 to 10 graphemes. */
export function isShortForm(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && graphemeCount(value) <= SHORT_FORM_LIMIT;
}
