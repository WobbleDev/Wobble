/** Nested rigid bodies placed by actual sibling Relationships. */
import { layoutGroup, type CrossTie, type GroupMember } from './graph-group-layout.ts';
import { groupRegionPadding, regionPadding, type Point } from './graph-layout.ts';
import { placeQuotientBodies } from './graph-quotient-layout.ts';
import { orientBodies } from './graph-body-orientation.ts';
import { compareText, keyAsLabel, type LabelOf } from './graph-analysis.ts';

/** Both outlines and room for a label between neighbouring sub-bodies. */
const subBodyGap = 2 * regionPadding + 66;
/** Parent outline clearance included in its rigid body's radius. */
export const groupOuterPadding = regionPadding + groupRegionPadding;

/**
 * Every sub-body uses the same quotient anchors for placement and orientation.
 * Its local centroid is the rigid pivot, so later sibling/parent-external
 * orientation preserves the reserved circular footprint and parent containment.
 */
export function layoutSubGroups(input: {
	members: readonly GroupMember[];
	internalLinks: readonly { source: string; target: string }[];
	subOf: ReadonlyMap<string, string>;
	leafIds?: ReadonlySet<string>;
	/** The text each sub-group id stands for, which orders the sub-groups. */
	labelOf?: LabelOf;
}): { offsets: Map<string, Point>; radius: number } {
	const { members, internalLinks, subOf } = input;
	const labelOf = input.labelOf ?? keyAsLabel;
	if (members.length === 0) return { offsets: new Map(), radius: groupOuterPadding };
	const sub = (id: string) => subOf.get(id) ?? '';
	const radii = new Map(members.map((m) => [m.id, m.radius]));
	const values = [...new Set(members.map((m) => sub(m.id)))].sort((a, b) =>
		compareText(labelOf(a), labelOf(b))
	);
	const crossBySub = new Map<string, CrossTie[]>();
	const quotientTies: { source: string; target: string; strength: number }[] = [];
	for (const { source, target } of internalLinks) {
		const a = sub(source),
			b = sub(target);
		if (a === b) continue;
		quotientTies.push({ source: a, target: b, strength: 1 });
		for (const [key, workerId, partnerGroup] of [
			[a, source, b],
			[b, target, a]
		]) {
			const list = crossBySub.get(key) ?? [];
			list.push({ workerId, partnerGroup });
			crossBySub.set(key, list);
		}
	}
	const bodies = values.map((key) => {
		const subMembers = members.filter((m) => sub(m.id) === key);
		const ids = new Set(subMembers.map((m) => m.id));
		const laid = layoutGroup({
			members: subMembers,
			leafIds: input.leafIds,
			internalLinks: internalLinks.filter((l) => ids.has(l.source) && ids.has(l.target)),
			crossTies: crossBySub.get(key) ?? [],
			// No provisional circle directions: orient only after quotient placement.
			partnerDirections: new Map(),
			overlapAware: true
		});
		const cx = [...laid.offsets.values()].reduce((sum, p) => sum + p.x, 0) / subMembers.length;
		const cy = [...laid.offsets.values()].reduce((sum, p) => sum + p.y, 0) / subMembers.length;
		return {
			key,
			// Recentring retains the original circle conservatively, including rim.
			radius: laid.radius + Math.hypot(cx, cy),
			offsets: new Map([...laid.offsets].map(([id, p]) => [id, { x: p.x - cx, y: p.y - cy }]))
		};
	});
	const anchors = placeQuotientBodies(bodies, quotientTies, subBodyGap, subBodyGap, labelOf);
	// Quotient targets reserve each body's radius and the full outline/label gap.
	// A bounded collision-only projection corrects any residual stress overlap.
	for (let pass = 0; pass < 40; pass += 1) {
		for (let i = 0; i < bodies.length; i += 1)
			for (let j = i + 1; j < bodies.length; j += 1) {
				const a = anchors.get(bodies[i].key)!,
					b = anchors.get(bodies[j].key)!;
				const dx = b.x - a.x,
					dy = b.y - a.y;
				const distance = Math.hypot(dx, dy);
				const minimum = bodies[i].radius + bodies[j].radius + subBodyGap;
				if (distance >= minimum) continue;
				const ux = distance ? dx / distance : 1,
					uy = distance ? dy / distance : 0;
				const push = (minimum - distance) / 2;
				a.x -= ux * push;
				a.y -= uy * push;
				b.x += ux * push;
				b.y += uy * push;
			}
	}
	const cx = [...anchors.values()].reduce((sum, p) => sum + p.x, 0) / anchors.size;
	const cy = [...anchors.values()].reduce((sum, p) => sum + p.y, 0) / anchors.size;
	const offsets = new Map<string, Point>();
	let radius = 0;
	for (const body of bodies) {
		const anchor = anchors.get(body.key)!;
		anchor.x -= cx;
		anchor.y -= cy;
		radius = Math.max(radius, Math.hypot(anchor.x, anchor.y) + body.radius);
		for (const [id, p] of body.offsets) offsets.set(id, { x: anchor.x + p.x, y: anchor.y + p.y });
	}
	return {
		offsets: orientBodies(
			offsets,
			new Map(members.map((m) => [m.id, sub(m.id)])),
			internalLinks,
			(id) => radii.get(id) ?? 0,
			anchors,
			labelOf
		),
		radius: radius + groupOuterPadding
	};
}
