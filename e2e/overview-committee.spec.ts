import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';
import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';

/**
 * My Committee: focusing the bullseye brings in a column of the Leaders beside the chart.
 * Its rows pin the same Worker the chart's dots do.
 */

async function seedCommittee(request: APIRequestContext) {
	const deptId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: deptId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House']
			}
		])
	});
	expect(configured.ok()).toBeTruthy();
	const crew: [string, string, string][] = [
		['Zara', 'Leader', 'Back of House'],
		['Ana', 'Leader', 'Front of House'],
		['Beto', 'Supporter', 'Front of House'],
		['Carla', 'Activist', 'Front of House'],
		['Diego', 'Disengaged', 'Back of House'],
		['Elena', 'Hostile', 'Back of House'],
		['Felipe', 'Supporter', 'Back of House'],
		['Gloria', 'Unassessed', 'Back of House'],
		['Hugo', 'Supporter', 'Back of House'],
		['Ines', 'Supporter', 'Front of House'],
		['Joel', 'Supporter', 'Front of House']
	];
	for (const [name, assessment, dept] of crew) {
		await createWorker(request, { name, assessment, attributes: { [deptId]: dept } });
	}
}

const edge = (page: Page) => page.locator('[data-focus-edge]');
const column = (page: Page) => page.locator('[data-committee-column]');
const members = (page: Page) => page.locator('[data-committee-member]');

test('lists the Leaders beside the focused bullseye, and hides at rest', async ({
	page,
	request
}) => {
	await seedCommittee(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	// At rest the column is out of the page: inert, and out of the reading order.
	await expect(column(page)).toHaveAttribute('inert', '');
	await expect(column(page)).toHaveCSS('opacity', '0');

	await edge(page).click();
	await expect(column(page)).not.toHaveAttribute('inert', '');
	await expect(column(page)).toHaveCSS('opacity', '1');
	await expect(column(page).getByRole('heading', { name: 'My Committee' })).toBeVisible();

	// Two Leaders, by name, each with their Department.
	await expect(members(page)).toHaveCount(2);
	await expect(members(page).first()).toContainText('Ana');
	await expect(members(page).first()).toContainText('Front of House');
	await expect(members(page).last()).toContainText('Zara');

	// Eleven Workers at 1 Leader per 5 need three Leaders: one is still missing.
	await expect(column(page).locator('[data-committee-coverage]')).toContainText('2 / 3 Leaders');
	await expect(column(page).locator('[data-committee-short]')).toHaveText('1 more needed');
});

test('a row pins that Leader on the chart, and a second press clears it', async ({
	page,
	request
}) => {
	await seedCommittee(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);
	await edge(page).click();

	const row = members(page).first();
	await row.click();
	await expect(row).toHaveAttribute('aria-pressed', 'true');
	const id = (await row.getAttribute('data-committee-member'))!;
	await expect(page.locator('circle[data-worker-id][data-selected]')).toHaveAttribute(
		'data-worker-id',
		id
	);

	await row.click();
	await expect(row).toHaveAttribute('aria-pressed', 'false');
	await expect(page.locator('circle[data-worker-id][data-selected]')).toHaveCount(0);

	// Returning to the dashboard drops a pin.
	await row.click();
	await expect(row).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
	await edge(page).click();
	await expect(row).toHaveAttribute('aria-pressed', 'false');
});
