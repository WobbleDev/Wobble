/**
 * The finished drawing: headings, names and routes at a candidate's own fit,
 * and the fixed-position variant for a manual placement.
 */
import {
	boxFor,
	nameLeader,
	placeLabels,
	placeRegionLabels,
	segmentCrossesBox,
	type LabelRequest
} from '../labels/graph-label-placement.ts';
import {
	evaluateDrawing,
	type DrawingEvaluation,
	type DrawingInput
} from '../graph-layout-quality.ts';
import {
	buildObstacleIndex,
	routeRelationships,
	type Route,
	type RouteObstacleSpec
} from '../routing/graph-relationship-routing.ts';
import type { GroupRegion, Point, Region } from '../graph-layout.ts';
import type { Box } from '../graph-shapes.ts';
import type { ComposerContext, Layout } from './graph-composition-context.ts';
import { spacingPolicy } from './graph-composition-context.ts';
import {
	chainOf,
	distance,
	fitScale,
	fitScaleWithHeadings,
	frameOf,
	outlineProxy,
	regionsOf
} from './graph-composition-layout.ts';
import { sizeOfHeading, sizeOfName } from './graph-composition-text.ts';
import type { ChildMetrics } from './graph-composition-children.ts';
import { compositionWorkLimits, createWorkBudget, WorkExhausted } from '../graph-work-budget.ts';

export type NamePlacement = {
	x: number;
	y: number;
	textAnchor: 'start' | 'middle' | 'end';
	side: string;
	box: Box;
	/** A short leader from the dot's surface to the name, when the name stands off. */
	leader?: { x1: number; y1: number; x2: number; y2: number };
};

export type HeadingPlacement = {
	labelAt: Region['labelAt'];
	box: Box;
	displayLabel?: string;
	displayCount?: boolean;
};

/** The published paths, with the evaluation that reads those very paths back. */
type PublishedDrawing = {
	routes: Map<string, Route>;
	evaluation: DrawingEvaluation;
};

export type Drawing = {
	key: string;
	layout: Layout;
	scale: number;
	extent: Box;
	regions: GroupRegion[];
	names: Map<string, NamePlacement>;
	headings: Map<string, HeadingPlacement>;
	routes: Map<string, Route>;
	/** The routes with long near-parallel ties laned; run once, on the drawing that is published. */
	tidy?: () => Map<string, Route>;
	/**
	 * The routes the packet publishes, with the conflicts read back from those very paths.
	 * The drawing is evaluated before its lanes are tidied, so the pre-tidy reading can miss
	 * a conflict a tidied lane creates; this closes that gap once, lazily.
	 */
	finalize?: () => PublishedDrawing;
	unresolved: string[];
	evaluation: DrawingEvaluation;
	/** Smallest gap between two top-level outlines, in CSS pixels at the drawing's own fit. */
	outlineGapPx: number;
	/** Smallest gap between two sibling child outlines, in CSS pixels; Infinity without a Sub-grouping. */
	childGapPx: number;
	/** An outlined child with a vertex outside its parent's drawn outline, if any. */
	escapedChild?: string;
	/** The floating chrome this fit reserved, already in map units. */
	chrome: Box[];
	reason?: string;
};

export function buildDrawing(
	ctx: ComposerContext,
	key: string,
	layout: Layout,
	mode: 'original' | 'composed',
	fixedScale?: number,
	childMetrics?: ChildMetrics
): Drawing {
	const fit = fitDrawing(ctx, layout, mode, fixedScale);
	const names = placeNames(ctx, mode, fit);
	const { routes, unresolved, regionList, tidy } = routeDrawing(ctx, mode, fit, names);
	const geometry: DrawingGeometry = {
		positions: fit.positions,
		unit: fit.unit,
		headingBoxes: fit.headingBoxes,
		chrome: fit.chrome,
		regions: regionList
	};
	const evaluation = evaluateDrawing(drawingInput(ctx, geometry, names, routes));
	const finalize = finalizeWithTidy(ctx, geometry, names, routes, evaluation, tidy);
	// Child clearance and containment arrive with the drawing's interior:
	// every top-level move is rigid within each parent, so they are measured
	// once per interior and converted at the drawing's own fit here.
	return {
		key,
		layout,
		scale: fit.scale,
		extent: fit.extent,
		regions: fit.regions,
		names,
		headings: fit.headings,
		routes,
		tidy,
		finalize,
		unresolved,
		evaluation,
		outlineGapPx: Number.isFinite(evaluation.outlineGap)
			? evaluation.outlineGap * fit.scale
			: Infinity,
		childGapPx: childMetrics ? childMetrics.gapMap * fit.scale : Infinity,
		escapedChild: childMetrics?.escaped,
		chrome: fit.chrome
	};
}

type DrawingGeometry = {
	positions: ReadonlyMap<string, Point>;
	unit: number;
	headingBoxes: readonly { id: string; box: Box }[];
	chrome: readonly Box[];
	regions: readonly RegionObstacle[];
};

/** The drawing as the independent evaluation reads it back: paths, shapes and reserved text. */
function drawingInput(
	ctx: ComposerContext,
	{ positions, unit, headingBoxes, chrome, regions }: DrawingGeometry,
	names: Map<string, NamePlacement>,
	routes: Map<string, Route>
): DrawingInput {
	return {
		routes: [...routes.values()].map(({ id, source, target, d }) => ({ id, source, target, d })),
		dots: ctx.nodes.map((node) => ({
			id: node.id,
			...positions.get(node.id)!,
			r: ctx.params.radiusFor(node.id)
		})),
		names: [...names].map(([id, placement]) => ({
			id: `name:${id}`,
			worker: id,
			box: placement.box
		})),
		headings: [...headingBoxes],
		chrome: chrome.map((box, i) => ({ id: `chrome:${i}`, box })),
		regions,
		workerRegions: new Map(ctx.nodes.map((node) => [node.id, chainOf(ctx, node.id)])),
		unit,
		budget: ctx.budget
	};
}

/**
 * The routes a drawing really shows, re-read so its conflicts describe those very paths.
 * Returns the pre-tidy reading unchanged when tidy tracked nothing (same Map instance).
 * The fresh budget keeps this reading from spending the allowance selection still needs.
 */
function finalizeWithTidy(
	ctx: ComposerContext,
	geometry: DrawingGeometry,
	names: Map<string, NamePlacement>,
	routes: Map<string, Route>,
	preTidy: DrawingEvaluation,
	tidy: (() => Map<string, Route>) | undefined
): (() => PublishedDrawing) | undefined {
	if (!tidy) return undefined;
	let published: PublishedDrawing | undefined;
	return () => {
		if (published) return published;
		const tidied = tidy();
		if (tidied === routes) {
			published = { routes, evaluation: preTidy };
			return published;
		}
		let evaluation: DrawingEvaluation;
		try {
			evaluation = evaluateDrawing({
				...drawingInput(ctx, geometry, names, tidied),
				budget: createWorkBudget(compositionWorkLimits)
			});
		} catch (error) {
			if (!(error instanceof WorkExhausted)) throw error;
			// A pathological allowance leaves no reading of the tidied routes: the pre-tidy
			// drawing and its reading are published unchanged, so the report always
			// describes the paths that are drawn.
			published = { routes, evaluation: preTidy };
			return published;
		}
		published = { routes: tidied, evaluation };
		return published;
	};
}

/**
 * The reference fit with the shipped drawing's headings counted: they are placed at the
 * plain fit by the drawing's own placement, on a budget of their own so the solve's
 * allowance is untouched, and the fit shrinks once if they reach past the free canvas.
 * A map whose headings fit keeps its reference scale exactly.
 */
export function fitReferenceToHeadings(ctx: ComposerContext): void {
	try {
		const probe = { ...ctx, budget: createWorkBudget(compositionWorkLimits) };
		const fit = fitDrawing(probe, ctx.original, 'original', ctx.referenceScale);
		const scale = fitScaleWithHeadings(
			fit.hullExtent,
			fit.headingBoxes.map(({ box }) => box),
			ctx.referenceScale,
			ctx.free
		);
		ctx.referenceScale = scale;
		ctx.unit0 = 1 / scale;
	} catch (error) {
		if (!(error instanceof WorkExhausted)) throw error;
	}
}

type DrawingFit = {
	positions: ReadonlyMap<string, Point>;
	hullExtent: Box;
	chords: { source: string; target: string; ax: number; ay: number; bx: number; by: number }[];
	scale: number;
	extent: Box;
	unit: number;
	regions: GroupRegion[];
	headings: Map<string, HeadingPlacement>;
	headingBoxes: { id: string; box: Box }[];
	chrome: Box[];
};

type RegionObstacle = {
	key: string;
	parent: string | undefined;
	polygon: Point[];
	outlined: boolean;
	convex: boolean;
};

function fitDrawing(
	ctx: ComposerContext,
	layout: Layout,
	mode: 'original' | 'composed',
	fixedScale?: number
): DrawingFit {
	const positions = layout.positions;
	const hullExtent = frameOf(ctx, positions, regionsOf(ctx, positions));
	const chords = ctx.links.flatMap((link) => {
		const a = positions.get(link.source);
		const b = positions.get(link.target);
		return a && b
			? [{ source: link.source, target: link.target, ax: a.x, ay: a.y, bx: b.x, by: b.y }]
			: [];
	});
	/** The reserved chrome in map units, for a camera that centres `frame` at scale `at`. */
	const chromeAt = (frame: Box, at: number): Box[] =>
		(ctx.params.composition.reserved ?? []).map((rect) => {
			const cx = (frame.left + frame.right) / 2;
			const cy = (frame.top + frame.bottom) / 2;
			return {
				left: cx + (rect.x - ctx.free.width / 2) / at,
				top: cy + (rect.y - ctx.free.height / 2) / at,
				right: cx + (rect.x + rect.width - ctx.free.width / 2) / at,
				bottom: cy + (rect.y + rect.height - ctx.free.height / 2) / at
			};
		});
	/** Headings at a fit: measured, placed clear of the ties and the chrome, and as boxes. */
	const placeHeadings = (at: number, chrome: readonly Box[]) => {
		const unit = 1 / at;
		const regions = regionsOf(ctx, positions);
		const room = {
			x: (hullExtent.left + hullExtent.right) / 2 - ctx.free.width * unit,
			y: (hullExtent.top + hullExtent.bottom) / 2 - ctx.free.height * unit,
			width: ctx.free.width * 2 * unit,
			height: ctx.free.height * 2 * unit
		};
		ctx.budget.spend('placement', regions.length * 10 * chords.length);
		placeRegionLabels(
			regions,
			room,
			ctx.counts,
			new Set(),
			chrome.map((box) => ({
				x: box.left,
				y: box.top,
				width: box.right - box.left,
				height: box.bottom - box.top
			})),
			(region) => {
				const size = sizeOfHeading(ctx, region.key);
				return {
					width: size.width * unit,
					height: size.height * unit,
					baseline: size.baseline === undefined ? undefined : size.baseline * unit
				};
			},
			mode === 'original'
				? undefined
				: (box) =>
						chords.filter((tie) =>
							segmentCrossesBox(
								{ left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height },
								tie
							)
						).length
		);
		const headings = new Map<string, HeadingPlacement>();
		const headingBoxes = regions
			.flatMap((top) => [top, ...top.subRegions])
			.flatMap((region) => {
				const box = region.labelBox;
				if (!box) return [];
				const rect = {
					left: box.x,
					top: box.y,
					right: box.x + box.width,
					bottom: box.y + box.height
				};
				headings.set(region.key, {
					labelAt: region.labelAt,
					box: rect,
					displayLabel: region.displayLabel,
					displayCount: region.displayCount
				});
				return [{ id: region.key, box: rect }];
			});
		return { regions, headings, headingBoxes };
	};
	const unionWith = (frame: Box, boxes: readonly { box: Box }[]) =>
		boxes.reduce<Box>(
			(box, { box: h }) => ({
				left: Math.min(box.left, h.left),
				top: Math.min(box.top, h.top),
				right: Math.max(box.right, h.right),
				bottom: Math.max(box.bottom, h.bottom)
			}),
			frame
		);
	let scale =
		fixedScale ?? (mode === 'original' ? ctx.referenceScale : fitScale(hullExtent, ctx.free));
	let placed = placeHeadings(scale, chromeAt(hullExtent, scale));
	// The frame the camera will fit includes the headings. One refit, one re-placement:
	// the fit and the geometry are never iterated to convergence.
	const extent = unionWith(hullExtent, placed.headingBoxes);
	let chrome = chromeAt(extent, scale);
	if (fixedScale === undefined && mode === 'composed') {
		const refit = fitScale(extent, ctx.free);
		if (Math.abs(refit / scale - 1) > 0.005 || (ctx.params.composition.reserved?.length ?? 0) > 0) {
			scale = refit;
			chrome = chromeAt(extent, scale);
			placed = placeHeadings(scale, chrome);
		}
	} else if ((ctx.params.composition.reserved?.length ?? 0) > 0) {
		placed = placeHeadings(scale, chrome);
	}
	const unit = 1 / scale;
	const { regions, headings, headingBoxes } = placed;
	return {
		positions,
		hullExtent,
		chords,
		scale,
		extent,
		unit,
		regions,
		headings,
		headingBoxes,
		chrome
	};
}

function placeNames(
	ctx: ComposerContext,
	mode: 'original' | 'composed',
	{ positions, unit, headingBoxes, chrome, chords }: DrawingFit
): Map<string, NamePlacement> {
	// Names: after headings, before routes, so neither can hide one.
	const requests: LabelRequest[] = ctx.resting.flatMap((id) => {
		const point = positions.get(id);
		if (!point) return [];
		const size = sizeOfName(ctx, id);
		return [
			{
				id,
				x: point.x,
				y: point.y,
				radius: ctx.params.radiusFor(id),
				width: (size.width + 3) * unit,
				height: size.height * unit
			}
		];
	});
	const obstacles = ctx.nodes.map((node) => ({
		id: node.id,
		...positions.get(node.id)!,
		radius: ctx.params.radiusFor(node.id)
	}));
	ctx.budget.spend('placement', requests.length * (obstacles.length + ctx.links.length) * 8);
	const placements = placeLabels(
		requests,
		obstacles,
		spacingPolicy.nameOffsetsPx[0] * unit,
		[...headingBoxes.map(({ box }) => box), ...chrome],
		chords,
		mode === 'original'
			? {}
			: {
					rings: spacingPolicy.nameOffsetsPx.map((px) => px / spacingPolicy.nameOffsetsPx[0]),
					tieWeight: 6
				}
	);
	const names = new Map<string, NamePlacement>();
	for (const request of requests) {
		const placement = placements.get(request.id)!;
		const box = boxFor(request, placement);
		const leader =
			mode === 'composed' ? nameLeader(request, box, spacingPolicy.leaderMinPx * unit) : undefined;
		names.set(request.id, { ...placement, box, leader });
	}
	return names;
}

/** The drawn outlines as routing obstacles: one convex proxy each, at this fit. */
function regionObstacles(regions: readonly GroupRegion[], unit: number): RegionObstacle[] {
	return regions.flatMap((top) =>
		[top, ...top.subRegions]
			.filter((region) => region.outlined)
			.map((region) => ({
				key: region.key,
				parent: region === top ? undefined : top.key,
				polygon: outlineProxy(region, unit),
				outlined: true,
				convex: true
			}))
	);
}

/** Every dot, reserved name, heading and outline as the router sees it, then the routes over them. */
function routeOver(
	ctx: ComposerContext,
	positions: ReadonlyMap<string, Point>,
	names: Map<string, NamePlacement>,
	headingBoxes: readonly { id: string; box: Box }[],
	regionList: readonly RegionObstacle[],
	unit: number
): { routes: Map<string, Route>; unresolved: string[]; tidy: () => Map<string, Route> } {
	const specs: RouteObstacleSpec[] = [
		...ctx.nodes.map((node): RouteObstacleSpec => {
			const p = positions.get(node.id)!;
			return {
				id: `dot:${node.id}`,
				kind: 'dot',
				worker: node.id,
				x: p.x,
				y: p.y,
				r: ctx.params.radiusFor(node.id)
			};
		}),
		...[...names].map(([id, placement]): RouteObstacleSpec => ({
			id: `name:${id}`,
			kind: 'name',
			worker: id,
			box: placement.box
		})),
		...headingBoxes.map(({ id, box }): RouteObstacleSpec => ({
			id: `heading:${id}`,
			kind: 'heading',
			box
		})),
		...regionList.map((region): RouteObstacleSpec => ({
			id: `region:${region.key}`,
			kind: 'region',
			region: region.key,
			polygon: region.polygon
		}))
	];
	const index = buildObstacleIndex(specs, { unit }, ctx.budget);
	return routeRelationships({
		requests: ctx.links.map((link) => ({
			id: link.id,
			source: link.source,
			target: link.target
		})),
		positions,
		index,
		endpointRegions: new Map(ctx.nodes.map((node) => [node.id, chainOf(ctx, node.id)])),
		budget: ctx.budget
	});
}

function routeDrawing(
	ctx: ComposerContext,
	mode: 'original' | 'composed',
	{ positions, unit, regions, headingBoxes }: DrawingFit,
	names: Map<string, NamePlacement>
): {
	routes: Map<string, Route>;
	unresolved: string[];
	regionList: RegionObstacle[];
	tidy?: () => Map<string, Route>;
} {
	const regionList = regionObstacles(regions, unit);
	if (mode === 'composed') {
		return { ...routeOver(ctx, positions, names, headingBoxes, regionList, unit), regionList };
	}
	const routes = new Map<string, Route>();
	for (const link of ctx.links) {
		const a = positions.get(link.source);
		const b = positions.get(link.target);
		if (!a || !b) continue;
		routes.set(link.id, {
			id: link.id,
			source: link.source,
			target: link.target,
			d: `M ${Math.round(a.x * 100) / 100} ${Math.round(a.y * 100) / 100} L ${Math.round(b.x * 100) / 100} ${Math.round(b.y * 100) / 100}`,
			waypoints: [a, b],
			length: distance(a, b),
			direct: true,
			blockers: []
		});
	}
	return { routes, unresolved: [], regionList };
}

/**
 * The shipped drawing's ties, detoured round the dots, names, headings and
 * outlines it already draws. The positions, text and fit are the shipped ones:
 * this can never move a dot, so it is safe to publish beside a kept arrangement.
 */
export function routeShipped(ctx: ComposerContext, base: Drawing): Drawing {
	const unit = 1 / base.scale;
	const headingBoxes = [...base.headings].map(([id, heading]) => ({ id, box: heading.box }));
	const regionList = regionObstacles(base.regions, unit);
	const { routes, unresolved, tidy } = routeOver(
		ctx,
		base.layout.positions,
		base.names,
		headingBoxes,
		regionList,
		unit
	);
	const geometry: DrawingGeometry = {
		positions: base.layout.positions,
		unit,
		headingBoxes,
		chrome: base.chrome,
		regions: regionList
	};
	const evaluation = evaluateDrawing(drawingInput(ctx, geometry, base.names, routes));
	return {
		...base,
		key: 'original+routed',
		routes,
		tidy,
		finalize: finalizeWithTidy(ctx, geometry, base.names, routes, evaluation, tidy),
		unresolved,
		evaluation
	};
}
