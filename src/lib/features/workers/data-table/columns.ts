/**
 * The Workers table's columns and the cell components they render.
 */
import { createColumnHelper, renderComponent, type Row, type Table } from '@tanstack/svelte-table';
import {
	assessmentOptions,
	type Agitation,
	type AssessmentOption,
	type Language,
	type Worker,
	type WorkerAttributeValue
} from '#lib/domain-vocabulary.ts';
import { m } from '#lib/paraglide/messages.js';
import { compareNames } from '#lib/i18n/format.ts';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import {
	answerChoices,
	answerFilterChoices,
	describeAnswerValue,
	assessmentChoices,
	heldAnswerIds,
	heldCategoryAnswerId,
	heldTagAnswerIds
} from '../answers.ts';
import { agitationFilterMatches, answerFilterMatches } from '#lib/shared/worker-filters.ts';
import { noValueReading } from '#lib/shared/no-value-reading.ts';
import { applyChange, storesList } from '#lib/shared/select-mode.ts';
import type { DataTableColumnMeta, DataTableFeatures } from './data-table-features.ts';
import DataTableColumnHeader from './data-table-column-header.svelte';
import DataTableOptionCell from './data-table-option-cell.svelte';
import DataTableSelectAllCell from './data-table-select-all-cell.svelte';
import {
	assessmentSortKey,
	compareAssessmentScale,
	compareWithEmptiesLast,
	heldLabelsKey,
	labelsSortKey
} from './worker-sort.ts';
import { assessmentColorFor } from '#lib/shared/assessment.ts';
import {
	WORKERS_SELECT_REM,
	contentColumnRem,
	workersColumnMinRem,
	workersColumnRem
} from './workers-table-width.ts';

const columnHelper = createColumnHelper<DataTableFeatures, Worker>();
/**
 * The width and horizontal padding each Workers table column carries, declared once
 * and read by both the header row and the body rows. Widths are lengths in rem
 * against the density base (see `workers-table-width.ts`): the table lays out
 * fixed, so a column's width is only ever a length. Shrinkable columns
 * interpolate between `width` (preferred) and `minWidth` with the table's
 * `--workers-table-t` factor (0..1); below the minimums the frame scrolls sideways.
 *
 * The checkbox and Name columns are pinned to the left (`pin`): the checkbox at
 * offset 0, Name at the checkbox's width, both from `WORKERS_SELECT_REM`, so the
 * two never leave a gap. Name's width is the `--workers-table-name-w` variable the
 * scroll viewport sets per breakpoint (about 8rem on a phone, 12rem from `sm`).
 */
const columnLayout = {
	selection: { widthClass: 'px-0 lg:pl-4', pin: 'select' as const },
	name: { widthClass: 'px-2 lg:px-3', pin: 'name' as const },
	assessment: { widthClass: 'px-2', grow: true }
};

/** The inline width (and sticky offset, for a pinned column) a header or body cell carries. */
export function columnStyle(meta: DataTableColumnMeta | undefined): string | undefined {
	if (!meta?.width) return undefined;
	const left =
		meta.pin === 'select' ? 'left:0;' : meta.pin === 'name' ? `left:${WORKERS_SELECT_REM}rem;` : '';
	if (meta.pin || !meta.minWidth) {
		const width = meta.grow
			? `calc(${meta.width} + var(--workers-table-slack, 0px) * ${parseFloat(meta.width)} / var(--workers-table-grow-rem, 1))`
			: meta.width;
		return `width:${width};${left}`;
	}
	// A shrinkable column rests between its minimum and its preferred width;
	// rem lengths times the unitless `--workers-table-t` is a valid length.
	const shrunk = `calc(${meta.minWidth} + (${meta.width} - ${meta.minWidth}) * var(--workers-table-t, 1))`;
	if (!meta.grow) return `width:${shrunk};${left}`;
	// A growing column takes its share of the spare width (`--workers-table-slack`,
	// over the growing columns' total, `--workers-table-grow-rem`) on top of its own.
	const rem = parseFloat(meta.width);
	const width = `calc(${shrunk} + var(--workers-table-slack, 0px) * ${rem} / var(--workers-table-grow-rem, 1))`;
	return `width:${width};${left}`;
}

/** Pinned cells stick to the left and stay opaque so scrolled columns never show through. */
export function pinClass(meta: DataTableColumnMeta | undefined): string | undefined {
	return meta?.pin ? 'sticky z-10 bg-panel' : undefined;
}

/** A Workers table row: hover, the selected tint, and the selected marker on the first pinned cell. */
export const workersRowClass =
	'not-in-data-[keyboard-nav=true]:hover:bg-[color-mix(in_oklab,var(--action)_5%,var(--panel))] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-[state=selected]:bg-[color-mix(in_oklab,var(--action)_12%,var(--panel))] [&:has([aria-expanded=true])>td[data-pin]]:bg-inset not-in-data-[keyboard-nav=true]:[&:hover>td[data-pin]]:bg-[color-mix(in_oklab,var(--action)_5%,var(--panel))] [&[data-state=selected]:hover>td[data-pin]]:bg-[color-mix(in_oklab,var(--action)_12%,var(--panel))] [&[data-state=selected]>td]:bg-[color-mix(in_oklab,var(--action)_12%,var(--panel))] [&[aria-current=true]>td:first-child]:shadow-[inset_2px_0_0_var(--action)]';

function matchesSelectedValues(
	row: Row<DataTableFeatures, Worker>,
	columnId: string,
	filterValue: unknown
): boolean {
	if (!Array.isArray(filterValue)) return false;
	if (filterValue.length === 0) return true;

	const selectedValues = filterValue.filter((value): value is string => typeof value === 'string');
	if (selectedValues.length !== filterValue.length) return false;

	const value = row.getValue(columnId);
	return Array.isArray(value)
		? value.some((option: unknown) => typeof option === 'string' && selectedValues.includes(option))
		: typeof value === 'string' && selectedValues.includes(value);
}

/** Sets an Attribute's answer for one Worker from the answer id(s) the cell chose. */
function updateAttribute(
	table: Table<DataTableFeatures, Worker>,
	workerId: string,
	attribute: WorkerAttributeDefinition,
	answerIds: string | string[]
) {
	const update = table.options.meta?.updateAttribute;
	if (!update) {
		throw new Error('Attribute update handler is not configured.');
	}

	return update(workerId, attribute.id, answerIds);
}

function updateAssessment(
	table: Table<DataTableFeatures, Worker>,
	workerId: string,
	assessment: AssessmentOption
) {
	const update = table.options.meta?.updateAssessment;
	if (!update) {
		throw new Error('Assessment update handler is not configured.');
	}

	return update(workerId, assessment);
}

function refreshWorkers(table: Table<DataTableFeatures, Worker>) {
	const refresh = table.options.meta?.refresh;
	if (!refresh) {
		throw new Error('Workers table refresh handler is not configured.');
	}

	return refresh();
}

function updateLanguages(
	table: Table<DataTableFeatures, Worker>,
	workerId: string,
	languageIds: string[]
) {
	const update = table.options.meta?.updateLanguages;
	if (!update) {
		throw new Error('Language update handler is not configured.');
	}

	return update(workerId, languageIds);
}

/**
 * A sort function over one column's key: `key` reads a Worker's value (null when
 * empty) and `compareValues` orders two present values. Empties sort last in both
 * directions; the direction comes from the column's own sorting state.
 */
function emptiesLastSortFn<T>(
	key: (worker: Worker) => T | null,
	compareValues: (first: T, second: T) => number
) {
	return (
		first: Row<DataTableFeatures, Worker>,
		second: Row<DataTableFeatures, Worker>,
		columnId: string
	) =>
		compareWithEmptiesLast(
			key(first.original),
			key(second.original),
			compareValues,
			first.table.getColumn(columnId)?.getIsSorted() === 'desc'
		);
}

/** The names of a Worker's Languages, in the order the worksite lists them. */
function languageNames(worker: Worker, languages: readonly Language[]): string[] {
	return languages
		.filter((language) => worker.languages.includes(language.id))
		.map((language) => language.name);
}

/**
 * A string that changes exactly when the inputs `createColumns` reads change:
 * each Attribute's id, name, kind and answers (id, value and parent), each
 * Agitation's id and text, and each Language's id and name, in list order. No
 * Worker data is part of it, so Worker edits never rebuild the columns; the
 * derived columns read each Worker's held answers through the cell's row, not
 * through this key.
 */
export function columnsKey(
	attributes: readonly WorkerAttributeDefinition[],
	agitations: readonly Agitation[],
	languages: readonly Language[]
): string {
	const attributeKey = (attribute: WorkerAttributeDefinition) => [
		attribute.id,
		attribute.name,
		attribute.kind,
		attribute.answers.map((answer) => [answer.id, answer.value, answer.parentId])
	];
	return JSON.stringify([
		attributes.map(attributeKey),
		agitations.map((agitation) => [agitation.id, agitation.text]),
		languages.map((language) => [language.id, language.name])
	]);
}

/**
 * Builds the Workers table's columns. Called from the page's own derivation, so
 * every message is read after the launch's applied locale is frozen; there is no
 * module-level English metadata to get stale.
 */
export function createColumns(
	attributes: readonly WorkerAttributeDefinition[],
	agitations: readonly Agitation[],
	languages: readonly Language[]
) {
	const languageLabels = languages.map((language) => language.name);
	const languageOptions = languageLabels.map((label) => ({ value: label, label }));
	const languageIdsByName = new Map(languages.map((language) => [language.name, language.id]));
	const assessmentOptionsForDisplay = assessmentChoices(assessmentOptions);
	const nameLabel = m.workers_column_name();
	const assessmentLabel = m.workers_column_assessment();
	const languagesLabel = m.workers_column_languages();

	return columnHelper.columns([
		columnHelper.display({
			id: 'selection',
			header: ({ table }) =>
				// The header checkbox means "every row the filters match"; the selection
				// reads the filtered row model itself, not the data prop or mounted rows.
				renderComponent(DataTableSelectAllCell, {
					selection: table.options.meta?.selection
				}),
			cell: ({ row, table }) =>
				renderComponent(DataTableSelectAllCell, {
					worker: row.original,
					selection: table.options.meta?.selection
				}),
			meta: {
				label: m.workers_column_selection(),
				...columnLayout.selection,
				width: `${WORKERS_SELECT_REM}rem`
			}
		}),
		columnHelper.accessor('name', {
			header: ({ column }) => renderComponent(DataTableColumnHeader, { column, title: nameLabel }),
			filterFn: 'includesString',
			// Name order follows the system regional locale, never the catalog language.
			sortFn: (first, second) => compareNames(first.original.name, second.original.name),
			meta: { label: nameLabel, ...columnLayout.name, width: 'var(--workers-table-name-w)' }
		}),
		columnHelper.accessor('assessment', {
			header: ({ column }) =>
				renderComponent(DataTableColumnHeader, {
					column,
					title: assessmentLabel,
					filter: { options: assessmentOptionsForDisplay, assessment: true }
				}),
			cell: ({ row, table }) =>
				renderComponent(DataTableOptionCell, {
					type: 'single',
					workerName: row.original.name,
					label: assessmentLabel,
					actionLabel: m.workers_assessment_action(),
					selected: row.original.assessment,
					options: assessmentOptionsForDisplay,
					swatch: assessmentColorFor(row.original.assessment),
					swatchFor: (option: string) => assessmentColorFor(option as AssessmentOption),
					onSaved: (report) => table.options.meta?.reportEdit(report),
					onFailed: (message) => table.options.meta?.reportFailure(message),
					refresh: () => refreshWorkers(table),
					fallbackMessage: m.workers_assessment_save_failed(),
					invalidMessage: m.workers_assessment_invalid(),
					onUpdate: (assessment) =>
						updateAssessment(table, row.original.id, assessment as AssessmentOption)
				}),
			filterFn: matchesSelectedValues,
			sortFn: emptiesLastSortFn(
				(worker) => assessmentSortKey(worker.assessment),
				compareAssessmentScale
			),
			meta: {
				label: assessmentLabel,
				...columnLayout.assessment,
				width: `${workersColumnRem('assessment', {})}rem`,
				minWidth: `${workersColumnMinRem('assessment', workersColumnRem('assessment', {}))}rem`
			}
		}),
		columnHelper.accessor((worker) => languageNames(worker, languages), {
			id: 'languages',
			header: ({ column }) =>
				renderComponent(DataTableColumnHeader, {
					column,
					title: languagesLabel,
					filter: { options: languageOptions }
				}),
			cell: ({ row, table }) =>
				renderComponent(DataTableOptionCell, {
					type: 'multi',
					workerName: row.original.name,
					label: languagesLabel,
					actionLabel: m.workers_languages_action(),
					selected: row.getValue('languages') as string[],
					options: languageOptions,
					onSaved: (report) => table.options.meta?.reportEdit(report),
					onFailed: (message) => table.options.meta?.reportFailure(message),
					refresh: () => refreshWorkers(table),
					fallbackMessage: m.workers_languages_save_failed(),
					onUpdate: (names) =>
						updateLanguages(
							table,
							row.original.id,
							names
								.map((name) => languageIdsByName.get(name))
								.filter((id): id is string => id !== undefined)
						)
				}),
			filterFn: matchesSelectedValues,
			// Attribute and language values are lists, so the engine would start them
			// descending; a first press sorts ascending, as Name does.
			sortDescFirst: false,
			sortFn: emptiesLastSortFn(
				(worker) => labelsSortKey(languageNames(worker, languages)),
				compareNames
			),
			meta: {
				label: languagesLabel,
				widthClass: 'px-2',
				grow: true,
				width: `${contentColumnRem(languageLabels)}rem`,
				minWidth: `${workersColumnMinRem('languages', contentColumnRem(languageLabels))}rem`
			}
		}),
		// The Agitation facet narrows the rows without becoming a visible column: the
		// grid hides it on load, and its filter is the whole interface to it.
		columnHelper.accessor((worker) => worker.agitations, {
			id: 'agitations',
			filterFn: (row, _columnId, filterValue) => agitationFilterMatches(row.original, filterValue),
			enableSorting: false,
			meta: { label: 'Agitations' }
		}),
		...attributes.map((attribute) => {
			const choices = answerChoices(attribute);
			const labels = choices.map((choice) => choice.label);
			const reading = noValueReading(attribute);
			return columnHelper.accessor((worker) => heldAnswerIds(worker, attribute), {
				id: attribute.id,
				header: ({ column }) =>
					renderComponent(DataTableColumnHeader, {
						column,
						title: attribute.name,
						// Both cardinalities offer the shared no-value reading beside their answers.
						filter: { options: answerFilterChoices(attribute), answers: true }
					}),
				cell: ({ row, table }) =>
					!storesList(attribute)
						? renderComponent(DataTableOptionCell, {
								type: 'single',
								workerName: row.original.name,
								label: attribute.name,
								actionLabel: attribute.name,
								selected: heldCategoryAnswerId(row.original, attribute),
								options: choices,
								emptyLabel: reading.label,
								emptyDescription: reading.description ?? undefined,
								allowNone: true,
								onSaved: (report) => table.options.meta?.reportEdit(report),
								onFailed: (message) => table.options.meta?.reportFailure(message),
								refresh: () => refreshWorkers(table),
								onUpdate: (value) => updateAttribute(table, row.original.id, attribute, value)
							})
						: renderComponent(DataTableOptionCell, {
								type: 'multi',
								workerName: row.original.name,
								label: attribute.name,
								actionLabel: attribute.name,
								selected: heldTagAnswerIds(row.original, attribute),
								options: choices,
								emptyLabel: reading.label,
								emptyDescription: reading.description ?? undefined,
								onSaved: (report) => table.options.meta?.reportEdit(report),
								onFailed: (message) => table.options.meta?.reportFailure(message),
								refresh: () => refreshWorkers(table),
								onUpdate: (values) =>
									updateAttribute(
										table,
										row.original.id,
										attribute,
										applyChange(attribute, heldTagAnswerIds(row.original, attribute), values)
									)
							}),
				// The Attribute's filter holds answer ids plus the no-selection condition;
				// answers and no selection OR within the Attribute.
				filterFn: (row, _columnId, filterValue) =>
					answerFilterMatches(row.original, attribute, filterValue),
				sortDescFirst: false,
				sortFn: emptiesLastSortFn(
					(worker) => heldLabelsKey(heldAnswerIds(worker, attribute), choices),
					compareNames
				),
				meta: {
					label: attribute.name,
					widthClass: 'px-2',
					grow: true,
					width: `${contentColumnRem(labels)}rem`,
					minWidth: `${workersColumnMinRem(attribute.id, contentColumnRem(labels))}rem`,
					describeValue: (value) => describeAnswerValue(attribute, value as WorkerAttributeValue)
				}
			});
		})
	]);
}
