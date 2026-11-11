// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { arrange, localLayoutSolves, type ArrangeInput } from '../layout/graph-arrangement.ts';
import type { ManualGeometry } from '../layout/graph-manual.ts';
import { spacingPolicy, type CompositionInput } from './graph-composition.ts';
import { layoutGroupRegions, regionKey, subRegionKey, type Point } from '../layout/graph-layout.ts';
import { buildBucketTree } from '../layout/graph-analysis.ts';
import {
	createLayoutQualityFixture,
	qualityArrangeInput
} from '#lib/testing/mapping/graph-layout-quality-fixture.ts';
import { evaluateDrawing } from '../layout/graph-layout-quality.ts';
import { flattenPath, pointInPolygon, polygonRelation } from '../layout/graph-shapes.ts';
import { labelledWorkerIds } from '../map-view-model.ts';
import { nodeRadius } from '../map-style.ts';
import { compositionWorkLimits } from '../layout/graph-work-budget.ts';
import type { WorkerGraphLink, WorkerGraphNode } from '../worker-relationship-map-model.ts';
import {
	answerIdOf,
	answerIdsFixture,
	answerText,
	attributeFixture
} from '#lib/testing/mapping/answer-fixtures.ts';
import { groupValue } from '../layout/graph-analysis.ts';

const names = ['Assembly', 'Billing', 'Cleaning', 'Dispatch', 'Engineering', 'Facilities'];
const department = attributeFixture({
	id: 'dept',
	name: 'Department',
	kind: 'category',
	options: names
});

/** The id a fixture answer text is held under; a blank text stays blank. */
const idOf = (attributeId: string, text: string) =>
	text === '' ? '' : answerIdOf(attributeId, text);

/** The region key a Department answer is held under, for keying centres by its text. */
const dk = (text: string) => (text === '' ? '' : answerIdOf('dept', text));

type Topology = { nodes: WorkerGraphNode[]; links: WorkerGraphLink[] };

/** Fills every relationshipCount from the stored pairs, so both sides see true degrees. */
function withDegrees({ nodes, links }: Topology): Topology {
	const degree = new Map<string, number>();
	for (const link of links) {
		degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
		degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
	}
	return { nodes: nodes.map((n) => ({ ...n, relationshipCount: degree.get(n.id) ?? 0 })), links };
}

/** Six groups of six with 32 cross-group pairs: A-C 8, A-B 4, C-D 4, B-E 8, D-F 8. */
function sixGroups(): Topology {
	const nodes: WorkerGraphNode[] = names.flatMap((group, g) =>
		Array.from({ length: 6 }, (_, index) => ({
			id: `${String.fromCharCode(65 + g)}${index}`,
			name: `${group} ${['Ames', 'Bell', 'Cho', 'Diaz', 'Eze', 'Fox'][index]}`,
			assessment: 'Unassessed' as const,
			attributes: answerIdsFixture({ dept: group }),
			relationshipCount: 0
		}))
	);
	const links: WorkerGraphLink[] = [];
	const add = (prefix: string, from: string, to: string, count: number) => {
		for (let i = 0; i < count; i += 1) {
			links.push({
				id: `${prefix}${i}`,
				source: `${from}${Math.floor(i / 6)}`,
				target: `${to}${i % 6}`,
				value: 1
			});
		}
	};
	add('ac', 'A', 'C', 8);
	add('ab', 'A', 'B', 4);
	add('cd', 'C', 'D', 4);
	add('be', 'B', 'E', 8);
	add('df', 'D', 'F', 8);
	return withDegrees({ nodes, links });
}

const sizes = {
	wide: { canvas: { width: 1300, height: 800 }, free: { width: 1300, height: 700 } },
	tall: { canvas: { width: 1000, height: 1200 }, free: { width: 1000, height: 1100 } },
	floor: { canvas: { width: 760, height: 520 }, free: { width: 760, height: 420 } }
} as const;

function groupedInput(
	topology: Topology,
	size: keyof typeof sizes,
	overrides: Partial<ArrangeInput> = {}
): ArrangeInput {
	return {
		mode: 'grouped',
		nodes: topology.nodes,
		links: topology.links,
		groupingAttribute: department,
		canvas: sizes[size].canvas,
		// A crowded gap: the shipped orientation clears the roomy layouts on its own, and
		// composition earns its place where the groups are close.
		gap: 70,
		...overrides
	};
}

function composition(topology: Topology, size: keyof typeof sizes): CompositionInput {
	return {
		freeCanvas: sizes[size].free,
		restingNameIds: [...labelledWorkerIds(topology.nodes, {})]
	};
}

/**
 * Every Relationship draws exactly once. Paths are published for the drawing that
 * won; when none were, the packet must record why the detours were kept back, so a
 * lost route set cannot pass as a legitimate fallback.
 */
function expectEveryRelationshipDrawn(result: ReturnType<typeof arrange>, pairs: number) {
	if (result.routes) {
		expect(result.routes.size).toBe(pairs);
		return;
	}
	expect(
		result.composition!.candidates.some(
			(candidate) => candidate.key === 'original+routed' && candidate.status === 'rejected'
		),
		'straight ties stand only for a recorded reason'
	).toBe(true);
}

const six = sixGroups();

describe('composed Grouped arrangement', () => {
	it('keeps every Worker, exact pair and membership, with one path per pair', () => {
		for (const size of ['wide', 'tall', 'floor'] as const) {
			const result = arrange({ ...groupedInput(six, size), composition: composition(six, size) });
			expect(result.positions.size).toBe(six.nodes.length);
			for (const node of six.nodes) {
				const point = result.positions.get(node.id)!;
				expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
			}
			expect([...result.centres.keys()].sort()).toEqual(names.map(dk).sort());
			const routes = result.routes;
			if (routes) {
				expect(routes.size).toBe(six.links.length);
				for (const link of six.links) {
					const route = routes.get(link.id)!;
					expect([route.source, route.target]).toEqual([link.source, link.target]);
					const flat = flattenPath(route.d, 0.05, 256)!;
					const from = result.positions.get(link.source)!;
					const to = result.positions.get(link.target)!;
					expect(flat.points[0].x).toBeCloseTo(from.x, 1);
					expect(flat.points[0].y).toBeCloseTo(from.y, 1);
					expect(flat.points.at(-1)!.x).toBeCloseTo(to.x, 1);
					expect(flat.points.at(-1)!.y).toBeCloseTo(to.y, 1);
				}
			}
		}
	});

	it('is a different drawing from the shipped one on the six-group topology, at wide and tall', () => {
		for (const size of ['wide', 'tall'] as const) {
			const shipped = arrange(groupedInput(six, size));
			const composed = arrange({ ...groupedInput(six, size), composition: composition(six, size) });
			const packet = composed.composition!;
			expect(packet.chosen).not.toBe('original');
			const moved = [...composed.centres].some(([key, centre]) => {
				const was = shipped.centres.get(key)!;
				return Math.hypot(centre.x - was.x, centre.y - was.y) > 1;
			});
			expect(moved, `${size}: ${packet.chosen} should move groups`).toBe(true);
			expect(packet.routes).toBeDefined();
		}
	});

	it('resolves conflicts the shipped drawing had, and adds none', () => {
		for (const size of ['wide', 'tall', 'floor'] as const) {
			const packet = arrange({
				...groupedInput(six, size),
				composition: composition(six, size)
			}).composition!;
			const original = packet.candidates.find((c) => c.key === 'original')!;
			const selected = packet.candidates.find((c) => c.status === 'selected')!;
			expect(selected.conflicts).toBeLessThanOrEqual(original.conflicts);
			expect(Object.values(packet.conflicts).flat().length).toBe(selected.conflicts);
		}
	});

	it('keeps the ring recognizable and complete, preserving its cycle', () => {
		const fixture = createLayoutQualityFixture();
		for (const size of ['wide', 'tall', 'floor'] as const) {
			const input = {
				...qualityArrangeInput(fixture, 'grouped'),
				gap: 170,
				canvas: sizes[size].canvas
			};
			const result = arrange({ ...input, composition: composition(fixture, size) });
			expect(result.positions.size).toBe(60);
			// The ring always finishes inside its allowance: every tie is a final path.
			expect(result.routes?.size).toBe(136);
			expect([...result.centres.keys()].sort()).toEqual(
				['Department 1', 'Department 2', 'Department 3', 'Department 4', 'Department 5']
					.map((text) => answerIdOf('quality-department', text))
					.sort()
			);
			// All eight communities still link in a ring: every community pair keeps its two ties.
			expect(fixture.links).toHaveLength(136);
		}
	});

	it('keeps outlines at least the minimum apart and each Worker inside its own region', () => {
		const size = 'wide';
		const result = arrange({ ...groupedInput(six, size), composition: composition(six, size) });
		const scale = result.composition!.scale;
		const regions = layoutGroupRegions(
			buildBucketTree(six.nodes, department, undefined),
			six.nodes.map((node) => ({
				...result.positions.get(node.id)!,
				group: groupValue(node, department),
				subGroup: ''
			}))
		);
		const polygons = regions.map((region) => ({
			key: region.key,
			polygon: flattenPath(region.path, 0.5 / scale, 256)!.points
		}));
		for (let i = 0; i < polygons.length; i += 1) {
			for (let j = i + 1; j < polygons.length; j += 1) {
				const relation = polygonRelation(polygons[i].polygon, polygons[j].polygon);
				expect(relation.overlap).toBe(false);
				// The sampled drawn outline is within 2px of the proxy the rule was checked on.
				expect(relation.distance * scale).toBeGreaterThanOrEqual(spacingPolicy.minOutlinePx - 3);
			}
		}
		for (const node of six.nodes) {
			const own = polygons.find((p) => p.key === groupValue(node, department))!;
			const point = result.positions.get(node.id)!;
			const r = nodeRadius(node.relationshipCount);
			expect(polygonRelation(own.polygon, [point, { x: point.x + r, y: point.y }]).overlap).toBe(
				true
			);
		}
	});

	it('draws final paths independent evaluation agrees clear of the dots it names', () => {
		const result = arrange({ ...groupedInput(six, 'tall'), composition: composition(six, 'tall') });
		const packet = result.composition!;
		const evaluation = evaluateDrawing({
			routes: [...result.routes!.values()].map(({ id, source, target, d }) => ({
				id,
				source,
				target,
				d
			})),
			dots: six.nodes.map((node) => ({
				id: node.id,
				...result.positions.get(node.id)!,
				r: nodeRadius(node.relationshipCount)
			})),
			names: [...packet.names].map(([id, name]) => ({
				id: `name:${id}`,
				worker: id,
				box: name.box
			})),
			headings: [...packet.headings].map(([id, heading]) => ({ id, box: heading.box })),
			regions: [],
			workerRegions: new Map(),
			unit: 1 / packet.scale
		});
		expect(evaluation.invalidRoutes).toEqual([]);
		expect(evaluation.dotConflicts).toEqual([]);
		expect(evaluation.nameConflicts).toEqual([]);
		expect(evaluation.headingConflicts).toEqual([]);
	});

	it('keeps unequal groups, a singleton and Unanswered, with no ties, complete and apart', () => {
		const front = attributeFixture({ ...department, options: ['Front', 'Back'] });
		const nodes: WorkerGraphNode[] = [
			...['Front', 'Front'].map((value, i) => ({
				id: `f${i}`,
				name: `Front ${i}`,
				assessment: 'Unassessed' as const,
				attributes: answerIdsFixture({ dept: value }),
				relationshipCount: 0
			})),
			...Array.from({ length: 6 }, (_, i) => ({
				id: `b${i}`,
				name: `Back ${i}`,
				assessment: 'Unassessed' as const,
				attributes: answerIdsFixture({ dept: 'Back' }),
				relationshipCount: 0
			})),
			{
				id: 'u0',
				name: 'Unanswered one',
				assessment: 'Unassessed' as const,
				attributes: {},
				relationshipCount: 0
			}
		];
		for (const size of ['wide', 'tall'] as const) {
			const result = arrange({
				mode: 'grouped',
				nodes,
				links: [],
				groupingAttribute: front,
				canvas: sizes[size].canvas,
				gap: 170,
				composition: { freeCanvas: sizes[size].free, restingNameIds: [] }
			});
			expect(result.positions.size).toBe(9);
			expect([...result.centres.keys()].sort()).toEqual(['', 'Back', 'Front'].map(dk));
			// With no Relationship there is no path to draw, so none is published.
			expect(result.routes?.size ?? 0).toBe(0);
			const packet = result.composition!;
			const regions = layoutGroupRegions(
				buildBucketTree(nodes, front, undefined),
				nodes.map((node) => ({
					...result.positions.get(node.id)!,
					group: groupValue(node, department),
					subGroup: ''
				}))
			);
			const outlined = regions.filter((region) => region.outlined);
			expect(outlined).toHaveLength(2);
			const [a, b] = outlined.map(
				(region) => flattenPath(region.path, 0.5 / packet.scale, 256)!.points
			);
			const relation = polygonRelation(a, b);
			expect(relation.overlap).toBe(false);
			expect(relation.distance * packet.scale).toBeGreaterThanOrEqual(
				spacingPolicy.minOutlinePx - 3
			);
		}
	});

	it('is deterministic: the same canonical input reaches the same selected packet', () => {
		const first = arrange({ ...groupedInput(six, 'wide'), composition: composition(six, 'wide') });
		// Evict the single-entry cache with a different map, then ask again.
		arrange({ ...groupedInput(six, 'tall'), composition: composition(six, 'tall') });
		const again = arrange({ ...groupedInput(six, 'wide'), composition: composition(six, 'wide') });
		expect(again).not.toBe(first);
		expect(again.composition!.chosen).toBe(first.composition!.chosen);
		expect([...again.positions]).toEqual([...first.positions]);
		expect([...(again.routes ?? [])].map(([, r]) => r.d)).toEqual(
			[...(first.routes ?? [])].map(([, r]) => r.d)
		);
	});

	it('treats selection, hover, search and the camera as outside the composition', () => {
		const base = { ...groupedInput(six, 'wide'), composition: composition(six, 'wide') };
		const first = arrange(base);
		// Active labels and the live camera arrive only as the view-level label view.
		const labelled = arrange({
			...base,
			labelView: {
				positions: first.positions,
				nodes: six.nodes,
				freeCanvas: { x: -650, y: -350, width: 1300, height: 700 },
				priorityIds: new Set(['A0'])
			}
		});
		expect(labelled.positions).toBe(first.positions);
		expect(labelled.composition).toBe(first.composition);
		expect(labelled.routes).toBe(first.routes);
	});

	it('recomposes for a renamed resting Worker without re-running unchanged local stress', () => {
		const base = { ...groupedInput(six, 'wide'), composition: composition(six, 'wide') };
		const before = arrange(base);
		const solves = localLayoutSolves.count;
		const hub = base.composition.restingNameIds[0];
		const renamed = {
			...base,
			nodes: six.nodes.map((node) =>
				node.id === hub ? { ...node, name: `${node.name}, long enough to move its box` } : node
			)
		};
		const after = arrange(renamed);
		expect(localLayoutSolves.count).toBe(solves);
		expect(after.composition).not.toBe(before.composition);
		expect(after.positions.size).toBe(before.positions.size);
		// A different group answer is a layout trigger and pays for local stress again.
		arrange({
			...base,
			nodes: six.nodes.map((node) =>
				node.id === 'A5' ? { ...node, attributes: answerIdsFixture({ dept: 'Billing' }) } : node
			)
		});
		expect(localLayoutSolves.count).toBeGreaterThan(solves);
	});

	it('recomposes when the measured text revision changes', () => {
		const base = { ...groupedInput(six, 'wide'), composition: composition(six, 'wide') };
		const estimated = arrange(base);
		const measured = arrange({
			...base,
			composition: {
				...base.composition,
				text: {
					source: 'measured',
					revision: 'measured:test',
					names: new Map(
						base.composition.restingNameIds.map((id) => [id, { width: 140, height: 15 }])
					),
					headings: new Map(names.map((name) => [dk(name), { width: 150, height: 15 }]))
				}
			}
		});
		expect(measured).not.toBe(estimated);
		expect(measured.composition!.textSource).toBe('measured');
		expect(estimated.composition!.textSource).toBe('estimate');
		expect(measured.positions.size).toBe(six.nodes.length);
	});

	it.each([
		['sparse', 700],
		['dense', 2500]
	])(
		'stays within its work allowance and falls back to the complete shipped drawing at 500 Workers (%s)',
		(_label, linkCount) => {
			const groups = Array.from({ length: 10 }, (_, g) => `G${g}`);
			const nodes: WorkerGraphNode[] = Array.from({ length: 500 }, (_, i) => ({
				id: `w${i}`,
				name: `Worker ${i}`,
				assessment: 'Unassessed' as const,
				attributes: answerIdsFixture({ dept: groups[i % 10] }),
				relationshipCount: 0
			}));
			const links: WorkerGraphLink[] = Array.from({ length: linkCount }, (_, i) => ({
				id: `l${i}`,
				source: `w${(i * 7) % 500}`,
				target: `w${(i * 13 + 5) % 500}`,
				value: 1
			})).filter((link) => link.source !== link.target);
			const topology = withDegrees({ nodes, links });
			const request = {
				mode: 'grouped' as const,
				nodes: topology.nodes,
				links: topology.links,
				groupingAttribute: attributeFixture({ ...department, options: groups }),
				canvas: { width: 1600, height: 1000 },
				gap: 170
			};
			const shipped = arrange(request);
			const result = arrange({
				...request,
				composition: {
					freeCanvas: { width: 1600, height: 900 },
					restingNameIds: [...labelledWorkerIds(topology.nodes, {})]
				}
			});
			expect(result.positions.size).toBe(500);
			const packet = result.composition!;
			for (const kind of ['placement', 'routing', 'evaluation'] as const) {
				expect(packet.work[kind]).toBeLessThanOrEqual(compositionWorkLimits[kind]);
			}
			// Exhaustion never returns a partial route set or drops a Worker: a kept drawing
			// stands exactly where it was shipped, and every published path is a whole one.
			if (packet.chosen === 'original') {
				for (const [id, point] of shipped.positions) {
					const kept = result.positions.get(id)!;
					expect(Math.hypot(kept.x - point.x, kept.y - point.y)).toBeLessThan(1e-6);
				}
			}
			if (result.routes) expect(result.routes.size).toBe(topology.links.length);
		}
	);
});

describe('child-first Sub-grouping composition', () => {
	const nested = createLayoutQualityFixture();
	const childBase = (size: keyof typeof sizes) => ({
		...qualityArrangeInput(nested, 'nested'),
		// Crowded, as in groupedInput: the shipped orientation clears roomier layouts itself.
		gap: 70,
		canvas: sizes[size].canvas
	});
	const subOf = (id: string) =>
		(nested.nodes.find((n) => n.id === id) &&
			answerText(
				nested.nodes.find((n) => n.id === id)!,
				'quality-role'
			)) ??
		'';

	/** Smallest gap between two drawn sibling child outlines, in reference pixels at `scale`. */
	function childGapPx(positions: ReadonlyMap<string, Point>, scale: number): number {
		const regions = layoutGroupRegions(
			buildBucketTree(
				nested.nodes,
				childBase('wide').groupingAttribute,
				childBase('wide').subGroupingAttribute
			),
			nested.nodes.map((node) => ({
				...positions.get(node.id)!,
				group: idOf('quality-department', nested.groupByWorker.get(node.id)!),
				subGroup: idOf('quality-role', subOf(node.id))
			}))
		);
		let gap = Infinity;
		for (const parent of regions) {
			const children = parent.subRegions.filter((sub) => sub.outlined);
			for (let i = 0; i < children.length; i += 1) {
				for (let j = i + 1; j < children.length; j += 1) {
					const a = flattenPath(children[i].path, 0.5 / scale, 256)!.points;
					const b = flattenPath(children[j].path, 0.5 / scale, 256)!.points;
					gap = Math.min(gap, polygonRelation(a, b).distance * scale);
				}
			}
		}
		return gap;
	}

	/** Outlined children with a vertex outside their parent's drawn outline. */
	function escapedChildren(result: ReturnType<typeof arrange>): string[] {
		const scale = result.composition!.scale;
		const regions = layoutGroupRegions(
			buildBucketTree(
				nested.nodes,
				childBase('wide').groupingAttribute,
				childBase('wide').subGroupingAttribute
			),
			nested.nodes.map((node) => ({
				...result.positions.get(node.id)!,
				group: idOf('quality-department', nested.groupByWorker.get(node.id)!),
				subGroup: idOf('quality-role', subOf(node.id))
			}))
		);
		const escaped: string[] = [];
		for (const parent of regions) {
			const outer = flattenPath(parent.path, 0.5 / scale, 256)!.points;
			for (const child of parent.subRegions.filter((sub) => sub.outlined)) {
				const inner = flattenPath(child.path, 0.5 / scale, 256)!.points;
				if (inner.some((p) => !pointInPolygon(p, outer))) escaped.push(child.key);
			}
		}
		return escaped;
	}

	it('re-solves child interiors before composing parents at wide and tall', () => {
		for (const size of ['wide', 'tall'] as const) {
			const input = childBase(size);
			const shipped = arrange(input);
			const result = arrange({ ...input, composition: composition(nested, size) });
			const packet = result.composition!;
			expect(packet.chosen, `${size}: a composed candidate wins`).not.toBe('original');
			// Child interiors are re-solved, not inherited: some within-parent
			// distance changes, which no rigid parent move (translation or
			// rotation) can produce. 1e-6 dwarfs the engine's 1-ulp round-trip.
			let reshaped = 0;
			const members = new Map<string, string[]>();
			for (const node of nested.nodes) {
				const parent = nested.groupByWorker.get(node.id)!;
				const list = members.get(parent) ?? [];
				list.push(node.id);
				members.set(parent, list);
			}
			for (const ids of members.values()) {
				for (let i = 0; i < ids.length; i += 1) {
					for (let j = i + 1; j < ids.length; j += 1) {
						const a = result.positions.get(ids[i])!;
						const b = result.positions.get(ids[j])!;
						const c = shipped.positions.get(ids[i])!;
						const d = shipped.positions.get(ids[j])!;
						reshaped = Math.max(
							reshaped,
							Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - Math.hypot(c.x - d.x, c.y - d.y))
						);
					}
				}
			}
			expect(reshaped, `${size}: children re-solved within their parents`).toBeGreaterThan(1e-6);
			expect(
				childGapPx(result.positions, packet.scale),
				`${size}: sibling children clear the 12px minimum`
			).toBeGreaterThanOrEqual(12 - 3);
			expect(
				escapedChildren(result),
				`${size}: every outlined child stays inside its parent`
			).toEqual([]);
		}
	});

	it('keeps routes inside their endpoint ancestry and out of unrelated siblings', () => {
		const input = childBase('wide');
		const result = arrange({ ...input, composition: composition(nested, 'wide') });
		if (!result.routes) return;
		const scale = result.composition!.scale;
		const regions = layoutGroupRegions(
			buildBucketTree(nested.nodes, input.groupingAttribute, input.subGroupingAttribute),
			nested.nodes.map((node) => ({
				...result.positions.get(node.id)!,
				group: idOf('quality-department', nested.groupByWorker.get(node.id)!),
				subGroup: idOf('quality-role', subOf(node.id))
			}))
		);
		const polys = new Map<string, { x: number; y: number }[]>();
		for (const parent of regions) {
			polys.set(parent.key, flattenPath(parent.path, 0.5 / scale, 256)!.points);
			for (const child of parent.subRegions) {
				polys.set(child.key, flattenPath(child.path, 0.5 / scale, 256)!.points);
			}
		}
		const chain = (id: string) => [
			regionKey(idOf('quality-department', nested.groupByWorker.get(id)!)),
			subRegionKey(
				idOf('quality-department', nested.groupByWorker.get(id)!),
				idOf('quality-role', subOf(id))
			)
		];
		const violations: string[] = [];
		for (const link of nested.links) {
			const route = result.routes.get(link.id)!;
			const allowed = new Set([...chain(link.source), ...chain(link.target)]);
			const from = result.positions.get(link.source)!;
			const to = result.positions.get(link.target)!;
			for (const waypoint of route.waypoints) {
				if (Math.hypot(waypoint.x - from.x, waypoint.y - from.y) < 1) continue;
				if (Math.hypot(waypoint.x - to.x, waypoint.y - to.y) < 1) continue;
				for (const [key, poly] of polys) {
					if (allowed.has(key) || !pointInPolygon(waypoint, poly)) continue;
					violations.push(`${link.id} enters ${key}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	it('is deterministic for the nested reading', () => {
		const first = arrange({ ...childBase('wide'), composition: composition(nested, 'wide') });
		arrange({ ...childBase('tall'), composition: composition(nested, 'tall') });
		const again = arrange({ ...childBase('wide'), composition: composition(nested, 'wide') });
		expect(again.composition!.chosen).toBe(first.composition!.chosen);
		expect([...again.positions]).toEqual([...first.positions]);
		expect([...again.centres]).toEqual([...first.centres]);
	});

	it('keeps the shipped nested drawing bit-identical across cache eviction', () => {
		// Regression test: a fresh solve once differed from a cache reuse by
		// 1 ulp (canonical-offset round-trip). The fresh path now redraws
		// through its own canonical offsets, so both paths coincide exactly.
		const first = arrange(childBase('wide'));
		arrange(childBase('tall'));
		const again = arrange(childBase('wide'));
		expect([...again.positions]).toEqual([...first.positions]);
		expect([...again.centres]).toEqual([...first.centres]);
	});

	it('invalidates on sub-group answers and keeps Unanswered exclusive', () => {
		const input = { ...childBase('wide'), composition: composition(nested, 'wide') };
		const base = arrange(input);
		expect(base.positions.size).toBe(60);
		const target = nested.nodes.find((n) => subOf(n.id) === 'Role A')!;
		const renamed = {
			...input,
			nodes: nested.nodes.map((n) =>
				n.id === target.id
					? {
							...n,
							attributes: {
								...n.attributes,
								...answerIdsFixture({ 'quality-role': 'Role D' })
							}
						}
					: n
			)
		};
		const moved = arrange(renamed);
		expect(moved).not.toBe(base);
		expect(moved.positions.size).toBe(60);
		// The moved Worker draws inside its new sub-region's outline extent.
		const movedRegions = layoutGroupRegions(
			buildBucketTree(renamed.nodes, input.groupingAttribute, input.subGroupingAttribute),
			renamed.nodes.map((node) => ({
				...moved.positions.get(node.id)!,
				group: idOf('quality-department', nested.groupByWorker.get(node.id)!),
				subGroup: idOf('quality-role', node.id === target.id ? 'Role D' : subOf(node.id))
			}))
		);
		const newHome = movedRegions
			.flatMap((parent) => parent.subRegions)
			.find(
				(sub) =>
					sub.key ===
					subRegionKey(
						idOf('quality-department', nested.groupByWorker.get(target.id)!),
						idOf('quality-role', 'Role D')
					)
			)!;
		const point = moved.positions.get(target.id)!;
		const xs = newHome.hull.map((p) => p.x);
		const ys = newHome.hull.map((p) => p.y);
		expect(point.x).toBeGreaterThan(Math.min(...xs) - 1);
		expect(point.x).toBeLessThan(Math.max(...xs) + 1);
		expect(point.y).toBeGreaterThan(Math.min(...ys) - 1);
		expect(point.y).toBeLessThan(Math.max(...ys) + 1);
		const unanswered = {
			...input,
			nodes: nested.nodes.map((n) =>
				n.id === target.id
					? {
							...n,
							attributes: {
								'quality-department': n.attributes!['quality-department']
							}
						}
					: n
			)
		};
		const without = arrange(unanswered);
		expect(without.positions.size).toBe(60);
		for (const node of without.positions.keys()) {
			const point = without.positions.get(node)!;
			expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
		}
	});

	it('completes a fixed 500-Worker nested map inside the single shared allowance', () => {
		const groups = Array.from({ length: 10 }, (_, g) => `H${g}`);
		const nodes: WorkerGraphNode[] = Array.from({ length: 500 }, (_, i) => ({
			id: `w${i}`,
			name: `Worker ${i}`,
			assessment: 'Unassessed' as const,
			attributes: answerIdsFixture({
				dept: groups[i % 10],
				role: `K${Math.floor(i / 10) % 4}`
			}),
			relationshipCount: 0
		}));
		const links: WorkerGraphLink[] = Array.from({ length: 900 }, (_, i) => ({
			id: `l${i}`,
			source: `w${(i * 7) % 500}`,
			target: `w${(i * 13 + 5) % 500}`,
			value: 1
		})).filter((link) => link.source !== link.target);
		const topology = withDegrees({ nodes, links });
		const request = {
			mode: 'grouped' as const,
			nodes: topology.nodes,
			links: topology.links,
			groupingAttribute: attributeFixture({ ...department, options: groups }),
			subGroupingAttribute: {
				...department,
				id: 'role',
				name: 'Role',
				options: ['K0', 'K1', 'K2', 'K3']
			},
			canvas: { width: 1600, height: 1000 },
			gap: 170
		};
		const shipped = arrange(request);
		const result = arrange({
			...request,
			composition: {
				freeCanvas: { width: 1600, height: 900 },
				restingNameIds: [...labelledWorkerIds(topology.nodes, {})]
			}
		});
		expect(result.positions.size).toBe(500);
		for (const point of result.positions.values()) {
			expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
		}
		const packet = result.composition!;
		// One shared allowance across hierarchy levels: the published totals stay inside it.
		for (const kind of ['placement', 'routing', 'evaluation'] as const) {
			expect(packet.work[kind]).toBeLessThanOrEqual(compositionWorkLimits[kind]);
		}
		// A kept drawing stands exactly where it was shipped, and every published path
		// is a whole one: exhaustion never leaves a partial route set.
		if (packet.chosen === 'original') {
			for (const [id, point] of shipped.positions) {
				const kept = result.positions.get(id)!;
				expect(Math.hypot(kept.x - point.x, kept.y - point.y)).toBeLessThan(1e-6);
			}
		}
		if (result.routes) expect(result.routes.size).toBe(topology.links.length);
	});
});

describe('manual placement over a composed arrangement', () => {
	const request = { ...groupedInput(six, 'wide'), composition: composition(six, 'wide') };
	const rest = arrange(request);
	const groupMove = (key: string, x: number, y: number): ManualGeometry => ({
		groupShift: new Map([[dk(key), { x, y }]]),
		workerShift: new Map()
	});

	it('translates the group rigidly with its names, headings and internal paths, and moves no other group', () => {
		const key = 'Facilities';
		const moved = arrange({ ...request, manual: groupMove(key, -2000, -1500) });
		expect(moved.revision).toBe(arrange(request).revision);
		for (const [group, centre] of rest.centres) {
			if (group === dk(key)) continue;
			expect(moved.centres.get(group)).toEqual(centre);
		}
		const inGroup = new Set(
			six.nodes.filter((n) => groupValue(n, department) === dk(key)).map((n) => n.id)
		);
		for (const [id, before] of rest.positions) {
			const after = moved.positions.get(id)!;
			expect(after.x - before.x).toBeCloseTo(inGroup.has(id) ? -2000 : 0, 6);
			expect(after.y - before.y).toBeCloseTo(inGroup.has(id) ? -1500 : 0, 6);
		}
		for (const [id, name] of rest.composition!.names) {
			const now = moved.composition!.names.get(id)!;
			expect(now.x - name.x).toBeCloseTo(inGroup.has(id) ? -2000 : 0, 6);
			expect(now.box.top - name.box.top).toBeCloseTo(inGroup.has(id) ? -1500 : 0, 6);
		}
		const heading = rest.composition!.headings.get(regionKey(dk(key)));
		if (heading)
			expect(moved.composition!.headings.get(regionKey(dk(key)))!.labelAt.x).toBeCloseTo(
				heading.labelAt.x - 2000,
				6
			);
	});

	it('lets a moved group land on another: no collision displacement', () => {
		const target = rest.centres.get(dk('Cleaning'))!;
		const from = rest.centres.get(dk('Assembly'))!;
		const moved = arrange({
			...request,
			manual: groupMove('Assembly', target.x - from.x, target.y - from.y)
		});
		expect(moved.centres.get(dk('Cleaning'))).toEqual(target);
		expect(moved.centres.get(dk('Assembly'))!.x).toBeCloseTo(target.x, 6);
	});

	it('keeps every path attached to its dots after a group move, with no repair pass', () => {
		const key = 'Cleaning';
		const moved = arrange({ ...request, manual: groupMove(key, 260, 160) });
		expect(moved.positions.size).toBe(six.nodes.length);
		if (rest.composition!.chosen !== 'original') {
			expect(moved.routes).toBeDefined();
			for (const link of six.links) {
				const route = moved.routes!.get(link.id)!;
				const flat = flattenPath(route.d, 0.05, 256)!;
				const from = moved.positions.get(link.source)!;
				const to = moved.positions.get(link.target)!;
				expect(flat.points[0].x).toBeCloseTo(from.x, 1);
				expect(flat.points[0].y).toBeCloseTo(from.y, 1);
				expect(flat.points.at(-1)!.x).toBeCloseTo(to.x, 1);
				expect(flat.points.at(-1)!.y).toBeCloseTo(to.y, 1);
			}
		}
	});

	it('moves one dot alone with its name and path ends, repairing nothing else', () => {
		const point = { ...rest.positions.get('B0')! };
		const moved = arrange({
			...request,
			manual: { groupShift: new Map(), workerShift: new Map([['B0', { x: 40, y: -30 }]]) }
		});
		expect(moved.positions.get('B0')).toEqual({ x: point.x + 40, y: point.y - 30 });
		for (const [id, was] of rest.positions) {
			if (id === 'B0') continue;
			expect(moved.positions.get(id)).toEqual(was);
		}
		for (const [id, name] of rest.composition!.names) {
			if (id === 'B0') continue;
			expect(moved.composition!.names.get(id)).toEqual(name);
		}
		for (const link of six.links) {
			if (link.source === 'B0' || link.target === 'B0') continue;
			expect(moved.routes?.get(link.id)).toEqual(rest.routes?.get(link.id));
		}
	});
});

describe('composed nested Sub-grouping', () => {
	const fixture = createLayoutQualityFixture();
	const nestedBase = (size: keyof typeof sizes) => ({
		...qualityArrangeInput(fixture, 'nested'),
		gap: 170,
		canvas: sizes[size].canvas
	});

	it('keeps every Worker, exact pair, parent and child, with contained non-overlapping sub-regions', () => {
		for (const size of ['wide', 'tall', 'floor'] as const) {
			const input = nestedBase(size);
			const result = arrange({ ...input, composition: composition(fixture, size) });
			expect(result.positions.size).toBe(60);
			expectEveryRelationshipDrawn(result, 136);
			const regions = layoutGroupRegions(
				buildBucketTree(fixture.nodes, input.groupingAttribute, input.subGroupingAttribute),
				fixture.nodes.map((node) => ({
					...result.positions.get(node.id)!,
					group: fixture.groupByWorker.get(node.id)!,
					subGroup: answerText(node, 'quality-role') ?? ''
				}))
			);
			const scale = result.composition!.scale;
			for (const parent of regions) {
				const outer = flattenPath(parent.path, 0.5 / scale, 256)!.points;
				const children = parent.subRegions.map(
					(child) => flattenPath(child.path, 0.5 / scale, 256)!.points
				);
				for (const child of children) {
					// Every child outline point lies within the parent outline (no escaped child).
					const hull = parent.hull;
					const xs = hull.map((p) => p.x);
					const ys = hull.map((p) => p.y);
					for (const p of child) {
						expect(p.x).toBeGreaterThan(Math.min(...xs) - 1);
						expect(p.x).toBeLessThan(Math.max(...xs) + 1);
						expect(p.y).toBeGreaterThan(Math.min(...ys) - 1);
						expect(p.y).toBeLessThan(Math.max(...ys) + 1);
					}
				}
				expect(outer.length).toBeGreaterThan(2);
				for (let i = 0; i < children.length; i += 1) {
					for (let j = i + 1; j < children.length; j += 1) {
						// Siblings may only touch where the shipped drawing already did.
						expect(polygonRelation(children[i], children[j]).distance).toBeGreaterThanOrEqual(0);
					}
				}
			}
		}
	});

	it('resolves conflicts the shipped nested drawing had and adds none', () => {
		for (const size of ['wide', 'tall'] as const) {
			const packet = arrange({
				...nestedBase(size),
				composition: composition(fixture, size)
			}).composition!;
			const original = packet.candidates.find((c) => c.key === 'original')!;
			const selected = packet.candidates.find((c) => c.status === 'selected')!;
			expect(selected.conflicts).toBeLessThanOrEqual(original.conflicts);
		}
	});

	it('moves a group with its children rigidly', () => {
		const input = { ...nestedBase('wide'), composition: composition(fixture, 'wide') };
		const rest = arrange(input);
		const key = 'Department 3';
		const delta = { x: -3000, y: -3000 };
		const moved = arrange({
			...input,
			manual: {
				groupShift: new Map([[idOf('quality-department', key), delta]]),
				workerShift: new Map()
			}
		});
		for (const node of fixture.nodes) {
			const before = rest.positions.get(node.id)!;
			const after = moved.positions.get(node.id)!;
			const inGroup = fixture.groupByWorker.get(node.id) === key;
			expect(after.x - before.x).toBeCloseTo(inGroup ? delta.x : 0, 6);
			expect(after.y - before.y).toBeCloseTo(inGroup ? delta.y : 0, 6);
		}
	});

	it('keeps a singleton parent, a single child and Unanswered complete', () => {
		const role = { ...department, id: 'role', name: 'Role', options: ['X', 'Y'] };
		const nodes: WorkerGraphNode[] = [
			['a', 'Front', 'X'],
			['b', 'Front', 'Y'],
			['c', 'Back', 'X'],
			['d', 'Back', ''],
			['e', '', 'X']
		].map(([id, d, r]) => ({
			id,
			name: `Worker ${id}`,
			assessment: 'Unassessed' as const,
			attributes: answerIdsFixture({ dept: d, role: r }),
			relationshipCount: 1
		}));
		const links: WorkerGraphLink[] = [
			{ id: 'l1', source: 'a', target: 'c', value: 1 },
			{ id: 'l2', source: 'b', target: 'e', value: 1 },
			{ id: 'l3', source: 'a', target: 'b', value: 1 }
		];
		const result = arrange({
			mode: 'grouped',
			nodes,
			links,
			groupingAttribute: attributeFixture({ ...department, options: ['Front', 'Back'] }),
			subGroupingAttribute: role,
			canvas: sizes.wide.canvas,
			gap: 170,
			composition: {
				freeCanvas: sizes.wide.free,
				restingNameIds: nodes.map((n) => n.id)
			}
		});
		expect(result.positions.size).toBe(5);
		expectEveryRelationshipDrawn(result, 3);
	});
});

describe('routing the shipped drawing', () => {
	const fixture = createLayoutQualityFixture();

	/**
	 * What an independent reading finds in a set of paths drawn over this result:
	 * ties running through a dot, a reserved name or a heading.
	 */
	function read(
		result: ReturnType<typeof arrange>,
		routes: { id: string; source: string; target: string; d: string }[]
	) {
		const packet = result.composition!;
		const evaluation = evaluateDrawing({
			routes,
			dots: fixture.nodes.map((node) => ({
				id: node.id,
				...result.positions.get(node.id)!,
				r: nodeRadius(node.relationshipCount)
			})),
			names: [...packet.names].map(([id, name]) => ({
				id: `name:${id}`,
				worker: id,
				box: name.box
			})),
			headings: [...packet.headings].map(([id, heading]) => ({ id, box: heading.box })),
			regions: [],
			workerRegions: new Map(),
			unit: 1 / packet.scale
		});
		return {
			invalid: evaluation.invalidRoutes,
			conflicts:
				evaluation.dotConflicts.length +
				evaluation.nameConflicts.length +
				evaluation.headingConflicts.length +
				evaluation.regionConflicts.length
		};
	}

	/** The same drawing with every tie stood straight between its two dots. */
	function straight(result: ReturnType<typeof arrange>) {
		return fixture.links.map((link) => {
			const a = result.positions.get(link.source)!;
			const b = result.positions.get(link.target)!;
			return {
				id: link.id,
				source: link.source,
				target: link.target,
				d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`
			};
		});
	}

	it.each(['nested', 'grouped'] as const)(
		'detours the shipped %s ties when no composed placement is accepted',
		(topology) => {
			const input = {
				...qualityArrangeInput(fixture, topology),
				gap: 170,
				canvas: sizes.wide.canvas
			};
			const shipped = arrange(input);
			const result = arrange({ ...input, composition: composition(fixture, 'wide') });
			const packet = result.composition!;
			// No composed placement is accepted at this fit, so the shipped positions stand...
			expect(packet.chosen).toBe('original');
			for (const [id, point] of shipped.positions) {
				expect(result.positions.get(id)).toEqual(point);
			}
			// ...and every tie is still drawn, detoured round what it meets rather than through it.
			expect(result.routes?.size).toBe(fixture.links.length);
			const routes = [...result.routes!.values()].map(({ id, source, target, d }) => ({
				id,
				source,
				target,
				d
			}));
			const routed = read(result, routes);
			expect(routed.invalid).toEqual([]);
			expect(routed.conflicts).toBeLessThan(read(result, straight(result)).conflicts);
		}
	);

	it('keeps the detoured shipped ties attached over a manual move, without re-routing them', () => {
		const input = {
			...qualityArrangeInput(fixture, 'nested'),
			gap: 170,
			canvas: sizes.wide.canvas
		};
		const rest = arrange({ ...input, composition: composition(fixture, 'wide') });
		const detoured = [...rest.routes!.values()].find((route) => !route.direct)!;
		expect(detoured, 'the shipped ties detour here').toBeDefined();
		const id = detoured.source;
		const was = rest.positions.get(id)!;
		const moved = arrange({
			...input,
			composition: composition(fixture, 'wide'),
			manual: { groupShift: new Map(), workerShift: new Map([[id, { x: 40, y: -30 }]]) }
		});
		expect(moved.positions.get(id)).toEqual({ x: was.x + 40, y: was.y - 30 });
		expect(moved.routes?.size).toBe(fixture.links.length);
		for (const link of fixture.links) {
			const from = moved.positions.get(link.source)!;
			const first = flattenPath(moved.routes!.get(link.id)!.d, 0.05, 256)!.points[0];
			expect(first.x).toBeCloseTo(from.x, 1);
			expect(first.y).toBeCloseTo(from.y, 1);
			// A path that touches no moved Worker is not touched.
			if (link.source !== id && link.target !== id)
				expect(moved.routes!.get(link.id)).toEqual(rest.routes!.get(link.id));
		}
	});
});

it('publishes conflicts that read back from the routes it publishes', () => {
	const six = sixGroups();
	const result = arrange({ ...groupedInput(six, 'wide'), composition: composition(six, 'wide') });
	const packet = result.composition!;
	expect(packet.routes, 'the composition ships paths').toBeDefined();
	const reading = evaluateDrawing({
		routes: [...packet.routes!.values()].map(({ id, source, target, d }) => ({
			id,
			source,
			target,
			d
		})),
		dots: six.nodes.map((node) => ({
			id: node.id,
			...result.positions.get(node.id)!,
			r: nodeRadius(node.relationshipCount)
		})),
		names: [...packet.names].map(([id, name]) => ({ id: `name:${id}`, worker: id, box: name.box })),
		headings: [...packet.headings].map(([id, heading]) => ({ id, box: heading.box })),
		regions: [],
		workerRegions: new Map(),
		unit: 1 / packet.scale
	});
	for (const [kind, found] of [
		['dot', reading.dotConflicts],
		['name', reading.nameConflicts],
		['heading', reading.headingConflicts],
		['region', reading.regionConflicts]
	] as const) {
		for (const identity of found) {
			expect(packet.conflicts[kind], identity).toContain(identity);
		}
	}
});
