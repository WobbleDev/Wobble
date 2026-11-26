/** The bullseye's annulus bands, ring-label wedges and the Hostile track. */
import type { AssessmentOption } from '#lib/domain-vocabulary.ts';
import {
	CHART_CENTER,
	MAX_DRAWN_RADIUS,
	CHART_SLACK,
	BASE_BAND_THICKNESS,
	HOSTILE_CENTERLINE_RADIUS,
	MIN_PITCH,
	CENTRE_LABEL_SHARE,
	RING_LABEL_ADVANCE_EM,
	RING_LABEL_UNITS,
	RING_LABEL_MARGIN,
	RING_LABEL_ANGLE,
	DRAWN_ASSESSMENTS,
	BAND_FILLS,
	type BandLayout
} from './bullseye-shared.ts';

/**
 * The angle a band keeps clear for its own name, in radians. The name is centred
 * on the band's centreline and set along it, so the wedge is its advance times its
 * length plus a margin either side, measured at that centreline. Dots of the band
 * pack round what is left of the circle. A quarter turn is the most a band gives
 * up. The innermost band's name is the chart's centre, so the caller passes it 0.
 */
export function ringLabelWedge(name: string, centreRadius: number): number {
	const width = name.length * RING_LABEL_ADVANCE_EM * RING_LABEL_UNITS + 2 * RING_LABEL_MARGIN;
	return Math.min(width / centreRadius, Math.PI / 2);
}

/**
 * Whether a ring's name, set at `labelSize` user units, still fits the arc the
 * band keeps clear for it. The wedge reserves room at the fixed Label step (see
 * `RING_LABEL_UNITS`); a chart drawn smaller turns the same interface size into
 * more user units, so the name can outgrow its wedge and cover the dots packed
 * beside it. Such a name is omitted rather than shrunk below the 11px Label
 * floor, leaving the chart's description to name the ring.
 */
export function ringLabelFits(name: string, centreRadius: number, labelSize: number): boolean {
	if (!(labelSize > 0) || !(centreRadius > 0)) return false;
	const arc = ringLabelWedge(name, centreRadius) * centreRadius;
	const ink = name.length * RING_LABEL_ADVANCE_EM * labelSize + 2 * RING_LABEL_MARGIN;
	return ink <= arc + 1e-6;
}

/** The name anchor in the chart's own angle convention, where twelve o'clock is −π/2. */
export function labelAnchorAngle(): number {
	return (RING_LABEL_ANGLE * Math.PI) / 180 - Math.PI / 2;
}

/**
 * A natural angle inside a name's wedge moves to the wedge edge nearer `member`'s
 * angle, so a tied dot stays on its own member's side; outside the wedge it is kept.
 */
export function wedgeEdgeToward(natural: number, member: number, wedge: number): number {
	const anchor = labelAnchorAngle();
	const offset = Math.atan2(Math.sin(natural - anchor), Math.cos(natural - anchor));
	if (Math.abs(offset) >= wedge / 2) return natural;
	const gap = (angle: number) =>
		Math.abs(Math.atan2(Math.sin(angle - member), Math.cos(angle - member)));
	const edges = [anchor - wedge / 2, anchor + wedge / 2];
	return gap(edges[0]) <= gap(edges[1]) ? edges[0] : edges[1];
}

/** The circle of `radius` as a two-arc subpath, for `pathLength`-independent rings. */
function circleSubpath(radius: number, sweep: 0 | 1): string {
	return `M ${CHART_CENTER - radius} ${CHART_CENTER} a ${radius} ${radius} 0 1 ${sweep} ${radius * 2} 0 a ${radius} ${radius} 0 1 ${sweep} ${-radius * 2} 0`;
}

/**
 * The half-circle a ring's name is set on, running clockwise from one side of the
 * anchor round to the other. Text laid on it reads the right way up and bows with
 * the ring it names; centring the text on the arc puts it on the anchor, and the
 * half-circle is longer than any standing's name, so nothing overflows an end.
 */
export function labelArcPath(radius: number, anchorDegrees = RING_LABEL_ANGLE): string {
	const anchor = (anchorDegrees * Math.PI) / 180 - Math.PI / 2;
	const point = (angle: number) =>
		`${(CHART_CENTER + Math.cos(angle) * radius).toFixed(2)} ${(
			CHART_CENTER +
			Math.sin(angle) * radius
		).toFixed(2)}`;
	return `M ${point(anchor - Math.PI / 2)} A ${radius} ${radius} 0 0 1 ${point(anchor + Math.PI / 2)}`;
}

/**
 * A band drawn as a real annulus: outer circle plus inner circle, and for the
 * innermost band the inner circle counter-drawn so the centre stays filled.
 * Concentric filled circles cannot do this — an inner band's fill covers the
 * outer band's, leaving only the outermost edge visible.
 */
function bandPath(outer: number, inner: number): string {
	if (inner <= 0) return circleSubpath(outer, 1);
	return `${circleSubpath(outer, 1)} ${circleSubpath(inner, 0)}`;
}

/** The Hostile track's radius: its usual place, pushed out as far as the bands grew. */
export function hostileTrackRadius(bands: readonly BandLayout[]): number {
	const edge = bands.at(-1)?.outerRadius ?? MAX_DRAWN_RADIUS;
	return HOSTILE_CENTERLINE_RADIUS + Math.max(0, edge - MAX_DRAWN_RADIUS);
}

/**
 * Band geometry, outside in. Each band's thickness is its standing's share of
 * the drawn workers, with a base thickness kept for empty standings. The panel
 * paints `--page`, and `BAND_FILLS` reads the stops one rung either side of
 * it, so the rings alternate without ever landing on the panel's own tone.
 *
 * `laneRoom` is extra room, per band, held clear on that band's inner edge for
 * the tie lanes that run there (see `bullseye-lanes.ts`). It comes first from
 * `CHART_SLACK` beyond the usual outer edge and then out of every band's
 * headcount share, so a band's area keeps tracking its share as closely as the
 * room allows. With no room asked for, the layout is the usual one.
 */
export function bandLayout(
	counts: Partial<Record<AssessmentOption, number>>,
	laneRoom: readonly number[] = []
): BandLayout[] {
	const room = DRAWN_ASSESSMENTS.map((_, index) => laneRoom[index] ?? 0);
	const totalRoom = room.reduce((sum, value) => sum + value, 0);
	const growth = Math.min(totalRoom, CHART_SLACK);
	const totalDrawnWorkers = DRAWN_ASSESSMENTS.reduce(
		(sum, assessment) => sum + (counts[assessment] ?? 0),
		0
	);
	const totalBase = BASE_BAND_THICKNESS.reduce((sum, base) => sum + base, 0);
	const extraRadiusBudget = Math.max(0, MAX_DRAWN_RADIUS + growth - totalBase - totalRoom);
	// The full circumference of the 256-unit box's inscribed circle; the dash
	// pattern repeats it so the boundary falls exactly on the ring.
	const fullCircle = Math.PI * 2 * CHART_CENTER;

	let currentRadius = 0;
	return DRAWN_ASSESSMENTS.map((assessment, index) => {
		const count = counts[assessment] ?? 0;
		const share = totalDrawnWorkers > 0 ? count / totalDrawnWorkers : 1 / DRAWN_ASSESSMENTS.length;
		const thickness = BASE_BAND_THICKNESS[index] + room[index] + extraRadiusBudget * share;
		const innerRadius = currentRadius;
		const outerRadius = currentRadius + thickness;
		currentRadius = outerRadius;

		// The innermost band holds its centre for the Committee's name, and never
		// takes so much of the thickness that its members lose their only row.
		const packingInnerRadius =
			innerRadius === 0
				? Math.max(0, Math.min(thickness * CENTRE_LABEL_SHARE, thickness - MIN_PITCH))
				: innerRadius + room[index];

		return {
			assessment,
			innerRadius,
			outerRadius,
			centerlineRadius: (innerRadius + outerRadius) / 2,
			packingInnerRadius,
			path: bandPath(outerRadius, innerRadius),
			dashArray: `${fullCircle} ${fullCircle}`,
			dashOffset: -fullCircle * (1 - innerRadius / outerRadius),
			fill: BAND_FILLS[index % BAND_FILLS.length]
		};
	});
}
