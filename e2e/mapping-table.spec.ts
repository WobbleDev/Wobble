import { randomUUID } from 'node:crypto';
import { type APIRequestContext, type Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { waitForMapReady } from './map.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

async function seed(request: APIRequestContext) {
	const teamId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: teamId, name: 'Team', kind: 'category', options: ['Shipping', 'Support'] }
		])
	});
	expect(configured.ok()).toBeTruthy();
	const people = [
		{ name: 'Ada', assessment: 'Leader', team: 'Shipping' },
		{ name: 'Bo', assessment: 'Supporter', team: 'Shipping' },
		{ name: 'Cy', assessment: 'Hostile', team: undefined }
	] as const;
	const ids: string[] = [];
	for (const person of people) {
		const created = await request.post('/api/workers', {
			data: {
				name: person.name,
				email: '',
				phone: '',
				assessment: person.assessment,
				attributes: wireWorkerAttributes({ [teamId]: person.team ?? '' }),
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
			name: 'Ada',
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
	return { ids };
}

async function showTable(page: Page) {
	await expect(page.getByRole('region', { name: 'Map table' })).toBeAttached();
}

test('there is no visible Map/Table toggle and the table takes no layout space', async ({
	page,
	request
}) => {
	await seed(request);
	await page.goto('/mapping');
	await expect(page.getByRole('group', { name: 'Mapping presentation' })).toHaveCount(0);
	const box = await page.getByTestId('mapping-table').boundingBox();
	expect(box === null || (box.width <= 1 && box.height <= 1)).toBe(true);
});

test('the skip link stays off the visible keyboard path and still focuses the table', async ({
	page,
	request
}) => {
	await seed(request);
	await page.goto('/mapping');
	await waitForMapReady(page);
	const skip = page.getByRole('link', { name: 'Skip to map data table' });
	await expect(skip).toHaveCount(1);
	await expect(skip).toHaveAttribute('tabindex', '-1');
	const box = await skip.boundingBox();
	expect(box === null || (box.width <= 1 && box.height <= 1)).toBe(true);
	// A screen reader can still follow it; it just never shows as a sighted Tab stop.
	await skip.focus();
	await expect(skip).toBeFocused();
	await skip.press('Enter');
	await expect(page.getByTestId('mapping-table')).toBeFocused();
});

test('nothing inside the map table is a keyboard tab stop', async ({ page, request }) => {
	await seed(request);
	await page.goto('/mapping');
	await waitForMapReady(page);
	await expect(page.locator('[data-map-table-row]')).toHaveCount(3);
	// Rows, sort controls and the skip link are readable by assistive tech but never
	// take a Tab stop: the table is a screen-reader-only reading, not a visible surface.
	await expect(page.locator('#mapping-table [tabindex="0"]')).toHaveCount(0);

	for (let step = 0; step < 24; step += 1) {
		await page.keyboard.press('Tab');
		const inTable = await page.evaluate(() =>
			Boolean(document.activeElement?.closest('#mapping-table'))
		);
		expect(inTable, `tab stop ${step + 1} entered the map table`).toBe(false);
	}
});

test('hiding an Assessment in the key removes its rows', async ({ page, request }) => {
	await seed(request);
	await page.goto('/mapping');
	await showTable(page);
	await expect(page.locator('[data-map-table-row]')).toHaveCount(3);
	await page.getByRole('button', { name: 'Hostile, 1 workers, shown' }).click();
	await expect(page.locator('[data-map-table-row]')).toHaveCount(2);
	await expect(page.getByRole('cell', { name: 'Cy', exact: true })).toHaveCount(0);
});

test('a row opens the record panel', async ({ page, request }) => {
	await seed(request);
	await page.goto('/mapping');
	await showTable(page);
	await page.locator('[data-map-table-row]').filter({ hasText: 'Ada' }).dispatchEvent('click');
	await expect(page.getByRole('region', { name: 'Worker record' })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Worker record' })).toContainText('Ada');
});

test('headers sort by keyboard', async ({ page, request }) => {
	await seed(request);
	await page.goto('/mapping');
	await showTable(page);
	const header = page.getByRole('columnheader', { name: 'Worker' });
	const button = header.getByRole('button');
	await button.focus();
	await button.press('Enter');
	await expect(header).toHaveAttribute('aria-sort', 'descending');
});

test('filtering out the selected worker closes the record panel', async ({ page, request }) => {
	await seed(request);
	await page.goto('/mapping');
	await showTable(page);
	await page.locator('[data-map-table-row]').filter({ hasText: 'Cy' }).dispatchEvent('click');
	await expect(page.getByRole('region', { name: 'Worker record' })).toBeVisible();
	await page.getByRole('button', { name: 'Hostile, 1 workers, shown' }).click();
	await expect(page.getByRole('region', { name: 'Worker record' })).toHaveCount(0);
	await expect(page.locator('[data-map-table-row]').filter({ hasText: 'Cy' })).toHaveCount(0);
});
