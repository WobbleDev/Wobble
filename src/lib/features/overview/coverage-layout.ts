/**
 * The geometry of the Committee card's dot zone. A filled mark is a Leader, an open
 * mark is one still needed; past what a 1:1 mark can show, one mark stands for a
 * clean unit of Leaders. The card never changes size, so everything here is read
 * from the zone the card gives it.
 */

/** The largest a mark may draw, matching the card's old `size-4` mark. */
export const MAX_DIAMETER = 16;
/** The floor of the 1:1 sweep: below this, marks stop reading as individuals. */
export const MIN_DIAMETER = 7.5;
/** Once a 1:1 mark would be smaller than the floor, units draw at least this big. */
export const UNIT_MIN_DIAMETER = 9.5;
/** Clean unit sizes, smallest first: the first that fits wins. */
export const UNIT_SIZES = [2, 5, 10, 20, 25, 50] as const;
/** A mark's breathing room, proportional to its diameter. */
export const GAP_RATIO = 0.35;
/** The room the inline unit caption needs at the right of the zone. */
export const UNIT_CAPTION_RESERVE = 96;

export type CoverageMark = {
	/** How much of the mark is filled: 1 a Leader, 0 still needed, between a remainder. */
	filled: number;
};

export type CoverageLayout = {
	diameter: number;
	/** The gap between marks; on multi-row layouts it spreads each full row flush. */
	gap: number;
	perRow: number;
	rows: number;
	unit: number;
	marks: CoverageMark[];
};

export type CoverageLayoutInput = {
	total: number;
	leaders: number;
	width: number;
	height: number;
	maxDiameter?: number;
	/** Room kept at the right of the zone for the inline unit caption. */
	captionReserve?: number;
};

type Fit = { diameter: number; gap: number; perRow: number; rows: number };

function markLayout(total: number, leaders: number, unit: number, fit: Fit): CoverageLayout {
	const count = Math.ceil(total / unit);
	const marks = Array.from({ length: count }, (_, index) => ({
		filled: Math.max(0, Math.min(1, (leaders - index * unit) / unit))
	}));
	return { ...fit, rows: fit.rows, unit, marks };
}

/**
 * The largest mark that fits `count` marks in the zone. A single row keeps its
 * compact gap; a multi-row layout widens the gap so every full row ends on the
 * right margin, and the last partial row starts from the left at that same gap.
 */
function fit(
	count: number,
	width: number,
	height: number,
	maxDiameter: number,
	minDiameter: number
) {
	if (count <= 0 || width <= 0 || height <= 0) return null;
	const top = Math.min(maxDiameter, height);
	for (let diameter = top; diameter >= minDiameter - 0.001; diameter -= 0.5) {
		const d = Math.round(diameter * 10) / 10;
		const baseGap = d * GAP_RATIO;
		const perRow = Math.max(1, Math.floor((width + baseGap) / (d + baseGap)));
		const rows = Math.ceil(count / perRow);
		let gap = baseGap;
		if (rows > 1 && perRow > 1) gap = Math.max(baseGap, (width - perRow * d) / (perRow - 1));
		const usedHeight = rows * d + (rows - 1) * gap;
		if (usedHeight <= height + 0.001) {
			return {
				diameter: d,
				gap: Math.round(gap * 100) / 100,
				perRow,
				rows
			};
		}
	}
	return null;
}

export function coverageLayout({
	total,
	leaders,
	width,
	height,
	maxDiameter = MAX_DIAMETER,
	captionReserve = UNIT_CAPTION_RESERVE
}: CoverageLayoutInput): CoverageLayout {
	if (total <= 0) {
		return {
			diameter: Math.max(MIN_DIAMETER, Math.min(maxDiameter, height || maxDiameter)),
			gap: 0,
			perRow: 1,
			rows: 0,
			unit: 1,
			marks: []
		};
	}

	const oneToOne = fit(total, width, height, maxDiameter, MIN_DIAMETER);
	if (oneToOne) return markLayout(total, leaders, 1, oneToOne);

	// The 1:1 marks would fall under the floor: stand each mark for a clean unit.
	const unitWidth = Math.max(1, width - captionReserve);
	for (const unit of UNIT_SIZES) {
		const unitFit = fit(Math.ceil(total / unit), unitWidth, height, maxDiameter, UNIT_MIN_DIAMETER);
		if (unitFit) return markLayout(total, leaders, unit, unitFit);
	}
	const unit = UNIT_SIZES[UNIT_SIZES.length - 1];
	const fallback = fit(Math.ceil(total / unit), unitWidth, height, maxDiameter, UNIT_MIN_DIAMETER);
	return markLayout(
		total,
		leaders,
		unit,
		fallback ?? {
			diameter: UNIT_MIN_DIAMETER,
			gap: UNIT_MIN_DIAMETER * GAP_RATIO,
			perRow: Math.max(1, Math.floor(unitWidth / (UNIT_MIN_DIAMETER * (1 + GAP_RATIO)))),
			rows: Math.ceil(total / unit)
		}
	);
}
