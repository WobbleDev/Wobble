import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { createWorkerWithIds } from './api.ts';

/**
 * Issue 214: a By-Attribute row with children opens in place, the bars show their
 * standing colours on row hover and their numbers on bar hover, and every bar segment
 * (the Overall support bar's too) opens the Workers of that standing.
 */

type Seeded = { departmentId: string; ids: Record<string, string> };

/** Kitchen holds two children, and Ed holds Kitchen itself, so opening it leaves a remainder. */
async function seed(request: APIRequestContext): Promise<Seeded> {
	const departmentId = 'department-' + randomUUID();
	const ids = {
		kitchen: 'kitchen-' + randomUUID(),
		line: 'line-' + randomUUID(),
		prep: 'prep-' + randomUUID(),
		floor: 'floor-' + randomUUID()
	};
	const configured = await request.put('/api/attributes', {
		data: [
			{
				id: departmentId,
				name: 'Department',
				kind: 'category',
				options: [
					{ id: ids.kitchen, value: 'Kitchen' },
					{ id: ids.line, value: 'Line', parentId: ids.kitchen },
					{ id: ids.prep, value: 'Prep', parentId: ids.kitchen },
					{ id: ids.floor, value: 'Floor' }
				]
			}
		]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	for (const worker of [
		{ name: 'Ana', assessment: 'Leader', answer: ids.line },
		{ name: 'Beto', assessment: 'Supporter', answer: ids.line },
		{ name: 'Carla', assessment: 'Hostile', answer: ids.prep },
		{ name: 'Ed', assessment: 'Supporter', answer: ids.kitchen },
		{ name: 'Dina', assessment: 'Supporter', answer: ids.floor }
	]) {
		await createWorkerWithIds(request, {
			name: worker.name,
			assessment: worker.assessment,
			attributes: { [departmentId]: worker.answer }
		});
	}
	return { departmentId, ids };
}

const byCard = (page: Page) => page.getByRole('region', { name: 'By Department' });
const rowNames = (page: Page) =>
	byCard(page).getByRole('link').and(page.locator('a[title]')).allTextContents();
const workerRows = (page: Page) => page.locator('tbody tr[data-worker-id]');

async function openOverview(page: Page): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto('/overview');
	await appReady(page);
	await expect(byCard(page)).toHaveAttribute('data-breakdown-ready', 'true');
}

test('a branch opens in place into its children and exact remainder, and closes again', async ({
	page,
	request
}) => {
	await seed(request);
	await openOverview(page);
	expect(await rowNames(page)).toEqual(['Kitchen', 'Floor']);

	const expand = byCard(page).getByRole('button', { name: 'Expand Kitchen', exact: true });
	await expect(expand).toHaveAttribute('aria-expanded', 'false');
	await expand.click();
	await expect(byCard(page).getByRole('button', { name: 'Collapse Kitchen' })).toHaveAttribute(
		'aria-expanded',
		'true'
	);
	await expect(byCard(page)).toHaveAttribute('data-breakdown-ready', 'true');
	// The branch is replaced by its children and the Workers holding Kitchen itself.
	await expect
		.poll(() => rowNames(page))
		.toEqual(expect.arrayContaining(['Line', 'Prep', 'Floor']));
	expect((await rowNames(page)).filter((name) => name === 'Kitchen')).toHaveLength(1);

	await byCard(page).getByRole('button', { name: 'Collapse Kitchen' }).click();
	await expect.poll(() => rowNames(page)).toEqual(['Kitchen', 'Floor']);
});

test('colours show on row hover, numbers and a highlight on bar hover', async ({
	page,
	request
}) => {
	await seed(request);
	await openOverview(page);
	const row = byCard(page)
		.locator('[data-group-row]:not([inert])')
		.filter({ has: page.getByRole('link', { name: 'Kitchen', exact: true }) });
	const bar = row.locator('.neutral-bar');
	const colours = () =>
		bar
			.locator('.seg')
			.evaluateAll((segments) => segments.map((s) => getComputedStyle(s).backgroundColor));
	const countOpacity = () =>
		bar
			.locator('.seg-count')
			.first()
			.evaluate((count) => getComputedStyle(count).opacity);

	await page.mouse.move(0, 0);
	const resting = await colours();
	expect(await countOpacity()).toBe('0');

	// The row's name is not the bar: colours only.
	await row.getByRole('link', { name: 'Kitchen', exact: true }).hover();
	await expect.poll(colours).not.toEqual(resting);
	expect(await countOpacity()).toBe('0');

	await bar.hover();
	await expect.poll(countOpacity).toBe('1');
});

test('bar segments open the Workers of that standing, for a group and for the whole Worksite', async ({
	page,
	request
}) => {
	await seed(request);
	await openOverview(page);

	// Kitchen's Supporter segment: its subtree (Line, Prep and Kitchen itself) at one standing; Floor's Supporter stays out.
	await byCard(page)
		.getByRole('link', { name: /^2 Supporters in Kitchen\. Open in Workers$/ })
		.click();
	await page.waitForURL(/\/workers/);
	await appReady(page);
	await expect(workerRows(page)).toHaveCount(2);
	await expect(workerRows(page).filter({ hasText: 'Beto' })).toHaveCount(1);
	await expect(workerRows(page).filter({ hasText: 'Ed' })).toHaveCount(1);

	await page.goBack();
	await appReady(page);
	await expect(byCard(page)).toHaveAttribute('data-breakdown-ready', 'true');

	// The Overall bar spans the Worksite: all three Supporters.
	await page
		.getByRole('region', { name: 'Overall support' })
		.getByRole('link', { name: /^3 Supporters, of all Workers\. Open in Workers$/ })
		.click();
	await page.waitForURL(/\/workers/);
	await appReady(page);
	await expect(workerRows(page)).toHaveCount(3);
});
