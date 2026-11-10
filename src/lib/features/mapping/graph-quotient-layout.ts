/** Deterministic placement for temporary bodies connected by actual Relationships. */
import { compareText, keyAsLabel, type LabelOf } from './graph-analysis.ts';
import { stressEdgeLength, stressEnergy, stressLayout, type StressPoint } from './graph-stress.ts';

/**
 * Starts each component's solve is tried from. One seed string's jitter can settle a
 * component into a worse shape, so every start rotates the circle-slot order too.
 */
const quotientStarts = 5;

/** Whether the segments p1-p2 and p3-p4 properly cross. */
function segmentsCross(
	p1: StressPoint,
	p2: StressPoint,
	p3: StressPoint,
	p4: StressPoint
): boolean {
	const side = (a: StressPoint, b: StressPoint, c: StressPoint) =>
		(b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
	return side(p3, p4, p1) * side(p3, p4, p2) < 0 && side(p1, p2, p3) * side(p1, p2, p4) < 0;
}

/** How many tie segments cross one another in a layout, ties sharing an end excluded. */
function tieCrossings(
	positions: ReadonlyMap<string, StressPoint>,
	ties: readonly QuotientTie[]
): number {
	let count = 0;
	for (let i = 0; i < ties.length; i += 1) {
		for (let j = i + 1; j < ties.length; j += 1) {
			const a = ties[i];
			const b = ties[j];
			if (new Set([a.source, a.target, b.source, b.target]).size < 4) continue;
			const [p1, p2, p3, p4] = [a.source, a.target, b.source, b.target].map((id) =>
				positions.get(id)
			);
			if (p1 && p2 && p3 && p4 && segmentsCross(p1, p2, p3, p4)) count += 1;
		}
	}
	return count;
}

/**
 * How many ties run through a body that is neither of their ends: the body's centre lies
 * closer to the segment than its own radius (`radiusOf` is in the layout's units).
 */
function tiePassThroughs(
	positions: ReadonlyMap<string, StressPoint>,
	ties: readonly QuotientTie[],
	radiusOf: (key: string) => number
): number {
	let count = 0;
	for (const tie of ties) {
		const a = positions.get(tie.source);
		const b = positions.get(tie.target);
		if (!a || !b) continue;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const lengthSquared = dx * dx + dy * dy;
		for (const [key, centre] of positions) {
			if (key === tie.source || key === tie.target) continue;
			const along =
				lengthSquared === 0
					? 0
					: Math.min(
							1,
							Math.max(0, ((centre.x - a.x) * dx + (centre.y - a.y) * dy) / lengthSquared)
						);
			const distance = Math.hypot(centre.x - (a.x + along * dx), centre.y - (a.y + along * dy));
			if (distance < radiusOf(key)) count += 1;
		}
	}
	return count;
}

export type QuotientBody = { key: string; radius: number };
export type QuotientTie = { source: string; target: string; strength: number };

type ComponentLayout = {
	key: string;
	positions: Map<string, StressPoint>;
	reach: number;
};

/**
 * Lay connected quotient components by weighted graph distance, then pack the
 * disconnected components as padded circles. A tie's strength is the number of
 * actual Relationships between its bodies; disconnected components never get
 * a synthetic edge.
 *
 * `gap` is the gutter a tied body pair keeps between its footprints (the
 * outline and label room a level needs). `packingClearance` is the separate
 * clearance unrelated packed components keep, so a level without an outline
 * can still pack its loose bodies clear of each other.
 */
export function placeQuotientBodies(
	bodies: readonly QuotientBody[],
	ties: readonly QuotientTie[],
	gap: number,
	packingClearance: number = gap,
	labelOf: LabelOf = keyAsLabel
): Map<string, StressPoint> {
	if (bodies.length === 0) return new Map();
	const sortedBodies = [...bodies].sort((a, b) => labelOf(a.key).localeCompare(labelOf(b.key)));
	const bodyByKey = new Map(sortedBodies.map((body) => [body.key, body]));
	const tiesByPair = new Map<string, QuotientTie>();
	for (const tie of ties) {
		if (
			tie.source === tie.target ||
			!bodyByKey.has(tie.source) ||
			!bodyByKey.has(tie.target) ||
			!Number.isFinite(tie.strength) ||
			tie.strength <= 0
		) {
			continue;
		}
		const [source, target] =
			compareText(labelOf(tie.source), labelOf(tie.target)) < 0
				? [tie.source, tie.target]
				: [tie.target, tie.source];
		const key = JSON.stringify([source, target]);
		const previous = tiesByPair.get(key);
		tiesByPair.set(key, {
			source,
			target,
			strength: (previous?.strength ?? 0) + tie.strength
		});
	}

	const neighbours = new Map(sortedBodies.map(({ key }) => [key, new Set<string>()]));
	for (const tie of tiesByPair.values()) {
		neighbours.get(tie.source)?.add(tie.target);
		neighbours.get(tie.target)?.add(tie.source);
	}

	const components: string[][] = [];
	const visited = new Set<string>();
	for (const { key } of sortedBodies) {
		if (visited.has(key)) continue;
		const component: string[] = [];
		const pending = [key];
		visited.add(key);
		while (pending.length > 0) {
			const current = pending.pop()!;
			component.push(current);
			const byLabel = (a: string, b: string) => compareText(labelOf(a), labelOf(b));
			for (const next of [...(neighbours.get(current) ?? [])].sort(byLabel).reverse()) {
				if (visited.has(next)) continue;
				visited.add(next);
				pending.push(next);
			}
		}
		components.push(component.sort((a, b) => compareText(labelOf(a), labelOf(b))));
	}

	const layouts: ComponentLayout[] = components.map((keys) => {
		const componentTies = [...tiesByPair.values()].filter(
			({ source, target }) => keys.includes(source) && keys.includes(target)
		);
		// Each start rotates the id order, so the circle slots move as well as the jitter. The
		// fewest ties through a third body wins, then fewest crossings, then least stress energy; a
		// near-tie (within 1e-9) keeps the lower start index.
		const bestStart = (ids: string[]) => {
			let best = new Map<string, StressPoint>();
			let bestEnergy = Infinity;
			let bestCrossings = Infinity;
			let bestPassThroughs = Infinity;
			for (let start = 0; start < quotientStarts; start += 1) {
				const shift = start % ids.length;
				const ordered = [...ids.slice(shift), ...ids.slice(0, shift)];
				const layout = stressLayout(
					ordered.map((id) => ({ id })),
					componentTies,
					{
						// The seed reads the keys' labels (list positions), so no id or text decides the start shape.
						seedKey: `${ids.map(labelOf).join('|')}#${start}`,
						linkDistanceFor: ({ source, target, strength = 1 }) =>
							1 / Math.sqrt(strength) +
							((bodyByKey.get(source)?.radius ?? 0) + (bodyByKey.get(target)?.radius ?? 0) + gap) /
								stressEdgeLength
					}
				);
				const energy = stressEnergy(
					layout,
					ids.map((id) => ({ id })),
					componentTies,
					{
						linkDistanceFor: ({ source, target, strength = 1 }) =>
							1 / Math.sqrt(strength) +
							((bodyByKey.get(source)?.radius ?? 0) + (bodyByKey.get(target)?.radius ?? 0) + gap) /
								stressEdgeLength
					}
				);
				const passThroughs = tiePassThroughs(
					layout,
					componentTies,
					(key) => (bodyByKey.get(key)?.radius ?? 0) / stressEdgeLength
				);
				const crossings = tieCrossings(layout, componentTies);
				if (
					passThroughs < bestPassThroughs ||
					(passThroughs === bestPassThroughs && crossings < bestCrossings) ||
					(passThroughs === bestPassThroughs &&
						crossings === bestCrossings &&
						energy < bestEnergy - 1e-9)
				) {
					bestPassThroughs = passThroughs;
					bestCrossings = crossings;
					best = layout;
					bestEnergy = energy;
				}
			}
			return best;
		};
		const positions = keys.length === 1 ? new Map([[keys[0], { x: 0, y: 0 }]]) : bestStart(keys);
		let reach = 0;
		for (const [id, point] of positions) {
			reach = Math.max(reach, Math.hypot(point.x, point.y) + (bodyByKey.get(id)?.radius ?? 0));
		}
		return { key: keys[0], positions, reach };
	});

	if (layouts.length === 1) return layouts[0].positions;

	// Circle-bounded component shelves leave room for every body and the packing
	// clearance, without turning disconnected components into an attracting pair.
	layouts.sort((a, b) => b.reach - a.reach || labelOf(a.key).localeCompare(labelOf(b.key)));
	const columns = Math.ceil(Math.sqrt(layouts.length));
	let rowTop = 0;
	const placed = new Map<string, StressPoint>();
	for (let start = 0; start < layouts.length; start += columns) {
		const row = layouts.slice(start, start + columns);
		const rowWidth =
			row.reduce((sum, layout) => sum + 2 * layout.reach, 0) + packingClearance * (row.length - 1);
		const rowReach = Math.max(...row.map(({ reach }) => reach));
		let x = -rowWidth / 2;
		for (const layout of row) {
			const centre = { x: x + layout.reach, y: rowTop + rowReach };
			for (const [id, point] of layout.positions) {
				placed.set(id, { x: centre.x + point.x, y: centre.y + point.y });
			}
			x += 2 * layout.reach + packingClearance;
		}
		rowTop += 2 * rowReach + packingClearance;
	}

	let cx = 0;
	let cy = 0;
	for (const point of placed.values()) {
		cx += point.x;
		cy += point.y;
	}
	cx /= placed.size;
	cy /= placed.size;
	for (const point of placed.values()) {
		point.x -= cx;
		point.y -= cy;
	}
	return placed;
}
