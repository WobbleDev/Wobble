/**
 * The Assessment bullseye's fixed geometry: constants and the shapes the bands, ties and dot
 * placement share. All values are user units inside the chart's 256 × 256 viewBox; the SVG
 * scales them with its box, so nothing here is ever measured from the rendered page.
 */
import type { AssessmentOption, Worker } from '#lib/domain-vocabulary.ts';

/** The chart centre, in user units. */
export const CHART_CENTER = 128;

/** One worker's mark: the rendered circle radius, in user units. */
export const DOT_RADIUS = 3.25;

/** The halo stroke drawn around each dot, in user units. */
export const DOT_STROKE_WIDTH = 1.25;

/** The smallest acceptable gap between two dots' halos, in user units. */
const MIN_DOT_GAP = 1.25;

/** The drawn bands' outermost boundary; the Hostile track sits beyond it. */
export const MAX_DRAWN_RADIUS = 98;

/**
 * How far the drawn bands may grow past their usual edge to make lane room for
 * ties, in user units, before the room is taken from the bands' headcount
 * share. The Hostile track and its name move out with them, and this is all the
 * room the viewBox has for that.
 */
export const CHART_SLACK = 5;

/**
 * The thickness each band keeps even when it holds no workers, inside out. The
 * innermost band carries the Committee's name at its centre as well as its
 * members' ring of dots, so it keeps the larger base; the total is unchanged, so
 * the bands still share the same extra radius and the chart still reaches the
 * same outer boundary.
 */
export const BASE_BAND_THICKNESS = [26, 10, 10, 10] as const;

/** The fixed track Hostile dots occupy, beyond the drawn bands. */
export const HOSTILE_CENTERLINE_RADIUS = 108;

/** A dot's true radius: its circle plus half of its halo stroke. */
export const DOT_FOOTPRINT = DOT_RADIUS + DOT_STROKE_WIDTH / 2;

/** Clear space a tie keeps between its end and the dot it joins, in user units. */
export const TIE_DOT_GAP = 2.5;

/** The least gap a tie keeps from a dot, and the least length it keeps, between close dots. */
export const TIE_MIN_GAP = 1;

export const TIE_MIN_LENGTH = 4;

/** Points sampled along a tie when keeping other dots off it. */
export const TIE_SAMPLES = 48;

/**
 * The bows a tie tries, in user units of control-point offset, straight first.
 * The curve's peak sits at half the offset.
 */
export const TIE_BOWS = [0, 4, 8, 12, 16, 20, 24, 30];

/**
 * The packing lattice pitch, in user units: two footprints plus the minimum
 * gap. Rows never sit closer than this radially, and dots on one row never
 * sit closer than this along the arc.
 */
export const MIN_PITCH = DOT_FOOTPRINT * 2 + MIN_DOT_GAP;

/** Edge clearance each row keeps from its band's boundary, in user units. */
export const EDGE_CLEARANCE = DOT_FOOTPRINT + MIN_DOT_GAP / 2;

/**
 * The share of the innermost band's thickness held clear at the centre for the
 * Committee's own name. The band is the chart's origin, so its members ring the
 * name rather than sitting on it; the rest of the thickness still carries their
 * rows, and the share is capped below so a thin band always keeps room for one.
 */
export const CENTRE_LABEL_SHARE = 0.55;

/** Roboto Mono's 0.6 em advance plus the ring name's 0.15 em tracking. */
export const RING_LABEL_ADVANCE_EM = 0.75;

/** The ring name's size in user units at the no-scroll floor's reset zoom. */
export const RING_LABEL_UNITS = 11 / 3.0625;

/** The clear space either side of a name's ink, in user units. */
export const RING_LABEL_MARGIN = 3;

/** The localized ring name of each drawn standing, as the chart shows it. */
export type RingNames = Record<(typeof DRAWN_ASSESSMENTS)[number], string>;

/**
 * Where on its ring a name is anchored, in degrees clockwise from twelve
 * o'clock. Negative turns the names to the left, which is also the side of the
 * frame the page has room for: the chart backdrop's centre sits right of the leading
 * column, so names at the top would rest on the fold at the viewport floor.
 */
export const RING_LABEL_ANGLE = -44;

/** The four drawn bands, inside out; the Hostile track lies beyond them. */
export const DRAWN_ASSESSMENTS = [
	'Leader',
	'Activist',
	'Supporter',
	'Disengaged'
] as const satisfies readonly AssessmentOption[];

type DrawnAssessment = (typeof DRAWN_ASSESSMENTS)[number];

export type PlotAssessment = Exclude<AssessmentOption, 'Unassessed'>;

/**
 * The bands alternate the two stops either side of the panel. The chart sits on
 * a `--page` panel, so `--panel` is one stop lighter and `--inset` one stop
 * darker than what it is drawn on: every ring steps off the panel by exactly one
 * stop, in alternating directions, and no ring can ever match the surface under
 * it. A ladder running one way would fade into the panel in one theme and out of
 * it in the other, because the ramp keeps its order while the roles flip.
 *
 * Position 0 is the innermost band, so the Organizing Committee takes the `pad`
 * stop and reads as the chart's bright core in either theme.
 */
export const BAND_FILLS = ['var(--panel)', 'var(--inset)'] as const;

export interface BandLayout {
	assessment: DrawnAssessment;
	innerRadius: number;
	outerRadius: number;
	centerlineRadius: number;
	/**
	 * The radius a band's dots keep clear inside: the band's own inner boundary,
	 * except for the innermost band, whose centre is held for its name.
	 */
	packingInnerRadius: number;
	path: string;
	dashArray: string;
	dashOffset: number;
	fill: string;
}

export interface PlacedDot {
	worker: Worker;
	cx: number;
	cy: number;
}

export interface RelationshipTie {
	id: string;
	from: string;
	to: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	d: string;
}

export interface PlotGroup {
	assessment: PlotAssessment;
	dots: PlacedDot[];
}
