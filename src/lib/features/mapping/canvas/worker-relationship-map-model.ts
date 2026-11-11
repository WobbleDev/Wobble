/**
 * Turning the Worksite's Workers and their Relationships into the nodes and ties the
 * map draws.
 */
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import type { Worker, WorkerAttributeValues } from '#lib/domain-vocabulary.ts';

export type WorkerGraphNode = {
	id: string;
	name: string;
	assessment: Worker['assessment'];
	/** Each Worker's answer ids per Attribute; the map reads answers by id, never text. */
	attributes: WorkerAttributeValues;
	/** The recorded Language ids, so the map can mark and name them without another lookup. */
	languages?: readonly string[];
	relationshipCount: number;
} & SimulationNodeDatum;

export type WorkerGraphLink = {
	id: string;
	source: string;
	target: string;
	value: number;
} & SimulationLinkDatum<WorkerGraphNode>;

function buildRelationships(workerRecords: readonly Worker[]) {
	const validIds = new Set(workerRecords.map((worker) => worker.id));
	const links: WorkerGraphLink[] = [];
	const linkIds = new Set<string>();

	for (const worker of workerRecords) {
		for (const relatedWorkerId of worker.relationships) {
			if (!validIds.has(relatedWorkerId)) {
				throw new Error(
					`Worker "${worker.id}" has a relationship to unknown worker "${relatedWorkerId}".`
				);
			}
			if (worker.id === relatedWorkerId) {
				throw new Error(`Worker "${worker.id}" cannot be related to itself.`);
			}

			const [source, target] =
				worker.id < relatedWorkerId ? [worker.id, relatedWorkerId] : [relatedWorkerId, worker.id];
			const id = JSON.stringify([source, target]);
			if (linkIds.has(id)) continue;

			linkIds.add(id);
			links.push({ id, source, target, value: 1 });
		}
	}

	return links;
}

function buildNodes(workerRecords: readonly Worker[], links: readonly WorkerGraphLink[]) {
	const relationshipCounts = new Map<string, number>();
	for (const link of links) {
		relationshipCounts.set(link.source, (relationshipCounts.get(link.source) ?? 0) + 1);
		relationshipCounts.set(link.target, (relationshipCounts.get(link.target) ?? 0) + 1);
	}

	return workerRecords.map((worker): WorkerGraphNode => ({
		id: worker.id,
		name: worker.name,
		assessment: worker.assessment,
		attributes: Object.fromEntries(
			Object.entries(worker.attributes).map(([id, held]) => [
				id,
				Array.isArray(held) ? [...held] : held
			])
		),
		languages: [...worker.languages],
		relationshipCount: relationshipCounts.get(worker.id) ?? 0
	}));
}

export function buildWorkerGraph(workerRecords: readonly Worker[]) {
	const links = buildRelationships(workerRecords);
	const nodes = buildNodes(workerRecords, links);

	return { nodes, links };
}
