import { randomUUID } from 'node:crypto';
import { appReady } from './page-ready.ts';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';

/**
 * Narrow-window pager traversal: three groups at 700px, where the page
 * controls appear. Guards the user-reported pager crash (the fit observer
 * feeding rendered pages back into fit writes until the framework's
 * update-depth guard replaced the dashboard with the error page): every turn
 * must keep the dashboard up and report no page error.
 */

const card = (page: Page) => page.getByRole('region', { name: 'Agitations' });
const controls = (page: Page) => card(page).locator('[data-agitations-page-controls]');
const next = (page: Page) => controls(page).getByRole('button', { name: 'Next agitations page' });
const prev = (page: Page) =>
	controls(page).getByRole('button', { name: 'Previous agitations page' });
const errorPage = (page: Page) => page.getByText('Wobble could not start');

async function seedThreeGroups(request: APIRequestContext): Promise<void> {
	const deptId = randomUUID();
	const groups = ['Front of House', 'Back of House', 'Overnight Deep-Clean Crew'];
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([{ id: deptId, name: 'Department', kind: 'category', options: groups }])
	});
	expect(configured.ok()).toBeTruthy();
	const texts = ['Pay', 'Hours', 'Staffing'];
	const ids: string[] = [];
	for (const text of texts) {
		const created = await request.post('/api/agitations', { data: { text } });
		expect(created.ok()).toBeTruthy();
		ids.push((await created.json()).agitation.id as string);
	}
	const assessments = ['Leader', 'Supporter', 'Activist', 'Supporter', 'Disengaged', 'Supporter'];
	for (let i = 0; i < groups.length; i += 1) {
		await createWorker(request, {
			name: 'Worker ' + (i + 1),
			assessment: assessments[i]!,
			attributes: { [deptId]: groups[i]! },
			agitations: [ids[i % ids.length]!, ids[(i + 1) % ids.length]!]
		});
		await createWorker(request, {
			name: 'Worker ' + (i + 1) + 'b',
			assessment: assessments[(i + 3) % assessments.length]!,
			attributes: { [deptId]: groups[i]! },
			agitations: [ids[(i + 2) % ids.length]!]
		});
	}
}

test('narrow pager traversal never shows the error page', async ({ page, request }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(String(error && (error as Error).message)));
	await seedThreeGroups(request);
	await page.setViewportSize({ width: 700, height: 874 });
	await page.goto('/overview');
	await appReady(page);
	await expect(card(page)).toHaveAttribute('data-agitations-ready', 'true');
	await expect(controls(page)).toBeVisible();

	for (let i = 0; i < 6; i += 1) {
		if (await next(page).isDisabled()) break;
		await next(page).click();
		await expect(errorPage(page)).toHaveCount(0);
		await expect(card(page)).toBeVisible();
	}
	for (let i = 0; i < 6; i += 1) {
		if (await prev(page).isDisabled()) break;
		await prev(page).click();
		await expect(errorPage(page)).toHaveCount(0);
		await expect(card(page)).toBeVisible();
	}
	await expect(errorPage(page)).toHaveCount(0);
	expect(errors).toEqual([]);
});
