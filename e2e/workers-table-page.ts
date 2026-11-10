import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { seedWorkers } from './workers-table-grid.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

/** Options for opening the Workers table in an e2e spec. */
export type WorkersTableOptions = {
	/** Seeds the Worksite first; the standard Workers table by default. */
	seed?: (request: APIRequestContext) => Promise<void>;
	/** Resizes the window before navigating; the Playwright default when omitted. */
	viewport?: { width: number; height: number };
	/** Waits until this many Worker rows are rendered. */
	rows?: number;
};

/**
 * Seeds a Worksite, opens the Workers table and waits for the shell to mount.
 * Specs that need a different Workers table or window size pass them in the options.
 */
export async function openWorkersTable(
	page: Page,
	request: APIRequestContext,
	{ seed = seedWorkers, viewport, rows }: WorkersTableOptions = {}
): Promise<void> {
	await seed(request);
	if (viewport) await page.setViewportSize(viewport);
	await page.goto('/workers');
	await appReady(page);
	if (rows !== undefined) {
		await expect(page.locator('tbody tr[data-worker-id]')).toHaveCount(rows);
	}
}

/**
 * A Workers table with everything the record reads: a Category Attribute, a Tag
 * Attribute, an Agitation, and a Note on the Worker this suite opens.
 */
export async function seedInspectorWorkers(request: APIRequestContext) {
	const departmentId = randomUUID();
	const shiftsId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: departmentId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House']
			},
			{ id: shiftsId, name: 'Shifts', kind: 'tag', options: ['Dinner', 'Brunch'] }
		])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	const agitation = await request.post('/api/agitations', { data: { text: 'Pay' } });
	expect(agitation.ok(), await agitation.text()).toBeTruthy();
	const payId = (await agitation.json()).agitation.id as string;
	const language = await request.post('/api/languages', { data: { name: 'English' } });
	expect(language.ok(), await language.text()).toBeTruthy();
	const englishId = (await language.json()).language.id as string;

	const names = ['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson'];
	for (const name of names) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: `${name.split(' ')[0].toLowerCase()}@example.test`,
				phone: '555-0100',
				assessment: 'Supporter',
				attributes: wireWorkerAttributes({
					[departmentId]: 'Front of House',
					[shiftsId]: ['Dinner']
				}),
				agitations: [payId],
				languages: [englishId],
				relationships: [],
				notes: [
					{ id: `note-${name}`, text: `${name} notes`, timestamp: '2024-01-01T00:00:00.000Z' }
				]
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}
}
