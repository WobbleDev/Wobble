/** Pure row construction and sorting for the Mapping's table presentation. */
import type { Language, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { noValueReading } from '#lib/shared/no-value-reading.ts';
import { bucketLabel, groupValue, linkEndId } from './layout/graph-analysis.ts';
import type { GroupingReading } from './grouping/map-grouping.ts';
import type { WorkerGraphLink, WorkerGraphNode } from './worker-relationship-map-model.ts';

export type MapTableRow = {
	id: string;
	name: string;
	assessment: WorkerGraphNode['assessment'];
	relationships: number;
	group: string;
	/** The system reading's secondary description, when a real answer reads the same. */
	groupDescription: string | null;
	/** Recorded Language names, or the no-recording reading. */
	languages: string;
	subGroup: string;
	subGroupDescription: string | null;
	tiesOutsideGroup: number;
	tiesToLeaders: number;
	/** Whether the Worker is one the complete Highlight query selects. */
	matchesHighlight: boolean;
};

export type MapTableSort = {
	column: keyof Omit<MapTableRow, 'id' | 'matchesHighlight'>;
	direction: 'asc' | 'desc';
};

/** Builds alphabetical rows from the same drawn nodes and ties as the map. */
export function mapTableRows(
	nodes: readonly WorkerGraphNode[],
	links: readonly WorkerGraphLink[],
	groupingAttribute?: WorkerAttributeDefinition,
	subGroupingAttribute?: WorkerAttributeDefinition,
	languages: readonly Language[] = [],
	/** The Workers a complete Highlight query selects; undefined when there is no complete query. */
	highlightIds: ReadonlySet<string> | undefined = undefined,
	/** The Grouping's own reading, so the table names regions exactly as the map does. */
	reading?: GroupingReading
): MapTableRow[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const available = reading?.status === 'available' ? reading : undefined;
	const regions = new Map((available?.regions ?? []).map((region) => [region.key, region]));
	const availableSubGrouping =
		available?.subGrouping?.status === 'available' ? available.subGrouping : undefined;
	const subRegions = new Map(
		(availableSubGrouping?.regions ?? []).map((region) => [region.key, region])
	);
	const groupReading = groupingAttribute ? noValueReading(groupingAttribute) : undefined;
	const subGroupReading = subGroupingAttribute ? noValueReading(subGroupingAttribute) : undefined;
	const ties = new Map<string, WorkerGraphLink[]>();
	for (const node of nodes) ties.set(node.id, []);
	for (const link of links) {
		const source = linkEndId(link.source);
		const target = linkEndId(link.target);
		ties.get(source)?.push(link);
		ties.get(target)?.push(link);
	}

	return nodes
		.map((node): MapTableRow => {
			const groupValueForNode = available
				? (available.regionOf.get(node.id)?.group ?? '')
				: groupValue(node, groupingAttribute);
			const region = regions.get(groupValueForNode);
			const group = groupingAttribute
				? (region?.label ?? bucketLabel(groupValueForNode, groupingAttribute))
				: '';
			// The paired reading names the sub-group; only without one does the projected
			// node carry the value directly.
			const subGroupValue = availableSubGrouping
				? (availableSubGrouping.regionOf.get(node.id) ?? '')
				: groupValue(node, subGroupingAttribute);
			const subRegion = subRegions.get(subGroupValue);
			const neighbours = ties.get(node.id) ?? [];
			return {
				id: node.id,
				name: node.name,
				assessment: node.assessment,
				relationships: node.relationshipCount,
				group,
				groupDescription: region
					? region.description
					: groupingAttribute && groupValueForNode === ''
						? (groupReading?.description ?? null)
						: null,
				subGroup: subGroupingAttribute
					? (subRegion?.label ?? bucketLabel(subGroupValue, subGroupingAttribute))
					: '',
				subGroupDescription: subGroupingAttribute
					? (subRegion?.description ??
						(subGroupValue === '' ? (subGroupReading?.description ?? null) : null))
					: null,
				languages: languageReading(node, languages),
				tiesOutsideGroup: groupingAttribute
					? neighbours.filter((link) => {
							const otherId =
								linkEndId(link.source) === node.id
									? linkEndId(link.target)
									: linkEndId(link.source);
							const other = byId.get(otherId);
							return other && groupValue(other, groupingAttribute) !== groupValueForNode;
						}).length
					: 0,
				tiesToLeaders: neighbours.filter((link) => {
					const otherId =
						linkEndId(link.source) === node.id ? linkEndId(link.target) : linkEndId(link.source);
					return byId.get(otherId)?.assessment === 'Leader';
				}).length,
				matchesHighlight: highlightIds !== undefined && highlightIds.has(node.id)
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * A Worker's recorded Language names in Worksite vocabulary order, or the same
 * no-recording reading the Worker card uses.
 */
function languageReading(node: WorkerGraphNode, languages: readonly Language[]): string {
	const recorded = languages.filter(({ id }) => node.languages?.includes(id));
	if (recorded.length === 0) return 'No languages recorded.';

	return recorded.map(({ name }) => name).join(', ');
}

/** Sorts without mutating the caller's rows; equal values retain name order. */
export function sortMapTableRows(rows: readonly MapTableRow[], sort: MapTableSort): MapTableRow[] {
	const direction = sort.direction === 'asc' ? 1 : -1;
	return [...rows].sort((a, b) => {
		const left = a[sort.column];
		const right = b[sort.column];
		const primary =
			typeof left === 'number' && typeof right === 'number'
				? left - right
				: String(left).localeCompare(String(right), undefined, { sensitivity: 'base' });
		return primary * direction || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
	});
}
