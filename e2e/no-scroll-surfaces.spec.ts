import { randomUUID } from 'node:crypto';
import { appReady } from './page-ready.ts';
import { type APIRequestContext } from '@playwright/test';
import { clippedContent, expect, scrollableOverflow, test } from './fixtures.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';
import { seedManyCategories } from './workers-table-grid.ts';

// The floor is 1024×640: the smallest viewport a browser window realistically
// leaves. Every height here must fit without scrolling and without clipping.
const sizes = [
	{ width: 1024, height: 640 },
	{ width: 1024, height: 768 },
	{ width: 1280, height: 800 },
	{ width: 1366, height: 768 },
	{ width: 1920, height: 1080 }
] as const;

/** Two Workers in one Category, one relationship between them. */
async function seedMappedWorkers(request: APIRequestContext) {
	const deptId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: ['Front of House'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const ids: string[] = [];
	for (const name of ['Ada', 'Grace']) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({ [deptId]: 'Front of House' }),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
		ids.push((await created.json()).worker.id);
	}

	const related = await request.put(`/api/workers/${ids[0]}`, {
		data: {
			name: 'Ada',
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: wireWorkerAttributes({ [deptId]: 'Front of House' }),
			agitations: [],
			languages: [],
			relationships: [ids[1]],
			notes: []
		}
	});
	expect(related.ok()).toBeTruthy();
}

test('below the floor Overview scrolls again instead of clipping', async ({ page, request }) => {
	await seedManyCategories(request);
	// 624 = 39rem, one step under the 40rem floor: the guarantee is gone but
	// nothing is hidden — the surface scrolls instead.
	await page.setViewportSize({ width: 1024, height: 624 });
	await page.goto('/overview');
	await appReady(page);

	const result = await page.getByTestId('tab-scroll-viewport').evaluate((el) => {
		el.scrollTop = 0;
		const before = el.scrollTop;
		el.scrollTop = 9999;
		return { scrollable: el.scrollHeight > el.clientHeight + 1, moved: el.scrollTop > before };
	});
	expect(result).toEqual({ scrollable: true, moved: true });
});

test('Mapping never scrolls at or above the viewport floor', async ({ page, request }) => {
	await seedMappedWorkers(request);

	for (const size of sizes) {
		await page.setViewportSize(size);
		await page.goto('/mapping');
		await appReady(page);

		expect(await scrollableOverflow(page)).toBe(0);
		expect(await clippedContent(page)).toEqual([]);
	}
});

test('the shell enforces the rule at the floor and relaxes it below', async ({ page }) => {
	const viewport = page.getByTestId('tab-scroll-viewport');

	await page.setViewportSize({ width: 1024, height: 640 });
	await page.goto('/overview');
	// Overview clips rather than hides, so the dashboard's slid strip can still paint
	// under the navigation rail; either way nothing scrolls.
	await expect(viewport).toHaveCSS('overflow-y', /^(hidden|clip)$/);

	await page.goto('/mapping');
	await expect(viewport).toHaveCSS('overflow-y', 'hidden');

	// Exempt surfaces keep scrolling at the floor.
	await page.goto('/settings');
	await expect(viewport).toHaveCSS('overflow-y', 'auto');

	// Below the floor the guarantee lapses.
	await page.goto('/overview');
	await page.setViewportSize({ width: 1024, height: 624 });
	await expect(viewport).toHaveCSS('overflow-y', 'auto');
});
