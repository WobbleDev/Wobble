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
 */

/** The pinned checkbox column. The Name column's sticky offset is this same value. */
export const WORKERS_SELECT_REM = 2.75;

const ASSESSMENT_REM = 9;
/** The narrowest Assessment gets while its option text still truncates cleanly. */
export const ASSESSMENT_MIN_REM = 6;

/** A content-sized column never gets narrower than this, nor wider than this. */
const CONTENT_MIN_REM = 6;
const CONTENT_MAX_REM = 14;
/** Below the preferred floor: how far a content column shrinks before the table scrolls. */
export const CONTENT_SHRINK_MIN_REM = 5;
/** Rough width of one character at the table's text size, plus a cell's padding and trigger room. */
const REM_PER_CHARACTER = 0.55;
const CONTENT_CHROME_REM = 3;

/** The width a column needs to show its longest option without breaking it. */
export function contentColumnRem(options: readonly string[]): number {
	const longest = options.reduce((max, option) => Math.max(max, option.length), 0);
	const wanted = longest * REM_PER_CHARACTER + CONTENT_CHROME_REM;
	return Math.min(CONTENT_MAX_REM, Math.max(CONTENT_MIN_REM, Math.ceil(wanted * 4) / 4));
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

/** The sum of the visible columns' preferred widths, as a CSS length. */
export function workersPreferredWidth(
	visibleColumnIds: readonly string[],
	contentRem: Readonly<Record<string, number>>
): string {
	let rem = 0;
	let name = false;
	for (const columnId of visibleColumnIds) {
		if (columnId === 'name') name = true;
		else rem += workersColumnRem(columnId, contentRem);
	}
	return name ? `calc(var(--workers-table-name-w) + ${rem}rem)` : `${rem}rem`;
}

/**
 * A shrinkable column's minimum width, in rem. Pinned columns (checkbox, Name)
 * stay fixed at their preferred width; Assessment floors at ASSESSMENT_MIN_REM
 * and content columns at most CONTENT_SHRINK_MIN_REM.
 */
export function workersColumnMinRem(columnId: string, preferredRem: number): number {
	if (columnId === 'selection' || columnId === 'name') return preferredRem;
	if (columnId === 'assessment') return Math.min(preferredRem, ASSESSMENT_MIN_REM);
	return Math.min(preferredRem, CONTENT_SHRINK_MIN_REM);
}

/** The sum of the visible columns' minimum widths, as a CSS length: the narrowest the table gets. */
export function workersMinWidth(
	visibleColumnIds: readonly string[],
	contentRem: Readonly<Record<string, number>>
): string {
	let rem = 0;
	let name = false;
	for (const columnId of visibleColumnIds) {
		if (columnId === 'name') name = true;
		else rem += workersColumnMinRem(columnId, workersColumnRem(columnId, contentRem));
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
	contentRem: Readonly<Record<string, number>>
): string {
	return `max(100%, ${workersMinWidth(visibleColumnIds, contentRem)})`;
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
 * column whose width is a rem length, and `growRem` sums the widths of the growing columns.
 */
export function workersVisibleRem(
	columns: readonly { id: string; width?: string; grow?: boolean }[]
): { contentRem: WorkersContentRem; growRem: number } {
	const contentRem: WorkersContentRem = {};
	for (const column of columns) {
		if (column.width?.endsWith('rem')) contentRem[column.id] = parseFloat(column.width);
	}
	let growRem = 0;
	for (const column of columns) {
		if (column.grow) growRem += contentRem[column.id] ?? 0;
	}
	return { contentRem, growRem };
}
