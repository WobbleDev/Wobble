/**
 * Candidate selection: the shared selection state, the acceptance rule, the
 * ranking, the attempt wrapper and the winner's packet.
 */
import type { DrawingEvaluation } from '../graph-layout-quality.ts';
import { WorkExhausted } from '../graph-work-budget.ts';
import { spacingPolicy, type ComposerContext } from './graph-composition-context.ts';
import { routeShipped, type Drawing } from './graph-composition-drawing.ts';
import type { CandidateReport, ComposeResult } from './graph-composition-types.ts';

export type SelectionState = {
	base: Drawing;
	baseEval: DrawingEvaluation;
	baseline: {
		dot: Set<string>;
		name: Set<string>;
		heading: Set<string>;
		region: Set<string>;
		layout: Set<string>;
	};
	reports: CandidateReport[];
	accepted: Drawing[];
};

export function createSelection(base: Drawing): SelectionState {
	const baseEval = base.evaluation;
	return {
		base,
		baseEval,
		baseline: {
			dot: new Set(baseEval.dotConflicts),
			name: new Set(baseEval.nameConflicts),
			heading: new Set(baseEval.headingConflicts),
			region: new Set(baseEval.regionConflicts),
			layout: new Set(baseEval.layoutConflicts)
		},
		reports: [],
		accepted: []
	};
}

function conflictCount(e: DrawingEvaluation) {
	return (
		e.dotConflicts.length +
		e.nameConflicts.length +
		e.headingConflicts.length +
		e.regionConflicts.length +
		e.layoutConflicts.length +
		e.invalidRoutes.length
	);
}

function metricsOf(drawing: Drawing) {
	const e = drawing.evaluation;
	return {
		conflicts: conflictCount(e),
		shallowOrShared: e.shallowCrossings + e.sharedRuns,
		crossings: e.properCrossings,
		totalLength: e.totalLength
	};
}

function report(
	sel: SelectionState,
	drawing: Drawing,
	status: CandidateReport['status'],
	reason?: string
) {
	sel.reports.push({
		key: drawing.key,
		status,
		reason,
		scale: drawing.scale,
		unresolved: drawing.unresolved.map(
			(id) =>
				`${id}>${drawing.routes.get(id)?.blockers.join('+')}:${drawing.routes.get(id)?.failure}`
		),
		...metricsOf(drawing)
	});
}

/**
 * Revision 1: each conflict a candidate resolves buys at most one more crossing between
 * ties, capped at half the original's crossings plus three. Never a new conflict, shallow
 * crossing or shared run.
 */
function resolvedBy(sel: SelectionState, e: DrawingEvaluation) {
	return Math.max(0, conflictCount(sel.baseEval) - conflictCount(e));
}

function crossingAllowanceFor(sel: SelectionState, e: DrawingEvaluation) {
	return Math.min(resolvedBy(sel, e), Math.ceil(0.5 * sel.baseEval.properCrossings) + 3);
}

/** The same exchange for ties meeting at a shallow angle, at most two more. */
function shallowAllowanceFor(sel: SelectionState, e: DrawingEvaluation) {
	return Math.min(resolvedBy(sel, e), 2);
}

/** The first conflict this drawing adds over the shipped baseline, if any. */
function newConflict(sel: SelectionState, e: DrawingEvaluation): string | undefined {
	const novel = (found: readonly string[], known: ReadonlySet<string>) =>
		found.find((identity) => !known.has(identity));
	if (e.invalidRoutes.length > 0) return `invalid route ${e.invalidRoutes[0]}`;
	const dot = novel(e.dotConflicts, sel.baseline.dot);
	if (dot) return `new dot conflict ${dot}`;
	const name = novel(e.nameConflicts, sel.baseline.name);
	if (name) return `new name conflict ${name}`;
	const heading = novel(e.headingConflicts, sel.baseline.heading);
	if (heading) return `new heading conflict ${heading}`;
	const region = novel(e.regionConflicts, sel.baseline.region);
	if (region) return `new region conflict ${region}`;
	const layout = novel(e.layoutConflicts, sel.baseline.layout);
	if (layout) return `new layout conflict ${layout}`;
	return undefined;
}

/** The acceptance rule for every non-original drawing; returns the reason it fails. */
function rejection(
	ctx: ComposerContext,
	sel: SelectionState,
	drawing: Drawing
): string | undefined {
	const minOutlinePx = spacingPolicy.minOutlinePx;
	const e = drawing.evaluation;
	const added = newConflict(sel, e);
	if (added) return added;
	if (drawing.outlineGapPx < minOutlinePx - 0.5) {
		return `outline gap ${drawing.outlineGapPx.toFixed(1)}px under the ${minOutlinePx}px minimum`;
	}
	if (ctx.subAttribute) {
		if (drawing.escapedChild !== undefined) {
			return `escaped child ${drawing.escapedChild}`;
		}
		if (drawing.childGapPx < spacingPolicy.minChildPx - 0.5) {
			return `child gap ${drawing.childGapPx.toFixed(1)}px under the ${spacingPolicy.minChildPx}px minimum`;
		}
	}
	// Revision 1 (see the evidence manifest): a candidate that resolves unresolved conflicts
	// may cost a few crossings between ties, never a new conflict or a shallow/shared run.
	if (e.properCrossings > sel.baseEval.properCrossings + crossingAllowanceFor(sel, e)) {
		return 'more crossings than the original allows';
	}
	if (e.shallowCrossings > sel.baseEval.shallowCrossings + shallowAllowanceFor(sel, e))
		return 'more shallow crossings than the original allows';
	if (e.sharedRuns > sel.baseEval.sharedRuns) return 'more shared runs than the original';
	if (e.totalLength > sel.baseEval.totalLength * 1.15) return 'routes 15% longer than the original';
	if (e.longestLength > sel.baseEval.longestLength * 1.25)
		return 'longest route 25% longer than the original';
	return undefined;
}

function diagonalOf(drawing: Drawing) {
	return (
		Math.hypot(
			drawing.extent.right - drawing.extent.left,
			drawing.extent.bottom - drawing.extent.top
		) || 1
	);
}

function aspectMismatch(ctx: ComposerContext, drawing: Drawing) {
	return Math.abs(
		Math.log(
			(drawing.extent.right - drawing.extent.left) /
				Math.max(1e-9, drawing.extent.bottom - drawing.extent.top) /
				(ctx.free.width / Math.max(1, ctx.free.height))
		)
	);
}

function displacement(ctx: ComposerContext, sel: SelectionState, drawing: Drawing) {
	let sum = 0;
	for (const [id, p] of drawing.layout.positions) {
		const o = ctx.original.positions.get(id)!;
		sum += (p.x - o.x) ** 2 + (p.y - o.y) ** 2;
	}
	return Math.sqrt(sum / Math.max(1, drawing.layout.positions.size)) / diagonalOf(sel.base);
}

/**
 * Revision 2: crossings gate admission (above) but no longer order admitted drawings. A
 * handful more crossings between ties that touch nothing outranked 15% shorter ties and a
 * map that fits its canvas; only the excess over the admission allowance still counts.
 */
function crossingExcess(sel: SelectionState, drawing: Drawing) {
	return Math.max(
		0,
		drawing.evaluation.properCrossings -
			sel.baseEval.properCrossings -
			crossingAllowanceFor(sel, drawing.evaluation)
	);
}

function shallowExcess(sel: SelectionState, drawing: Drawing) {
	return Math.max(
		0,
		drawing.evaluation.shallowCrossings -
			sel.baseEval.shallowCrossings -
			shallowAllowanceFor(sel, drawing.evaluation)
	);
}

function rank(ctx: ComposerContext, sel: SelectionState, drawing: Drawing) {
	const m = metricsOf(drawing);
	return [
		m.conflicts,
		drawing.evaluation.sharedRuns + shallowExcess(sel, drawing),
		crossingExcess(sel, drawing),
		drawing.evaluation.totalLength / diagonalOf(drawing),
		aspectMismatch(ctx, drawing),
		displacement(ctx, sel, drawing)
	];
}

function better(ctx: ComposerContext, sel: SelectionState, a: Drawing, b: Drawing): boolean {
	const ra = rank(ctx, sel, a);
	const rb = rank(ctx, sel, b);
	for (let i = 0; i < ra.length; i += 1) {
		const tolerance = 1e-6 * Math.max(1, Math.abs(ra[i]), Math.abs(rb[i]));
		if (ra[i] < rb[i] - tolerance) return true;
		if (ra[i] > rb[i] + tolerance) return false;
	}
	return false;
}

export function attempt(
	ctx: ComposerContext,
	sel: SelectionState,
	key: string,
	build: () => Drawing | undefined
): Drawing | undefined {
	try {
		const drawing = build();
		if (!drawing) return undefined;
		const reason = rejection(ctx, sel, drawing);
		if (reason) {
			drawing.reason = reason;
			report(sel, drawing, 'rejected', reason);
			return drawing;
		}
		sel.accepted.push(drawing);
		return drawing;
	} catch (error) {
		if (!(error instanceof WorkExhausted)) throw error;
		sel.reports.push({
			key,
			status: 'rejected',
			reason: error.message,
			conflicts: 0,
			shallowOrShared: 0,
			crossings: 0,
			totalLength: 0,
			scale: 0
		});
		return undefined;
	}
}

export function pickWinner(
	ctx: ComposerContext,
	sel: SelectionState
): { winner: Drawing; chosen: string } {
	let winner = sel.base;
	let chosen = 'original';
	for (const drawing of sel.accepted) {
		if (better(ctx, sel, drawing, winner)) {
			winner = drawing;
			chosen = drawing.key;
		}
	}
	for (const drawing of sel.accepted) {
		report(sel, drawing, drawing === winner ? 'selected' : 'valid');
		sel.reports[sel.reports.length - 1].rank = rank(ctx, sel, drawing);
	}
	sel.reports.push({
		key: 'original',
		status: winner === sel.base ? 'selected' : 'valid',
		scale: sel.base.scale,
		...metricsOf(sel.base)
	});
	return { winner, chosen };
}

/**
 * The shipped positions keep their ties, routed. Routing is not a placement, so it
 * is judged on its own terms rather than as a candidate: every path must certify,
 * the set may add no conflict the straight ties did not have, and it must outrank
 * them. The layout gates of {@link rejection} do not apply — the positions and their
 * gaps are the shipped ones, whatever they are — and neither do its length gates,
 * since a detour that clears an obstacle is necessarily longer.
 */
export function routesForShippedDrawing(
	ctx: ComposerContext,
	sel: SelectionState
): Drawing | undefined {
	// Nothing to buy: with no conflict in the shipped drawing, no detour can help it.
	if (conflictCount(sel.baseEval) === 0) return undefined;
	let drawing: Drawing;
	try {
		drawing = routeShipped(ctx, sel.base);
	} catch (error) {
		if (!(error instanceof WorkExhausted)) throw error;
		sel.reports.push({
			key: 'original+routed',
			status: 'rejected',
			reason: error.message,
			conflicts: 0,
			shallowOrShared: 0,
			crossings: 0,
			totalLength: 0,
			scale: sel.base.scale
		});
		return undefined;
	}
	const reason =
		newConflict(sel, drawing.evaluation) ??
		(better(ctx, sel, drawing, sel.base) ? undefined : 'detours leave the drawing no better');
	if (reason) {
		report(sel, drawing, 'rejected', reason);
		return undefined;
	}
	report(sel, drawing, 'valid');
	return drawing;
}

export function packetOf(
	ctx: ComposerContext,
	sel: SelectionState,
	winner: Drawing,
	chosen: string,
	/** The drawing whose paths are published: the winner's, or the shipped ones detoured. */
	published: Drawing
): ComposeResult {
	// The published paths may be laned after the drawing was read: report the conflicts of
	// the very routes that ship, never of the pre-tidy ones.
	const publishedDrawing = published.finalize?.() ?? {
		routes: published.routes,
		evaluation: published.evaluation
	};
	const e = publishedDrawing.evaluation;
	return {
		positions: new Map(winner.layout.positions),
		centres: new Map(winner.layout.centres),
		packet: {
			chosen,
			scale: winner.scale,
			frame: {
				x: winner.extent.left,
				y: winner.extent.top,
				width: winner.extent.right - winner.extent.left,
				height: winner.extent.bottom - winner.extent.top
			},
			routes: publishedDrawing.routes,
			names: winner.names,
			headings: winner.headings,
			conflicts: {
				dot: e.dotConflicts,
				name: e.nameConflicts,
				heading: e.headingConflicts,
				region: e.regionConflicts,
				layout: e.layoutConflicts
			},
			candidates: sel.reports,
			textSource: ctx.text.source,
			work: { ...ctx.budget.used },
			revision: 0
		}
	};
}

export function originalPacket(ctx: ComposerContext, error: WorkExhausted): ComposeResult {
	// Even the shipped drawing could not be evaluated inside the allowance: keep it,
	// complete and unchanged, with its straight ties and dynamic text.
	return {
		positions: new Map(ctx.original.positions),
		centres: new Map(ctx.original.centres),
		packet: {
			chosen: 'original',
			scale: ctx.referenceScale,
			frame: {
				x: ctx.originalExtent.left,
				y: ctx.originalExtent.top,
				width: ctx.originalExtent.right - ctx.originalExtent.left,
				height: ctx.originalExtent.bottom - ctx.originalExtent.top
			},
			routes: undefined,
			names: new Map(),
			headings: new Map(),
			conflicts: { dot: [], name: [], heading: [], region: [], layout: [] },
			candidates: [
				{
					key: 'original',
					status: 'selected',
					reason: error.message,
					conflicts: 0,
					shallowOrShared: 0,
					crossings: 0,
					totalLength: 0,
					scale: ctx.referenceScale
				}
			],
			textSource: ctx.text.source,
			work: { ...ctx.budget.used },
			revision: 0
		}
	};
}
