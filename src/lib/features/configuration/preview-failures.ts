/** The messages shown when a Configuration preview or Save fails. */
import { m } from '#lib/paraglide/messages.js';
import { ApiError } from '#lib/client/api-error.ts';

/**
 * The copy the save bar shows when a preview fails (ADR-0024). The core's message is a
 * diagnostic, not screen copy: the stable code picks the words, and the fallback stays
 * generic.
 */
export function previewFailureMessage(error: unknown): string {
	const code = error instanceof ApiError ? error.code : undefined;
	switch (code) {
		case 'attribute_answers_in_use':
			return m.configuration_answers_in_use();
		case 'configuration_answer_has_children':
			return m.configuration_error_answer_has_children();
		case 'configuration_merge_invalid':
			return m.configuration_error_merge_invalid_preview();
		case 'configuration_hierarchy_invalid':
			return m.configuration_error_hierarchy_invalid_preview();
		case 'configuration_sibling_label_conflict':
			return m.configuration_error_sibling_label_conflict();
		case 'invalid_configuration_preview':
			return m.configuration_error_preview_failed();
		default:
			return m.configuration_error_preview_generic();
	}
}

/**
 * The copy the save bar shows when a resolution-aware Save refuses or fails (ADR-0024).
 * The core message never reaches the screen.
 */
export function configurationSaveFailureMessage(error: unknown): string {
	const code = error instanceof ApiError ? error.code : undefined;
	switch (code) {
		case 'attribute_answers_in_use':
			return m.configuration_answers_in_use();
		case 'stale_configuration_preview':
			return m.configuration_error_stale_preview();
		case 'configuration_resolution_required':
			return m.configuration_error_resolution_required();
		case 'configuration_replacement_invalid':
			return m.configuration_error_replacement_invalid();
		case 'configuration_answer_has_children':
			return m.configuration_error_answer_has_children();
		case 'configuration_merge_invalid':
			return m.configuration_error_merge_invalid_save();
		case 'configuration_hierarchy_invalid':
			return m.configuration_error_hierarchy_invalid_save();
		case 'configuration_sibling_label_conflict':
			return m.configuration_error_sibling_label_conflict();
		default:
			return m.configuration_error_save_generic();
	}
}
