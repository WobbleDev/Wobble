// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { detectClusters, gatherStart } from './graph-clusters.ts';

function clique(prefix: string, size: number) {
	const ids = Array.from({ length: size }, (_, i) => `${prefix}${i}`);
	const links: { source: string; target: string }[] = [];
	for (let a = 0; a < size; a += 1) {
		for (let b = a + 1; b < size; b += 1) links.push({ source: ids[a], target: ids[b] });
	}
	return { ids, links };
}

describe('detectClusters', () => {
	const a = clique('a', 6);
	const b = clique('b', 6);
	const ids = [...a.ids, ...b.ids, 'loner'];
	const links = [...a.links, ...b.links, { source: 'a0', target: 'b0' }];

	it('separates two dense sets joined by one bridge', () => {
		const c = detectClusters(ids, links);
		expect(new Set(a.ids.map((id) => c.get(id))).size).toBe(1);
		expect(new Set(b.ids.map((id) => c.get(id))).size).toBe(1);
		expect(c.get('a0')).not.toBe(c.get('b0'));
	});

	it('leaves a worker with no Relationships alone', () => {
		const c = detectClusters(ids, links);
		const shared = ids.filter((id) => c.get(id) === c.get('loner'));
		expect(shared).toEqual(['loner']);
	});

	it('is deterministic whatever the input order', () => {
		const first = detectClusters(ids, links);
		const second = detectClusters([...ids].reverse(), [...links].reverse());
		expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
	});
});

describe('gatherStart', () => {
	const canvas = { width: 800, height: 600 };
	const a = clique('a', 6);
	const b = clique('b', 6);
	const loners = Array.from({ length: 40 }, (_, i) => `z${i}`);
	const ids = [...a.ids, ...b.ids, ...loners];
	const clusters = detectClusters(ids, [...a.links, ...b.links]);

	it('is identical across runs and places every worker', () => {
		const one = gatherStart(ids, clusters, canvas);
		expect(one.size).toBe(ids.length);
		expect([...gatherStart(ids, clusters, canvas)]).toEqual([...one]);
	});

	it('keeps disconnected singleton Workers finite and separated', () => {
		const start = gatherStart(ids, clusters, canvas);
		for (const id of loners) {
			const p = start.get(id)!;
			expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
			for (const other of ids.filter((other) => other !== id)) {
				const q = start.get(other)!;
				expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(20);
			}
		}
	});
});
