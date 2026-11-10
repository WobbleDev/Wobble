import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';

test('Compare groups reads two groups of one Attribute with labeled denominators', async ({
	page,
	request
}) => {
	const departmentId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: departmentId, name: 'Department', kind: 'category', options: ['Packing', 'Delivery'] }
		])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	for (const worker of [
		{ name: 'Alex', assessment: 'Leader', department: 'Packing' },
		{ name: 'Blair', assessment: 'Unassessed', department: 'Packing' },
		{ name: 'Casey', assessment: 'Supporter', department: 'Delivery' },
		{ name: 'Drew', assessment: 'Unassessed', department: '' }
	] as const) {
		await createWorker(request, {
			name: worker.name,
			assessment: worker.assessment,
			attributes: { [departmentId]: worker.department }
		});
	}

	await page.setViewportSize({ width: 1440, height: 1080 });
	await page.goto('/overview');
	await appReady(page);

	await page.getByRole('button', { name: 'Compare groups' }).click();
	const dialog = page.locator('[data-group-comparison]');
	await dialog.getByRole('button', { name: 'First group' }).click();
	await page.getByRole('option', { name: 'Packing' }).click();
	await expect(page.getByRole('option')).toHaveCount(0);
	await dialog.getByRole('button', { name: 'Second group' }).click();
	await page.getByRole('option', { name: 'Delivery' }).click();

	const row = (name: string) => dialog.locator(`[data-compare-row="${name}"]`);
	await expect(row('workers')).toContainText('2 of 4 · 50%');
	await expect(row('workers')).toContainText('of all Workers');
	await expect(row('assessed')).toContainText('1 of 2 · 50%');
	await expect(row('assessed')).toContainText('of Packing');
	await expect(row('support')).toContainText('1 of 1 · 100%');
	await expect(row('level-Unassessed')).toContainText('1 of 2 · 50%');
});

test('Jump to group turns the Support rows to the chosen group by identity', async ({
	page,
	request
}) => {
	const departmentId = randomUUID();
	const options = Array.from({ length: 12 }, (_, i) => `Unit ${String(i + 1).padStart(2, '0')}`);
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([{ id: departmentId, name: 'Department', kind: 'category', options }])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	for (const unit of options) {
		await createWorker(request, {
			name: `W ${unit}`,
			assessment: 'Supporter',
			attributes: { [departmentId]: unit }
		});
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/overview');
	await appReady(page);

	const last = options[options.length - 1];
	const rows = page.locator('[data-breakdown-rows] [data-group-row]:not([inert])');
	await expect(rows.filter({ hasText: last })).toHaveCount(0);
	await page.getByRole('button', { name: 'Jump to group' }).click();
	await page.getByRole('option', { name: last }).click();
	await expect(rows.filter({ hasText: last })).toHaveCount(1);
});
