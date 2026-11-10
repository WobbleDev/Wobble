// @module-tag mapping
import { arrange } from './graph-arrangement.ts';
import { describe, expect, it } from 'vitest';
import {
	fitAndSeparate,
	graphDistances,
	pairKey,
	separatePositions,
	stressEdgeLength,
	stressLayout,
	stressPairVisits,
	stressSeedJitter,
	stressSweepBudget,
	stressSweepCeiling,
	stressSweepFloor,
	stressSweeps,
	type StressLink,
	type StressNode
} from './graph-stress.ts';
import { answerIdsFixture, attributeFixture } from './answer-fixtures.ts';

const N = (id: string): StressNode => ({ id });
const L = (source: string, target: string): StressLink => ({ source, target });

/**
 * The dense all-pairs reference the solver used to ship (Floyd–Warshall over a
 * matrix), kept only to prove the sparse walk agrees with it. It is deliberately
 * built differently from the module: no shared helper, no shared constants.
 */
function referenceDistances(
	nodes: readonly StressNode[],
	links: readonly StressLink[],
	hubSpacing: boolean
): number[][] {
	const n = nodes.length;
	const ids = nodes.map(({ id }) => id);
	const indexOf = new Map(ids.map((id, index) => [id, index]));
	const degree = new Map(ids.map((id) => [id, 0]));
	for (const { source, target } of links) {
		degree.set(source, (degree.get(source) ?? 0) + 1);
		degree.set(target, (degree.get(target) ?? 0) + 1);
	}

	const matrix = Array.from({ length: n }, (_, i) =>
		Array.from({ length: n }, (_, j) => (i === j ? 0 : Number.POSITIVE_INFINITY))
	);
	for (const { source, target } of links) {
		const i = indexOf.get(source);
		const j = indexOf.get(target);
		if (i === undefined || j === undefined || i === j) continue;
		const weight = hubSpacing
			? 1 + 0.12 * Math.max(0, (degree.get(source) ?? 0) + (degree.get(target) ?? 0) - 4)
			: 1;
		if (weight < matrix[i][j]) {
			matrix[i][j] = weight;
			matrix[j][i] = weight;
		}
	}

	for (let k = 0; k < n; k += 1) {
		for (let i = 0; i < n; i += 1) {
			for (let j = 0; j < n; j += 1) {
				const candidate = matrix[i][k] + matrix[k][j];
				if (candidate < matrix[i][j]) matrix[i][j] = candidate;
			}
		}
	}

	let maxFinite = 0;
	for (let i = 0; i < n; i += 1) {
		for (let j = 0; j < n; j += 1) {
			if (i !== j && Number.isFinite(matrix[i][j]) && matrix[i][j] > maxFinite) {
				maxFinite = matrix[i][j];
			}
		}
	}

	return matrix.map((row, i) =>
		row.map((d, j) => (i !== j && !Number.isFinite(d) ? maxFinite + 1 : d))
	);
}

describe('graphDistances', () => {
	it('reads a path as hops of one', () => {
		const d = graphDistances([N('a'), N('b'), N('c')], [L('a', 'b'), L('b', 'c')]);
		expect(d.get(pairKey('a', 'c'))).toBe(2);
	});

	it('gives unreachable pairs maxFinite + 1', () => {
		const d = graphDistances([N('a'), N('b'), N('z')], [L('a', 'b')]);
		// Longest real distance is 1, so the isolate pair sits at 2.
		expect(d.get(pairKey('a', 'z'))).toBe(2);
	});

	it('weights a hub pair wider when hub spacing is on', () => {
		const nodes = [N('hub'), N('a'), N('b'), N('c'), N('other')];
		const links = [L('hub', 'a'), L('hub', 'b'), L('hub', 'c'), L('other', 'a')];
		const d = graphDistances(nodes, links, { hubSpacing: true });
		// hub (deg 3) to a (deg 2): 1 + 0.12·max(0, 3+2−4) = 1.12
		expect(d.get(pairKey('hub', 'a'))).toBeCloseTo(1.12, 10);
	});

	/*
	 * The solver walks the adjacency instead of filling a dense matrix. These
	 * cases hold the sparse walk to the dense answer it replaced, including the
	 * cases where the two could plausibly diverge: a fractional edge weight that
	 * makes a longer hop path cheaper, a duplicate edge, a self-loop, a link that
	 * names a Worker outside the set, and a disconnected component.
	 */
	it('agrees with the dense all-pairs reference, weighted and unweighted', () => {
		const cases: { name: string; nodes: StressNode[]; links: StressLink[] }[] = [
			{
				name: 'a disconnected component and an isolate',
				nodes: [N('a'), N('b'), N('c'), N('x'), N('y')],
				links: [L('a', 'b'), L('b', 'c'), L('x', 'y')]
			},
			{
				name: 'a hub, so hub spacing makes weights fractional',
				nodes: [N('hub'), N('a'), N('b'), N('c'), N('d'), N('tail')],
				links: [
					L('hub', 'a'),
					L('hub', 'b'),
					L('hub', 'c'),
					L('hub', 'd'),
					L('a', 'tail'),
					L('hub', 'tail')
				]
			},
			{
				name: 'a duplicate edge and a self-loop',
				nodes: [N('a'), N('b'), N('c')],
				links: [L('a', 'b'), L('b', 'a'), L('a', 'a'), L('b', 'c')]
			},
			{
				name: 'a link naming a Worker outside the set',
				nodes: [N('a'), N('b')],
				links: [L('a', 'b'), L('a', 'ghost'), L('ghost', 'b')]
			}
		];

		for (const { name, nodes, links } of cases) {
			for (const hubSpacing of [false, true]) {
				const actual = graphDistances(nodes, links, { hubSpacing });
				const expected = referenceDistances(nodes, links, hubSpacing);

				nodes.forEach((from, i) => {
					nodes.forEach((to, j) => {
						if (i === j) return;
						expect(
							actual.get(pairKey(from.id, to.id)),
							`${name} (hubSpacing: ${hubSpacing}) ${from.id}→${to.id}`
						).toBeCloseTo(expected[i][j], 10);
					});
				});
			}
		}
	});

	it('keeps an unreachable pair one step past the farthest real distance', () => {
		// The real graph's farthest pair is a→c at 2 hops, so every pair that
		// nothing connects — including the isolate — takes 3, not its hop count.
		const nodes = [N('a'), N('b'), N('c'), N('z')];
		const links = [L('a', 'b'), L('b', 'c')];
		const d = graphDistances(nodes, links);
		expect(d.get(pairKey('a', 'z'))).toBe(3);
		expect(d.get(pairKey('b', 'z'))).toBe(3);
	});
});

describe('stressSweeps', () => {
	/*
	 * The count used to be the constant 220 at every size, so a full solve grew
	 * with the square of the Workers table. It is now a work budget spread over `n`.
	 */
	it('keeps the shipped ceiling where the ceiling binds', () => {
		expect(stressSweeps(1)).toBe(stressSweepCeiling);
		expect(stressSweeps(50)).toBe(stressSweepCeiling);
		expect(stressSweeps(200)).toBe(stressSweepCeiling);
	});

	it('thins the sweeps out as the Workers table grows', () => {
		// 400 sits between the ceiling and the floor, so the budget is what binds.
		expect(stressSweeps(400)).toBe(Math.floor(stressSweepBudget / 400));
		expect(stressSweeps(400)).toBeLessThan(stressSweepCeiling);
		// Past the break-even (budget ÷ floor) the floor is what binds instead.
		expect(stressSweeps(800)).toBe(stressSweepFloor);
	});

	it('never falls below the floor, and never exceeds the ceiling', () => {
		for (const n of [0, 1, 50, 200, 401, 800, 2000, 10_000, 100_000]) {
			expect(stressSweeps(n)).toBeGreaterThanOrEqual(stressSweepFloor);
			expect(stressSweeps(n)).toBeLessThanOrEqual(stressSweepCeiling);
		}
	});

	it('never rises as the Workers table grows', () => {
		let previous = stressSweeps(1);
		for (let n = 2; n <= 1200; n += 1) {
			const next = stressSweeps(n);
			expect(next).toBeLessThanOrEqual(previous);
			previous = next;
		}
	});

	it('is a pure function of the count, so determinism survives', () => {
		expect(stressSweeps(500)).toBe(stressSweeps(500));
	});
});

describe('solver cost', () => {
	// A worksite-shaped graph: a couple of Relationships per Worker, clustered.
	function worksite(n: number): { nodes: StressNode[]; links: StressLink[] } {
		const nodes = Array.from({ length: n }, (_, i) => N(`w${i}`));
		const links: StressLink[] = [];
		const seen = new Set<string>();
		const perGroup = Math.max(1, Math.floor(n / 20));
		for (let i = 0; i < n; i += 1) {
			for (let k = 1; k <= 3; k += 1) {
				const partner = Math.floor(i / perGroup) * perGroup + ((i + k * 3) % perGroup);
				const a = Math.min(i, Math.min(n - 1, partner));
				const b = Math.max(i, Math.min(n - 1, partner));
				if (a === b || seen.has(`${a}::${b}`)) continue;
				seen.add(`${a}::${b}`);
				links.push(L(`w${a}`, `w${b}`));
			}
		}
		return { nodes, links };
	}

	/*
	 * A regression gate that counts work, not milliseconds, so a busy machine
	 * cannot turn it red. The cap is the sweep budget's own cost for one full
	 * solve (budget · n pair visits) with 10% headroom; a layout that sweeps more
	 * than the budget allows, or solves more than once per arrangement, exceeds it.
	 */
	const workCap = 24_200_000;
	// Grouped, each cluster solves alone, so the work is far smaller (about
	// 160k pair visits today); the cap is roughly twice that.
	const groupedWorkCap = 320_000;

	it('arranges a 500-Worker worksite inside the budget', () => {
		const { nodes, links } = worksite(500);
		const radiusFor = () => 7.2;

		const before = stressPairVisits();
		const positions = stressLayout(nodes, links, { overlapAware: true, radiusFor });
		const work = stressPairVisits() - before;

		expect(positions.size).toBe(500);
		expect(work).toBeLessThanOrEqual(workCap);
	});

	it('arranges a 500-Worker worksite with a Sub-grouping inside the budget', () => {
		const { nodes, links } = worksite(500);
		const teams = ['T1', 'T2', 'T3', 'T4', 'T5'];
		const shifts = ['Day', 'Night', 'Swing', 'Early'];
		const attr = (id: string, options: string[]) =>
			attributeFixture({ id, name: id, kind: 'category' as const, options });
		const workers = nodes.map((node, i) => ({
			id: node.id,
			name: node.id,
			assessment: 'Unassessed' as const,
			attributes: answerIdsFixture({
				team: teams[Math.floor(i / 100)],
				shift: shifts[i % 4]
			}),
			relationshipCount: 3
		}));

		const before = stressPairVisits();
		const { positions } = arrange({
			mode: 'grouped',
			nodes: workers,
			links: links.map((link, i) => ({
				id: `l${i}`,
				source: String(link.source),
				target: String(link.target),
				value: 1
			})),
			groupingAttribute: attr('team', teams),
			subGroupingAttribute: attr('shift', shifts),
			canvas: { width: 1600, height: 1000 },
			gap: 80
		});
		const work = stressPairVisits() - before;

		expect(positions.size).toBe(500);
		expect(work).toBeLessThanOrEqual(groupedWorkCap);
	});
});

describe('stressLayout', () => {
	it('lays a path graph collinear', () => {
		const nodes = [N('a'), N('b'), N('c'), N('d')];
		const links = [L('a', 'b'), L('b', 'c'), L('c', 'd')];
		const positions = stressLayout(nodes, links);

		// Each adjacent pair sits at the edge length within tolerance.
		const edgeAdjacent = (p: string, q: string) => {
			const a = positions.get(p) as { x: number; y: number };
			const b = positions.get(q) as { x: number; y: number };
			return Math.hypot(a.x - b.x, a.y - b.y);
		};
		for (const [p, q] of [
			['a', 'b'],
			['b', 'c'],
			['c', 'd']
		] as const) {
			expect(edgeAdjacent(p, q)).toBeCloseTo(stressEdgeLength, 0);
		}

		// The path reads as a chain: successive endpoint directions never
		// reverse (a–b–c–d runs monotonically through b), and the middle node
		// stays within a small fraction of the edge length of the line through
		// the outer nodes, confirming the layout is chain-like, not a star or a
		// doubled-back arrangement.
		const a = positions.get('a') as { x: number; y: number };
		const b = positions.get('b') as { x: number; y: number };
		const c = positions.get('c') as { x: number; y: number };
		const d = positions.get('d') as { x: number; y: number };

		// Each step advances along the previous step's direction (no fold-back).
		const dot = (
			from: { x: number; y: number },
			mid: { x: number; y: number },
			to: { x: number; y: number }
		) => (mid.x - from.x) * (to.x - mid.x) + (mid.y - from.y) * (to.y - mid.y);
		expect(dot(a, b, c)).toBeGreaterThan(0);
		expect(dot(b, c, d)).toBeGreaterThan(0);

		// The middle node is within a small multiple of the edge length of the
		// chord a–d, because the chain is nearly straight.
		const span = Math.hypot(d.x - a.x, d.y - a.y);
		const projection = ((b.x - a.x) * (d.x - a.x) + (b.y - a.y) * (d.y - a.y)) / (span * span);
		const foot = { x: a.x + (d.x - a.x) * projection, y: a.y + (d.y - a.y) * projection };
		expect(Math.hypot(b.x - foot.x, b.y - foot.y)).toBeLessThan(stressEdgeLength * 0.6);
	});

	it('is deterministic for identical input', () => {
		const nodes = [N('a'), N('b'), N('c')];
		const links = [L('a', 'b'), L('b', 'c')];
		const first = stressLayout(nodes, links);
		const second = stressLayout(nodes, links);
		expect([...second.entries()]).toEqual([...first.entries()]);
	});

	it('leaves pinned nodes where they were', () => {
		const nodes = [N('a'), N('b'), N('c')];
		const links = [L('a', 'b'), L('b', 'c')];
		const seed = new Map([
			['a', { x: 500, y: -500 }],
			['b', { x: 0, y: 0 }],
			['c', { x: 100, y: 0 }]
		]);
		const positions = stressLayout(nodes, links, { seed, pinnedIds: new Set(['a', 'c']) });

		// Pins keep their own coordinates relative to the centroid shift; a
		// pinned pair must keep its exact drawn separation.
		const a = positions.get('a') as { x: number; y: number };
		const c = positions.get('c') as { x: number; y: number };
		const seedSpan = Math.hypot(
			(seed.get('a') as { x: number; y: number }).x - (seed.get('c') as { x: number; y: number }).x,
			(seed.get('a') as { x: number; y: number }).y - (seed.get('c') as { x: number; y: number }).y
		);
		expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeCloseTo(seedSpan, 6);
	});
});

describe('separatePositions / fitAndSeparate', () => {
	it('pushes overlapping nodes apart', () => {
		const positions = new Map([
			['a', { x: 0, y: 0 }],
			['b', { x: 2, y: 0 }]
		]);
		const radius = () => 4;
		const separated = separatePositions(positions, radius, 4, 10);
		const a = separated.get('a') as { x: number; y: number };
		const b = separated.get('b') as { x: number; y: number };
		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(2 * 4 + 4 - 1e-9);
	});

	it('respects a scale cap in fit', () => {
		const positions = new Map([
			['a', { x: -10, y: -10 }],
			['b', { x: 10, y: 10 }]
		]);
		const fitted = fitAndSeparate(
			positions,
			() => 0,
			{ width: 1000, height: 1000 },
			{ scaleCap: 1.8 }
		);
		// Natural scale over the 20-unit axis span is 50; the cap keeps it at
		// 1.8, read per axis (the a→b distance is the diagonal of that box).
		const a = fitted.get('a') as { x: number; y: number };
		const b = fitted.get('b') as { x: number; y: number };
		expect(Math.abs(a.x - b.x)).toBeCloseTo(20 * 1.8, 6);
		expect(Math.abs(a.y - b.y)).toBeCloseTo(20 * 1.8, 6);
	});
});

describe('seededJitter', () => {
	it('stays inside its documented amplitude', () => {
		expect(stressSeedJitter).toBeGreaterThan(0);
		expect(stressSeedJitter).toBeLessThanOrEqual(1);
	});
});
