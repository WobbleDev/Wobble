/**
 * The candidate drawings: the child-first interior stage and the coordinated
 * alternatives built from it.
 */
import { compareText } from '../layout/graph-analysis.ts';
import { regionKey, type Point } from '../layout/graph-layout.ts';
import { WorkExhausted } from '../layout/graph-work-budget.ts';
import type { ComposerContext, Layout } from './graph-composition-context.ts';
import { distance, movedLayout } from './graph-composition-layout.ts';
import { buildDrawing, type Drawing } from './graph-composition-drawing.ts';
import {
	composeChildrenFirst,
	measureChildren,
	type ChildCell,
	type ChildMetrics
} from './graph-composition-children.ts';
import { reconcile, reconcileChildren, repair } from './graph-composition-collision.ts';
import { attempt, type SelectionState } from './graph-composition-selection.ts';

export type InteriorStage = {
	interior: Layout | undefined;
	childCells: Map<string, ChildCell[]> | undefined;
	base0: Layout;
	mayCompose: boolean;
	interiorMetrics: ChildMetrics | undefined;
};

export function composeInterior(ctx: ComposerContext, sel: SelectionState): InteriorStage {
	// ---- Child-first interior: compose each parent's children before the
	// parents, on the one shared allowance. Composed candidates below build
	// on these interiors; when the stage fails they are skipped and the
	// shipped drawing stands, complete.
	let interior: Layout | undefined;
	let childCells: Map<string, ChildCell[]> | undefined;
	let childNote: string | undefined;
	if (ctx.subAttribute) {
		try {
			const first = composeChildrenFirst(ctx, ctx.original);
			if (first) {
				interior = first.layout;
				childCells = first.cells;
				childNote = `re-solved ${first.shaped} children in ${ctx.keys.length} parents, max move ${(first.maxMove * ctx.referenceScale).toFixed(1)}px`;
			} else {
				childNote = 'child sweeps left a sibling overlap';
			}
		} catch (error) {
			if (!(error instanceof WorkExhausted)) throw error;
			childNote = error.message;
		}
		sel.reports.push({
			key: 'child-first',
			status: interior ? 'valid' : 'rejected',
			reason: childNote,
			conflicts: 0,
			shallowOrShared: 0,
			crossings: 0,
			totalLength: 0,
			scale: ctx.referenceScale
		});
	}
	const base0: Layout = interior ?? ctx.original;
	const mayCompose = !ctx.subAttribute || interior !== undefined;
	const interiorMetrics = interior
		? measureChildren(ctx, interior.positions, ctx.unit0)
		: undefined;
	return { interior, childCells, base0, mayCompose, interiorMetrics };
}

function repairRound(ctx: ComposerContext, sel: SelectionState, source: Drawing) {
	if (source.unresolved.length === 0) return;
	const blocked = new Map<string, number>();
	for (const id of source.unresolved) {
		for (const blocker of source.routes.get(id)?.blockers ?? []) {
			if (blocker.startsWith('region:'))
				blocked.set(blocker.slice(7), (blocked.get(blocker.slice(7)) ?? 0) + 1);
		}
	}
	// Ties break on the groups' list positions, so neither a rename nor an id moves them.
	const positionOfRegion = new Map(ctx.keys.map((key) => [regionKey(key), ctx.groupLabel(key)]));
	const [worst] = [...blocked].sort(
		(x, y) =>
			y[1] - x[1] ||
			compareText(positionOfRegion.get(x[0]) ?? x[0], positionOfRegion.get(y[0]) ?? y[0])
	);
	const targetKey = worst ? ctx.keys.find((key) => regionKey(key) === worst[0]) : undefined;
	if (targetKey === undefined) return;
	const pair = source.unresolved
		.map((id) => source.routes.get(id)!)
		.find((route) => route.blockers.includes(`region:${worst[0]}`));
	if (!pair) return;
	const a = source.layout.positions.get(pair.source)!;
	const b = source.layout.positions.get(pair.target)!;
	const length = distance(a, b) || 1;
	const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
	for (const [suffix, sign] of [
		['r1', 1],
		['r2', -1]
	] as const) {
		const key = `${source.key}+${suffix}`;
		attempt(ctx, sel, key, () => {
			const layout: Layout = {
				positions: new Map(source.layout.positions),
				centres: new Map(source.layout.centres)
			};
			const step = 16 * ctx.unit0 * sign;
			const dx = normal.x * step;
			const dy = normal.y * step;
			layout.centres.set(targetKey, {
				x: layout.centres.get(targetKey)!.x + dx,
				y: layout.centres.get(targetKey)!.y + dy
			});
			for (const id of ctx.membersByKey.get(targetKey) ?? []) {
				const p = layout.positions.get(id)!;
				layout.positions.set(id, { x: p.x + dx, y: p.y + dy });
			}
			if (!repair(ctx, layout)) return undefined;
			// A rigid parent move preserves the source interior: its
			// child clearance and containment carry over.
			return buildDrawing(ctx, key, layout, 'composed', undefined, {
				gapMap: source.childGapPx / source.scale,
				escaped: source.escapedChild
			});
		});
	}
}

function copy(layout: Layout): Layout {
	return {
		positions: new Map(layout.positions),
		centres: new Map(layout.centres)
	};
}

export function composeCandidates(
	ctx: ComposerContext,
	sel: SelectionState,
	stage: InteriorStage
): void {
	// A: the shipped drawing, already built. B: the child-composed positions
	// with measured names and routes (or the shipped ones without a Sub-grouping).
	const routed =
		stage.mayCompose &&
		attempt(ctx, sel, 'routed', () =>
			buildDrawing(ctx, 'routed', copy(stage.base0), 'composed', undefined, stage.interiorMetrics)
		);
	if (routed && !routed.reason) repairRound(ctx, sel, routed);
	if (stage.mayCompose && ctx.keys.length > 1) {
		const short = ctx.free.width <= ctx.free.height ? 'x' : 'y';
		const coordinated: [string, (key: string, centre: Point) => Point][] = [
			[
				'compress',
				(_key, centre) => ({
					x: ctx.meanCentre.x + (centre.x - ctx.meanCentre.x) * 0.9,
					y: ctx.meanCentre.y + (centre.y - ctx.meanCentre.y) * 0.9
				})
			],
			[
				'aspect',
				(_key, centre) => ({
					x: ctx.meanCentre.x + (centre.x - ctx.meanCentre.x) * (short === 'x' ? 0.9 : 1.05),
					y: ctx.meanCentre.y + (centre.y - ctx.meanCentre.y) * (short === 'y' ? 0.9 : 1.05)
				})
			]
		];
		for (const [key, centreFor] of coordinated) {
			const drawing = attempt(ctx, sel, key, () => {
				const layout = movedLayout(ctx, centreFor, stage.base0);
				if (!repair(ctx, layout)) {
					sel.reports.push({
						key,
						status: 'rejected',
						reason: 'collision sweeps left an outline clash',
						conflicts: 0,
						shallowOrShared: 0,
						crossings: 0,
						totalLength: 0,
						scale: 0
					});
					return undefined;
				}
				reconcile(ctx, layout);
				const movedChildren = stage.childCells
					? reconcileChildren(ctx, layout, stage.childCells)
					: false;
				return buildDrawing(
					ctx,
					key,
					layout,
					'composed',
					undefined,
					!stage.childCells
						? undefined
						: movedChildren
							? measureChildren(ctx, layout.positions, ctx.unit0)
							: stage.interiorMetrics
				);
			});
			if (drawing && !drawing.reason) repairRound(ctx, sel, drawing);
		}
	}
}
