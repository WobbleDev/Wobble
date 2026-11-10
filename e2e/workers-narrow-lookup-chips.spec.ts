import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

async function seed(request: import('@playwright/test').APIRequestContext) {
	const ids: string[] = [];
	for (const name of ['French', 'Mandarin']) {
		const created = await request.post('/api/languages', { data: { name } });
		expect(created.ok()).toBeTruthy();
		ids.push((await created.json()).language.id as string);
	}
	const cleared = await request.put('/api/attributes', { data: wireDefinitions([]) });
	expect(cleared.ok()).toBeTruthy();
	for (let index = 0; index < 3; index++) {
		const created = await request.post('/api/workers', {
			data: {
				name: `Worker ${String(index).padStart(2, '0')}`,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({}),
				agitations: [],
				languages: ids,
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}
}

for (const [width, textSize] of [
	[320, '100'],
	[375, '100'],
	[390, '100'],
	[375, '150']
] as const) {
	test(`at ${width}px, text ${textSize}%, the search sits on its own row and the table scrolls itself`, async ({
		page,
		request
	}) => {
		await seed(request);
		await page.setViewportSize({ width, height: 800 });
		await page.goto('/workers');
		await appReady(page);
		await page.evaluate((size) => (document.documentElement.dataset.textSize = size), textSize);

		const search = page.locator('[data-worker-search]');
		const newWorker = page.locator('[data-new-worker-trigger]');
		await expect(search).toBeVisible();
		const [s, n] = await Promise.all([search.boundingBox(), newWorker.boundingBox()]);
		expect(s!.x).toBeGreaterThanOrEqual(0);
		expect(s!.x + s!.width).toBeLessThanOrEqual(width);
		expect(s!.y).toBeGreaterThanOrEqual(n!.y + n!.height - 1);
		await expect(newWorker).toBeVisible();
		expect(n!.x + n!.width).toBeLessThanOrEqual(width);

		await search.fill('Worker 01');
		await expect(page.getByTestId('worker-count')).toBeVisible();
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);
	});
}

test('chips stay distinct from normal, hovered and checked rows in both themes and increased contrast', async ({
	page,
	request
}) => {
	await seed(request);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/workers');
	await appReady(page);

	const row = page.getByRole('row').filter({ hasText: 'Worker 01' });
	const chip = row.getByText('French', { exact: true }).first();
	const gap = () =>
		page.evaluate(
			([r, c]) => {
				const rowEl = document.querySelector(r) as HTMLElement;
				const cell = rowEl.querySelector('td:not([data-pin])') as HTMLElement;
				const chipEl = rowEl.querySelector(c) as HTMLElement;
				return [getComputedStyle(cell).backgroundColor, getComputedStyle(chipEl).backgroundColor];
			},
			['tbody tr[data-worker-id]:nth-child(2)', 'span.bg-chip']
		);
	for (const [dark, contrast] of [
		[false, 'off'],
		[true, 'off'],
		[false, 'on'],
		[true, 'on']
	] as const) {
		await page.evaluate(
			([d, c]) => {
				document.documentElement.classList.toggle('dark', d);
				document.documentElement.dataset.contrast = c;
			},
			[dark, contrast] as const
		);
		await expect(chip).toBeVisible();
		await expect(chip).toHaveCSS('box-shadow', /rgb/);
		const [rowBg, chipBg] = await gap();
		expect(chipBg).not.toBe(rowBg);
		await row.hover();
		const [hoverBg, chipHover] = await gap();
		expect(chipHover).not.toBe(hoverBg);
		await row.getByRole('checkbox').check();
		const [checkedBg, chipChecked] = await gap();
		expect(chipChecked).not.toBe(checkedBg);
		await row.getByRole('checkbox').uncheck();
	}
});
