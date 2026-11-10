import type { APIRequestContext } from '@playwright/test';
import { expect, testId } from './fixtures.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

/**
 * Builds a Worksite through the Attribute value wire mapping: Attributes are defined with
 * text answers, Workers name answers as text, and every function returns the ids it
 * created, so a spec can keep addressing what it seeded. Function-style on purpose: a
 * scenario reads top to bottom.
 */

export type AttributeSeed = {
	id?: string;
	name: string;
	kind: 'category' | 'tag';
	options: string[];
};

/** A Worker to create; attributes are answers given as text, not ids. */
export type WorksiteWorkerSeed = {
	name: string;
	assessment?: string;
	email?: string;
	phone?: string;
	attributes?: Record<string, string | string[]>;
	agitations?: string[];
	languages?: string[];
	relationships?: string[];
	notes?: { id: string; text: string; timestamp: string }[];
};

/** Adds or replaces the Worksite's Attributes; returns their ids in the order given. */
export async function addAttributes(
	request: APIRequestContext,
	definitions: AttributeSeed[]
): Promise<string[]> {
	const ids = definitions.map((definition) => definition.id ?? testId());
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions(
			definitions.map((definition, index) => ({ ...definition, id: ids[index] }))
		)
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	return ids;
}

/** Creates Workers from text answers; returns their ids in the order given. */
export async function addWorkers(
	request: APIRequestContext,
	seeds: WorksiteWorkerSeed[]
): Promise<string[]> {
	const ids: string[] = [];
	for (const seed of seeds) {
		const created = await request.post('/api/workers', {
			data: {
				name: seed.name,
				email: seed.email ?? '',
				phone: seed.phone ?? '',
				assessment: seed.assessment ?? 'Unassessed',
				attributes: wireWorkerAttributes(seed.attributes ?? {}),
				agitations: seed.agitations ?? [],
				languages: seed.languages ?? [],
				relationships: seed.relationships ?? [],
				notes: seed.notes ?? []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
		ids.push(((await created.json()) as { worker: { id: string } }).worker.id);
	}
	return ids;
}

/** Creates one Agitation per text; returns their ids in the order given. */
export async function addAgitations(
	request: APIRequestContext,
	names: string[]
): Promise<string[]> {
	const ids: string[] = [];
	for (const text of names) {
		const created = await request.post('/api/agitations', { data: { text } });
		expect(created.ok(), await created.text()).toBeTruthy();
		ids.push(((await created.json()) as { agitation: { id: string } }).agitation.id);
	}
	return ids;
}

/** Creates one Language per name; returns their ids in the order given. */
export async function addLanguages(request: APIRequestContext, names: string[]): Promise<string[]> {
	const ids: string[] = [];
	for (const name of names) {
		const created = await request.post('/api/languages', { data: { name } });
		expect(created.ok(), await created.text()).toBeTruthy();
		ids.push(((await created.json()) as { language: { id: string } }).language.id);
	}
	return ids;
}
