import { randomUUID } from 'node:crypto';
import { type APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { waitForMapInteraction } from './map.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

test.use({ reducedMotion: 'reduce' });

async function seed(request: APIRequestContext) {
	const teamId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: teamId, name: 'Team', kind: 'category', options: ['Shipping', 'Support'] }
		])
	});
	expect(configured.ok()).toBeTruthy();
	const ids: string[] = [];
	for (const [name, assessment] of [
		['Worker 01', 'Leader'],
		['Worker 02', 'Supporter'],
		['Worker 03', 'Supporter'],
		['Worker 04', 'Hostile']
	] as const) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment,
				attributes: wireWorkerAttributes({ [teamId]: 'Shipping' }),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status()).toBe(201);
		ids.push((await created.json()).worker.id);
	}
	const related = await request.put(`/api/workers/${ids[0]}`, {
		data: {
			name: 'Worker 01',
			email: '',
			phone: '',
			assessment: 'Leader',
			attributes: wireWorkerAttributes({ [teamId]: 'Shipping' }),
			agitations: [],
			languages: [],
			relationships: [ids[1]],
			notes: []
		}
	});
	expect(related.ok()).toBeTruthy();
	return ids;
}

test('filters that leave nobody name the filters and clear only them', async ({
	page,
	request
}) => {
	await seed(request);
	await page.goto('/mapping');
	await waitForMapInteraction(page);
	const reading = page.getByTestId('map-scope-reading');
	await expect(reading).toHaveText('4 of 4 workers drawn');

	await page.getByRole('searchbox', { name: 'Find a worker' }).fill('Worker 0');
	for (const name of ['Leader', 'Supporter', 'Hostile']) {
		await page.getByRole('button', { name: new RegExp(`^${name}, \\d+ workers?, shown`) }).click();
	}
	await expect(page.getByTestId('map-empty-state')).toHaveAttribute('data-kind', 'filters');
	await expect(reading).toHaveText('0 of 4 workers drawn · 4 hidden by filters');

	await page.getByTestId('map-empty-state').getByRole('button', { name: 'Clear filters' }).click();
	await expect(page.getByTestId('map-empty-state')).toHaveCount(0);
	await expect(reading).toHaveText('4 of 4 workers drawn');
	// The search is its own scope: Clear filters leaves it.
	await expect(page.getByRole('searchbox', { name: 'Find a worker' })).toHaveValue('Worker 0');
});

test('Isolate states drawn, listed and isolated-away counts that match the Map table', async ({
	page,
	request
}) => {
	const ids = await seed(request);
	await page.goto('/mapping');
	await waitForMapInteraction(page);
	const reading = page.getByTestId('map-scope-reading');

	// Hide Hostile so drawn and total differ, then isolate Worker 01 (one Relationship).
	await page.getByRole('button', { name: /^Hostile, \d+ workers?, shown/ }).click();
	await page.locator(`[data-node-id="${ids[0]}"]`).click();
	await page.getByRole('button', { name: 'Isolate', exact: true }).click();

	await expect(reading).toHaveText(
		'3 of 4 workers drawn · 1 hidden by filters · Isolate lists 2, 1 isolated away'
	);
	const rows = page.getByTestId('mapping-table').getByRole('row');
	// One header row plus the listed Workers.
	await expect(rows).toHaveCount(1 + 2);
});
