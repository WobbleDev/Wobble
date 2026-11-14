/**
 * Abbreviations while a Configuration is edited (ADR 0046). Pure: the core generates and
 * validates every form; this only decides what a row shows and what an edit does to the draft.
 */
import { ABBREVIATION_LIMIT, graphemeCount } from '#lib/shared/abbreviation.ts';
import type { AttributeAnswerDraft } from './attribute-draft.ts';

/** The text a row's Abbreviation field shows: the edited form, else the core's suggestion. */
export function shownAbbreviation(
	answer: AttributeAnswerDraft,
	suggestions: ReadonlyMap<string, string>
): string {
	if (answer.abbreviationOrigin === 'edited') return answer.abbreviation ?? '';
	return suggestions.get(answer.id) ?? answer.abbreviation ?? '';
}

function withoutAbbreviation(answer: AttributeAnswerDraft): AttributeAnswerDraft {
	const rest = { ...answer };
	delete rest.abbreviation;
	delete rest.abbreviationOrigin;
	return rest;
}

/** Typing edits the form; clearing it returns the value to a generated one. */
export function editAbbreviation(answer: AttributeAnswerDraft, text: string): AttributeAnswerDraft {
	if (!text.trim()) return withoutAbbreviation(answer);
	return { ...answer, abbreviation: text, abbreviationOrigin: 'edited' };
}

/** A rename regenerates a generated form (the core suggests the new one) and keeps an edited one. */
export function renameAnswerValue(
	answer: AttributeAnswerDraft,
	value: string
): AttributeAnswerDraft {
	const renamed = { ...answer, value };
	return answer.abbreviationOrigin === 'edited' ? renamed : withoutAbbreviation(renamed);
}

/** Whether an edited form is beyond the limit; Save waits until it fits. */
export function abbreviationTooLong(answer: AttributeAnswerDraft): boolean {
	return (
		answer.abbreviationOrigin === 'edited' &&
		graphemeCount((answer.abbreviation ?? '').trim()) > ABBREVIATION_LIMIT
	);
}
