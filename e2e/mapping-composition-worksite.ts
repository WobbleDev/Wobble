import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { expect } from './fixtures.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';
import type { CompositionWorksite } from './mapping-composition-dataset.ts';

export * from './mapping-composition-dataset.ts';

export type PopulatedWorksite = {
	/** Each Worker's stored id, in the order the spec lists them. */
	ids: string[];
	/** The Worksite's own id for each Category, by name. */
	attributeIds: Map<string, string>;
};

/** Stores the Worksite through the API. */
export async function populateWorksite(
	request: APIRequestContext,
	worksite: CompositionWorksite
): Promise<PopulatedWorksite> {
	const attributeIds = new Map(
		worksite.attributes.map((attribute) => [attribute.name, randomUUID()])
	);
	const answers = (attributes: Record<string, string>) =>
		Object.fromEntries(
			Object.entries(attributes).map(([name, value]) => [attributeIds.get(name)!, value])
		);
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions(
			worksite.attributes.map((attribute) => ({
				id: attributeIds.get(attribute.name)!,
				name: attribute.name,
				options: attribute.options,
				kind: 'category'
			}))
		)
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	const ids: string[] = [];
	for (const worker of worksite.workers) {
		const created = await request.post('/api/workers', {
			data: {
				name: worker.name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes(answers(worker.attributes)),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
		ids.push((await created.json()).worker.id as string);
	}
	const partners = ids.map(() => new Set<string>());
	for (const [a, b] of worksite.relationships) {
		partners[a].add(ids[b]);
		partners[b].add(ids[a]);
	}
	for (let index = 0; index < ids.length; index += 1) {
		const updated = await request.put(`/api/workers/${ids[index]}`, {
			data: {
				name: worksite.workers[index].name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes(answers(worksite.workers[index].attributes)),
				agitations: [],
				languages: [],
				relationships: [...partners[index]],
				notes: []
			}
		});
		expect(updated.ok(), await updated.text()).toBeTruthy();
	}
	return { ids, attributeIds };
}
