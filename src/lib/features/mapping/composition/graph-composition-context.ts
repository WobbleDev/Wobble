/**
 * The composer's shared context: the values that used to sit around one
 * thousand-line closure, now built once and passed to every composer module.
 */
import {
	answerPositionLabel,
	buildBucketTree,
	compareText,
	groupValue
} from '../layout/graph-analysis.ts';
import { regionKey, subRegionKey, type Point } from '../layout/graph-layout.ts';
import { mapLabelText } from '../labels/graph-label-placement.ts';
import { estimateTextSnapshot, type TextSnapshot } from '../labels/graph-text-metrics.ts';
import type { Box } from '../layout/graph-shapes.ts';
import type { WorkBudget } from '../layout/graph-work-budget.ts';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import type { WorkerGraphLink, WorkerGraphNode } from '../canvas/worker-relationship-map-model.ts';
import { frameOf, fitScale, keyOf, regionsOf } from './graph-composition-layout.ts';

/** The reading rules, in reference CSS pixels. Revise the revision with any change. */
export const spacingPolicy = {
	revision: 'spacing-2',
	minOutlinePx: 24,
	preferredOutlinePx: 48,
	/** Separation between two sibling sub-group outlines: minimum, then preferred. */
	minChildPx: 12,
	preferredChildPx: 24,
	textClearancePx: 8,
	nameOffsetsPx: [8, 16, 24, 32, 40, 48],
	leaderMinPx: 12,
	leaderCapPx: 24
} as const;

/** What the Arrangement is told about the screen; numbers only. */
export type CompositionInput = {
	/** The free canvas in CSS pixels when the map was laid out: chrome excluded, card closed. */
	freeCanvas: { width: number; height: number };
	/** The Workers whose names stand at rest, selection and hover neutralized, in priority order. */
	restingNameIds: readonly string[];
	/** Measured text; without it the conservative estimate applies. */
	text?: TextSnapshot;
	/**
	 * The floating chrome the camera leaves uncovered at the edges (the Assessment key and the
	 * dot-size key), in CSS pixels from the free canvas's top-left. Text steps around it.
	 */
	reserved?: readonly { x: number; y: number; width: number; height: number }[];
};

export type ComposeParams = {
	nodes: readonly WorkerGraphNode[];
	links: readonly WorkerGraphLink[];
	groupingAttribute: WorkerAttributeDefinition;
	/** A second Category: each group then holds contained sub-regions. */
	subGroupingAttribute?: WorkerAttributeDefinition;
	/** The shipped arrangement: positions and each group's centre. */
	positions: ReadonlyMap<string, Point>;
	centres: ReadonlyMap<string, Point>;
	radiusFor: (id: string) => number;
	composition: CompositionInput;
	budget: WorkBudget;
};

export type Layout = { positions: Map<string, Point>; centres: Map<string, Point> };

export type ComposerContext = {
	params: ComposeParams;
	nodes: readonly WorkerGraphNode[];
	links: readonly WorkerGraphLink[];
	subAttribute: WorkerAttributeDefinition | undefined;
	buckets: ReturnType<typeof buildBucketTree>;
	groupOf: Map<string, string>;
	groupLabel: ReturnType<typeof answerPositionLabel>;
	subLabel: ReturnType<typeof answerPositionLabel>;
	keys: string[];
	nodeIndex: Map<string, WorkerGraphNode>;
	membersByKey: Map<string, string[]>;
	counts: Map<string, number>;
	resting: string[];
	text: TextSnapshot;
	original: Layout;
	originalExtent: Box;
	referenceScale: number;
	unit0: number;
	meanCentre: Point;
	free: { width: number; height: number };
	budget: WorkBudget;
};

/** The measured snapshot when there is one, else the conservative estimate over the same strings. */
function resolveText(
	nodes: readonly WorkerGraphNode[],
	buckets: ReturnType<typeof buildBucketTree>,
	composition: CompositionInput
): TextSnapshot {
	if (composition.text) return composition.text;
	const nameOf = new Map(nodes.map((node) => [node.id, node.name]));
	return estimateTextSnapshot(
		composition.restingNameIds.flatMap((id) =>
			nameOf.has(id) ? [{ id, text: mapLabelText(nameOf.get(id) ?? '') }] : []
		),
		buckets.flatMap((bucket) => [
			{ key: regionKey(bucket.value), label: bucket.label, count: bucket.count, child: false },
			...bucket.subGroups.map((sub) => ({
				key: subRegionKey(bucket.value, sub.value),
				label: sub.label,
				count: sub.count,
				child: true
			}))
		])
	);
}

export function createComposerContext(params: ComposeParams): ComposerContext {
	const { nodes, links, groupingAttribute, budget } = params;
	const free = params.composition.freeCanvas;
	const subAttribute = params.subGroupingAttribute;
	const buckets = buildBucketTree(nodes, groupingAttribute, subAttribute);
	const groupOf = new Map(nodes.map((node) => [node.id, groupValue(node, groupingAttribute)]));
	const groupLabel = answerPositionLabel(groupingAttribute);
	const subLabel = answerPositionLabel(subAttribute);
	const keys = [...new Set(groupOf.values())].sort((a, b) =>
		compareText(groupLabel(a), groupLabel(b))
	);
	const nodeIndex = new Map(nodes.map((node) => [node.id, node]));
	const membersByKey = new Map<string, string[]>(keys.map((key) => [key, []]));
	const counts = new Map<string, number>();
	for (const bucket of buckets) {
		counts.set(regionKey(bucket.value), bucket.count);
		for (const sub of bucket.subGroups) {
			counts.set(subRegionKey(bucket.value, sub.value), sub.count);
		}
	}
	const resting = params.composition.restingNameIds.filter((id) => groupOf.has(id));
	const text = resolveText(nodes, buckets, params.composition);

	// The shipped drawing, and the fit every reference pixel converts through.
	const original: Layout = {
		positions: new Map(params.positions),
		centres: new Map(params.centres)
	};
	const all = keys.map((key) => original.centres.get(key)!);
	const meanCentre = {
		x: all.reduce((sum, p) => sum + p.x, 0) / Math.max(1, all.length),
		y: all.reduce((sum, p) => sum + p.y, 0) / Math.max(1, all.length)
	};

	// The derived geometry below needs the rest of the context, so it is built first.
	const ctx = {
		params,
		nodes,
		links,
		subAttribute,
		buckets,
		groupOf,
		groupLabel,
		subLabel,
		keys,
		nodeIndex,
		membersByKey,
		counts,
		resting,
		text,
		original,
		meanCentre,
		free,
		budget
	} as ComposerContext;
	for (const node of nodes) membersByKey.get(keyOf(ctx, node.id))?.push(node.id);
	const originalRegions = regionsOf(ctx, original.positions);
	ctx.originalExtent = frameOf(ctx, original.positions, originalRegions);
	ctx.referenceScale = fitScale(ctx.originalExtent, free);
	ctx.unit0 = 1 / ctx.referenceScale;
	return ctx;
}
