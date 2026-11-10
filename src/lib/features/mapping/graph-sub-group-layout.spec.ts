// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { layoutSubGroups, groupOuterPadding } from './graph-sub-group-layout.ts';
import { nodeRadius } from './map-style.ts';

function members(count: number, prefix: string) {
	return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, radius: nodeRadius(1) }));
}

function setup(withTies: boolean) {
	const all = [...members(6, 'a'), ...members(6, 'b'), ...members(6, 'c'), ...members(6, 'd')];
	const subOf = new Map(all.map((m) => [m.id, m.id[0]]));
	const links: { source: string; target: string }[] = [];
	for (const p of ['a', 'b', 'c', 'd']) {
		for (let i = 0; i < 5; i += 1) links.push({ source: `${p}${i}`, target: `${p}${i + 1}` });
	}
	// a and b share many ties; c and d share none.
	if (withTies) for (let i = 0; i < 5; i += 1) links.push({ source: `a${i}`, target: `b${i}` });
	return { members: all, internalLinks: links, subOf };
}

function centre(offsets: Map<string, { x: number; y: number }>, prefix: string) {
	const pts = [...offsets].filter(([id]) => id.startsWith(prefix)).map(([, p]) => p);
	return {
		x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
		y: pts.reduce((s, p) => s + p.y, 0) / pts.length
	};
}

describe('layoutSubGroups', () => {
	it('places every member, deterministically', () => {
		const input = setup(true);
		const first = layoutSubGroups(input);
		const second = layoutSubGroups(input);
		expect(first.offsets.size).toBe(24);
		expect([...first.offsets]).toEqual([...second.offsets]);
		expect(first.radius).toBe(second.radius);
	});

	it('keeps sub-groups apart: every pair of members from two sub-groups clears the dot sizes', () => {
		const { offsets } = layoutSubGroups(setup(true));
		const ids = [...offsets.keys()];
		for (const a of ids) {
			for (const b of ids) {
				if (a >= b || a[0] === b[0]) continue;
				const pa = offsets.get(a)!;
				const pb = offsets.get(b)!;
				expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeGreaterThan(2 * nodeRadius(1));
			}
		}
	});

	it('puts sub-groups sharing ties nearer each other than a pair with none', () => {
		const { offsets } = layoutSubGroups(setup(true));
		const dist = (x: string, y: string) => {
			const a = centre(offsets, x);
			const b = centre(offsets, y);
			return Math.hypot(a.x - b.x, a.y - b.y);
		};
		const others = [dist('a', 'c'), dist('a', 'd'), dist('b', 'c'), dist('b', 'd')];
		const mean = others.reduce((sum, d) => sum + d, 0) / others.length;
		expect(dist('a', 'b')).toBeLessThan(mean);
	});

	it('includes the outline padding in the body radius, and contains every member', () => {
		const { offsets, radius } = layoutSubGroups(setup(false));
		for (const p of offsets.values()) {
			expect(Math.hypot(p.x, p.y) + groupOuterPadding).toBeLessThanOrEqual(radius + 1e-6);
		}
	});

	it('lays a single sub-group out on its own', () => {
		const m = members(4, 'a');
		const { offsets } = layoutSubGroups({
			members: m,
			internalLinks: [],
			subOf: new Map(m.map((x) => [x.id, 'only']))
		});
		expect(offsets.size).toBe(4);
	});
});
