// @module-tag mapping
/**
 * The composed Grouped drawing of the browser specs' six-Group Worksite
 * (`e2e/mapping-composition-dataset.ts`), read back the way the browser read it: the
 * drawn dots and exact pairs, and the independent evaluation of the final paths.
 */
import { describe, expect, it } from 'vitest';
import { sixGroupWorksite } from '../../../../../e2e/mapping-composition-dataset.ts';
import { worksiteGraph } from '#lib/testing/mapping/composition-worksite-fixture.ts';
import { arrange } from '../layout/graph-arrangement.ts';
import { buildBucketTree, groupValue } from '../layout/graph-analysis.ts';
import { layoutGroupRegions } from '../layout/graph-layout.ts';
import { evaluateDrawing } from '../layout/graph-layout-quality.ts';
import { groupGapDefault } from '../layout/graph-group-physics.ts';
import { flattenPath } from '../layout/graph-shapes.ts';
import { nodeRadius } from '../map-style.ts';
import { labelledWorkerIds } from '../map-view-model.ts';

/** The browser specs' three canvases; the free canvas is what the control strip leaves. */
const canvases = {
	wide: { width: 1600, height: 1000 },
	tall: { width: 1000, height: 1400 },
	floor: { width: 1024, height: 640 }
} as const;
const stripHeight = 100;

const worksite = sixGroupWorksite();
const graph = worksiteGraph(worksite);
const department = graph.attributes.get('Department')!;

/** What the canvas draws for a Worksite at a canvas size: the arrangement and its evaluation. */
function composed(size: keyof typeof canvases) {
	const canvas = canvases[size];
	const result = arrange({
		mode: 'grouped',
		nodes: graph.nodes,
		links: graph.links,
		groupingAttribute: department,
		canvas,
		gap: groupGapDefault,
		composition: {
			freeCanvas: { width: canvas.width, height: canvas.height - stripHeight },
			restingNameIds: [...labelledWorkerIds(graph.nodes, {})]
		}
	});
	const packet = result.composition!;
	const unit = 1 / packet.scale;
	// The routes the drawing publishes; without them the shipped straight ties stand.
	const routes = graph.links.map((link) => {
		const published = result.routes?.get(link.id);
		const a = result.positions.get(link.source)!;
		const b = result.positions.get(link.target)!;
		return {
			id: link.id,
			source: link.source,
			target: link.target,
			d: published?.d ?? `M ${a.x} ${a.y} L ${b.x} ${b.y}`
		};
	});
	const regions = layoutGroupRegions(
		buildBucketTree(graph.nodes, department, undefined),
		graph.nodes.map((node) => ({
			...result.positions.get(node.id)!,
			group: groupValue(node, department),
			subGroup: ''
		}))
	).flatMap((region) => {
		const flat = region.outlined ? flattenPath(region.path, 0.5 * unit, 256) : undefined;
		return flat ? [{ key: region.key, polygon: flat.points, outlined: true }] : [];
	});
	const evaluation = evaluateDrawing({
		routes,
		dots: graph.nodes.map((node) => ({
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
		chrome: [],
		regions,
		workerRegions: new Map(
			graph.nodes.map((node) => [node.id, [groupValue(node, department) || '__unassigned']])
		),
		unit
	});
	return { result, packet, routes, evaluation };
}

describe('the six-Group Worksite composed for the canvas', () => {
	for (const size of Object.keys(canvases) as (keyof typeof canvases)[]) {
		it(`draws every Worker and the exact pair of every Relationship, with independently checked paths (${size})`, () => {
			const { result, packet, routes, evaluation } = composed(size);
			expect(result.routes?.size, 'the drawing publishes a final path per pair').toBe(
				worksite.relationships.length
			);
			expect([...result.positions.keys()].sort()).toEqual([...graph.ids].sort());
			const stored = worksite.relationships.map(([a, b]) =>
				[graph.ids[a], graph.ids[b]].sort().join('|')
			);
			const rendered = routes.map((route) => [route.source, route.target].sort().join('|'));
			expect(rendered.sort(), 'every pair once').toEqual([...stored].sort());
			expect(evaluation.invalidRoutes, 'endpoints attach exactly').toEqual([]);
			// The packet may keep conflicts the shipped drawing had; the independent reading
			// must find no others.
			for (const [kind, found] of [
				['dot', evaluation.dotConflicts],
				['name', evaluation.nameConflicts],
				['heading', evaluation.headingConflicts],
				['region', evaluation.regionConflicts]
			] as const) {
				for (const identity of found) expect(packet.conflicts[kind], identity).toContain(identity);
			}
			expect(evaluation.regionConflicts).toEqual([]);
		});
	}

	it('traces three fixed pairs through their routes and avoids the Workers between', () => {
		const { routes, evaluation } = composed('wide');
		const at = (key: string) => graph.ids[(key.charCodeAt(0) - 65) * 6 + Number(key[1])];
		// A0-C0 (a bridge between two groups), B0-E0 (a bridge down the chain), A0-B0 (a short hop).
		for (const [first, second] of [
			['A0', 'C0'],
			['B0', 'E0'],
			['A0', 'B0']
		]) {
			const a = at(first);
			const b = at(second);
			const route = routes.find(
				(r) => (r.source === a && r.target === b) || (r.source === b && r.target === a)
			);
			expect(route, `${first}-${second} is drawn`).toBeDefined();
			expect(
				evaluation.dotConflicts.filter((identity) => identity.startsWith(`${route!.id}:`)),
				`${first}-${second} stays clear of the Workers between`
			).toEqual([]);
		}
	});
});
