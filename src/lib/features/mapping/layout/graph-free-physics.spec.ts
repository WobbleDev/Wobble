// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { freePhysicsLayout, freePhysicsMaxTicks } from './graph-free-physics.ts';
import { nodeRadius } from '../map-style.ts';
import type { StressLink, StressNode } from './graph-stress.ts';

const canvas = { width: 900, height: 600 };

/** Two tight clusters of `size` workers each, joined by one bridge. */
function clusters(size: number) {
	const nodes: StressNode[] = [];
	const links: StressLink[] = [];
	for (const c of ['a', 'b']) {
		for (let i = 0; i < size; i += 1) nodes.push({ id: `${c}${i}` });
		for (let i = 0; i < size; i += 1) {
			for (let j = i + 1; j < size; j += 1) links.push({ source: `${c}${i}`, target: `${c}${j}` });
		}
	}
	links.push({ source: 'a0', target: 'b0' });
	return { nodes, links };
}

function degrees(nodes: StressNode[], links: StressLink[]) {
	const d = new Map(nodes.map((n) => [n.id, 0]));
	for (const l of links) {
		d.set(l.source, (d.get(l.source) ?? 0) + 1);
		d.set(l.target, (d.get(l.target) ?? 0) + 1);
	}
	return d;
}

describe('freePhysicsLayout', () => {
	it('gives identical positions for identical input', () => {
		const { nodes, links } = clusters(6);
		const a = freePhysicsLayout(nodes, links, canvas);
		const b = freePhysicsLayout(nodes, links, canvas);
		expect([...b]).toEqual([...a]);
	});

	it('places connected pairs nearer on average than unconnected pairs', () => {
		const { nodes, links } = clusters(6);
		const pos = freePhysicsLayout(nodes, links, canvas);
		const linked = new Set(links.map((l) => `${l.source}|${l.target}`));
		let near = 0;
		let nearN = 0;
		let far = 0;
		let farN = 0;
		for (let i = 0; i < nodes.length; i += 1) {
			for (let j = i + 1; j < nodes.length; j += 1) {
				const p = pos.get(nodes[i].id)!;
				const q = pos.get(nodes[j].id)!;
				const d = Math.hypot(p.x - q.x, p.y - q.y);
				if (linked.has(`${nodes[i].id}|${nodes[j].id}`)) {
					near += d;
					nearN += 1;
				} else {
					far += d;
					farN += 1;
				}
			}
		}
		expect(near / nearN).toBeLessThan(far / farN);
	});

	it('keeps dots apart, finite and inside the canvas', () => {
		const { nodes, links } = clusters(8);
		const pos = freePhysicsLayout(nodes, links, canvas);
		const deg = degrees(nodes, links);
		const r = (id: string) => nodeRadius(deg.get(id) ?? 0);
		for (const n of nodes) {
			const p = pos.get(n.id)!;
			expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
			expect(p.x - r(n.id)).toBeGreaterThanOrEqual(-0.5);
			expect(p.y - r(n.id)).toBeGreaterThanOrEqual(-0.5);
			expect(p.x + r(n.id)).toBeLessThanOrEqual(canvas.width + 0.5);
			expect(p.y + r(n.id)).toBeLessThanOrEqual(canvas.height + 0.5);
		}
		for (let i = 0; i < nodes.length; i += 1) {
			for (let j = i + 1; j < nodes.length; j += 1) {
				const p = pos.get(nodes[i].id)!;
				const q = pos.get(nodes[j].id)!;
				const d = Math.hypot(p.x - q.x, p.y - q.y);
				expect(d).toBeGreaterThanOrEqual(r(nodes[i].id) + r(nodes[j].id) - 0.5);
			}
		}
	});

	it('handles one worker, no relationships and nothing', () => {
		const one = freePhysicsLayout([{ id: 'x' }], [], canvas).get('x')!;
		expect(Number.isFinite(one.x) && Number.isFinite(one.y)).toBe(true);
		const isolated = freePhysicsLayout([{ id: 'p' }, { id: 'q' }, { id: 'r' }], [], canvas);
		expect(isolated.size).toBe(3);
		for (const p of isolated.values())
			expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
		expect(freePhysicsLayout([], [], canvas).size).toBe(0);
	});

	it('keeps a pinned worker at its point while others move', () => {
		const { nodes, links } = clusters(5);
		const free = freePhysicsLayout(nodes, links, canvas);
		const pinnedPoint = { x: 120, y: 90 };
		const start = new Map([['a1', { x: 400, y: 300 }]]);
		const pinned = freePhysicsLayout(nodes, links, canvas, {
			start,
			pinned: new Map([['a1', pinnedPoint]])
		});
		expect(pinned.get('a1')).toEqual(pinnedPoint);
		const other = pinned.get('b3')!;
		const before = free.get('b3')!;
		expect(Math.hypot(other.x - before.x, other.y - before.y)).toBeGreaterThan(0);
	});

	it('terminates on a large worksite within the tick cap', () => {
		const nodes = Array.from({ length: 400 }, (_, i) => ({ id: `w${i}` }));
		const links = nodes.slice(1).map((n, i) => ({ source: n.id, target: `w${(i * 7) % (i + 1)}` }));
		let ticks = 0;
		const pos = freePhysicsLayout(
			nodes,
			links,
			{ width: 2400, height: 1600 },
			{
				onTick: () => (ticks += 1)
			}
		);
		expect(pos.size).toBe(400);
		expect(ticks).toBeLessThanOrEqual(freePhysicsMaxTicks);
	});
});

describe('freePhysicsLayout re-heating', () => {
	const chain: StressNode[] = ['p', 'q', 'r', 'v'].map((id) => ({ id }));
	const chainLinks: StressLink[] = [
		{ source: 'p', target: 'q' },
		{ source: 'q', target: 'r' },
		{ source: 'r', target: 'v' }
	];
	const resting = new Map([
		['p', { x: 200, y: 300 }],
		['q', { x: 260, y: 300 }],
		['r', { x: 320, y: 300 }],
		['v', { x: 380, y: 300 }]
	]);
	const pinned = new Map([['p', { x: 120, y: 150 }]]);

	it('holds a pinned worker at its point while the others move', () => {
		const moved = freePhysicsLayout(chain, chainLinks, canvas, {
			start: resting,
			pinned,
			alpha: 0.5
		});
		expect(moved.get('p')).toEqual({ x: 120, y: 150 });
		const someoneMoved = ['q', 'r', 'v'].some((id) => {
			const before = resting.get(id)!;
			const after = moved.get(id)!;
			return Math.hypot(after.x - before.x, after.y - before.y) > 1;
		});
		expect(someoneMoved).toBe(true);
	});

	it('starts un-dragged workers from their resting points, not the seed', () => {
		const held = freePhysicsLayout(chain, chainLinks, canvas, { start: resting, pinned, alpha: 0 });
		for (const id of ['q', 'r', 'v']) expect(held.get(id)).toEqual(resting.get(id));
	});

	it('moves a neighbour in a short drag run, and not at all in a zero-tick run', () => {
		const zero = freePhysicsLayout(chain, chainLinks, canvas, {
			start: resting,
			pinned,
			alpha: 0.5,
			maxTicks: 0
		});
		expect(zero.get('q')).toEqual(resting.get('q'));
		const short = freePhysicsLayout(chain, chainLinks, canvas, {
			start: resting,
			pinned,
			alpha: 0.5,
			maxTicks: 8
		});
		expect(short.get('p')).toEqual({ x: 120, y: 150 });
		expect(short.get('q')).not.toEqual(resting.get('q'));
	});

	it('settles further on release than a short drag run', () => {
		const short = freePhysicsLayout(chain, chainLinks, canvas, {
			start: resting,
			pinned,
			alpha: 0.5,
			maxTicks: 8
		});
		const full = freePhysicsLayout(chain, chainLinks, canvas, { start: short, alpha: 0.5 });
		const moved = [...full].some(([id, p]) => {
			const q = short.get(id)!;
			return Math.hypot(p.x - q.x, p.y - q.y) > 0.5;
		});
		expect(moved).toBe(true);
	});
});
