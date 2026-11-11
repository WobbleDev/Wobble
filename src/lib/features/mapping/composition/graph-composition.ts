/**
 * Composes a Grouped map as one drawing: where the groups sit, where
 * the names stand, and the individual Relationship paths, chosen together.
 *
 * With a Sub-grouping, children are composed within each parent first: each
 * parent's child bodies are placed from their actual Relationships with
 * measured child separation, the parents are rebuilt around them, the
 * top-level bodies are composed under the accepted spacing rules, and one
 * bounded child-orientation reconciliation follows. A parent move carries its
 * children rigidly throughout.
 *
 * The shipped arrangement is always the first candidate and the complete
 * fallback. A small fixed set of coordinated alternatives is built from the
 * child-composed drawing (routes only; all groups moving together; the same
 * with an aspect correction), each is repaired against the drawn outlines,
 * given its final text and routes, and evaluated as a finished drawing. Only
 * complete, fully evaluated drawings can be selected, and an exhausted work
 * allowance discards the candidate in progress, never returning a partial one.
 *
 * Positions come from the caller and go back to it: this module owns no state.
 */
import { WorkExhausted } from '../layout/graph-work-budget.ts';
import { createComposerContext, type ComposeParams } from './graph-composition-context.ts';
import { buildDrawing, fitReferenceToHeadings, type Drawing } from './graph-composition-drawing.ts';
import type { ComposeResult } from './graph-composition-types.ts';
import {
	createSelection,
	originalPacket,
	packetOf,
	pickWinner,
	routesForShippedDrawing
} from './graph-composition-selection.ts';
import {
	composeCandidates,
	composeInterior,
	type InteriorStage
} from './graph-composition-candidates.ts';

export { spacingPolicy } from './graph-composition-context.ts';
export type { CompositionInput } from './graph-composition-context.ts';
export type { CompositionPacket } from './graph-composition-types.ts';

export function composeGrouped(params: ComposeParams): ComposeResult {
	const ctx = createComposerContext(params);
	fitReferenceToHeadings(ctx);

	// ---- Stage 1: bodies, outlines and the coordinated moves.

	// ---- Stage 1b: the child-first interior, when the map is sub-grouped.
	// Each parent's children are composed from their actual Relationships with
	// measured child separation before the parents are composed. A parent move
	// later carries its children rigidly; the cells below track the composed
	// interiors for the single bounded reconciliation.

	// ---- Stage 2: the final drawing at the candidate's own fit.

	const compose = (): ComposeResult => {
		// ---- Candidates and selection.

		let base: Drawing;
		try {
			base = buildDrawing(ctx, 'original', ctx.original, 'original');
		} catch (error) {
			if (!(error instanceof WorkExhausted)) throw error;
			// Even the shipped drawing could not be evaluated inside the allowance: keep it,
			// complete and unchanged, with its straight ties and dynamic text.
			return originalPacket(ctx, error);
		}
		const sel = createSelection(base);
		const stage: InteriorStage = composeInterior(ctx, sel);
		composeCandidates(ctx, sel, stage);
		const { winner, chosen } = pickWinner(ctx, sel);
		// The shipped positions keep their ties, routed, whenever routing earns it. Only a
		// candidate that moved something brings its own paths; the shipped drawing's are
		// detoured over the very positions and text it was drawn with.
		const published = winner === sel.base ? (routesForShippedDrawing(ctx, sel) ?? winner) : winner;
		return packetOf(ctx, sel, winner, chosen, published);
	};

	return compose();
}
