/**
 * Short forms while a Configuration is edited (ADR 0046). Pure: the core generates and
 * validates every form; this only decides what a row shows and what an edit does to the draft.
 */
import { SHORT_FORM_LIMIT, graphemeCount } from '#lib/shared/short-form.ts';
import type { AttributeAnswerDraft } from './attribute-draft.ts';

/** The text a row's Short form field shows: the edited form, else the core's suggestion. */
export function shownShortForm(
	answer: AttributeAnswerDraft,
	suggestions: ReadonlyMap<string, string>
): string {
	if (answer.shortFormOrigin === 'edited') return answer.shortForm ?? '';
	return suggestions.get(answer.id) ?? answer.shortForm ?? '';
}

function withoutShortForm(answer: AttributeAnswerDraft): AttributeAnswerDraft {
	const rest = { ...answer };
	delete rest.shortForm;
	delete rest.shortFormOrigin;
	return rest;
}

/** Typing edits the form; clearing it returns the value to a generated one. */
export function editShortForm(answer: AttributeAnswerDraft, text: string): AttributeAnswerDraft {
	if (!text.trim()) return withoutShortForm(answer);
	return { ...answer, shortForm: text, shortFormOrigin: 'edited' };
}

/** A rename regenerates a generated form (the core suggests the new one) and keeps an edited one. */
export function renameAnswerValue(
	answer: AttributeAnswerDraft,
	value: string
): AttributeAnswerDraft {
	const renamed = { ...answer, value };
	return answer.shortFormOrigin === 'edited' ? renamed : withoutShortForm(renamed);
}

/** Whether an edited form is beyond the limit; Save waits until it fits. */
export function shortFormTooLong(answer: AttributeAnswerDraft): boolean {
	return (
		answer.shortFormOrigin === 'edited' &&
		graphemeCount((answer.shortForm ?? '').trim()) > SHORT_FORM_LIMIT
	);
}
