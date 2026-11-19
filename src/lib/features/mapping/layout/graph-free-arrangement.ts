/**
 * The ungrouped arrangement: free physics over the whole graph, gathered by cluster, oriented
 * by relationship, fitted to the canvas and tidied. `graph-arrangement` chooses this mode and
 * owns the caches; a Free frame is one pass over the graph here.
 */
import { detectClusters, gatherStart } from './graph-clusters.ts';
import { freePhysicsLayout } from './graph-free-physics.ts';
import { orientBodies } from './graph-body-orientation.ts';
import { fanLeaves, type LeafBound } from './graph-leaf-placement.ts';
import { fitAndSeparate } from './graph-stress.ts';
import { tidyLayout } from './graph-tidy.ts';
import { subGroupTidySlack } from './graph-grouped-scope.ts';
import type { Point } from './graph-layout.ts';
import type { ArrangeInput } from './graph-arrangement.ts';

/** The low alpha a fresh Free layout settles at from its gathered start. */
const freeGatherAlpha = 0.05;
/** Padding handed to the final dot separator of the ungrouped layout, in layout units. */
const freeFitPad = 10;

/** One ungrouped frame: gather the clusters, settle the physics, orient, fit and tidy. */
export function arrangeFree(
	input: ArrangeInput,
	canvas: ArrangeInput['canvas'],
	radiusFor: (id: string) => number
): { positions: Map<string, Point>; crossLinkIds: Set<string> } {
	const { nodes, links } = input;
	const positions = new Map<string, Point>();
	const crossLinkIds = new Set<string>();
	// Ungrouped: free physics over the whole graph, from a fresh gathered start.
	const clusters = detectClusters(
		nodes.map((node) => node.id),
		links
	);
	const gathered = gatherStart(
		nodes.map((node) => node.id),
		clusters,
		canvas,
		links,
		radiusFor
	);

	const laid = freePhysicsLayout(
		nodes.map((node) => ({ id: node.id })),
		links.map((link) => ({ source: link.source, target: link.target })),
		{ width: canvas.width, height: canvas.height },
		{ start: gathered, alpha: freeGatherAlpha }
	);
	const oriented = orientBodies(
		laid,
		new Map([...clusters].map(([id, key]) => [id, String(key)])),
		links,
		radiusFor
	);
	// Preserve the existing uniform fit after rigid orientation. The final
	// separator corrects only dot clearance; it does not re-aim clusters.
	const fanned = fanLeaves(oriented, links, radiusFor);
	const fitted = fitAndSeparate(fanned, radiusFor, canvas, { pad: freeFitPad });
	// Each Worker tidies within reach of its cluster, so a cluster stays one
	// cluster. Tidy can move a hub; its leaves are fanned again around it.
	const placed = fanLeaves(
		tidyLayout(fitted, links, radiusFor, {
			bounds: clusterBounds(fitted, clusters, radiusFor)
		}),
		links,
		radiusFor
	);
	for (const [id, point] of placed) positions.set(id, point);

	return { positions, crossLinkIds };
}

/** Each Worker's cluster circle, with the same give sub-group members get. */
function clusterBounds(
	positions: ReadonlyMap<string, Point>,
	clusters: ReadonlyMap<string, unknown>,
	radiusFor: (id: string) => number
): Map<string, LeafBound> {
	const members = new Map<unknown, string[]>();
	for (const id of positions.keys()) {
		const key = clusters.get(id) ?? id;
		const list = members.get(key) ?? [];
		list.push(id);
		members.set(key, list);
	}
	const bounds = new Map<string, LeafBound>();
	for (const ids of members.values()) {
		const centre = {
			x: ids.reduce((sum, id) => sum + positions.get(id)!.x, 0) / ids.length,
			y: ids.reduce((sum, id) => sum + positions.get(id)!.y, 0) / ids.length
		};
		const radius = Math.max(
			...ids.map((id) => {
				const p = positions.get(id)!;
				return Math.hypot(p.x - centre.x, p.y - centre.y) + radiusFor(id);
			})
		);
		for (const id of ids) bounds.set(id, { centre, radius: radius + subGroupTidySlack });
	}
	return bounds;
}
