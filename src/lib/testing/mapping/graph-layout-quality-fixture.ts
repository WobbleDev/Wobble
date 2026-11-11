import { answerIdsFixture, attributeFixture } from './answer-fixtures.ts';
import type { ArrangeInput } from '#lib/features/mapping/layout/graph-arrangement.ts';
import type {
	QualityBody,
	QualityRelationship
} from '#lib/features/mapping/layout/graph-layout-quality.ts';
import type {
	WorkerGraphLink,
	WorkerGraphNode
} from '#lib/features/mapping/worker-relationship-map-model.ts';

const qualityDepartment = attributeFixture({
	id: 'quality-department',
	name: 'Department',
	kind: 'category',
	options: ['Department 1', 'Department 2', 'Department 3', 'Department 4', 'Department 5']
});

const qualityRole = attributeFixture({
	id: 'quality-role',
	name: 'Role',
	kind: 'category',
	options: ['Role A', 'Role B', 'Role C', 'Role D']
});

const communitySizes = [8, 8, 8, 8, 7, 7, 7, 7];

export type QualityFixture = {
	nodes: WorkerGraphNode[];
	links: WorkerGraphLink[];
	communityByWorker: Map<string, string>;
	groupByWorker: Map<string, string>;
	subGroupByWorker: Map<string, string>;
};

/** A synthetic 60-Worker graph: eight dense-ish communities linked in a ring. */
export function createLayoutQualityFixture(): QualityFixture {
	const nodes: WorkerGraphNode[] = [];
	const communityByWorker = new Map<string, string>();
	const groupByWorker = new Map<string, string>();
	const subGroupByWorker = new Map<string, string>();
	let index = 0;
	for (let community = 0; community < communitySizes.length; community += 1) {
		for (let member = 0; member < communitySizes[community]; member += 1) {
			const id = `synthetic-${String(index + 1).padStart(2, '0')}`;
			const department = `Department ${(Math.floor(index / 12) % 5) + 1}`;
			const role = `Role ${String.fromCharCode(65 + (Math.floor(index / 3) % 4))}`;
			nodes.push({
				id,
				name: `Synthetic Worker ${index + 1}`,
				assessment: 'Unassessed',
				attributes: answerIdsFixture({
					[qualityDepartment.id]: department,
					[qualityRole.id]: role
				}),
				relationshipCount: 0
			});
			communityByWorker.set(id, `Community ${community + 1}`);
			groupByWorker.set(id, department);
			subGroupByWorker.set(id, `${department} / ${role}`);
			index += 1;
		}
	}
	const links: WorkerGraphLink[] = [];
	const seen = new Set<string>();
	const add = (a: string, b: string) => {
		const key = [a, b].sort().join('::');
		if (seen.has(key)) return;
		seen.add(key);
		links.push({
			id: `relationship-${String(links.length + 1).padStart(3, '0')}`,
			source: a,
			target: b,
			value: 1
		});
	};
	const communities: string[][] = [];
	let cursor = 0;
	for (const size of communitySizes) {
		communities.push(nodes.slice(cursor, cursor + size).map(({ id }) => id));
		cursor += size;
	}
	for (const community of communities) {
		for (let member = 0; member < community.length; member += 1) {
			add(community[member], community[(member + 1) % community.length]);
			add(community[member], community[(member + 2) % community.length]);
		}
	}
	for (let community = 0; community < communities.length; community += 1) {
		const here = communities[community];
		const next = communities[(community + 1) % communities.length];
		add(here[0], next[0]);
		add(here[Math.floor(here.length / 2)], next[Math.floor(next.length / 2)]);
	}
	const degree = new Map<string, number>(nodes.map(({ id }) => [id, 0]));
	for (const link of links) {
		degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
		degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
	}
	for (const node of nodes) node.relationshipCount = degree.get(node.id) ?? 0;
	return { nodes, links, communityByWorker, groupByWorker, subGroupByWorker };
}

export function qualityArrangeInput(
	fixture: QualityFixture,
	variant: 'free' | 'grouped' | 'nested'
): ArrangeInput {
	return {
		mode: variant === 'free' ? 'free' : 'grouped',
		nodes: fixture.nodes,
		links: fixture.links,
		groupingAttribute: variant === 'free' ? undefined : qualityDepartment,
		subGroupingAttribute: variant === 'nested' ? qualityRole : undefined,
		canvas: { width: 1280, height: 800 },
		gap: 80
	};
}

function bodiesForPartition(partition: ReadonlyMap<string, string>): QualityBody[] {
	const bodies = new Map<string, string[]>();
	for (const [workerId, bodyId] of partition) {
		const members = bodies.get(bodyId) ?? [];
		members.push(workerId);
		bodies.set(bodyId, members);
	}
	return [...bodies].map(([id, members]) => ({ id, members }));
}

export function partitionMaps(fixture: QualityFixture, variant: 'free' | 'grouped' | 'nested') {
	return variant === 'free'
		? [fixture.communityByWorker]
		: variant === 'grouped'
			? [fixture.groupByWorker]
			: [fixture.groupByWorker, fixture.subGroupByWorker];
}

export function bodiesForVariant(fixture: QualityFixture, variant: 'free' | 'grouped' | 'nested') {
	return partitionMaps(fixture, variant).flatMap(bodiesForPartition);
}

export function asQualityRelationships(links: readonly WorkerGraphLink[]): QualityRelationship[] {
	return links.map(({ id, source, target }) => ({
		id,
		source: String(source),
		target: String(target)
	}));
}
