import type { Box as CanvasBox } from './graph-free-canvas.ts';
import type { GroupRegion, Region } from './graph-layout.ts';

export type LabelSide =
	| 'below'
	| 'right'
	| 'left'
	| 'above'
	| 'below-right'
	| 'below-left'
	| 'above-right'
	| 'above-left';
export type LabelRequest = {
	id: string;
	x: number;
	y: number;
	radius: number;
	width: number;
	height: number;
};
export type Obstacle = { id: string; x: number; y: number; radius: number };
/** A drawn tie, as the segment between its two dots. */
export type TieSegment = {
	source: string;
	target: string;
	ax: number;
	ay: number;
	bx: number;
	by: number;
};
export type LabelPlacement = {
	x: number;
	y: number;
	textAnchor: 'start' | 'middle' | 'end';
	side: LabelSide;
	/** The distance from the dot, as a multiple of the gap, the label was placed at. */
	ring?: number;
};

export type Box = { left: number; top: number; right: number; bottom: number };

export function boxFor(request: LabelRequest, placement: LabelPlacement): Box {
	const left =
		placement.textAnchor === 'start'
			? placement.x
			: placement.textAnchor === 'end'
				? placement.x - request.width
				: placement.x - request.width / 2;
	const top = placement.y - request.height / 2;
	return {
		left,
		top,
		right: left + request.width,
		bottom: top + request.height
	};
}

function intersectsCircle(box: Box, obstacle: Obstacle): boolean {
	const nearestX = Math.max(box.left, Math.min(obstacle.x, box.right));
	const nearestY = Math.max(box.top, Math.min(obstacle.y, box.bottom));
	return Math.hypot(nearestX - obstacle.x, nearestY - obstacle.y) < obstacle.radius;
}

/** Whether the segment passes through the box (Liang-Barsky clipping). */
export function segmentCrossesBox(box: Box, tie: TieSegment): boolean {
	const dx = tie.bx - tie.ax;
	const dy = tie.by - tie.ay;
	let enter = 0;
	let leave = 1;
	for (const [p, q] of [
		[-dx, tie.ax - box.left],
		[dx, box.right - tie.ax],
		[-dy, tie.ay - box.top],
		[dy, box.bottom - tie.ay]
	]) {
		if (p === 0) {
			if (q < 0) return false;
			continue;
		}
		const t = q / p;
		if (p < 0) enter = Math.max(enter, t);
		else leave = Math.min(leave, t);
		if (enter > leave) return false;
	}
	return true;
}

/** What a tie under a name costs, against a hard obstacle (a dot or another label). */
const foreignTieCost = 2;
const hardCost = 100;
/** What a spot reaching outside the preferred box costs: less than lying under a foreign tie. */
const outsideCost = 1.5;
/** A pull toward the earlier spots, which sit closer to the dot. */
const spotOrderCost = 0.05;
/** The rings tried when the caller has no policy: the shipped grouped placement. */
const defaultRings = [1, 2.5, 4, 7, 10];

/**
 * Free's denser rings: a name stands no farther than four gaps (32 screen pixels) from its
 * dot's surface, and the nearer steps are close enough that proximity wins before a name
 * travels. Grouped placement keeps `defaultRings`.
 */
const freeNameRings = [1, 1.5, 2, 2.5, 3, 3.5, 4] as const;

/**
 * The cost model Free names use: a Relationship under a name costs the same whether it is
 * the name's own or another Worker's, a bundle of ties adds at most `tieCostCap` (so it never
 * outweighs a hard collision), and each ring step costs about half a foreign tie. Grouped
 * placement keeps the defaults in `placeLabels`.
 */
export const freeNamePlacement = {
	rings: freeNameRings,
	ownTieShare: 1,
	tieCostCap: 3,
	ringCost: 1
} as const;

function boxWithin(box: Box, outer: Box): boolean {
	return (
		box.left >= outer.left &&
		box.right <= outer.right &&
		box.top >= outer.top &&
		box.bottom <= outer.bottom
	);
}

function intersectsBox(a: Box, b: Box): boolean {
	return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function candidate(
	request: LabelRequest,
	side: LabelSide,
	ring: number,
	gap: number
): LabelPlacement {
	const distance = gap * ring;
	switch (side) {
		case 'below':
			return {
				x: request.x,
				y: request.y + request.radius + distance + request.height / 2,
				textAnchor: 'middle',
				side,
				ring
			};
		case 'right':
			return {
				x: request.x + request.radius + distance,
				y: request.y,
				textAnchor: 'start',
				side,
				ring
			};
		case 'left':
			return {
				x: request.x - request.radius - distance,
				y: request.y,
				textAnchor: 'end',
				side,
				ring
			};
		case 'above':
			return {
				x: request.x,
				y: request.y - request.radius - distance - request.height / 2,
				textAnchor: 'middle',
				side,
				ring
			};
		case 'below-right':
		case 'above-right':
		case 'below-left':
		case 'above-left': {
			// Diagonal: the label's near corner clears the dot along its 45° ray.
			const reach = (request.radius + distance) * Math.SQRT1_2;
			const right = side.endsWith('right');
			return {
				x: request.x + (right ? reach : -reach),
				y:
					request.y +
					(side.startsWith('below') ? reach + request.height / 2 : -reach - request.height / 2),
				textAnchor: right ? 'start' : 'end',
				side,
				ring
			};
		}
	}
}

/** Place labels in request order; earlier labels reserve space first. The exported wrapper repairs the grazes this grid allows. */
function placeLabelsInner(
	requests: readonly LabelRequest[],
	obstacles: readonly Obstacle[],
	gap: number,
	/** Text already on the map, such as group labels, that names must not cover. */
	reserved: readonly Box[] = [],
	/** Drawn ties: a soft cost, so a name leans away from them but never hides for one. */
	ties: readonly TieSegment[] = [],
	options: {
		/** Distances from the dot, as multiples of `gap`, tried nearest first. */
		rings?: readonly number[];
		/** Scales the soft cost of lying under a tie. */
		tieWeight?: number;
		/** What the name's own tie costs relative to a foreign one; one means both cost the same. */
		ownTieShare?: number;
		/** The most tie cost one name may accrue, so a bundle cannot outweigh a hard obstacle. */
		tieCostCap?: number;
		/** A soft cost for each ring step away from the dot. */
		ringCost?: number;
		/** A soft preference: a spot reaching outside this box costs more than one inside it. */
		within?: Box;
		/** Visible canvas: leaving it is a hard collision, like covering another name. */
		viewport?: Box;
		/**
		 * The side and ring a label chose at the framing camera. A kept spot is used as drawn
		 * unless it would cover a dot, another label or reserved text; only then is the label
		 * placed afresh.
		 */
		kept?: ReadonlyMap<string, { side: LabelSide; ring: number }>;
		/**
		 * On a narrow canvas a resting name that cannot stand clear of another resting
		 * name is dropped rather than drawn over it (its card and table row still name the
		 * Worker). Active names are never listed here, so hover and selection keep their rule.
		 */
		dropOnNameCollision?: ReadonlySet<string>;
	} = {}
): Map<string, LabelPlacement> {
	const placements = new Map<string, LabelPlacement>();
	const boxes: Box[] = [...reserved];
	/** The name boxes alone, which are the only collisions the narrow-layout drop reads. */
	const nameBoxes: Box[] = [];
	const collidesWithName = (box: Box) => nameBoxes.some((name) => intersectsBox(box, name));
	const sides: readonly LabelSide[] = [
		'below',
		'right',
		'left',
		'above',
		'below-right',
		'below-left',
		'above-right',
		'above-left'
	];
	const hardAt = (box: Box, requestId: string) =>
		obstacles.filter((obstacle) => obstacle.id !== requestId && intersectsCircle(box, obstacle))
			.length +
		boxes.filter((accepted) => intersectsBox(box, accepted)).length +
		(options.viewport && !boxWithin(box, options.viewport) ? 1 : 0);

	for (const request of requests) {
		// The first clear spot wins; when every spot collides, the least-crowded one
		// does, rather than a fixed fallback that lands on a dot.
		let chosen: LabelPlacement | undefined;
		// A name that chose its side and ring at the framing camera keeps them while that
		// spot stays clear: zooming alone must not rearrange the picture.
		const kept = options.kept?.get(request.id);
		if (kept) {
			const placement = candidate(request, kept.side, kept.ring, gap);
			const box = boxFor(request, placement);
			if (hardAt(box, request.id) === 0) {
				placements.set(request.id, placement);
				boxes.push(box);
				nameBoxes.push(box);
				continue;
			}
		}
		let cheapest = Infinity;
		let order = 0;
		// Each ring pushes the label further from its dot; a label that can only
		// clear a crowded cluster at a distance still reads as that dot's.
		search: for (const [ringIndex, ring] of (options.rings ?? defaultRings).entries()) {
			for (const side of sides) {
				const placement = candidate(request, side, ring, gap);
				const box = boxFor(request, placement);
				const hard = hardAt(box, request.id);
				let tieCost = 0;
				for (const tie of ties) {
					if (!segmentCrossesBox(box, tie)) continue;
					const own = tie.source === request.id || tie.target === request.id;
					tieCost +=
						foreignTieCost * (own ? (options.ownTieShare ?? 0.5) : 1) * (options.tieWeight ?? 1);
				}
				let soft = Math.min(tieCost, options.tieCostCap ?? Infinity);
				if (options.within && !boxWithin(box, options.within)) soft += outsideCost;
				// Each ring step and a small pull toward the first spots keep a label
				// near its own dot, competing with the ties under it.
				const cost =
					hard * hardCost + soft + ringIndex * (options.ringCost ?? 0) + order * spotOrderCost;
				if (cost < cheapest) {
					cheapest = cost;
					chosen = placement;
				}
				order += 1;
				if (hard === 0 && soft === 0) break search;
			}
		}
		chosen ??= candidate(request, 'below', 1, gap);
		// Narrow canvases keep their own contract: a name that cannot stand clear
		// of another resting name is left off rather than pushed farther out.
		if (hardAt(boxFor(request, chosen), request.id) > 0 && !options.dropOnNameCollision) {
			// The coarse grid found no clear cell in this crowd: look between and
			// beyond its rings before accepting an overlap. Green maps never reach
			// here — their coarse winner is already clear — so this only moves names
			// that would otherwise be drawn over a dot, a name or reserved text.
			const coarseRings = options.rings ?? defaultRings;
			const fine: { ring: number; index: number }[] = [];
			for (let i = 0; i < coarseRings.length - 1; i++) {
				fine.push({ ring: (coarseRings[i] + coarseRings[i + 1]) / 2, index: i + 0.5 });
			}
			const last = coarseRings.length - 1;
			fine.push({ ring: coarseRings[last] * 1.5, index: last + 1 });
			fine.push({ ring: coarseRings[last] * 2, index: last + 2 });
			for (const { ring, index } of fine) {
				for (const side of sides) {
					const placement = candidate(request, side, ring, gap);
					const box = boxFor(request, placement);
					const hard = hardAt(box, request.id);
					let tieCost = 0;
					for (const tie of ties) {
						if (!segmentCrossesBox(box, tie)) continue;
						const own = tie.source === request.id || tie.target === request.id;
						tieCost +=
							foreignTieCost * (own ? (options.ownTieShare ?? 0.5) : 1) * (options.tieWeight ?? 1);
					}
					let soft = Math.min(tieCost, options.tieCostCap ?? Infinity);
					if (options.within && !boxWithin(box, options.within)) soft += outsideCost;
					const cost =
						hard * hardCost + soft + index * (options.ringCost ?? 0) + order * spotOrderCost;
					if (cost < cheapest) {
						cheapest = cost;
						chosen = placement;
					}
					order += 1;
				}
			}
		}
		const chosenBox = boxFor(request, chosen);
		// A resting name on a narrow canvas has no least-crowded consolation: if every
		// spot runs over another resting name, the name is left off the drawing.
		if (options.dropOnNameCollision?.has(request.id) && collidesWithName(chosenBox)) continue;
		placements.set(request.id, chosen);
		boxes.push(chosenBox);
		nameBoxes.push(chosenBox);
	}

	return placements;
}

/** A dot's drawn box, shrunk the way the drawn contract shrinks it before testing an overlap. */
function dotBoxOverlap(box: Box, obstacle: Obstacle, shrink: number): boolean {
	return (
		box.left < obstacle.x + obstacle.radius - shrink &&
		obstacle.x - obstacle.radius + shrink < box.right &&
		box.top < obstacle.y + obstacle.radius - shrink &&
		obstacle.y - obstacle.radius + shrink < box.bottom
	);
}

/**
 * Places every label, then repairs the corner grazes the circle test allows: a
 * name can clear a round dot yet touch its drawn box corner, which the drawn
 * contract forbids. The repair only runs when the single search left a graze,
 * so maps that already clear return untouched.
 */
export function placeLabels(
	...args: Parameters<typeof placeLabelsInner>
): Map<string, LabelPlacement> {
	const [requests, obstacles, gap, reserved = [], ties = [], options = {}] = args;
	// Narrow canvases keep the drop contract: re-placing grazes would push names
	// back on that the narrow reading deliberately left off.
	if (options.dropOnNameCollision) return placeLabelsInner(...args);
	// Two screen pixels in map units: gap holds eight screen pixels, and the drawn
	// contract shrinks a dot's box by two before testing the overlap.
	const shrink = gap / 4;
	const grazeBoxes = (placements: Map<string, LabelPlacement>): Box[] => {
		const hits: Box[] = [];
		for (const request of requests) {
			const placement = placements.get(request.id);
			if (!placement) continue;
			const box = boxFor(request, placement);
			for (const obstacle of obstacles) {
				if (obstacle.id === request.id) continue;
				if (dotBoxOverlap(box, obstacle, shrink)) {
					hits.push({
						left: obstacle.x - obstacle.radius + shrink,
						top: obstacle.y - obstacle.radius + shrink,
						right: obstacle.x + obstacle.radius - shrink,
						bottom: obstacle.y + obstacle.radius - shrink
					});
					break;
				}
			}
		}
		return hits;
	};
	let best = placeLabelsInner(...args);
	let bestCount = grazeBoxes(best).length;
	const extra: Box[] = [];
	for (let iter = 0; iter < 6 && bestCount > 0; iter++) {
		for (const hit of grazeBoxes(best)) extra.push(hit);
		const retry = placeLabelsInner(
			requests,
			obstacles,
			gap,
			[...reserved, ...extra],
			ties,
			options
		);
		const count = grazeBoxes(retry).length;
		if (count < bestCount) {
			best = retry;
			bestCount = count;
		}
	}
	return best;
}

/** A short leader from a dot's surface to its name's box, when the name stands off by `minStandoff` or more. */
export function nameLeader(
	dot: { x: number; y: number; radius: number },
	box: Box,
	minStandoff: number
): { x1: number; y1: number; x2: number; y2: number } | undefined {
	const nearestX = Math.max(box.left, Math.min(dot.x, box.right));
	const nearestY = Math.max(box.top, Math.min(dot.y, box.bottom));
	const reach = Math.hypot(nearestX - dot.x, nearestY - dot.y);
	if (reach - dot.radius < minStandoff || reach === 0) return undefined;
	const ux = (nearestX - dot.x) / reach;
	const uy = (nearestY - dot.y) / reach;
	return {
		x1: dot.x + ux * dot.radius,
		y1: dot.y + uy * dot.radius,
		x2: nearestX,
		y2: nearestY
	};
}

export function mapLabelText(name: string): string {
	return name.length <= 24 ? name : `${name.slice(0, 23)}…`;
}

export function estimateLabelWidth(text: string, fontSize: number): number {
	return text.length * fontSize * 0.56;
}
/** Deterministic packing for the region labels produced by the grouped layout. */
export function placeRegionLabels(
	regions: GroupRegion[],
	room: CanvasBox,
	counts: ReadonlyMap<string, number>,
	priorityKeys: ReadonlySet<string>,
	obstacles: readonly CanvasBox[] = [],
	/** Measured text in map units; without it the character-count estimates apply. */
	measure?: (
		region: Region,
		child: boolean
	) => { width: number; height: number; baseline?: number } | undefined,
	/**
	 * A cost for a heading standing in this box (the ties running through it). When
	 * given, the cheapest clear position wins over the first clear one, and more
	 * positions along the outline are tried.
	 */
	penalty?: (box: CanvasBox) => number
): GroupRegion[] {
	const occupied = [...obstacles];
	const overlaps = (a: CanvasBox, b: CanvasBox) =>
		a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
	const characterWidth = 8.5;
	const defaultLabelHeight = 20;
	const tasks = regions
		.flatMap((region) => [
			{ region, child: false },
			...region.subRegions.map((region) => ({ region, child: true }))
		])
		.sort(
			(a, b) =>
				Number(priorityKeys.has(b.region.key)) - Number(priorityKeys.has(a.region.key)) ||
				Number(a.child) - Number(b.child) ||
				(counts.get(b.region.key) ?? 0) - (counts.get(a.region.key) ?? 0) ||
				a.region.key.localeCompare(b.region.key)
		);

	for (const { region, child } of tasks) {
		const measured = measure?.(region, child);
		const labelHeight = measured?.height ?? defaultLabelHeight;
		const count = String(counts.get(region.key) ?? 0);
		const letterCount = [...region.label].length;
		const estimatedWidth = child ? 6.5 : characterWidth;
		const fullWidth = measured
			? measured.width
			: letterCount * estimatedWidth + (count.length + 1) * estimatedWidth + 8;
		// A measured line spends its width evenly over its characters.
		const charWidth = measured
			? fullWidth / Math.max(1, letterCount + count.length + 1)
			: estimatedWidth;
		const suffixWidth = measured
			? (count.length + 1) * charWidth
			: (count.length + 1) * charWidth + 8;
		const xs = region.hull.map((point) => point.x);
		const ys = region.hull.map((point) => point.y);
		const left = Math.min(...xs);
		const right = Math.max(...xs);
		const top = Math.min(...ys);
		const bottom = Math.max(...ys);
		const preferred = {
			x: region.labelAt.x - fullWidth / 2,
			y: region.labelAt.y - labelHeight + 4
		};
		const above = preferred.y;
		const candidates = [
			preferred,
			{ x: (left + right - fullWidth) / 2, y: bottom + 8 },
			{ x: left - fullWidth - 8, y: (top + bottom - labelHeight) / 2 },
			{ x: right + 8, y: (top + bottom - labelHeight) / 2 },
			...(penalty
				? [
						{ x: left, y: above },
						{ x: right - fullWidth, y: above },
						{ x: preferred.x - (right - left) / 4, y: above },
						{ x: preferred.x + (right - left) / 4, y: above },
						{ x: left, y: bottom + 8 },
						{ x: right - fullWidth, y: bottom + 8 }
					]
				: [])
		];
		const inside = (box: CanvasBox) =>
			box.x >= room.x &&
			box.y >= room.y &&
			box.x + box.width <= room.x + room.width &&
			box.y + box.height <= room.y + room.height;
		const clear = candidates
			.map((point) => ({ ...point, width: fullWidth, height: labelHeight }))
			.filter((box) => inside(box) && occupied.every((other) => !overlaps(box, other)));
		let chosen = clear[0];
		if (penalty && clear.length > 1) {
			let cheapest = penalty(clear[0]);
			for (const box of clear.slice(1)) {
				const cost = penalty(box);
				if (cost < cheapest - 1e-9) {
					cheapest = cost;
					chosen = box;
				}
			}
		}

		if (!chosen) {
			const slots: CanvasBox[] = [];
			const rows = [Math.max(room.y, Math.min(preferred.y, room.y + room.height - labelHeight))];
			for (let y = room.y; y + labelHeight <= room.y + room.height; y += labelHeight + 4)
				rows.push(y);
			for (const y of rows) {
				let intervals = [{ left: room.x, right: room.x + room.width }];
				for (const block of occupied) {
					if (y >= block.y + block.height || y + labelHeight <= block.y) continue;
					intervals = intervals.flatMap((span) =>
						block.x >= span.right || block.x + block.width <= span.left
							? [span]
							: [
									{ left: span.left, right: Math.max(span.left, block.x - 4) },
									{ left: Math.min(span.right, block.x + block.width + 4), right: span.right }
								]
					);
				}
				for (const span of intervals) {
					const width = Math.min(fullWidth, span.right - span.left);
					if (width < suffixWidth + charWidth) continue;
					slots.push({
						x: Math.max(span.left, Math.min(preferred.x, span.right - width)),
						y,
						width,
						height: labelHeight
					});
				}
			}
			slots.sort(
				(a, b) =>
					Number(b.width >= fullWidth) - Number(a.width >= fullWidth) ||
					(b.width < fullWidth ? b.width - a.width : 0) ||
					Math.hypot(a.x - preferred.x, a.y - preferred.y) -
						Math.hypot(b.x - preferred.x, b.y - preferred.y)
			);
			chosen = slots[0];
		}

		if (!chosen) {
			const width = Math.min(room.width, charWidth + 8);
			const labelBoxes = tasks.flatMap(({ region: item }) =>
				item.labelBox ? [item.labelBox] : []
			);
			for (const blocks of [occupied, labelBoxes]) {
				for (
					let y = room.y;
					!chosen && y + labelHeight <= room.y + room.height;
					y += labelHeight + 4
				) {
					for (let x = room.x; x + width <= room.x + room.width; x += width + 4) {
						const box = { x, y, width, height: labelHeight };
						if (blocks.every((other) => !overlaps(box, other))) {
							chosen = box;
							break;
						}
					}
				}
				if (chosen) break;
			}
			chosen ??= { x: room.x, y: room.y, width, height: Math.min(labelHeight, room.height) };
			region.displayCount = false;
		}

		// The epsilon keeps a heading that exactly fits from losing a letter to rounding.
		const capacity = Math.max(1, Math.floor((chosen.width - suffixWidth) / charWidth + 1e-6));
		const letters = [...region.label];
		region.displayLabel =
			region.displayCount === false
				? '…'
				: letters.length > capacity
					? letters.slice(0, capacity - 1).join('') + '…'
					: region.label;
		region.labelAt = measured
			? {
					x: chosen.x,
					y: chosen.y + (measured.baseline ?? labelHeight * 0.78),
					textAnchor: 'start'
				}
			: { x: chosen.x + 4, y: chosen.y + labelHeight - 5, textAnchor: 'start' };
		region.labelBox = chosen;
		occupied.push(chosen);
	}
	return regions;
}
