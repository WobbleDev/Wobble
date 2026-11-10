/**
 * The bullseye's geometry: the annulus bands, the dot footprint, and where each
 * Worker's dot sits. These measurements are load-bearing and deliberate — re-check
 * a dense render (ADR 0012) before simplifying any of them.
 */
import { assessedOptions, type AssessmentOption, type Worker } from '#lib/domain-vocabulary.ts';

/**
 * The Assessment bullseye's fixed geometry. All values are user units inside
 * the chart's 256 × 256 viewBox; the SVG scales them with its box, so nothing
 * here is ever measured from the rendered page.
 */

/** The chart centre, in user units. */
export const CHART_CENTER = 128;

/** One worker's mark: the rendered circle radius, in user units. */
export const DOT_RADIUS = 3.25;

/** The halo stroke drawn around each dot, in user units. */
export const DOT_STROKE_WIDTH = 1.25;

/** The smallest acceptable gap between two dots' halos, in user units. */
const MIN_DOT_GAP = 1.25;

/** The drawn bands' outermost boundary; the Hostile track sits beyond it. */
const MAX_DRAWN_RADIUS = 98;

/**
 * How far the drawn bands may grow past their usual edge to make lane room for
 * ties, in user units, before the room is taken from the bands' headcount
 * share. The Hostile track and its name move out with them, and this is all the
 * room the viewBox has for that.
 */
const CHART_SLACK = 5;

/**
 * The thickness each band keeps even when it holds no workers, inside out. The
 * innermost band carries the Committee's name at its centre as well as its
 * members' ring of dots, so it keeps the larger base; the total is unchanged, so
 * the bands still share the same extra radius and the chart still reaches the
 * same outer boundary.
 */
const BASE_BAND_THICKNESS = [26, 10, 10, 10] as const;

/** The fixed track Hostile dots occupy, beyond the drawn bands. */
const HOSTILE_CENTERLINE_RADIUS = 108;

/** A dot's true radius: its circle plus half of its halo stroke. */
export const DOT_FOOTPRINT = DOT_RADIUS + DOT_STROKE_WIDTH / 2;

/** Clear space a tie keeps between its end and the dot it joins, in user units. */
const TIE_DOT_GAP = 2.5;

/** The least gap a tie keeps from a dot, and the least length it keeps, between close dots. */
const TIE_MIN_GAP = 1;
const TIE_MIN_LENGTH = 4;

/** Points sampled along a tie when keeping other dots off it. */
const TIE_SAMPLES = 48;

/**
 * The bows a tie tries, in user units of control-point offset, straight first.
 * The curve's peak sits at half the offset.
 */
const TIE_BOWS = [0, 4, 8, 12, 16, 20, 24, 30];

/**
 * The packing lattice pitch, in user units: two footprints plus the minimum
 * gap. Rows never sit closer than this radially, and dots on one row never
 * sit closer than this along the arc.
 */
const MIN_PITCH = DOT_FOOTPRINT * 2 + MIN_DOT_GAP;

/** Edge clearance each row keeps from its band's boundary, in user units. */
const EDGE_CLEARANCE = DOT_FOOTPRINT + MIN_DOT_GAP / 2;

/**
 * The share of the innermost band's thickness held clear at the centre for the
 * Committee's own name. The band is the chart's origin, so its members ring the
 * name rather than sitting on it; the rest of the thickness still carries their
 * rows, and the share is capped below so a thin band always keeps room for one.
 */
const CENTRE_LABEL_SHARE = 0.55;

/** Roboto Mono's 0.6 em advance plus the ring name's 0.15 em tracking. */
const RING_LABEL_ADVANCE_EM = 0.75;
/** The ring name's size in user units at the no-scroll floor's reset zoom. */
const RING_LABEL_UNITS = 11 / 3.0625;
/** The clear space either side of a name's ink, in user units. */
const RING_LABEL_MARGIN = 3;

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

/** The localized ring name of each drawn standing, as the chart shows it. */
export type RingNames = Record<(typeof DRAWN_ASSESSMENTS)[number], string>;

/**
 * Where on its ring a name is anchored, in degrees clockwise from twelve
 * o'clock. Negative turns the names to the left, which is also the side of the
 * frame the page has room for: the ground's centre sits right of the leading
 * column, so names at the top would rest on the fold at the viewport floor.
 */
const RING_LABEL_ANGLE = -44;

/** The name anchor in the chart's own angle convention, where twelve o'clock is −π/2. */
function labelAnchorAngle(): number {
	return (RING_LABEL_ANGLE * Math.PI) / 180 - Math.PI / 2;
}

/**
 * A natural angle inside a name's wedge moves to the wedge edge nearer `member`'s
 * angle, so a tied dot stays on its own member's side; outside the wedge it is kept.
 */
function wedgeEdgeToward(natural: number, member: number, wedge: number): number {
	const anchor = labelAnchorAngle();
	const offset = Math.atan2(Math.sin(natural - anchor), Math.cos(natural - anchor));
	if (Math.abs(offset) >= wedge / 2) return natural;
	const gap = (angle: number) =>
		Math.abs(Math.atan2(Math.sin(angle - member), Math.cos(angle - member)));
	const edges = [anchor - wedge / 2, anchor + wedge / 2];
	return gap(edges[0]) <= gap(edges[1]) ? edges[0] : edges[1];
}

/** The four drawn bands, inside out; the Hostile track lies beyond them. */
export const DRAWN_ASSESSMENTS = [
	'Leader',
	'Activist',
	'Supporter',
	'Disengaged'
] as const satisfies readonly AssessmentOption[];
type DrawnAssessment = (typeof DRAWN_ASSESSMENTS)[number];
type PlotAssessment = Exclude<AssessmentOption, 'Unassessed'>;

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
const BAND_FILLS = ['var(--panel)', 'var(--inset)'] as const;

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

/**
 * The drawn ties: one per branch of the Committee's reach tree, from the worker
 * a branch grows out of to the worker it reaches.
 */
export function plotRelationshipTies(workers: Worker[], groups: PlotGroup[]): RelationshipTie[] {
	const dots = new Map(
		groups.flatMap((group) => group.dots.map((dot) => [dot.worker.id, dot] as const))
	);
	const everyDot = [...dots.values()];
	const ties: RelationshipTie[] = [];
	for (const [childId, parentId] of reachTree(workers)) {
		const start = dots.get(parentId);
		const end = dots.get(childId);
		if (!start || !end) continue;
		ties.push({
			id: `${parentId}--${childId}`,
			from: parentId,
			to: childId,
			x1: start.cx,
			y1: start.cy,
			x2: end.cx,
			y2: end.cy,
			d: tiePath(start, end, everyDot)
		});
	}
	return ties.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * A tie is a hairline that stops short of both dots, so it reads as a spoke
 * between them rather than a stroke running through either. It is straight
 * unless that would run it over a dot in `around` it does not join, which only
 * a tie along one band's row can do; then it bows outward, away from the
 * centre, by the least amount that clears every such dot.
 */
export function tiePath(
	start: { cx: number; cy: number },
	end: { cx: number; cy: number },
	around: { cx: number; cy: number }[] = []
): string {
	const dx = end.cx - start.cx;
	const dy = end.cy - start.cy;
	const distance = Math.hypot(dx, dy);
	// Close dots give up some of the gap rather than lose the line between them.
	const trim = Math.max(
		DOT_FOOTPRINT + TIE_MIN_GAP,
		Math.min(DOT_FOOTPRINT + TIE_DOT_GAP, (distance - TIE_MIN_LENGTH) / 2)
	);
	if (distance <= trim * 2) return `M ${start.cx} ${start.cy} L ${end.cx} ${end.cy}`;
	// The normal pointing away from the centre, for the bow.
	const midX = (start.cx + end.cx) / 2;
	const midY = (start.cy + end.cy) / 2;
	const side = Math.sign(-dy * (midX - CHART_CENTER) + dx * (midY - CHART_CENTER)) || 1;
	const nx = (-dy / distance) * side;
	const ny = (dx / distance) * side;
	const others = around.filter(
		(dot) =>
			Math.hypot(dot.cx - start.cx, dot.cy - start.cy) > 0.01 &&
			Math.hypot(dot.cx - end.cx, dot.cy - end.cy) > 0.01
	);
	const f = (n: number) => +n.toFixed(2);
	for (const bow of TIE_BOWS) {
		const px = midX + nx * bow;
		const py = midY + ny * bow;
		const at = (t: number) => ({
			x: (1 - t) ** 2 * start.cx + 2 * (1 - t) * t * px + t ** 2 * end.cx,
			y: (1 - t) ** 2 * start.cy + 2 * (1 - t) * t * py + t ** 2 * end.cy
		});
		const samples = Array.from({ length: TIE_SAMPLES + 1 }, (_, i) => i / TIE_SAMPLES);
		const t0 = samples.find((t) => Math.hypot(at(t).x - start.cx, at(t).y - start.cy) >= trim);
		const t1 = samples.findLast((t) => Math.hypot(at(t).x - end.cx, at(t).y - end.cy) >= trim);
		if (t0 === undefined || t1 === undefined || t1 <= t0) continue;
		const visible = samples.filter((t) => t >= t0 && t <= t1).map(at);
		const clear = others.every((dot) =>
			visible.every((p) => Math.hypot(p.x - dot.cx, p.y - dot.cy) > DOT_FOOTPRINT + TIE_MIN_GAP)
		);
		if (!clear && bow !== TIE_BOWS.at(-1)) continue;
		const from = at(t0);
		const to = at(t1);
		if (bow === 0) return `M ${f(from.x)} ${f(from.y)} L ${f(to.x)} ${f(to.y)}`;
		// The stretch of the curve between t0 and t1, as a curve of its own.
		const cx =
			(1 - t0) * (1 - t1) * start.cx + ((1 - t0) * t1 + t0 * (1 - t1)) * px + t0 * t1 * end.cx;
		const cy =
			(1 - t0) * (1 - t1) * start.cy + ((1 - t0) * t1 + t0 * (1 - t1)) * py + t0 * t1 * end.cy;
		return `M ${f(from.x)} ${f(from.y)} Q ${f(cx)} ${f(cy)} ${f(to.x)} ${f(to.y)}`;
	}
	return `M ${start.cx} ${start.cy} L ${end.cx} ${end.cy}`;
}

export interface PlotGroup {
	assessment: PlotAssessment;
	dots: PlacedDot[];
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

/**
 * Dots evenly spread around `radius`, starting at twelve o'clock — or, when a
 * wedge (in radians) is held clear for the ring's name, spread evenly across what
 * is left of the circle either side of where that name is anchored.
 */
function placeOnCircle(members: Worker[], radius: number, wedge = 0): PlacedDot[] {
	const count = members.length;
	const span = Math.PI * 2 - wedge;
	// The dots are spread over what is left of the circle and the *gap* between the
	// last one and the first is what the name sits in, so it is the gap — not the
	// first dot — that has to be centred on the name.
	const spacing = count > 0 ? span / count : 0;
	const start = wedge > 0 ? labelAnchorAngle() + (wedge + spacing) / 2 : -Math.PI / 2;
	return members.map((worker, index) => {
		const angle = count === 1 ? -Math.PI / 2 : start + index * spacing;
		return {
			worker,
			cx: CHART_CENTER + Math.cos(angle) * radius,
			cy: CHART_CENTER + Math.sin(angle) * radius
		};
	});
}

/** Cluster tied dots around their target angles and fill the largest gaps. */
function placeTargetRow(
	members: Worker[],
	radius: number,
	targets: (number | undefined)[],
	wedge: number,
	fullRow: boolean,
	blocked: number[] = []
): PlacedDot[] {
	if (fullRow || !targets.some((target) => target !== undefined)) {
		return placeOnCircle(members, radius, wedge);
	}
	const span = Math.PI * 2 - wedge;
	const start = wedge > 0 ? labelAnchorAngle() + wedge / 2 : -Math.PI / 2;
	const end = start + span;
	const minGap = 2 * Math.asin(Math.min(1, MIN_PITCH / (2 * radius)));
	const tied = members
		.map((worker, index) => ({ worker, target: targets[index] }))
		.filter((item): item is { worker: Worker; target: number } => item.target !== undefined);
	const untied = members.filter((worker, index) => targets[index] === undefined);
	const angles = new Map<string, number>();
	if (tied.length === 1) {
		const normalized =
			start + ((((tied[0].target - start) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2));
		angles.set(tied[0].worker.id, Math.min(end, Math.max(start, normalized)));
	} else if (tied.length > 1) {
		let best: { cost: number; values: number[]; order: typeof tied } | undefined;
		for (let rotation = 0; rotation < tied.length; rotation++) {
			const order = [...tied.slice(rotation), ...tied.slice(0, rotation)];
			for (let wrap = -2; wrap <= 2; wrap++) {
				const desired: number[] = [];
				for (const item of order) {
					let angle = item.target + wrap * Math.PI * 2;
					if (desired.length > 0) {
						while (angle < desired.at(-1)! - Math.PI) angle += Math.PI * 2;
					}
					desired.push(angle);
				}
				const values = [...desired];
				for (let i = 1; i < values.length; i++)
					values[i] = Math.max(values[i], values[i - 1] + minGap);
				if (values.at(-1)! > end) {
					const shift = values.at(-1)! - end;
					for (let i = 0; i < values.length; i++) values[i] -= shift;
				}
				if (values[0] < start) continue;
				const cost = values.reduce(
					(sum, value, index) =>
						sum +
						Math.abs(
							Math.atan2(
								Math.sin(value - order[index].target),
								Math.cos(value - order[index].target)
							)
						),
					0
				);
				if (!best || cost < best.cost) best = { cost, values, order };
			}
		}
		if (best) best.order.forEach((item, index) => angles.set(item.worker.id, best!.values[index]));
		else {
			const spacing = span / tied.length;
			tied.forEach((item, index) => angles.set(item.worker.id, start + spacing * (index + 0.5)));
		}
	}
	const gapAngle = minGap;
	const within = (angle: number) =>
		start + ((((angle - start) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2));
	for (const worker of untied.sort(byId)) {
		const occupied = [...angles.values(), ...blocked.map(within)].sort((a, b) => a - b);
		const bounds = [start, ...occupied, end];
		let bestGap = -1;
		let bestAngle = start;
		for (let i = 0; i < bounds.length - 1; i++) {
			const gap = bounds[i + 1] - bounds[i];
			if (gap > bestGap && gap >= 2 * gapAngle) {
				bestGap = gap;
				bestAngle = (bounds[i] + bounds[i + 1]) / 2;
			}
		}
		if (bestGap < 0) bestAngle = start + (span * (angles.size + 1)) / (members.length + 1);
		angles.set(worker.id, bestAngle);
	}
	return members.map((worker) => {
		const angle = angles.get(worker.id) ?? -Math.PI / 2;
		return {
			worker,
			cx: CHART_CENTER + Math.cos(angle) * radius,
			cy: CHART_CENTER + Math.sin(angle) * radius
		};
	});
}

/**
 * How many dots an arc of `radius` holds at the minimum pitch, chord-exact. The
 * arc approximation would overfill rows near the centre, where the chord between
 * neighbours is meaningfully shorter than the arc. `wedge` is the angle the row
 * must keep clear for the ring's name, in radians.
 */
function rowCapacity(radius: number, wedge: number): number {
	const ratio = MIN_PITCH / (2 * radius);
	if (ratio > 1) return 1;
	return Math.max(1, Math.floor((Math.PI - wedge / 2) / Math.asin(ratio)));
}

/**
 * The thickness a band has to spread rows across: its total thickness minus
 * the edge clearance at both boundaries.
 */
function usableThickness(band: BandLayout): number {
	return band.outerRadius - band.packingInnerRadius - EDGE_CLEARANCE * 2;
}

/**
 * The radii of `rows` rows, edge-anchored: the innermost row clears the radius
 * the band packs from and the outermost row its outer boundary by the edge
 * clearance, and the rows between spread evenly, so the radial step never falls
 * below the pitch. A single row sits exactly on the centreline of what the band
 * packs into.
 */
function rowRadii(band: BandLayout, rows: number): number[] {
	if (rows === 1) return [(band.packingInnerRadius + band.outerRadius) / 2];
	const usable = usableThickness(band);
	return Array.from(
		{ length: rows },
		(_, index) => band.packingInnerRadius + EDGE_CLEARANCE + (usable * index) / (rows - 1)
	);
}

/**
 * Split `count` across the rows so each row carries a share proportional to
 * its capacity. Every row keeps the same dot density, so a partly full band
 * thins evenly instead of overloading its narrow inner rows.
 */
function distribute(count: number, radii: number[], wedge: number): number[] {
	const capacities = radii.map((radius) => rowCapacity(radius, wedge));
	const total = capacities.reduce((sum, capacity) => sum + capacity, 0);
	const exact = capacities.map((capacity) => (count * capacity) / total);
	const shares = exact.map(Math.floor);
	let placed = shares.reduce((sum, share) => sum + share, 0);

	const byRemainder = exact
		.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
		.sort((a, b) => b.remainder - a.remainder || a.index - b.index);

	for (let cursor = 0; placed < count; cursor += 1) {
		shares[byRemainder[cursor].index] += 1;
		placed += 1;
	}

	return shares;
}

/**
 * The rows a band's population packs into. `k` is the smallest row count
 * whose summed capacity covers the population, solved iteratively because
 * each row's radius depends on `k`. Past the documented ceiling the band
 * packs at its maximum row count anyway, and the dots may touch or overlap.
 * `wedge` is the angle every row keeps clear, in radians.
 */
function planRows(
	band: BandLayout,
	count: number,
	wedge: number
): { radius: number; count: number }[] {
	if (count === 0) return [];

	const usable = usableThickness(band);
	const maxRows = usable < MIN_PITCH ? 1 : Math.floor(usable / MIN_PITCH) + 1;

	for (let rows = 1; rows <= maxRows; rows++) {
		const radii = rowRadii(band, rows);
		const capacity = radii.reduce((sum, radius) => sum + rowCapacity(radius, wedge), 0);
		if (capacity >= count) {
			return distribute(count, radii, wedge).map((rowCount, index) => ({
				radius: radii[index],
				count: rowCount
			}));
		}
	}

	const radii = rowRadii(band, maxRows);
	return distribute(count, radii, wedge).map((rowCount, index) => ({
		radius: radii[index],
		count: rowCount
	}));
}

const byId = (a: Worker, b: Worker): number => a.id.localeCompare(b.id);

/** The widest wedge one Committee member's tree may fan across, in radians. */
const MAX_TREE_WEDGE = Math.PI / 2;

/** The bands a reach tree may grow through, inside out, out to the Hostile track. */
const TREE_BANDS: readonly PlotAssessment[] = assessedOptions;

const treeDepth = (worker: Worker): number =>
	TREE_BANDS.indexOf(worker.assessment as PlotAssessment);

/**
 * The Committee's reach as a forest: one tree per Committee member, grown
 * breadth-first through relationships out through every band to the Hostile
 * track. Each reached worker hangs off exactly one parent, in its
 * own band or a band further in, so every branch grows outward. When a worker
 * could hang off several, it takes the one reaching the most new workers, then
 * the lowest id. Returns child id → parent id.
 */
export function reachTree(workers: Worker[]): Map<string, string> {
	const byWorkerId = new Map(workers.map((worker) => [worker.id, worker]));
	const parent = new Map<string, string>();
	const reached = new Set<string>();
	let frontier = workers.filter((worker) => worker.assessment === 'Leader').sort(byId);
	for (const member of frontier) reached.add(member.id);
	while (frontier.length > 0) {
		const candidates = new Map<string, Worker[]>();
		for (const from of frontier) {
			for (const id of from.relationships) {
				const to = byWorkerId.get(id);
				if (!to || reached.has(id) || treeDepth(to) < 1 || treeDepth(to) < treeDepth(from))
					continue;
				candidates.set(id, [...(candidates.get(id) ?? []), from]);
			}
		}
		const load = new Map<string, number>();
		for (const froms of candidates.values())
			for (const from of froms) load.set(from.id, (load.get(from.id) ?? 0) + 1);
		const next: Worker[] = [];
		for (const id of [...candidates.keys()].sort()) {
			const best = [...candidates.get(id)!].sort(
				(a, b) => load.get(b.id)! - load.get(a.id)! || byId(a, b)
			)[0];
			parent.set(id, best.id);
			reached.add(id);
			next.push(byWorkerId.get(id)!);
		}
		frontier = next;
	}
	return parent;
}

/**
 * The Committee in an order that seats members who know the same workers side
 * by side: start at the best-connected member, then keep adding the member who
 * shares the most workers with the one just seated. A tie from a member to a
 * worker in a neighbour's tree then runs a short way along its lane.
 */
function seatBySharing(workers: Worker[], committee: Worker[]): Worker[] {
	const known = new Map(
		committee.map((member) => [
			member.id,
			new Set(
				workers
					.filter(
						(worker) => worker.assessment !== 'Leader' && worker.relationships.includes(member.id)
					)
					.map((worker) => worker.id)
			)
		])
	);
	const shared = (a: Worker, b: Worker) =>
		[...known.get(a.id)!].filter((id) => known.get(b.id)!.has(id)).length;
	const remaining = [...committee].sort(
		(a, b) => known.get(b.id)!.size - known.get(a.id)!.size || byId(a, b)
	);
	const seated = remaining.splice(0, 1);
	while (remaining.length > 0) {
		const last = seated[seated.length - 1];
		let best = 0;
		for (let i = 1; i < remaining.length; i++) {
			if (shared(last, remaining[i]) > shared(last, remaining[best])) best = i;
		}
		seated.push(...remaining.splice(best, 1));
	}
	return seated;
}

/**
 * Where every tree worker aims, as a radial tree layout. Each Committee member
 * gets a wedge of the circle sized by its whole tree, and each worker splits its
 * wedge into one slot per worker in its subtree: its own slot in the middle,
 * each child's share either side. A worker never sits on top of its child, so
 * even a tie within one band stays a visible line. Children in outer bands take
 * the slots nearest the parent and inner ones the far sides, so a spoke to an
 * outer worker never passes over a sibling nearer the centre. Wedges never
 * overlap, so neither do branches.
 */
function treeAngles(workers: Worker[], parent: Map<string, string>): Map<string, number> {
	const byWorkerId = new Map(workers.map((worker) => [worker.id, worker]));
	const children = new Map<string, Worker[]>();
	for (const [childId, parentId] of parent) {
		children.set(parentId, [...(children.get(parentId) ?? []), byWorkerId.get(childId)!]);
	}
	const size = new Map<string, number>();
	const measure = (worker: Worker): number => {
		const total = (children.get(worker.id) ?? []).reduce((sum, child) => sum + measure(child), 1);
		size.set(worker.id, total);
		return total;
	};
	const committee = seatBySharing(
		workers,
		workers.filter((worker) => worker.assessment === 'Leader').sort(byId)
	);
	const whole = committee.reduce((sum, member) => sum + measure(member), 0);
	const angles = new Map<string, number>();
	const assign = (worker: Worker, from: number, to: number, toward: 'start' | 'end' | null) => {
		const ranked = [...(children.get(worker.id) ?? [])].sort(
			(a, b) => treeDepth(b) - treeDepth(a) || size.get(b.id)! - size.get(a.id)! || byId(a, b)
		);
		// Centre-out: the worker's own slot in the middle, then its children
		// alternately either side, nearest first. A worker reached from within its
		// own band instead takes the end of its wedge facing its parent, with its
		// children running away from it, so nothing of its subtree sits between
		// the two and the tie joining them along the band crosses no one.
		const order: (Worker | null)[] = [null];
		if (toward === 'start') order.push(...ranked);
		else if (toward === 'end') order.unshift(...ranked.reverse());
		else
			ranked.forEach((child, index) =>
				index % 2 === 0 ? order.push(child) : order.unshift(child)
			);
		const slot = (to - from) / size.get(worker.id)!;
		const before = order
			.slice(0, order.indexOf(null))
			.reduce((sum, item) => sum + size.get(item!.id)!, 0);
		const own = from + slot * (before + 0.5);
		let cursor = from;
		for (const item of order) {
			const span = slot * (item ? size.get(item.id)! : 1);
			if (item) {
				const sameBand = treeDepth(item) === treeDepth(worker);
				assign(item, cursor, cursor + span, sameBand ? (cursor < own ? 'end' : 'start') : null);
			} else angles.set(worker.id, cursor + span / 2);
			cursor += span;
		}
	};
	// The first member's wedge is centred on twelve o'clock.
	let cursor = -Math.PI / 2 - (Math.PI * (size.get(committee[0]?.id ?? '') ?? 0)) / whole;
	for (const member of committee) {
		const share = (Math.PI * 2 * size.get(member.id)!) / whole;
		// A tree never fans wider than a quarter turn, however few members share
		// the circle, so its spokes always lean outward rather than across the centre.
		const span = Math.min(share, MAX_TREE_WEDGE);
		const middle = cursor + share / 2;
		assign(member, middle - span / 2, middle + span / 2, null);
		cursor += share;
	}
	return angles;
}

/**
 * The angles, at `radius`, where a tie passes within a dot's reach of that
 * circle. A worker outside the trees is never seated on one of them, so no
 * tie runs over a dot it does not join.
 */
function tieCrossings(
	segments: { x1: number; y1: number; x2: number; y2: number }[],
	radius: number
): number[] {
	const crossings: number[] = [];
	for (const { x1, y1, x2, y2 } of segments) {
		for (let step = 0; step <= TIE_SAMPLES; step++) {
			const x = x1 + ((x2 - x1) * step) / TIE_SAMPLES;
			const y = y1 + ((y2 - y1) * step) / TIE_SAMPLES;
			if (Math.abs(Math.hypot(x - CHART_CENTER, y - CHART_CENTER) - radius) < MIN_PITCH) {
				crossings.push(Math.atan2(y - CHART_CENTER, x - CHART_CENTER));
			}
		}
	}
	return crossings;
}

/**
 * One dot group per plotted Assessment, in band order with Hostile last. Each
 * drawn band packs its dots into concentric rows inside the band, with a
 * single row sitting on the centreline while the population fits it; Hostile
 * dots sit on their own fixed track beyond the drawn boundary. Workers in the
 * Committee's reach trees sit at their tree angle on their band's innermost
 * rows; everyone else fills the space the trees leave, clear of every tie.
 */
export function plotWorkerGroups(
	workers: Worker[],
	bands: BandLayout[],
	names: RingNames
): PlotGroup[] {
	const parent = reachTree(workers);
	const angles = treeAngles(workers, parent);
	const target = (worker: Worker) => angles.get(worker.id);
	const hostileRadius = hostileTrackRadius(bands);
	const firstRow = new Map<PlotAssessment, number>([
		...bands.map((band) => [band.assessment, band.packingInnerRadius + EDGE_CLEARANCE] as const),
		['Hostile', hostileRadius]
	]);
	// Where each tie will run, from its ends' tree angles on their bands' first rows.
	const point = (id: string) => {
		const worker = workers.find((w) => w.id === id)!;
		const radius = firstRow.get(worker.assessment as PlotAssessment) ?? 0;
		const angle = angles.get(id)!;
		return {
			x: CHART_CENTER + Math.cos(angle) * radius,
			y: CHART_CENTER + Math.sin(angle) * radius
		};
	};
	const segments = [...parent].map(([childId, parentId]) => {
		const a = point(parentId);
		const b = point(childId);
		return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
	});

	const groups: PlotGroup[] = bands.map((band) => {
		const members = workers.filter((worker) => worker.assessment === band.assessment);
		const byTarget = (a: Worker, b: Worker) =>
			(target(a) ?? Infinity) - (target(b) ?? Infinity) || byId(a, b);
		const tied = members.filter((worker) => target(worker) !== undefined).sort(byTarget);
		const untied = members.filter((worker) => target(worker) === undefined).sort(byId);
		// Every band whose name sits inside it keeps that name's wedge clear, and the
		// plan is solved with the wedge already spent, so a row is never asked to
		// hold more than the arc it has left. The innermost band is the exception:
		// its name is the chart's centre rather than a word on its edge, so its
		// members keep the whole circle.
		const wedge =
			band.assessment === 'Leader'
				? 0
				: ringLabelWedge(names[band.assessment], (band.innerRadius + band.outerRadius) / 2);
		const rows = planRows(band, members.length, wedge);
		// A tied dot whose natural angle falls in the wedge moves to the wedge edge nearer its own member.
		const pull = (worker: Worker) => {
			const natural = target(worker);
			const member = parent.get(worker.id);
			if (natural === undefined || member === undefined || wedge === 0) return natural;
			return wedgeEdgeToward(natural, angles.get(member) ?? natural, wedge);
		};

		let cursor = 0;
		const dots: PlacedDot[] = [];
		const packingOrder = [...tied, ...untied];
		for (const row of rows) {
			const rowWorkers = packingOrder.slice(cursor, cursor + row.count);
			dots.push(
				...placeTargetRow(
					rowWorkers,
					row.radius,
					rowWorkers.map(pull),
					wedge,
					rowWorkers.length >= rowCapacity(row.radius, wedge),
					tieCrossings(segments, row.radius)
				)
			);
			cursor += row.count;
		}

		return { assessment: band.assessment, dots };
	});

	// Hostile dots sit on their own track, but take their tree angle like any band.
	const hostile = workers.filter((worker) => worker.assessment === 'Hostile');
	const hostileOrder = [
		...hostile
			.filter((worker) => target(worker) !== undefined)
			.sort((a, b) => target(a)! - target(b)! || byId(a, b)),
		...hostile.filter((worker) => target(worker) === undefined).sort(byId)
	];
	groups.push({
		assessment: 'Hostile',
		dots: placeTargetRow(
			hostileOrder,
			hostileRadius,
			hostileOrder.map(target),
			0,
			hostileOrder.length >= rowCapacity(hostileRadius, 0),
			tieCrossings(segments, hostileRadius)
		)
	});

	return groups;
}
