import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';

const gap04Overall = (page: import('@playwright/test').Page) =>
	page.getByRole('region', { name: 'Overall support' });
const gap04ByCard = (page: import('@playwright/test').Page) =>
	page.getByRole('region', { name: /^By/ });
const gap04GroupLinks = (page: import('@playwright/test').Page) =>
	gap04ByCard(page).locator('ul li a[title]');
test('@product-gap-04 Support lists every Worker once, with the system no-value group last', async ({
	page,
	request
}) => {
	const departmentId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: departmentId,
				name: 'Department',
				kind: 'category',
				options: ['Packing', 'Delivery', 'No Department']
			}
		])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	for (const worker of [
		{ name: 'Alex', assessment: 'Leader', department: 'Packing' },
		{ name: 'Blair', assessment: 'Supporter', department: 'Delivery' },
		// Casey holds no answer; Drew holds the literal answer named No Department.
		{ name: 'Casey', assessment: 'Unassessed', department: '' },
		{ name: 'Drew', assessment: 'Activist', department: 'No Department' }
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

	// Whole-Worksite support keeps its arithmetic: 3 of 4, with Unassessed in the
	// denominator.
	await expect(gap04Overall(page)).toContainText('75%');
	await expect(gap04Overall(page)).toContainText('3 of 4, of all Workers');

	// Every Worker appears exactly once: two configured answers, the literal
	// answer's group, and the system group appended last.
	await expect(gap04GroupLinks(page)).toHaveCount(4);
	await expect(gap04GroupLinks(page).nth(0)).toHaveText('Packing');
	await expect(gap04GroupLinks(page).nth(1)).toHaveText('Delivery');

	const literal = gap04GroupLinks(page).nth(2);
	await expect(literal).toHaveAttribute('title', 'No Department');
	await expect(literal).toHaveText('No Department');
	await expect(literal).not.toContainText('No selection');

	const system = gap04GroupLinks(page).nth(3);
	await expect(system).toHaveAttribute('title', 'No Department');
	await expect(system).toHaveText('No Department');
	// The system group is the one link opening the missing-answer Workers.
	await expect(system).toHaveAttribute('href', /missing=/);
	await expect(literal).not.toHaveAttribute('href', /missing=/);
	await expect(gap04ByCard(page).locator('ul li a[href*="missing="]')).toHaveCount(1);
});
test('@product-gap-04 the system group disappears when every Worker holds an answer', async ({
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
		{ name: 'Blair', assessment: 'Supporter', department: 'Delivery' }
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

	await expect(gap04GroupLinks(page)).toHaveCount(2);
	await expect(gap04ByCard(page).locator('ul li a[href*="missing="]')).toHaveCount(0);
});
