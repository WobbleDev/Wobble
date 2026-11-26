/**
 * The Workers table's column widths, in rem against the density base.
 *
 * The grid lays out fixed (an auto-laid-out table re-measures its columns from
 * whichever rows the virtualizer has mounted, so columns would jump while it
 * scrolls), which means a cell cannot carry `min-width` and a column's width is
 * only ever a length. So the widths are declared here, once: the checkbox and
 * Name columns are pinned and share `WORKERS_SELECT_REM` for their offsets, and
 * Languages and Attribute columns are sized from the longest word they can
 * show. Shrinkable columns interpolate between a preferred width and a minimum
 * width with one unitless factor `--workers-table-t` (0..1, computed in JS); the table
 * floors at the sum of the minimums, so the scrollport only scrolls sideways
 * when the frame is narrower than even the minimums.
 *
 * A Worksite with six or more Attributes switches to readable floors: each
 * content column keeps its whole header (label, sort icon and filter button) and
 * its longest single value, or up to two Multi-Select chips, before the table
 * scrolls. Fewer Attributes keep the older shrink floor so a short table still
 * fits a narrow desktop frame without scrolling.
 */

/** The pinned checkbox column. The Name column's sticky offset is this same value. */
export const WORKERS_SELECT_REM = 2.75;

const ASSESSMENT_REM = 9;
/** The narrowest Assessment gets while the table still fits by shrinking. */
export const ASSESSMENT_MIN_REM = 6;

/** A content-sized column never gets narrower than this, nor wider than this. */
const CONTENT_MIN_REM = 6;
const CONTENT_MAX_REM = 15;
/** Few Attributes: how far a content column shrinks before the table scrolls. */
export const CONTENT_SHRINK_MIN_REM = 5;

/** Preferred widths still size a column from its longest single option. */
const REM_PER_CHARACTER = 0.55;
const CONTENT_CHROME_REM = 3;

/**
 * Readable floors are measured against the real table type. Body text at 14px
 * never advances more than 0.49rem per character (Public Sans); 0.5rem covers
 * the proportional font in every density.
 */
const VALUE_REM_PER_CHARACTER = 0.5;
/** The cell's horizontal padding plus the trigger's padding and border. */
const VALUE_CHROME_REM = 1.5;
/** The Assessment dot and the gap beside it. */
const SWATCH_CHROME_REM = 0.875;
/** A Multi-Select chip's horizontal padding, the gap between chips, and the +N chip. */
const CHIP_PADDING_REM = 0.75;
const CHIP_GAP_REM = 0.25;
const MULTI_MORE_REM = 1.5;

/**
 * A header label is mono `text-xs` (11px), advancing 0.6em plus `tracking-key`'s
 * 0.08em: 0.4675rem per character. 0.5rem keeps that safe when the density base
 * changes. The chrome is measured from the rendered header: cell padding, the
 * sort button's padding, border and negative margin, its icon and gap, and the
 * filter button beside it.
 */
const HEADER_REM_PER_CHARACTER = 0.5;
const HEADER_CHROME_REM = 4.25;

/** The width a column needs to show its longest option without breaking it. */
export function contentColumnRem(options: readonly string[]): number {
	const longest = options.reduce((max, option) => Math.max(max, option.length), 0);
	const wanted = longest * REM_PER_CHARACTER + CONTENT_CHROME_REM;
	return Math.min(CONTENT_MAX_REM, Math.max(CONTENT_MIN_REM, Math.ceil(wanted * 4) / 4));
}

/** What a cell can show, beyond its options: a Multi-Select list or a colour dot. */
export type ContentColumnValueOptions = {
	/** The cell shows up to two chips side by side. */
	multi?: boolean;
	/** The value carries a leading colour dot (Assessment). */
	swatch?: boolean;
	/** The system no-value reading, shown as one plain line when no answer is held. */
	emptyLabel?: string;
};

/** One value's width, with the cell and trigger chrome it always carries. */
function singleValueRem(value: string, swatch = false): number {
	return (
		value.length * VALUE_REM_PER_CHARACTER + VALUE_CHROME_REM + (swatch ? SWATCH_CHROME_REM : 0)
	);
}

/** The width the cell's values need: the longest single line, or two chips. */
function contentValueNeedRem(
	values: readonly string[],
	{ multi = false, swatch = false, emptyLabel = '' }: ContentColumnValueOptions
): number {
	const longestSingle = values.reduce(
		(max, value) => Math.max(max, singleValueRem(value, swatch)),
		emptyLabel ? singleValueRem(emptyLabel) : 0
	);
	if (!multi || values.length === 0) return longestSingle;

	// The cell shows the two longest selected labels as chips; size for that
	// pair so a Multi-Select reading is not cut while a shorter answer would fit.
	const shown = [...values].sort((first, second) => second.length - first.length).slice(0, 2);
	const chips =
		shown.reduce(
			(sum, value) => sum + value.length * VALUE_REM_PER_CHARACTER + CHIP_PADDING_REM,
			0
		) +
		CHIP_GAP_REM * (shown.length - 1) +
		VALUE_CHROME_REM +
		(values.length > 2 ? MULTI_MORE_REM : 0);
	return Math.max(longestSingle, chips);
}

/**
 * The width a wide table's content column must keep: its whole header (label and
 * controls) and its values, capped at the widest allowed column. It is a minimum,
 * so a Worksite with six or more Attributes scrolls rather than truncating it.
 */
export function contentColumnNeedRem(
	label: string,
	values: readonly string[],
	options: ContentColumnValueOptions = {}
): number {
	const header = label.length * HEADER_REM_PER_CHARACTER + HEADER_CHROME_REM;
	const need = Math.max(CONTENT_MIN_REM, header, contentValueNeedRem(values, options));
	return Math.min(CONTENT_MAX_REM, Math.ceil(need * 4) / 4);
}

/** Name is pinned to its longest name, within these bounds; a longer name truncates. */
const NAME_MIN_REM = 8;
const NAME_MAX_REM = 14;
/** Name text is medium weight, and the cell carries padding. */
const NAME_REM_PER_CHARACTER = 0.5;
const NAME_CHROME_REM = 1.5;

/** The width Name needs to show its longest name whole, capped at `NAME_MAX_REM`. */
export function nameColumnRem(names: readonly string[]): number {
	const longest = names.reduce((max, name) => Math.max(max, name.length), 0);
	const wanted = longest * NAME_REM_PER_CHARACTER + NAME_CHROME_REM;
	return Math.min(NAME_MAX_REM, Math.max(NAME_MIN_REM, Math.ceil(wanted * 4) / 4));
}

/**
 * Widths for the columns that are not Name or the checkbox. `contentRem` holds
 * the content-sized columns (Languages and each Attribute) by column id.
 */
export function workersColumnRem(
	columnId: string,
	contentRem: Readonly<Record<string, number>>
): number {
	if (columnId === 'selection') return WORKERS_SELECT_REM;
	if (columnId === 'assessment') return ASSESSMENT_REM;
	return contentRem[columnId] ?? CONTENT_MIN_REM;
}

/**
 * A shrinkable column's minimum width in a table that fits by shrinking. Pinned
 * columns (checkbox, Name) stay fixed at their preferred width; Assessment floors
 * at ASSESSMENT_MIN_REM and content columns at CONTENT_SHRINK_MIN_REM. A wide
 * Worksite uses `contentColumnNeedRem` instead, so its floors stay readable.
 */
export function workersColumnMinRem(columnId: string, preferredRem: number): number {
	if (columnId === 'selection' || columnId === 'name') return preferredRem;
	if (columnId === 'assessment') return Math.min(preferredRem, ASSESSMENT_MIN_REM);
	return Math.min(preferredRem, CONTENT_SHRINK_MIN_REM);
}

/**
 * The sum of the visible columns' minimum widths, as a CSS length: the narrowest the table
 * gets. `minRem` holds each column's declared minimum; anything missing falls back to the
 * narrow shrink rule above.
 */
export function workersMinWidth(
	visibleColumnIds: readonly string[],
	contentRem: Readonly<Record<string, number>>,
	minRem: Readonly<Record<string, number>> = {}
): string {
	let rem = 0;
	let name = false;
	for (const columnId of visibleColumnIds) {
		if (columnId === 'name') name = true;
		else
			rem +=
				minRem[columnId] ?? workersColumnMinRem(columnId, workersColumnRem(columnId, contentRem));
	}
	return name ? `calc(var(--workers-table-name-w) + ${rem}rem)` : `${rem}rem`;
}

/**
 * How far the frame sits between the minimum and preferred sums, 0..1.
 * At or below the minimum the table stops shrinking (0); at or above the
 * preferred sum the columns rest at full width (1).
 */
export function shrinkFactor(framePx: number, minPx: number, prefPx: number): number {
	if (!(prefPx > minPx)) return 1;
	if (!(framePx > minPx)) return 0;
	if (!(framePx < prefPx)) return 1;
	return (framePx - minPx) / (prefPx - minPx);
}

/**
 * The table's used width as a CSS length: its columns' minimum sum, or the whole frame
 * when that is wider. Name's width is a variable the scroll viewport defines,
 * so the one sum serves phone and desktop. Between the minimum and preferred
 * sums the columns shrink via `--workers-table-t` instead of scrolling.
 */
export function workersTableWidth(
	visibleColumnIds: readonly string[],
	contentRem: Readonly<Record<string, number>>,
	minRem: Readonly<Record<string, number>> = {}
): string {
	return `max(100%, ${workersMinWidth(visibleColumnIds, contentRem, minRem)})`;
}

/** A column's declared content width in rem, by column id. */
export type WorkersContentRem = Record<string, number>;

/**
 * The grow share used when no visible column grows. `--workers-table-grow-rem` is a divisor in
 * the column calc, so it must never be zero; with nothing growing, one keeps it defined.
 */
export const NO_GROW_SHARE_REM = 1;

/**
 * The visible columns' declared rem widths, derived in one pass: `contentRem` holds each
 * column whose width is a rem length, `minRem` each declared minimum, and `growRem` sums
 * the widths of the growing columns.
 */
export function workersVisibleRem(
	columns: readonly { id: string; width?: string; minWidth?: string; grow?: boolean }[]
): { contentRem: WorkersContentRem; minRem: WorkersContentRem; growRem: number } {
	const contentRem: WorkersContentRem = {};
	const minRem: WorkersContentRem = {};
	for (const column of columns) {
		if (column.width?.endsWith('rem')) contentRem[column.id] = parseFloat(column.width);
		if (column.minWidth?.endsWith('rem')) minRem[column.id] = parseFloat(column.minWidth);
	}
	let growRem = 0;
	for (const column of columns) {
		if (column.grow) growRem += contentRem[column.id] ?? 0;
	}
	return { contentRem, minRem, growRem };
}
