/**
 * The TanStack Table features this grid registers. Add a feature here rather than
 * importing it wherever it is used.
 */
import {
	columnFilteringFeature,
	columnOrderingFeature,
	columnVisibilityFeature,
	createFilteredRowModel,
	createSortedRowModel,
	filterFn_includesString,
	rowSortingFeature,
	tableFeatures
} from '@tanstack/svelte-table';
import type { AssessmentOption, WorkerAttributeValue } from '#lib/domain-vocabulary.ts';
import type { WorkersSelection } from './data-table-selection.svelte.ts';

/**
 * What an Undo managed to put back. A sequential batch can stop part-way, so the
 * report says how much landed and leaves the rest for another attempt.
 */
export type DataTableUndoResult = {
	/** Steps this call put back. */
	restored: number;
	/** Steps the original change completed, and so the most an Undo could restore. */
	total: number;
	/** Restorations still outstanding; calling the same Undo again retries them. */
	remaining: number;
	/** The restore that stopped the Undo, if it stopped early. */
	error: string | null;
	/** The reload after the Undo failed, if it did. */
	refreshError: string | null;
	/** Retries just that reload; present only for a single edit whose reload failed. */
	retryRefresh?: () => Promise<void>;
};

/**
 * A completed record edit, reported so the table can confirm it and offer Undo.
 *
 * A batch that only partly landed keeps both failures visible: the endpoint error
 * that stopped it, and a reload failure that must not hide it. `undo` is absent
 * when nothing landed, and when deletion cannot honestly be taken back.
 */
export type DataTableEditReport = {
	message: string;
	/** The failure that stopped the change part-way, when some steps did not run. */
	error?: string;
	/** The core's stable code for that failure (ADR-0024), when the reply carried one.
	 *  The UI words the failure from it rather than showing the core's diagnostic. */
	errorCode?: string;
	/** The reload's own failure, when the Workers table could not be refreshed. */
	refreshError?: string;
	/** Puts the change back. Calling it again retries only what is left. */
	undo?: () => Promise<DataTableUndoResult>;
	/** Retries just the reload; present only when that reload failed. */
	retryRefresh?: () => Promise<void>;
};

/** A column's declared width and horizontal padding, read by the header row and
 *  the body rows from one place so the two cannot drift apart. */
export type DataTableColumnMeta = {
	label?: string;
	widthClass?: string;
	/** Shares in the table's spare width when the columns fit the frame. */
	grow?: boolean;
	/** The column's width as a CSS length (rem, or the Name variable). */
	width?: string;
	/** The narrowest a shrinkable column gets before the table scrolls. */
	minWidth?: string;
	/** Pinned columns stay in view while the table scrolls sideways. */
	pin?: 'select' | 'name';
	/** How a cell's value reads to assistive technology, in configured names. */
	describeValue?: (value: unknown) => string;
};

export type DataTableMeta = {
	updateAttribute: (
		workerId: string,
		attributeId: string,
		value: WorkerAttributeValue
	) => Promise<void>;
	updateAssessment: (workerId: string, assessment: AssessmentOption) => Promise<void>;
	updateLanguages: (workerId: string, languageIds: string[]) => Promise<void>;
	reportEdit: (report: DataTableEditReport) => void;
	/** Shows a write that did not save, in plain words. */
	reportFailure: (message: string) => void;
	/** Reloads the Workers table; the writes above do not reload it themselves. */
	refresh: () => Promise<void>;
	selection?: WorkersSelection;
};

// New in v9: declare the features this table uses — anything you don't
// register is tree-shaken out of the bundle.
export const features = tableFeatures({
	columnFilteringFeature,
	columnOrderingFeature,
	columnVisibilityFeature,
	rowSortingFeature,
	filteredRowModel: createFilteredRowModel(),
	sortedRowModel: createSortedRowModel(),
	filterFns: { includesString: filterFn_includesString },
	tableMeta: {} as DataTableMeta,
	columnMeta: {} as DataTableColumnMeta
});

// Pass this as the first generic argument to `ColumnDef`, `Column`, `Table`,
// and `Row` so each type knows which feature APIs are available.
export type DataTableFeatures = typeof features;
