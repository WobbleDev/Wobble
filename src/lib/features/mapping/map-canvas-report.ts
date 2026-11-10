/**
 * The drawing the renderer publishes, read back from what it actually drew: the
 * visible links and their shipped paths, the dots at the drawn radii, the names in
 * their placed boxes, the headings at the measured face and camera zoom, and the
 * outlined regions with their parent keys.
 *
 * The composition still chooses candidates from its own reading; this one exists
 * because a re-placed name or a heading laid out at another camera than the
 * packet's own fit can add a contact the packet never saw.
 */
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { groupValue } from './graph-analysis.ts';
import { outlineProxy } from './graph-composition-layout.ts';
import type { Box as LabelBox } from './graph-label-placement.ts';
import { regionKey, subRegionKey, type GroupRegion, type Point } from './graph-layout.ts';
import type { DrawingInput } from './graph-layout-quality.ts';
import type { TextSnapshot } from './graph-text-metrics.ts';
import type { WorkerGraphLink, WorkerGraphNode } from './worker-relationship-map-model.ts';

/** Everything the renderer holds at rest, passed in so this module stays pure. */
export type ReportDrawingSource = {
	readonly visibleNodes: readonly WorkerGraphNode[];
	readonly visibleLinks: readonly WorkerGraphLink[];
	/** Where the arrangement settles each Worker, in map units. */
	readonly positions: ReadonlyMap<string, Point>;
	/** The packet's shipped paths, absent when the ties draw straight. */
	readonly routes: ReadonlyMap<string, { d: string }> | undefined;
	readonly radiusFor: (node: WorkerGraphNode) => number;
	readonly placements: ReadonlyMap<string, { box: LabelBox }>;
	readonly regions: readonly GroupRegion[];
	readonly textSnapshot: TextSnapshot | undefined;
	readonly zoom: number;
	readonly groupingAttribute: WorkerAttributeDefinition | undefined;
	readonly subGroupingAttribute: WorkerAttributeDefinition | undefined;
};

/**
 * Builds the drawing input for the published report from the renderer's own
 * geometry. Nothing here is measured or derived beyond the boxes it reads.
 */
export function reportDrawingInput(input: ReportDrawingSource): DrawingInput {
	const unit = 1 / input.zoom;
	const pointOf = (id: string) => input.positions.get(id) ?? { x: 0, y: 0 };
	return {
		routes: input.visibleLinks.map((link) => {
			const a = pointOf(link.source);
			const b = pointOf(link.target);
			return {
				id: link.id,
				source: link.source,
				target: link.target,
				d: input.routes?.get(link.id)?.d ?? `M ${a.x} ${a.y} L ${b.x} ${b.y}`
			};
		}),
		dots: input.visibleNodes.map((node) => ({
			id: node.id,
			...pointOf(node.id),
			r: input.radiusFor(node)
		})),
		names: [...input.placements].map(([id, placement]) => ({
			id: `name:${id}`,
			worker: id,
			box: placement.box
		})),
		headings: input.regions.flatMap((top) =>
			[top, ...top.subRegions].flatMap((label, index) => {
				const size = input.textSnapshot?.headings.get(label.key);
				if (!size) {
					return label.labelBox
						? [
								{
									id: label.key,
									box: {
										left: label.labelBox.x,
										top: label.labelBox.y,
										right: label.labelBox.x + label.labelBox.width,
										bottom: label.labelBox.y + label.labelBox.height
									}
								}
							]
						: [];
				}
				// The heading is measured at its 11px face (a sub-heading at 10px) and
				// drawn screen-fixed, so its rendered box is that size over the camera zoom.
				// The label's own slot is a heuristic once the packet chose the shipped
				// drawing, so the measured face is the only truthful box.
				const scale = (index > 0 ? 11 / 10 : 1) / input.zoom;
				const width = size.width * scale;
				const height = size.height * scale;
				const baseline = (size.baseline ?? size.height * 0.78) * scale;
				const left =
					label.labelAt.textAnchor === 'start'
						? label.labelAt.x
						: label.labelAt.textAnchor === 'end'
							? label.labelAt.x - width
							: label.labelAt.x - width / 2;
				const top = label.labelAt.y - baseline;
				return [{ id: label.key, box: { left, top, right: left + width, bottom: top + height } }];
			})
		),
		regions: input.regions.flatMap((top) =>
			[top, ...top.subRegions]
				.filter((region) => region.outlined)
				.map((region) => ({
					key: region.key,
					parent: region === top ? undefined : top.key,
					polygon: outlineProxy(region, unit),
					outlined: true,
					convex: true
				}))
		),
		workerRegions: new Map(
			input.visibleNodes.map((node) => {
				const group = groupValue(node, input.groupingAttribute);
				return [
					node.id,
					input.subGroupingAttribute
						? [regionKey(group), subRegionKey(group, groupValue(node, input.subGroupingAttribute))]
						: [regionKey(group)]
				] as const;
			})
		),
		unit
	};
}
