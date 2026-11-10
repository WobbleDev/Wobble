/**
 * Per-group local layout: a group's workers — component cores, pendants and a
 * periphery strip — are laid out by graph-distance stress, then packed into one
 * circle-bounded group body the physics can move and rotate.
 *
 * Pure, deterministic and cacheable: everything here is a function of the
 * group's members, their ties and the partner directions.
 */
import { fanLeaves } from './graph-leaf-placement.ts';
import {
	pairKey,
	separatePositions,
	stressEdgeLength,
	stressLayout,
	type StressLink,
	type StressPoint
} from './graph-stress.ts';

/** Gap between two packed components. */
const packingGap = 16;
/** Spacing between adjacent degree-0 workers in the periphery strip. */
const peripherySpacing = 24;
/** A port stands this far beyond the component's own stress reach. */
const portStandoff = 20;
/** A component's packing slot is padded beyond its own reach by this much. */
const componentPadding = 8;
/** The group radius keeps this rim beyond its own reach. */
const groupRadiusPad = 14;
/** The separation pass a packed group runs when not overlap-aware. */
const groupSeparationPad = 8;
const groupSeparationIterations = 60;
/** The separation pass an overlap-aware group runs (tighter, quicker). */
const overlapSeparationPad = 1;
const overlapSeparationIterations = 10;
/** The step a bridging member is drawn toward its partner direction, relative to the port reach. */
const portPull = 0.12;
const goldenAngle = 2.39996;

export type GroupMember = { id: string; radius: number };
export type CrossTie = { workerId: string; partnerGroup: string };

/** Arrange isolated workers in a centred golden-angle disc. */
export function peripheryDisc(count: number, spacing: number): StressPoint[] {
	return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => {
		const radius = spacing * 0.5 * Math.sqrt(i + 0.5);
		const angle = i * goldenAngle;
		return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
	});
}

/** Place component centres into centred rows, accounting for each component's reach. */
export function shelfSlots(reaches: readonly number[], gap: number): StressPoint[] {
	if (reaches.length === 0) return [];
	const columns = Math.ceil(Math.sqrt(reaches.length));
	const slots: StressPoint[] = [];
	let rowTop = 0;
	for (let start = 0; start < reaches.length; start += columns) {
		const row = reaches.slice(start, start + columns);
		const rowWidth = row.reduce((sum, reach) => sum + 2 * reach, 0) + gap * (row.length - 1);
		let x = -rowWidth / 2;
		const rowReach = Math.max(...row);
		for (const reach of row) {
			slots.push({ x: x + reach, y: rowTop + rowReach });
			x += 2 * reach + gap;
		}
		rowTop += rowReach * 2 + gap;
	}
	return slots;
}

export type GroupLayoutInput = {
	/** This group's workers, with the radius each draws at. */
	members: readonly GroupMember[];
	/** Ties between members (the tie is symmetric; either end may be the source). */
	internalLinks: readonly { source: string; target: string }[];
	/** This group's workers' ties into other groups. */
	crossTies: readonly CrossTie[];
	/** The unit direction each partner group's anchor sits in, from the group centre. */
	partnerDirections: ReadonlyMap<string, StressPoint>;
	/** Give the stress solver radii clearance (see stressLayout). */
	overlapAware?: boolean;
	leafIds?: ReadonlySet<string>;
};

export type GroupLayoutResult = {
	/** Offsets from the group's own centre for every real member. */
	offsets: Map<string, StressPoint>;
	/** The body's radius: the furthest reach of any offset plus its radius, plus a rim. */
	radius: number;
};

/** Split a group's members into core components, pendants and the periphery strip. */
export function classifyMembers(
	members: readonly GroupMember[],
	internalLinks: readonly { source: string; target: string }[]
): { cores: string[][]; pendants: Map<string, string>; periphery: string[] } {
	const memberIds = members.map(({ id }) => id);
	const idSet = new Set(memberIds);
	const degree = new Map<string, number>(memberIds.map((id) => [id, 0]));

	const adjacency = new Map<string, string[]>();
	for (const { source, target } of internalLinks) {
		if (!idSet.has(source) || !idSet.has(target) || source === target) continue;
		degree.set(source, (degree.get(source) ?? 0) + 1);
		degree.set(target, (degree.get(target) ?? 0) + 1);
		if (!adjacency.has(source)) adjacency.set(source, []);
		if (!adjacency.has(target)) adjacency.set(target, []);
		adjacency.get(source)!.push(target);
		adjacency.get(target)!.push(source);
	}

	// Components of the in-group graph, grown from the first-seen member id.
	const components: string[][] = [];
	const seen = new Set<string>();
	for (const id of memberIds) {
		if (seen.has(id) || (degree.get(id) ?? 0) === 0) continue;
		const component: string[] = [];
		const queue = [id];
		seen.add(id);
		while (queue.length > 0) {
			const current = queue.pop() as string;
			component.push(current);
			for (const next of adjacency.get(current) ?? []) {
				if (seen.has(next)) continue;
				seen.add(next);
				queue.push(next);
			}
		}
		components.push(component);
	}

	// Pendants are decided at group level: a member of degree 1 whose
	// neighbour holds degree 2 or more inside the group is a pendant.
	const pendants = new Map<string, string>();
	for (const member of members) {
		if ((degree.get(member.id) ?? 0) !== 1) continue;
		const neighbour = (adjacency.get(member.id) ?? [])[0];
		if (neighbour !== undefined && (degree.get(neighbour) ?? 0) >= 2) {
			pendants.set(member.id, neighbour);
		}
	}

	// The components themselves are the core components; pendants come off
	// them at placement. A chain a–b–c reads as one hub (c) with both leaves
	// fanned off it — the brief's own rule.
	const cores = components;

	// Tree components sort by an approximate depth-first size: leaves first,
	// or by first member id where the component is a plain chain.
	cores.sort((a, b) => b.length - a.length || (a[0] ?? '').localeCompare(b[0] ?? ''));

	// What is left after cores and pendants is the periphery strip.
	const cored = new Set(cores.flat());
	const periphery = memberIds.filter((id) => !cored.has(id) && !pendants.has(id));

	return { cores, pendants, periphery };
}

/**
 * Lay one core component out: stress over its members, then each member that
 * bridges a partner group is pulled a step along that partner's direction, so
 * the bridge worker's tie reads outward from the core.
 */
function layoutCore(
	component: readonly string[],
	memberRadiusById: ReadonlyMap<string, number>,
	internalLinks: readonly StressLink[],
	crossTies: readonly CrossTie[],
	partnerDirections: ReadonlyMap<string, StressPoint>,
	overlapAware: boolean
): { offsets: Map<string, StressPoint>; reach: number } {
	const componentSet = new Set(component);
	const outTies = crossTies.filter(({ workerId }) => componentSet.has(workerId));

	const relaxed = stressLayout(
		component.map((id) => ({ id })),
		internalLinks,
		{ overlapAware, radiusFor: (id) => memberRadiusById.get(id) ?? 0 }
	);

	const portReach =
		stressEdgeLength * Math.sqrt(Math.max(1, component.length)) * 0.9 + portStandoff;
	const pulled = new Map(relaxed);
	for (const { workerId, partnerGroup } of outTies) {
		const offset = pulled.get(workerId);
		if (!offset) continue;
		const direction = partnerDirections.get(partnerGroup);
		if (!direction) continue;
		pulled.set(workerId, {
			x: offset.x + direction.x * portReach * portPull,
			y: offset.y + direction.y * portReach * portPull
		});
	}

	let reach = 0;
	for (const [id, offset] of pulled) {
		reach = Math.max(reach, Math.hypot(offset.x, offset.y) + (memberRadiusById.get(id) ?? 0));
	}
	return { offsets: pulled, reach };
}

export function layoutGroup(input: GroupLayoutInput): GroupLayoutResult {
	const { members, crossTies, partnerDirections } = input;
	const overlapAware = input.overlapAware ?? false;

	const memberRadiusById = new Map(members.map(({ id, radius }) => [id, radius]));
	const idSet = new Set(members.map(({ id }) => id));

	// The group's own ties, deduplicated and oriented source < target.
	const uniqueLinks = new Map<string, StressLink>();
	for (const { source, target } of input.internalLinks) {
		if (!idSet.has(source) || !idSet.has(target) || source === target) continue;
		const key = pairKey(source, target);
		if (!uniqueLinks.has(key)) {
			uniqueLinks.set(
				key,
				source < target ? { source, target } : { source: target, target: source }
			);
		}
	}

	const { cores, periphery } = classifyMembers(members, [...uniqueLinks.values()]);

	// Lay every core, smallest reach packed last; one shelf row at a time.
	const coreLayouts = cores.map((core) => {
		const coreLinks = [...uniqueLinks.values()].filter(
			({ source, target }) => core.includes(source) && core.includes(target)
		);
		const { offsets, reach } = layoutCore(
			core,
			memberRadiusById,
			coreLinks,
			crossTies,
			partnerDirections,
			overlapAware
		);
		return { core, offsets, reach };
	});

	// Shelf placement wraps components into centred rows.
	const padded = coreLayouts.map(({ reach }) => reach + componentPadding);
	const slots = shelfSlots(padded, packingGap);
	const placed = new Map<string, StressPoint>();
	for (const [index, component] of coreLayouts.entries()) {
		const slot = slots[index] ?? { x: 0, y: 0 };
		for (const [id, offset] of component.offsets) {
			placed.set(id, { x: offset.x + slot.x, y: offset.y + slot.y });
		}
	}

	// Degree-0 workers fill the open space around the component shelf.
	const disc = peripheryDisc(periphery.length, peripherySpacing);
	for (const [index, id] of periphery.entries()) {
		if (placed.has(id)) continue;
		placed.set(id, disc[index] ?? { x: 0, y: 0 });
	}

	const fanned = fanLeaves(
		placed,
		input.internalLinks,
		(id) => memberRadiusById.get(id) ?? 0,
		input.leafIds
	);

	// The separation pass, chosen by mode: overlap-aware is tight and quick,
	// the plain mode runs the full padded settle.
	const separated = overlapAware
		? separatePositions(
				fanned,
				(id) => memberRadiusById.get(id) ?? 0,
				overlapSeparationPad,
				overlapSeparationIterations
			)
		: separatePositions(
				fanned,
				(id) => memberRadiusById.get(id) ?? 0,
				groupSeparationPad,
				groupSeparationIterations
			);

	// Recentre on the placed members' centroid.
	let cx = 0;
	let cy = 0;
	for (const offset of separated.values()) {
		cx += offset.x;
		cy += offset.y;
	}
	if (separated.size > 0) {
		cx /= separated.size;
		cy /= separated.size;
	}
	const centred = new Map<string, StressPoint>();
	for (const [id, offset] of separated) {
		centred.set(id, { x: offset.x - cx, y: offset.y - cy });
	}

	// The group's radius: the furthest reach plus the rim.
	let radius = 0;
	for (const [id, offset] of centred) {
		radius = Math.max(radius, Math.hypot(offset.x, offset.y) + (memberRadiusById.get(id) ?? 0));
	}
	radius += groupRadiusPad;

	return { offsets: centred, radius };
}
