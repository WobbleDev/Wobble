// @module-tag mapping
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arrange } from './graph-arrangement.ts';
import {
	asQualityRelationships,
	bodiesForVariant,
	createLayoutQualityFixture,
	partitionMaps,
	qualityArrangeInput
} from '#lib/testing/mapping/graph-layout-quality-fixture.ts';
import { scoreLayoutQuality } from './graph-layout-quality.ts';
import { nodeRadius } from '../map-style.ts';
import type { Point } from './graph-layout.ts';
import {
	answerIdsFixture,
	answerText,
	attributeFixture
} from '#lib/testing/mapping/answer-fixtures.ts';

const variants = ['free', 'grouped', 'nested'] as const;
const canvas = { width: 1280, height: 800 };

function pointInside(point: Point, polygon: readonly Point[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
		const a = polygon[i];
		const b = polygon[j];
		const crosses =
			a.y > point.y !== b.y > point.y &&
			point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
		if (crosses) inside = !inside;
	}
	return inside;
}

function arrangementMetrics(
	positions: ReadonlyMap<string, Point>,
	nodes: ReturnType<typeof createLayoutQualityFixture>['nodes'],
	regions: ReturnType<typeof arrange>['regions'],
	variant: (typeof variants)[number]
) {
	const radii = new Map(nodes.map((node) => [node.id, nodeRadius(node.relationshipCount)]));
	let overlapPairs = 0;
	let minimumSurfaceGap = Infinity;
	for (let i = 0; i < nodes.length; i += 1) {
		for (let j = i + 1; j < nodes.length; j += 1) {
			const a = positions.get(nodes[i].id);
			const b = positions.get(nodes[j].id);
			if (!a || !b) continue;
			const gap =
				Math.hypot(a.x - b.x, a.y - b.y) - radii.get(nodes[i].id)! - radii.get(nodes[j].id)!;
			minimumSurfaceGap = Math.min(minimumSurfaceGap, gap);
			if (gap < -1e-6) overlapPairs += 1;
		}
	}
	const escapedMembers =
		variant === 'free'
			? 0
			: nodes.filter((node) => {
					const position = positions.get(node.id);
					const region = regions.find(({ key }) =>
						key.includes(answerText(node, 'quality-department'))
					);
					if (!position || !region) return true;
					if (variant === 'nested') {
						const sub = region.subRegions.find(({ key }) =>
							key.endsWith(answerText(node, 'quality-role'))
						);
						return !sub || !pointInside(position, sub.hull);
					}
					return !pointInside(position, region.hull);
				}).length;
	const points = [...positions.values()];
	const extentWidth = points.length
		? Math.max(...points.map(({ x }) => x)) - Math.min(...points.map(({ x }) => x))
		: 0;
	const extentHeight = points.length
		? Math.max(...points.map(({ y }) => y)) - Math.min(...points.map(({ y }) => y))
		: 0;
	const requiredUniformFitScale = Math.min(
		(canvas.width - 112) / Math.max(extentWidth, 1),
		(canvas.height - 112) / Math.max(extentHeight, 1)
	);
	return {
		dotClearance: {
			overlapPairs,
			minimumSurfaceGap: Number.isFinite(minimumSurfaceGap) ? minimumSurfaceGap : 0
		},
		regionContainment: { escapedMembers },
		canvasFit: { requiredUniformFitScale, fitsWithUniformCameraScale: requiredUniformFitScale > 0 }
	};
}

function captureBaseline() {
	const fixture = createLayoutQualityFixture();
	const radii = new Map(fixture.nodes.map((node) => [node.id, nodeRadius(node.relationshipCount)]));
	const arrangements = Object.fromEntries(
		variants.map((variant) => {
			const input = qualityArrangeInput(fixture, variant);
			const start = performance.now();
			const result = arrange(input);
			const coldMs = performance.now() - start;
			const cachedStart = performance.now();
			arrange(input);
			const cachedMs = performance.now() - cachedStart;
			const score = scoreLayoutQuality({
				positions: result.positions,
				links: asQualityRelationships(fixture.links),
				bodies: bodiesForVariant(fixture, variant),
				outwardPartitions: partitionMaps(fixture, variant),
				canvas,
				radii,
				bodyPadding: input.gap / 2
			});
			return [
				variant,
				{
					positions: Object.fromEntries(
						[...result.positions].sort(([a], [b]) => a.localeCompare(b))
					),
					score,
					constraints: arrangementMetrics(result.positions, fixture.nodes, result.regions, variant),
					timingsMs: { coldArrange: coldMs, cachedArrange: cachedMs }
				}
			];
		})
	);
	const largeTimings = Object.fromEntries(
		['sparse', 'hub', 'grouped', 'nested', 'single-cluster'].map((shape) => {
			const n = 500;
			const workers = Array.from({ length: n }, (_, index) => ({
				id: `cost-${shape}-${index}`,
				name: `Cost Worker ${index}`,
				assessment: 'Unassessed' as const,
				attributes: answerIdsFixture({
					'quality-department': `Department ${Math.floor(index / 100) + 1}`,
					'quality-role': `Role ${String.fromCharCode(65 + (index % 4))}`
				}),
				relationshipCount: shape === 'hub' ? (index === 0 ? n - 1 : 1) : 3
			}));
			const pairs = new Set<string>();
			const add = (a: number, b: number) => {
				if (a === b) return;
				const low = Math.min(a, b);
				const high = Math.max(a, b);
				pairs.add(`${low},${high}`);
			};
			if (shape === 'hub') {
				for (let index = 1; index < n; index += 1) add(0, index);
			} else {
				for (let index = 0; index < n; index += 1) {
					if (shape === 'sparse' || shape === 'grouped' || shape === 'nested') {
						const perCluster = 10;
						const start = Math.floor(index / perCluster) * perCluster;
						add(index, start + ((index + 3) % perCluster));
						add(index, start + ((index + 7) % perCluster));
					} else {
						add(index, (index + 1) % n);
						add(index, (index + 7) % n);
					}
				}
			}
			const links = [...pairs].map((pair, index) => {
				const [source, target] = pair.split(',').map(Number);
				return {
					id: `cost-link-${index}`,
					source: workers[source].id,
					target: workers[target].id,
					value: 1
				};
			});
			const degrees = new Map(workers.map(({ id }) => [id, 0]));
			for (const link of links) {
				degrees.set(link.source, (degrees.get(link.source) ?? 0) + 1);
				degrees.set(link.target, (degrees.get(link.target) ?? 0) + 1);
			}
			for (const worker of workers) worker.relationshipCount = degrees.get(worker.id) ?? 0;
			const grouped = shape === 'grouped' || shape === 'nested';
			const input = {
				mode: grouped ? ('grouped' as const) : ('free' as const),
				nodes: workers,
				links,
				groupingAttribute: grouped
					? attributeFixture({
							id: 'quality-department',
							name: 'Department',
							kind: 'category' as const,
							options: qualityOptions
						})
					: undefined,
				subGroupingAttribute:
					shape === 'nested'
						? attributeFixture({
								id: 'quality-role',
								name: 'Role',
								kind: 'category' as const,
								options: ['Role A', 'Role B', 'Role C', 'Role D']
							})
						: undefined,
				canvas: { width: 1600, height: 1000 },
				gap: 80
			};
			const start = performance.now();
			const result = arrange(input);
			const coldMs = performance.now() - start;
			const cachedStart = performance.now();
			arrange(input);
			const cachedMs = performance.now() - cachedStart;
			return [
				shape,
				{
					workers: n,
					relationships: links.length,
					coldArrange: coldMs,
					cachedArrange: cachedMs,
					positions: result.positions.size
				}
			];
		})
	);
	return {
		metadata: {
			name: 'Synthetic Mapping arrangement baseline',
			createdAt: new Date().toISOString(),
			sourceRevision: process.env.BASELINE_SOURCE_REVISION ?? 'record with git rev-parse HEAD',
			geometrySource:
				'The public arrange API with the fixed 60-Worker quality fixture at a 1280×800 canvas.',
			fixtureDescription:
				'60 synthetic Workers in eight clusters with 16 ring inter-cluster Relationships; this does not reproduce unavailable hand-arranged screenshot data.',
			conditions: { canvas, gap: 80, radiusLaw: 'nodeRadius(relationshipCount)', bodyPadding: 40 },
			identities: {
				workers: fixture.nodes.map(({ id }) => id),
				relationships: fixture.links.map(({ id, source, target }) => ({ id, source, target })),
				clusters: Object.fromEntries(fixture.clusterByWorker),
				groups: Object.fromEntries(fixture.groupByWorker),
				subGroups: Object.fromEntries(fixture.subGroupByWorker)
			}
		},
		arrangements,
		costBaselines: {
			description:
				'Synthetic 500-Worker cost fixtures; one process, cold then immediate cached call; timings are observations, not test thresholds.',
			largeTimings
		}
	};
}

const qualityOptions = [
	'Department 1',
	'Department 2',
	'Department 3',
	'Department 4',
	'Department 5'
];

describe('synthetic arrangement baseline', () => {
	it('keeps the same 60 Workers and Relationships in Free, Grouped and nested arrangements', () => {
		const fixture = createLayoutQualityFixture();
		expect(fixture.nodes).toHaveLength(60);
		expect(fixture.clusterByWorker.size).toBe(60);
		expect(new Set(fixture.clusterByWorker.values()).size).toBe(8);
		for (const variant of variants) {
			const first = arrange(qualityArrangeInput(fixture, variant));
			expect(first.positions.size).toBe(60);
			expect(
				[...first.positions.values()].every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))
			).toBe(true);
			const second = arrange(qualityArrangeInput(fixture, variant));
			expect(second.positions).toEqual(first.positions);
		}
	});

	it('reduces crossings and pass-throughs for the ungrouped synthetic ring', () => {
		const fixture = createLayoutQualityFixture();
		const result = arrange(qualityArrangeInput(fixture, 'free'));
		const score = scoreLayoutQuality({
			positions: result.positions,
			links: asQualityRelationships(fixture.links),
			bodies: bodiesForVariant(fixture, 'free'),
			outwardPartitions: partitionMaps(fixture, 'free'),
			canvas,
			radii: new Map(fixture.nodes.map((n) => [n.id, nodeRadius(n.relationshipCount)])),
			bodyPadding: 40
		});
		expect(score.properCrossings).toBeLessThan(225);
		expect(score.bodyPassThroughs).toBeLessThan(15);
	});

	it.each(variants)(
		'keeps ties off unrelated dots, crossings near their middles and dots apart in %s',
		(variant) => {
			const fixture = createLayoutQualityFixture();
			const result = arrange(qualityArrangeInput(fixture, variant));
			const score = scoreLayoutQuality({
				positions: result.positions,
				links: asQualityRelationships(fixture.links),
				bodies: bodiesForVariant(fixture, variant),
				outwardPartitions: partitionMaps(fixture, variant),
				canvas,
				radii: new Map(fixture.nodes.map((n) => [n.id, nodeRadius(n.relationshipCount)])),
				bodyPadding: 40
			});
			expect(score.dotHits).toBe(0);
			// Fitting groups to the canvas costs a few crossings near an end.
			expect(score.endCrossings).toBeLessThan(score.properCrossings * 0.25);
			expect(score.minimumDotGap).toBeGreaterThanOrEqual(16);
		}
	);

	it('meets every original representative quality gate without changing the baseline', () => {
		const baseline = JSON.parse(
			readFileSync(
				resolve(process.cwd(), 'e2e/fixtures/mapping-layout-quality-baseline.json'),
				'utf8'
			)
		);
		const fixture = createLayoutQualityFixture();
		for (const variant of variants) {
			const request = qualityArrangeInput(fixture, variant);
			const result = arrange(request);
			const score = scoreLayoutQuality({
				positions: result.positions,
				links: asQualityRelationships(fixture.links),
				bodies: bodiesForVariant(fixture, variant),
				outwardPartitions: partitionMaps(fixture, variant),
				canvas,
				radii: new Map(fixture.nodes.map((n) => [n.id, nodeRadius(n.relationshipCount)])),
				bodyPadding: 40
			});
			const before = baseline.arrangements[variant].score;
			expect(score.properCrossings).toBeLessThan(before.properCrossings);
			expect(score.bodyPassThroughs).toBeLessThan(before.bodyPassThroughs);
			expect(score.longestToMedianRatio).toBeLessThanOrEqual(before.longestToMedianRatio + 1e-9);
			expect(score.normalizedOutwardLength).toBeLessThanOrEqual(
				before.normalizedOutwardLength + 1e-9
			);
			expect(
				arrangementMetrics(result.positions, fixture.nodes, result.regions, variant).dotClearance
					.overlapPairs
			).toBe(0);
			expect(
				arrangementMetrics(result.positions, fixture.nodes, result.regions, variant)
					.regionContainment.escapedMembers
			).toBe(0);
		}
	});

	it.skipIf(
		process.env.CAPTURE_LAYOUT_BASELINE !== '1' && process.env.CAPTURE_MAPPING_BASELINE !== '1'
	)(
		'writes the current Mapping arrangement evidence only on explicit capture',
		() => {
			const path = resolve(
				process.cwd(),
				process.env.CAPTURE_MAPPING_BASELINE === '1'
					? '.scratch/mapping-live-directions/baseline/arrangement-quality.json'
					: 'e2e/fixtures/mapping-layout-quality-baseline.json'
			);
			mkdirSync(resolve(path, '..'), { recursive: true });
			writeFileSync(path, `${JSON.stringify(captureBaseline(), null, 2)}\n`);
			expect(path).toContain(
				process.env.CAPTURE_MAPPING_BASELINE === '1'
					? 'arrangement-quality.json'
					: 'mapping-layout-quality-baseline.json'
			);
		},
		30_000
	);
});
