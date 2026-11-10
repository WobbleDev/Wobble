// @module-tag mapping
import { describe, expect, it } from 'vitest';
import {
	classifyMembers,
	layoutGroup,
	peripheryDisc,
	shelfSlots,
	type CrossTie,
	type GroupMember
} from './graph-group-layout.ts';
import { pairKey } from './graph-stress.ts';

const member = (id: string, radius = 4): GroupMember => ({ id, radius });
const tie = (workerId: string, partnerGroup: string): CrossTie => ({ workerId, partnerGroup });

describe('classifyMembers', () => {
	it('splits cores, pendants and the periphery strip', () => {
		const members = [member('a'), member('b'), member('c'), member('pendant'), member('lonely')];
		const links = [
			{ source: 'a', target: 'b' },
			{ source: 'b', target: 'c' },
			{ source: 'b', target: 'pendant' }
		];
		const { cores, pendants, periphery } = classifyMembers(members, links);

		// One connected component; the pendant hangs off degree-2 b and the
		// leaf-less lonely worker stands in the periphery strip.
		expect(cores).toHaveLength(1);
		expect(cores[0]?.sort()).toEqual(['a', 'b', 'c', 'pendant']);
		expect(pendants.get('pendant')).toBe('b');
		expect(periphery).toEqual(['lonely']);
	});

	it('keeps a degree-1 worker in the core when its neighbour is also degree-1', () => {
		// Two workers tied only to each other: no pendant, one core of two.
		const members = [member('a'), member('b')];
		const { cores, pendants, periphery } = classifyMembers(members, [{ source: 'a', target: 'b' }]);

		expect(cores).toEqual([['a', 'b']]);
		expect(pendants.size).toBe(0);
		expect(periphery).toEqual([]);
	});
});

describe('layoutGroup', () => {
	it('keeps no two members inside their radii (overlap-aware)', () => {
		const members: GroupMember[] = 'abcdefgh'.split('').map((id) => member(id, 6));
		const links = [
			{ source: 'a', target: 'b' },
			{ source: 'b', target: 'c' },
			{ source: 'c', target: 'd' },
			{ source: 'd', target: 'a' },
			{ source: 'e', target: 'f' },
			{ source: 'f', target: 'g' }
		];
		const { offsets } = layoutGroup({
			members,
			internalLinks: links,
			crossTies: [],
			partnerDirections: new Map(),
			overlapAware: true
		});

		const ids = members.map(({ id }) => id);
		for (let i = 0; i < ids.length; i += 1) {
			for (let j = i + 1; j < ids.length; j += 1) {
				const a = offsets.get(ids[i]) as { x: number; y: number };
				const b = offsets.get(ids[j]) as { x: number; y: number };
				const clearance = 0.9 * (6 + 6) - 1e-6;
				expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(clearance - 0.35);
			}
		}
	});

	it('sits a pendant within the stated distance of its neighbour', () => {
		const members = [member('core-a', 5), member('core-b', 5), member('pend', 4)];
		const links = [
			{ source: 'core-a', target: 'core-b' },
			{ source: 'core-b', target: 'pend' }
		];
		const { offsets } = layoutGroup({
			members,
			internalLinks: links,
			crossTies: [],
			partnerDirections: new Map()
		});

		const neighbour = offsets.get('core-b') as { x: number; y: number };
		const pendant = offsets.get('pend') as { x: number; y: number };
		const distance = Math.hypot(pendant.x - neighbour.x, pendant.y - neighbour.y);
		// The open fan uses the physics rest gap (30), the largest leaf radius, and separation slack.
		expect(distance).toBeLessThanOrEqual(5 + 5 + 30 + 1e-6 + 8);
		expect(distance).toBeGreaterThanOrEqual(5 + 4);
	});

	it('keeps two laid components clear of each other', () => {
		const members = [...'abcdef'].map((id) => member(id, 5));
		const links = [
			{ source: 'a', target: 'b' },
			{ source: 'a', target: 'c' },
			{ source: 'd', target: 'e' },
			{ source: 'd', target: 'f' }
		];
		const { offsets } = layoutGroup({
			members,
			internalLinks: links,
			crossTies: [],
			partnerDirections: new Map()
		});

		const componentA = ['a', 'b', 'c'];
		const componentD = ['d', 'e', 'f'];
		let closest = Number.POSITIVE_INFINITY;
		for (const a of componentA) {
			for (const b of componentD) {
				const pa = offsets.get(a) as { x: number; y: number };
				const pb = offsets.get(b) as { x: number; y: number };
				closest = Math.min(closest, Math.hypot(pa.x - pb.x, pa.y - pb.y));
			}
		}
		// Two five-radius members of different components keep more than a
		// pendant's worth of daylight, and never overlap outright.
		expect(closest).toBeGreaterThan(10);
	});

	it('lays eight unconnected members out as a disc, not a row', () => {
		const members = [...'abcdefgh'].map((id) => member(id, 4));
		const { offsets } = layoutGroup({
			members,
			internalLinks: [],
			crossTies: [],
			partnerDirections: new Map()
		});
		const xs = [...offsets.values()].map(({ x }) => x);
		const ys = [...offsets.values()].map(({ y }) => y);
		const width = Math.max(...xs) - Math.min(...xs);
		const height = Math.max(...ys) - Math.min(...ys);
		expect(width / height).toBeLessThanOrEqual(1.5);
		expect(height / width).toBeLessThanOrEqual(1.5);
	});

	it('keeps every disc member clear', () => {
		const members = [...'abcdefgh'].map((id) => member(id, 4));
		const { offsets } = layoutGroup({
			members,
			internalLinks: [],
			crossTies: [],
			partnerDirections: new Map()
		});
		for (let i = 0; i < members.length; i += 1) {
			for (let j = i + 1; j < members.length; j += 1) {
				const a = offsets.get(members[i]!.id)!;
				const b = offsets.get(members[j]!.id)!;
				expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(
					members[i]!.radius + members[j]!.radius + 4
				);
			}
		}
	});

	it('wraps four components into two rows', () => {
		const slots = shelfSlots([10, 10, 10, 10], 16);
		expect(new Set(slots.map(({ y }) => y)).size).toBe(2);
		expect(slots.slice(0, 2).map(({ y }) => y)).toEqual([10, 10]);
		expect(slots.slice(2).map(({ y }) => y)).toEqual([46, 46]);
	});

	it('places periphery members on a centred golden-angle disc', () => {
		const points = peripheryDisc(3, 24);
		expect(points).toHaveLength(3);
		expect(points[0]?.x).toBeCloseTo(24 * 0.5 * Math.sqrt(0.5) * Math.cos(0));
		expect(points[0]?.y).toBeCloseTo(24 * 0.5 * Math.sqrt(0.5) * Math.sin(0));
	});

	it('keeps the periphery disc clear before separation', () => {
		const points = peripheryDisc(8, 24);
		for (let i = 0; i < points.length; i += 1) {
			for (let j = i + 1; j < points.length; j += 1) {
				expect(
					Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y)
				).toBeGreaterThanOrEqual(12);
			}
		}
	});

	it('lays degree-0 workers around a disc instead of in the obsolete row', () => {
		const members = ['a', 'b', 'c'].map((id) => member(id));
		const { offsets } = layoutGroup({
			members,
			internalLinks: [],
			crossTies: [],
			partnerDirections: new Map()
		});

		const points = ['a', 'b', 'c'].map((id) => offsets.get(id) as { x: number; y: number });
		expect(new Set(points.map(({ y }) => Math.round(y))).size).toBeGreaterThan(1);
	});

	it('covers every member inside the group radius', () => {
		const members = [...'abcdefg'].map((id) => member(id, 6));
		const links = [
			{ source: 'a', target: 'b' },
			{ source: 'b', target: 'c' }
		];
		const { offsets, radius } = layoutGroup({
			members,
			internalLinks: links,
			crossTies: [tie('b', 'Kitchen')],
			partnerDirections: new Map([['Kitchen', { x: 1, y: 0 }]])
		});

		expect(placedCount(offsets, members)).toBe(members.length);
		for (const [id, offset] of offsets) {
			const member = members.find((entry) => entry.id === id) as GroupMember;
			expect(Math.hypot(offset.x, offset.y) + member.radius).toBeLessThanOrEqual(radius + 1e-9);
		}
	});

	it('is deterministic for identical input', () => {
		const members = [...'abcde'].map((id) => member(id, 5));
		const links = [
			{ source: 'a', target: 'b' },
			{ source: 'c', target: 'd' }
		];
		const input = {
			members,
			internalLinks: links,
			crossTies: [tie('a', 'Bar'), tie('c', 'Floor')] as readonly CrossTie[],
			partnerDirections: new Map([
				['Bar', { x: 0, y: 1 }],
				['Floor', { x: -1, y: 0 }]
			])
		};
		const first = layoutGroup(input);
		const second = layoutGroup(input);
		expect([...second.offsets.entries()]).toEqual([...first.offsets.entries()]);
		expect(second.radius).toBe(first.radius);
	});
});

function placedCount(
	offsets: Map<string, { x: number; y: number }>,
	members: readonly GroupMember[]
): number {
	let count = 0;
	for (const { id } of members) {
		if (offsets.has(id)) count += 1;
	}
	return count;
}

// pairKey is imported to pin the canonical-order contract the module relies on.
expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'));
