/**
 * The bullseye's geometry: the annulus bands, the dot footprint, and where each
 * Worker's dot sits. These measurements are load-bearing and deliberate — re-check
 * a dense render (ADR 0012) before simplifying any of them.
 */
import type { Worker } from '#lib/domain-vocabulary.ts';
import {
	CHART_CENTER,
	MIN_PITCH,
	EDGE_CLEARANCE,
	RING_LABEL_UNITS,
	type RingNames,
	type PlotAssessment,
	type BandLayout,
	type PlacedDot,
	type PlotGroup
} from './bullseye-shared.ts';
import {
	ringLabelWedge,
	labelAnchorAngle,
	wedgeEdgeToward,
	hostileTrackRadius
} from './bullseye-bands.ts';
import { byId, reachTree, treeAngles, tieCrossings } from './bullseye-ties.ts';

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
	names: RingNames,
	labelSize = RING_LABEL_UNITS
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
				: ringLabelWedge(
						names[band.assessment],
						(band.innerRadius + band.outerRadius) / 2,
						labelSize
					);
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
