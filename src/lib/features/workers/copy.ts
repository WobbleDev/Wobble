/**
 * The Workers view's count-aware copy.
 *
 * Paraglide messages are complete sentences only, so a count chooses one of
 * three already-complete messages instead of a translated suffix being glued on.
 * Every function reads the messages when it is called, after the launch locale
 * has been frozen.
 */
import { m } from '#lib/paraglide/messages.js';
import type { BulkCopy } from './data-table/bulk-actions-copy.ts';

/** "0 workers", "1 worker", "3 workers". */
export function workerCount(count: number): string {
	if (count === 0) return m.workers_count_zero();
	if (count === 1) return m.workers_count_one();
	return m.workers_count_many({ count });
}

/** "1 selected", "3 selected". */
export function selectedCount(count: number): string {
	return count === 1 ? m.workers_selected_one() : m.workers_selected_many({ count });
}

/** The import button's complete label: "Import 1 contact", "Import 3 contacts". */
export function contactImportAction(count: number): string {
	if (count === 0) return m.workers_import_import_zero();
	if (count === 1) return m.workers_import_import_one();
	return m.workers_import_import_many({ count });
}

/** The completion sentence: "Imported 6 contacts." */
export function contactImportComplete(count: number): string {
	if (count === 0) return m.workers_import_complete_zero();
	if (count === 1) return m.workers_import_complete_one();
	return m.workers_import_complete_many({ count });
}

/** How many unusable phones the import left blank. */
export function blankPhoneSummary(count: number): string {
	return count === 1
		? m.workers_import_blank_phone_one()
		: m.workers_import_blank_phone_many({ count });
}

/** The complete copy one bulk run needs, selected by count at call time. */
export function bulkCopy(): BulkCopy {
	return {
		assessmentField: m.workers_field_assessment(),
		languagesField: m.workers_field_languages(),
		reloadFailed: m.workers_reload_failed(),
		count: workerCount,
		saved: (field, count) => {
			if (count === 0) return m.workers_bulk_saved_zero({ field });
			if (count === 1) return m.workers_bulk_saved_one({ field });
			return m.workers_bulk_saved_many({ field, count });
		},
		savedPartial: (field, applied, requested) =>
			m.workers_bulk_saved_partial({ field, applied, requested }),
		assessmentFailed: (count) => {
			if (count === 0) return m.workers_bulk_assessment_failed_zero();
			if (count === 1) return m.workers_bulk_assessment_failed_one();
			return m.workers_bulk_assessment_failed_many({ count });
		},
		languagesFailed: (count) => {
			if (count === 0) return m.workers_bulk_languages_failed_zero();
			if (count === 1) return m.workers_bulk_languages_failed_one();
			return m.workers_bulk_languages_failed_many({ count });
		},
		setFailed: (field, count) => {
			if (count === 0) return m.workers_bulk_set_failed_zero({ field });
			if (count === 1) return m.workers_bulk_set_failed_one({ field });
			return m.workers_bulk_set_failed_many({ field, count });
		},
		changeFailed: (field, count) => {
			if (count === 0) return m.workers_bulk_change_failed_zero({ field });
			if (count === 1) return m.workers_bulk_change_failed_one({ field });
			return m.workers_bulk_change_failed_many({ field, count });
		},
		deleteFailed: (count) => {
			if (count === 0) return m.workers_bulk_delete_failed_zero();
			if (count === 1) return m.workers_bulk_delete_failed_one();
			return m.workers_bulk_delete_failed_many({ count });
		},
		deleted: (count) => {
			if (count === 0) return m.workers_bulk_deleted_zero();
			if (count === 1) return m.workers_bulk_deleted_one();
			return m.workers_bulk_deleted_many({ count });
		},
		deletedPartial: (applied, total) => m.workers_bulk_deleted_partial({ applied, total })
	};
}

/** How many rows the import skipped. */
export function skippedRowSummary(count: number): string {
	return count === 1
		? m.workers_import_complete_skipped_one()
		: m.workers_import_complete_skipped_many({ count });
}

/** How many imported rows may duplicate a Worker that was already there. */
export function duplicateRowSummary(count: number): string {
	return count === 1
		? m.workers_import_complete_duplicates_one()
		: m.workers_import_complete_duplicates_many({ count });
}
