import type { WorkerAttributeValues, WorkerImportContact } from '#lib/domain-vocabulary.ts';
import { decodeImportResult, type ImportResult } from './api-decode.ts';
import { jsonInit, requestJson } from './request-json.ts';

/** One accepted CSV row: the source row number the review showed, and the contact it becomes. */
export type ImportRowContact = WorkerImportContact & {
	row: number;
	/** The answers the review chose, by Attribute id, as the Attribute stores them. */
	attributes?: WorkerAttributeValues;
};

/**
 * Creates the accepted rows in one core transaction. `attributeIds` names the Attribute
 * definitions the review saw; the core refuses (`import_stale_vocabulary`) and creates
 * nothing when they changed since. Answers each created id against its source row.
 */
export function importContacts(
	contacts: ImportRowContact[],
	attributeIds: readonly string[]
): Promise<ImportResult> {
	return requestJson(
		'/api/workers',
		jsonInit('POST', { contacts, attributeIds }),
		(status) => `Could not import contacts (HTTP ${status}).`,
		decodeImportResult
	);
}
