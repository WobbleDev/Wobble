import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test, testId } from './fixtures.ts';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';
import { appReady } from './page-ready.ts';

const card = (page: Page) => page.getByRole('region', { name: 'Agitations' });
const headerTable = (page: Page) => card(page).locator('[data-agitations-headers]');

/** Each full name and the Abbreviation the core generates for it: initials, a shortened word, or the 9-grapheme cut. */
const longNames: Record<string, string> = {
	'Front of House Cleaning': 'FHC',
	'Back of House Maintenance': 'BHM',
	'Customer Service North': 'Customer …',
	'Community Support Team': 'CST',
	'North Warehouse Receiving': 'North War…',
	'South Warehouse Shipping': 'South War…',
	'Ward 12': 'Ward 12'
};

/** Configures the Attributes in one save (a save replaces the whole configuration). */
async function seedAttributes(
	request: APIRequestContext,
	attributes: { name: string; values: string[]; occupied?: string[] }[]
) {
	const ids = attributes.map(() => testId());
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions(
			attributes.map((attribute, index) => ({
				id: ids[index]!,
				name: attribute.name,
				kind: 'category',
				options: attribute.values
			}))
		)
	});
	expect(configured.ok()).toBeTruthy();
	const agitation = await request.post('/api/agitations', { data: { text: 'Pay' } });
	expect(agitation.ok()).toBeTruthy();
	const agitationId = (await agitation.json()).agitation.id as string;
	for (const [position, attribute] of attributes.entries()) {
		for (const [index, value] of (attribute.occupied ?? attribute.values).entries()) {
			await createWorker(request, {
				name: `Worker ${attribute.name} ${index}`,
				assessment: 'Supporter',
				attributes: { ...Object.fromEntries(ids.map((id) => [id, ''])), [ids[position]!]: value },
				agitations: [agitationId]
			});
		}
	}
	return ids;
}

async function seed(
	request: APIRequestContext,
	name: string,
	values: string[],
	occupied: string[] = values
) {
	return (await seedAttributes(request, [{ name, values, occupied }]))[0]!;
}

/** The label each header shows, keyed by its full name, across every page. */
async function collectHeaders(page: Page) {
	const collected: Record<string, string> = {};
	for (let turn = 0; turn < 20; turn += 1) {
		const entries = await headerTable(page)
			.locator('th[title]')
			.evaluateAll((headers) =>
				headers.map((header) => [
					header.getAttribute('title')!,
					header.querySelector('[data-group-name]')!.textContent!.trim()
				])
			);
		Object.assign(collected, Object.fromEntries(entries));
		const overflow = await headerTable(page).evaluate((table) => ({
			width: table.clientWidth,
			scroll: table.scrollWidth
		}));
		expect(overflow.scroll).toBeLessThanOrEqual(overflow.width + 1);
		const next = card(page).getByRole('button', { name: 'Next agitations page' });
		if (!(await next.count()) || (await next.isDisabled())) break;
		await next.click();
	}
	return collected;
}

async function pageCount(page: Page) {
	const next = card(page).getByRole('button', { name: 'Next agitations page' });
	let pages = 1;
	while ((await next.count()) && !(await next.isDisabled())) {
		await next.click();
		pages += 1;
	}
	return pages;
}

test('narrow headers show Abbreviations and wide headers show full names', async ({
	page,
	request,
	browserName
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => {
		// WebKit reports a ResizeObserver that settles over two frames as a page error; it is the
		// browser's own notice that a notification waited a frame, not a fault in the page.
		if (browserName === 'webkit' && error.message.startsWith('ResizeObserver loop completed'))
			return;
		errors.push(error.message);
	});
	const [departments, zones] = await seedAttributes(request, [
		{ name: 'Department', values: Object.keys(longNames) },
		// Two long names on one wide page share the whole card between them.
		{ name: 'Zone', values: ['Customer Service', 'Community Support'] }
	]);

	await page.setViewportSize({ width: 390, height: 874 });
	await page.goto('/overview?by=' + departments);
	await appReady(page);
	await expect(card(page)).toHaveAttribute('data-agitations-ready', 'true');
	expect(await collectHeaders(page)).toEqual({
		...longNames,
		'No Department': 'No Department'
	});
	await card(page).screenshot({ path: test.info().outputPath('abbreviations-390.png') });

	await page.setViewportSize({ width: 1800, height: 874 });
	await page.goto('/overview?by=' + zones);
	await appReady(page);
	await expect(card(page)).toHaveAttribute('data-agitations-ready', 'true');
	expect(await collectHeaders(page)).toEqual({
		'Customer Service': 'Customer Service',
		'Community Support': 'Community Support',
		'No Zone': 'No Zone'
	});
	expect(errors).toEqual([]);
});

test('the full name is the tooltip and accessible name, and the count links are unchanged', async ({
	page,
	request
}) => {
	await seed(request, 'Department', Object.keys(longNames));
	await page.setViewportSize({ width: 390, height: 874 });
	await page.goto('/overview');
	await appReady(page);
	const trigger = headerTable(page).getByRole('button', {
		name: 'Front of House Cleaning (1)',
		exact: true
	});
	await expect(trigger.locator('[data-group-name]')).toHaveText('FHC');
	await trigger.focus();
	await expect(trigger).toBeFocused();
	await expect(trigger).toHaveAttribute('aria-describedby', /.+/);
	const id = await trigger.getAttribute('aria-describedby');
	await expect(page.locator(`[id="${id}"]`)).toHaveText('Front of House Cleaning');
	await expect(
		card(page).locator('table.agitations-body').getByRole('columnheader', {
			name: 'Front of House Cleaning (1)',
			exact: true
		})
	).toHaveCount(1);
	await card(page)
		.getByRole('link', {
			name: 'View 1 Worker holding Pay in Front of House Cleaning',
			exact: true
		})
		.click();
	await expect(page).toHaveURL(/\/workers\?/);
	await expect(page.getByRole('row', { name: /Worker Department 0/ })).toBeVisible();
	await expect(page.getByRole('row', { name: /Worker Department 1/ })).toHaveCount(0);
});

test('labels never add a page: the count follows the whole columns that fit', async ({
	page,
	request
}) => {
	const names = [
		'Customer Service North',
		'Customer Service South',
		'Back of House Maintenance',
		'Front of House Cleaning',
		'Community Support Team',
		'Night Warehouse Receiving',
		'Day Warehouse Shipping',
		'Overnight Deep-Clean Crew'
	];
	const departments = await seed(request, 'Department', names);
	await page.setViewportSize({ width: 700, height: 874 });
	await page.goto('/overview?by=' + departments);
	await appReady(page);
	await expect(card(page)).toHaveAttribute('data-agitations-ready', 'true');
	const perPage = await headerTable(page).locator('th.agitation-group-header').count();
	expect(perPage).toBeGreaterThan(0);
	expect(await pageCount(page)).toBe(Math.ceil(names.length / perPage));
});

test('the No value reading stays in full beside Abbreviations', async ({ page, request }) => {
	const departments = await seed(
		request,
		'Department',
		['Customer Service North', 'Back of House Maintenance'],
		['Customer Service North', 'Back of House Maintenance', '']
	);
	await page.setViewportSize({ width: 390, height: 874 });
	await page.goto('/overview?by=' + departments);
	await appReady(page);
	await expect(card(page)).toHaveAttribute('data-agitations-ready', 'true');
	const collected = await collectHeaders(page);
	expect(collected['No Department']).toBe('No Department');
});
