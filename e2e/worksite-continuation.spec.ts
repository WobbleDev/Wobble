import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { createWorker, readDataset } from './api.ts';
import { wireDefinitions } from './answer-wire.ts';

test('the Worksite menu counts agree with each Worksite, and an empty one offers the first Worker', async ({
	page,
	request,
	activeWorksite
}) => {
	// A worker names every defined Attribute, so the seed defines none.
	const defined = await request.put('/api/attributes', { data: wireDefinitions([]) });
	expect(defined.ok()).toBeTruthy();
	await createWorker(request, { name: 'Worker 01' });
	await createWorker(request, { name: 'Worker 02' });
	const inActive = (await readDataset(request)).workers.length;
	expect(inActive).toBe(2);

	await page.goto('/overview');
	await appReady(page);
	const created = page.waitForResponse(
		(response) => response.url().endsWith('/api/worksite') && response.request().method() === 'POST'
	);
	await page.getByRole('button', { name: `Active Worksite: ${activeWorksite.name}` }).click();
	await page.getByRole('menuitem', { name: 'New Worksite' }).click();
	const empty = (await (await created).json()).worksite;
	await page
		.getByRole('dialog', { name: 'Set up your worksite' })
		.getByRole('button', { name: 'Skip setup' })
		.click();

	await page.getByRole('button', { name: `Active Worksite: ${empty.name}` }).click();
	const row = (name: string) =>
		page.getByRole('menuitem', { name, exact: false }).filter({ hasText: name });
	await expect(row(activeWorksite.name).locator('[data-worksite-count]')).toHaveText(
		String(inActive)
	);
	await expect(row(empty.name).locator('[data-worksite-count]')).toHaveText('0');
	await page.keyboard.press('Escape');

	await page.getByRole('link', { name: 'Add first worker' }).click();
	await expect(page).toHaveURL('/workers');
	await page.getByRole('button', { name: 'Add first worker' }).click();
	await expect(page.getByTestId('new-worker-row')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Import contacts' })).toBeVisible();
});
