import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

const names = ['French', 'Mandarin', 'Spanish', 'Polish'];

test('multi-value cells show two chips and +N, with one row height', async ({ page, request }) => {
	test.setTimeout(120_000);
	const ids: string[] = [];
	for (const name of names) {
		const created = await request.post('/api/languages', { data: { name } });
		expect(created.ok()).toBeTruthy();
		const { language }: { language: { id: string } } = await created.json();
		ids.push(language.id);
	}
	const cleared = await request.put('/api/attributes', { data: wireDefinitions([]) });
	expect(cleared.ok()).toBeTruthy();

	for (let index = 0; index < 12; index++) {
		const created = await request.post('/api/workers', {
			data: {
				name: `Chip Worker ${String(index).padStart(2, '0')}`,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({}),
				agitations: [],
				languages: ids.slice(0, index % 5),
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}

	await page.goto('/workers');
	await appReady(page);

	const four = page.getByRole('row').filter({ hasText: 'Chip Worker 04' });
	const button = four.getByRole('button', { name: /^Edit languages for Chip Worker 04/ });
	await expect(button).toBeVisible();
	await expect(button).toContainText('+2');
	for (const name of names) await expect(button).toHaveAccessibleName(new RegExp(name));

	await button.click();
	const items = page.getByRole('menuitemcheckbox');
	await expect(items).toHaveCount(4);
	for (const item of await items.all()) await expect(item).toBeChecked();
	await page.keyboard.press('Escape');

	const rows = page.getByRole('row').filter({ hasText: 'Chip Worker' });
	const heights: number[] = [];
	for (const row of (await rows.all()).slice(0, 10)) {
		const box = await row.boundingBox();
		heights.push(Math.round(box?.height ?? 0));
	}
	expect(heights.length).toBe(10);
	expect(new Set(heights).size).toBe(1);
});
