/**
 * The CSV import's behaviour, apart from the dialog that shows it: reading the file,
 * the column mapping, the review view (filter and page), the commit and what follows it.
 * The host is the boundary: the live Worksite and Attribute snapshot, the commit, the
 * list refresh and the hand-off to the created Workers.
 */
import { SvelteMap } from 'svelte/reactivity';
import { ApiError } from '#lib/client/api-error.ts';
import type { ImportResult } from '#lib/client/api-decode.ts';
import type { ImportRowContact } from '#lib/client/workers-api.ts';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import {
	acceptedRows,
	mappingSamples,
	reviewPage,
	reviewRows,
	type AttributeDecision,
	type DuplicateDecision,
	type ReviewFilter,
	type RowDecisions
} from './csv-import-review.ts';
import type { ExistingContact } from './duplicate-signals.ts';
import {
	ContactCsvError,
	mapContactCsvRow,
	parseContactCsv,
	type ContactCsvColumns
} from './csv-import-utils.ts';

export type ImportSnapshot = {
	worksiteId: string | null;
	worksiteName: string;
	/** The Attribute definitions the review is read against. */
	attributes: WorkerAttributeDefinition[];
	/** The Workers already in the Worksite, for duplicate suggestions. */
	workers: ExistingContact[];
};

export type ContactImportHost = {
	snapshot(): Promise<ImportSnapshot>;
	importRows(rows: ImportRowContact[], attributeIds: string[]): Promise<ImportResult>;
	refresh(): Promise<void>;
	openCreated(worksiteId: string | null, ids: string[]): Promise<void> | void;
};

export type ImportStage = 'upload' | 'review' | 'complete';

/** What went wrong, for the dialog to word. */
export type ImportError =
	| { code: 'parse'; row: number }
	| { code: 'empty' | 'read_failed' | 'import_failed' | 'stale_vocabulary' };

export type ContactImportFile = { name: string; text(): Promise<string> };

export function createContactImport(host: ContactImportHost) {
	let stage = $state<ImportStage>('upload');
	let fileName = $state('');
	let headers = $state<string[]>([]);
	let csvRows = $state.raw<string[][]>([]);
	let columns = $state<ContactCsvColumns>({ name: -1, email: -1, phone: -1 });
	let snapshot = $state.raw<ImportSnapshot>({
		worksiteId: null,
		worksiteName: '',
		attributes: [],
		workers: []
	});
	/** The CSV column read for each Attribute, by Attribute id. */
	let attributeColumns = $state<Record<string, number>>({});
	/** What the organizer decided for each row that asked, by source row. */
	const decisions = new SvelteMap<number, RowDecisions>();
	let filter = $state<ReviewFilter>('all');
	let pageNumber = $state(1);
	let reading = $state(false);
	let importing = $state(false);
	let error = $state<ImportError | null>(null);
	let refreshFailed = $state(false);
	let result = $state<ImportResult | null>(null);
	/** The rows the commit carried, kept so the completion can state what it did. */
	let committedBlankPhones = $state(0);
	let committedSkipped = $state(0);
	/** Rows imported next to Workers they may duplicate: the created id and the Workers it may be. */
	let committedDuplicates = $state.raw<{ created: string; candidates: string[] }[]>([]);

	const attributeIds = $derived(snapshot.attributes.map((attribute) => attribute.id));
	const rows = $derived(
		columns.name < 0
			? []
			: reviewRows(
					csvRows.map((row, index) => mapContactCsvRow(row, index, columns)),
					{
						attributes: snapshot.attributes,
						attributeColumns,
						csvRows,
						existing: snapshot.workers,
						decisions
					}
				)
	);
	const accepted = $derived(acceptedRows(rows, snapshot.attributes));
	const undecidedCount = $derived(rows.filter((row) => row.disposition === 'undecided').length);
	const blankPhoneCount = $derived(rows.filter((row) => row.disposition === 'blank-phone').length);
	const skippedCount = $derived(rows.filter((row) => row.disposition === 'skip').length);
	const problemRowCount = $derived(rows.filter((row) => row.problems.length > 0).length);
	const view = $derived(reviewPage(rows, filter, pageNumber));

	function reset() {
		stage = 'upload';
		fileName = '';
		headers = [];
		csvRows = [];
		columns = { name: -1, email: -1, phone: -1 };
		filter = 'all';
		pageNumber = 1;
		reading = false;
		importing = false;
		error = null;
		refreshFailed = false;
		result = null;
		committedBlankPhones = 0;
		committedSkipped = 0;
		committedDuplicates = [];
		attributeColumns = {};
		decisions.clear();
	}

	/** The Attribute whose name a header matches, for headers nothing else claimed. */
	function suggestAttributeColumns(headerRow: readonly string[], taken: ContactCsvColumns) {
		const claimed = [taken.name, taken.email, taken.phone];
		const suggested: Record<string, number> = {};
		const normal = (text: string) => text.normalize('NFC').trim().toLocaleLowerCase();
		for (const attribute of snapshot.attributes) {
			const index = headerRow.findIndex(
				(header, at) => !claimed.includes(at) && normal(header) === normal(attribute.name)
			);
			if (index >= 0) {
				suggested[attribute.id] = index;
				claimed.push(index);
			}
		}
		return suggested;
	}

	async function chooseFile(file: ContactImportFile) {
		reading = true;
		error = null;
		fileName = file.name;
		headers = [];
		csvRows = [];
		stage = 'upload';
		try {
			const parsed = await parseContactCsv(await file.text());
			// The vocabulary the review is read against, taken with the file.
			snapshot = await host.snapshot();
			headers = parsed.headers;
			csvRows = parsed.rows;
			columns = { ...parsed.suggestedColumns };
			attributeColumns = suggestAttributeColumns(parsed.headers, parsed.suggestedColumns);
			decisions.clear();
			filter = 'all';
			pageNumber = 1;
			stage = 'review';
		} catch (cause) {
			error =
				cause instanceof ContactCsvError && cause.code === 'parse'
					? { code: 'parse', row: cause.row ?? 1 }
					: cause instanceof ContactCsvError
						? { code: 'empty' }
						: { code: 'read_failed' };
		} finally {
			reading = false;
		}
	}

	// A different mapping reads different cells, so earlier decisions no longer describe them.
	function setColumn(role: keyof ContactCsvColumns, index: number) {
		columns = { ...columns, [role]: index };
		decisions.clear();
		pageNumber = 1;
	}

	function setAttributeColumn(attributeId: string, index: number) {
		attributeColumns = { ...attributeColumns, [attributeId]: index };
		decisions.clear();
		pageNumber = 1;
	}

	function decide(row: number, change: RowDecisions) {
		decisions.set(row, { ...decisions.get(row), ...change });
	}

	function decideAttribute(row: number, decision: AttributeDecision) {
		decide(row, { attribute: decision });
	}

	function decideDuplicate(row: number, decision: DuplicateDecision) {
		decide(row, { duplicate: decision });
	}

	/** The organizer's one answer for every row still waiting on it. */
	function decideAllAttributes(decision: AttributeDecision) {
		for (const row of rows) {
			if (
				row.valid &&
				row.decisions.attribute === undefined &&
				row.attributes.some((entry) => entry.reading.problems.length > 0)
			) {
				decideAttribute(row.rowNumber, decision);
			}
		}
	}

	function decideAllDuplicates(decision: DuplicateDecision) {
		for (const row of rows) {
			if (row.duplicates.length > 0 && row.decisions.duplicate === undefined) {
				decideDuplicate(row.rowNumber, decision);
			}
		}
	}

	function setFilter(next: ReviewFilter) {
		filter = next;
		pageNumber = 1;
	}

	function setPage(next: number) {
		pageNumber = reviewPage(rows, filter, next).page;
	}

	function back() {
		stage = 'upload';
		error = null;
	}

	/** Commits the accepted rows. Answers whether Workers were created. */
	async function commit(): Promise<boolean> {
		if (importing || accepted.length === 0 || undecidedCount > 0) return false;
		importing = true;
		error = null;
		refreshFailed = false;
		try {
			result = await host.importRows(accepted, attributeIds);
		} catch (cause) {
			if (cause instanceof ApiError && cause.code === 'import_stale_vocabulary') {
				// Nothing was created. Read the vocabulary again so the next Import commits
				// against what the Worksite holds now.
				error = { code: 'stale_vocabulary' };
				// What was decided described the old vocabulary, so it is asked again.
				decisions.clear();
				try {
					snapshot = await host.snapshot();
				} catch {
					// The next commit is refused the same way until the snapshot reads.
				}
			} else {
				error = { code: 'import_failed' };
			}
			return false;
		} finally {
			importing = false;
		}
		committedBlankPhones = blankPhoneCount;
		committedSkipped = skippedCount;
		const createdRows = result.created;
		committedDuplicates = rows.flatMap((row) => {
			const created = createdRows.find((entry) => entry.row === row.rowNumber)?.id;
			return created !== undefined && row.duplicates.length > 0
				? [{ created, candidates: row.duplicates.map((duplicate) => duplicate.workerId) }]
				: [];
		});
		stage = 'complete';
		try {
			await host.refresh();
		} catch {
			refreshFailed = true;
		}
		return true;
	}

	/** Opens the created Workers, in the order the file listed them. */
	async function continueToWorkers() {
		if (!result || result.created.length === 0) return;
		await host.openCreated(
			snapshot.worksiteId,
			result.created.map((created) => created.id)
		);
	}

	/**
	 * Opens each Worker created beside the ones it may duplicate, in file order, so the
	 * organizer can compare them and merge by hand. Nothing is merged here.
	 */
	async function continueToDuplicates() {
		if (committedDuplicates.length === 0) return;
		const ids = committedDuplicates
			.flatMap((entry) => [entry.created, ...entry.candidates])
			.filter((id, at, all) => all.indexOf(id) === at);
		await host.openCreated(snapshot.worksiteId, ids);
	}

	return {
		reset,
		setAttributeColumn,
		decideAttribute,
		decideDuplicate,
		decideAllAttributes,
		decideAllDuplicates,
		continueToDuplicates,
		chooseFile,
		setColumn,
		setFilter,
		setPage,
		back,
		commit,
		continueToWorkers,
		get stage() {
			return stage;
		},
		get fileName() {
			return fileName;
		},
		get headers() {
			return headers;
		},
		get columns() {
			return columns;
		},
		get attributes() {
			return snapshot.attributes;
		},
		get attributeColumns() {
			return attributeColumns;
		},
		get undecidedCount() {
			return undecidedCount;
		},
		get committedDuplicateCount() {
			return committedDuplicates.length;
		},
		attributeSamples(attributeId: string) {
			return mappingSamples(csvRows, attributeColumns[attributeId] ?? -1);
		},
		get csvRows() {
			return csvRows;
		},
		get worksiteName() {
			return snapshot.worksiteName;
		},
		get filter() {
			return filter;
		},
		get view() {
			return view;
		},
		get rows() {
			return rows;
		},
		get acceptedCount() {
			return accepted.length;
		},
		get skippedCount() {
			return skippedCount;
		},
		get blankPhoneCount() {
			return blankPhoneCount;
		},
		get problemRowCount() {
			return problemRowCount;
		},
		get reading() {
			return reading;
		},
		get importing() {
			return importing;
		},
		get error() {
			return error;
		},
		get refreshFailed() {
			return refreshFailed;
		},
		get result() {
			return result;
		},
		get committedBlankPhones() {
			return committedBlankPhones;
		},
		get committedSkipped() {
			return committedSkipped;
		},
		samples(role: keyof ContactCsvColumns) {
			return mappingSamples(csvRows, columns[role]);
		}
	};
}
