/**
 * The browser specs' synthetic Worksites (`e2e/mapping-composition-dataset.ts`) read as the
 * graph the map draws, so a unit spec replays the very dataset a browser spec stored.
 * Test support only.
 */
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import type { CompositionWorksite } from '../../../../e2e/mapping-composition-dataset.ts';
import { answerIdsFixture, attributeFixture } from './answer-fixtures.ts';
import type {
	WorkerGraphLink,
	WorkerGraphNode
} from '#lib/features/mapping/canvas/worker-relationship-map-model.ts';

export type WorksiteGraph = {
	/** The Worker ids, in the Worksite's own order. */
	ids: string[];
	nodes: WorkerGraphNode[];
	links: WorkerGraphLink[];
	/** Each Category by name. */
	attributes: Map<string, WorkerAttributeDefinition>;
};

export function worksiteGraph(worksite: CompositionWorksite): WorksiteGraph {
	const attributes = new Map(
		worksite.attributes.map((attribute) => [
			attribute.name,
			attributeFixture({
				id: `attribute-${attribute.name}`,
				name: attribute.name,
				kind: 'category',
				options: attribute.options
			})
		])
	);
	const ids = worksite.workers.map((_, index) => `worker-${index}`);
	const degree = new Map<string, number>();
	const links: WorkerGraphLink[] = worksite.relationships.map(([a, b], index) => {
		degree.set(ids[a], (degree.get(ids[a]) ?? 0) + 1);
		degree.set(ids[b], (degree.get(ids[b]) ?? 0) + 1);
		return { id: `link-${index}`, source: ids[a], target: ids[b], value: 1 };
	});
	const nodes: WorkerGraphNode[] = worksite.workers.map((worker, index) => ({
		id: ids[index],
		name: worker.name,
		assessment: 'Unassessed',
		attributes: answerIdsFixture(
			Object.fromEntries(
				Object.entries(worker.attributes).map(([name, value]) => [attributes.get(name)!.id, value])
			)
		),
		relationshipCount: degree.get(ids[index]) ?? 0
	}));
	return { ids, nodes, links, attributes };
}
