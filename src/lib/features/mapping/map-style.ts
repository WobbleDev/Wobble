/**
 * The Relationship map's reading rules: how strongly a Worker or a tie is drawn,
 * and how large a dot is.
 *
 * Pure functions of the view model — no DOM and no runes, so they can be
 * unit-tested directly.
 */
import { linkEndId } from './layout/graph-analysis.ts';
import type { MapViewModel } from './map-view-model.ts';
import type { WorkerGraphLink, WorkerGraphNode } from './canvas/worker-relationship-map-model.ts';

/**
 * How solid a Worker's dot is drawn.
 *
 * The Worker being read wins over the degree it sits on, so a ghosted
 * second-degree Worker still answers a hover or a selection at full strength.
 */
export function nodeOpacity(node: WorkerGraphNode, viewModel: MapViewModel): number {
	if (viewModel.selectedId === node.id || viewModel.hoveredId === node.id) return 1;
	if (viewModel.ghostedIds.has(node.id)) return 0.16;
	if (viewModel.spotlightIds.size > 0 && !viewModel.spotlightIds.has(node.id)) return 0.28;
	if (isHighlightFaded(node.id, viewModel)) return 0.28;

	return 0.94;
}

/**
 * Whether a complete Highlight query fades a Worker. The selected and hovered
 * Workers are never faded by it: they answer at full strength, as they do for the
 * spotlight. Without a complete query nothing is faded.
 */
export function isHighlightFaded(nodeId: string, viewModel: MapViewModel): boolean {
	const { highlightIds } = viewModel;
	if (highlightIds === undefined) return false;
	if (viewModel.selectedId === nodeId || viewModel.hoveredId === nodeId) return false;

	return !highlightIds.has(nodeId);
}

/** How solid a tie is drawn, given what is ghosted, spotlit and grouped. */
export function linkOpacity(link: WorkerGraphLink, viewModel: MapViewModel): number {
	const source = linkEndId(link.source);
	const target = linkEndId(link.target);

	if (viewModel.ghostedIds.has(source) || viewModel.ghostedIds.has(target)) return 0.1;
	if (isEgoLink(link, viewModel)) return 0.9;
	if (
		viewModel.spotlightIds.size > 0 &&
		!(viewModel.spotlightIds.has(source) && viewModel.spotlightIds.has(target))
	) {
		return 0.12;
	}
	if (viewModel.highlightIds !== undefined) {
		if (!(viewModel.highlightIds.has(source) && viewModel.highlightIds.has(target))) return 0.12;
	}

	// The bridges between Grouping regions are the figure; the ties inside one
	// region fall back so those bridges can be read against them. `stroke-border`
	// was a line one shade off the surface, so most ties disappeared: the ink-3
	// token carries them instead, and these stops keep a cross tie readable
	// against the within ties it crosses.
	const region = viewModel.linkRegions.get(link.id);
	if (region === 'cross') return 0.6;
	if (region === 'within') return 0.35;

	return 0.5;
}

/** Whether a tie touches the Worker whose record is open. */
export function isEgoLink(link: WorkerGraphLink, viewModel: MapViewModel): boolean {
	const source = linkEndId(link.source);
	const target = linkEndId(link.target);
	return source === viewModel.selectedId || target === viewModel.selectedId;
}

/**
 * A size in screen pixels, read in the layer's own user units.
 *
 * The canvas draws inside a `<g>` the camera scales, so every length written
 * into that group is multiplied by the zoom: type and strokes written in user
 * units shrink as the map is zoomed out. Dividing the wanted screen size by the
 * zoom holds it at that size at every camera scale, which is what keeps a name
 * legible at the fit and still legible two zoom-ins later.
 *
 * A zoom that is zero, negative or not a number cannot divide anything: the
 * size is then taken as already being in user units.
 */
export function screenFixed(size: number, zoom: number): number {
	return Number.isFinite(zoom) && zoom > 0 ? size / zoom : size;
}

/**
 * How far a dot reaches for the pointer.
 *
 * The painted dot is a 3-unit disc for a lone Worker — six pixels across, a
 * quarter of the 24px a touch target needs — so the pointer is caught by its own
 * transparent circle instead. The target is the wider of a 6-unit apron around
 * the dot and 12 pixels at the current zoom (a 24px target), so a hub keeps
 * its apron and a small dot keeps a reachable one when the map is zoomed out.
 */
export function hitRadius(radius: number, zoom: number): number {
	return Math.max(radius + 6, screenFixed(12, zoom));
}

/**
 * Whether a Worker's name is drawn on the map.
 *
 * A name is kept for the Workers the cap left labelled, but only where it can
 * still be read: a ghosted Worker and a Worker outside the spotlight are already
 * drawn as smudges, and a grey name over them is noise rather than a label. The
 * Worker being read is the exception — a selection or a hover answers at full
 * strength, so its name stays wherever the cap had it.
 */
export function showsLabel(nodeId: string, viewModel: MapViewModel): boolean {
	if (!viewModel.labelIds.has(nodeId)) return false;
	if (viewModel.selectedId === nodeId || viewModel.hoveredId === nodeId) return true;
	if (isHighlightFaded(nodeId, viewModel)) return false;
	if (viewModel.ghostedIds.has(nodeId) && !viewModel.isolated) return false;
	if (viewModel.spotlightIds.size > 0 && !viewModel.spotlightIds.has(nodeId)) return false;

	return true;
}

/**
 * A Worker's dot radius from its recorded Relationship count.
 *
 * The approved bound is `min(4 + 4 * degree, 24)`: a lone Worker draws at 4
 * user units, and a hub caps at 24 instead of sizing the canvas around itself
 * — hub spacing in the layouts keeps the degree difference readable without a
 * larger disc. The cap means a radius never reports an exact count back — the
 * count stays in the node's accessible name and in the dossier, which is
 * where exactness lives.
 */
export function nodeRadius(relationshipCount: number): number {
	const degree = Number.isFinite(relationshipCount)
		? Math.max(0, Math.floor(relationshipCount))
		: 0;
	return Math.min(4 + 4 * degree, 24);
}

/**
 * A node's own boundary: hollow for the Unassessed, panel-edged for everyone
 * else, so a filled dot always reads as a standing.
 */
export function nodeStroke(
	node: WorkerGraphNode,
	colorFor: (node: WorkerGraphNode) => string
): string {
	return node.assessment === 'Unassessed' ? colorFor(node) : 'var(--panel)';
}
