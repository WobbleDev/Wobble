// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { decodeWorksiteDataset } from '#lib/client/dataset-api.ts';
import { arrange } from './graph-arrangement.ts';
import { buildWorkerGraph } from './worker-relationship-map-model.ts';
import collisionDotGrouped from '../../../../e2e/fixtures/mapping-label-collision-dot-grouped.json' with { type: 'json' };
import collisionSeed11 from '../../../../e2e/fixtures/mapping-label-collision-seed-11.json' with { type: 'json' };
import { attributeFixture, answerIdsFixture } from './answer-fixtures.ts';
import type { WorkerGraphLink, WorkerGraphNode } from './worker-relationship-map-model.ts';

/**
 * A tie is drawn heavier when it joins two different groups (map-canvas draws
 * `isCross` ties at stroke width 2 and the rest at 1). This file owns which ties are
 * cross ties: the arrangement's `crossLinkIds`, read on the captured fixtures and on a
 * small literal graph.
 */

describe('cross-group ties on the captured fixtures', () => {
	for (const [name, fixture] of [
		['seed 11', collisionSeed11],
		['dot overlap grouped capture', collisionDotGrouped]
	] as const) {
		it(`marks exactly the ties between two Departments, for ${name}`, () => {
			const dataset = decodeWorksiteDataset(fixture.dataset);
			const { nodes, links } = buildWorkerGraph(dataset.workers);
			const department = dataset.attributes.find((attribute) => attribute.id === fixture.deptId)!;
			const groupOf = new Map(
				nodes.map((node) => [node.id, String(node.attributes[department.id] ?? '')])
			);
			const expected = links
				.filter((link) => groupOf.get(link.source) !== groupOf.get(link.target))
				.map((link) => link.id)
				.sort();

			const { crossLinkIds } = arrange({
				mode: 'grouped',
				nodes,
				links,
				groupingAttribute: department,
				canvas: { width: 1280, height: 800 },
				gap: 24
			});

			expect([...crossLinkIds].sort()).toEqual(expected);
			expect(expected.length).toBeGreaterThan(0);
			expect(expected.length).toBeLessThan(links.length);
		});
	}
});

describe('cross-group ties on a literal graph', () => {
	const department = attributeFixture({
		id: 'dept',
		name: 'Department',
		kind: 'category',
		options: ['North', 'South']
	});
	const node = (id: string, answer: string) =>
		({
			id,
			name: id,
			assessment: 'Unassessed',
			attributes: answerIdsFixture({ [department.id]: answer }),
			relationshipCount: 0
		}) as WorkerGraphNode;
	const link = (source: string, target: string): WorkerGraphLink =>
		({ id: JSON.stringify([source, target]), source, target, value: 1 }) as WorkerGraphLink;

	it('leaves a tie inside one Department out of the cross set and takes the one between Departments', () => {
		const nodes = [node('a', 'North'), node('b', 'North'), node('c', 'South')];
		const links = [link('a', 'b'), link('b', 'c')];
		const { crossLinkIds } = arrange({
			mode: 'grouped',
			nodes,
			links,
			groupingAttribute: department,
			canvas: { width: 800, height: 600 },
			gap: 24
		});

		expect(crossLinkIds.has(links[0].id)).toBe(false);
		expect(crossLinkIds.has(links[1].id)).toBe(true);
		expect(crossLinkIds.size).toBe(1);
	});
});
