import { expect, test } from './fixtures.ts';
import { worksiteDataset } from './api.ts';
import { appReady } from './page-ready.ts';
import { seedWorkers } from './workers-table-grid.ts';

test(
	'startup finishes when a required JavaScript chunk arrives after five seconds',
	{ tag: '@smoke' },
	async ({ page }) => {
		await page.route('**/_app/immutable/entry/start.*.js', async (route) => {
			// Model the slow local asset read captured in the release trace. This is
			// deliberate network latency, rather than a delay before an assertion.
			const response = await route.fetch();
			await new Promise((resolve) => setTimeout(resolve, 6500));
			await route.fulfill({ response });
		});
		await page.goto('/configuration');
		await expect(page.locator('#splash')).toBeVisible();
		await appReady(page);
		await expect(page.getByRole('heading', { name: 'Configuration', exact: true })).toBeVisible();
	}
);

test('startup failure removes the splash, copies safe details and retries without changing data', async ({
	page,
	context,
	request
}) => {
	await seedWorkers(request);
	const before = await worksiteDataset(request);
	await page.route(
		'**/api/dataset',
		(route) =>
			route.fulfill({
				status: 503,
				contentType: 'application/json',
				body: JSON.stringify({
					message: 'Private Worker Jane at /private/roster.sqlite',
					code: 'private-code'
				})
			}),
		{ times: 1 }
	);
	await page.goto('/workers');
	await expect(page.getByRole('heading', { name: 'Wobble could not start' })).toBeVisible();
	await expect(page.locator('#splash')).toHaveCount(0);
	await expect(page.locator('body')).not.toContainText('Private Worker Jane');
	await page.getByText('Technical details', { exact: true }).click();
	await expect(page.locator('pre')).toContainText('HTTP 503');
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.getByRole('button', { name: 'Copy details' }).click();
	await expect(page.getByRole('status')).toHaveText('Details copied.');
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	expect(copied).toContain('HTTP 503');
	expect(copied).not.toMatch(/Jane|private|roster/);
	await page.getByRole('button', { name: 'Retry', exact: true }).click();
	await appReady(page);
	await expect(page.getByRole('heading', { name: 'Workers', exact: true })).toBeVisible();
	expect(await worksiteDataset(request)).toEqual(before);
});
