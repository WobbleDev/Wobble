import { appReady } from './page-ready.ts';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test, testId } from './fixtures.ts';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';
import { answerId } from './answer-wire.ts';
import { openOverview as openSharedOverview } from './pages.ts';
import { addAttributes, addWorkers } from './worksite-builder.ts';

/**
 * Ticket 03: readings open Workers. A group name, a matrix cell and an All cell
 * each open the Workers they read, and every one of those links works by keyboard.
 */

async function seedDashboard(
	request: APIRequestContext
): Promise<{ deptId: string; payId: string }> {
	const deptId = testId();
	const roleId = testId();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: deptId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House']
			},
			{ id: roleId, name: 'Role', kind: 'category', options: ['Cook', 'Server'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const pay = await request.post('/api/agitations', { data: { text: 'Pay' } });
	expect(pay.ok()).toBeTruthy();
	const payId = (await pay.json()).agitation.id as string;
	const hours = await request.post('/api/agitations', { data: { text: 'Hours' } });
	expect(hours.ok()).toBeTruthy();
	const hoursId = (await hours.json()).agitation.id as string;
	const snacks = await request.post('/api/agitations', { data: { text: 'Snacks' } });
	expect(snacks.ok()).toBeTruthy();
	const snacksId = (await snacks.json()).agitation.id as string;

	const crew: {
		name: string;
		assessment: string;
		dept: string;
		role: string;
		agitations: string[];
	}[] = [
		{
			name: 'Ana',
			assessment: 'Leader',
			dept: 'Front of House',
			role: 'Cook',
			agitations: [payId]
		},
		{
			name: 'Beto',
			assessment: 'Supporter',
			dept: 'Front of House',
			role: 'Cook',
			agitations: [payId, hoursId, snacksId]
		},
		{
			name: 'Carla',
			assessment: 'Activist',
			dept: 'Front of House',
			role: 'Server',
			agitations: [hoursId]
		},
		{
			name: 'Diego',
			assessment: 'Disengaged',
			dept: 'Back of House',
			role: 'Cook',
			agitations: []
		},
		{
			name: 'Elena',
			assessment: 'Hostile',
			dept: 'Back of House',
			role: 'Cook',
			agitations: [payId]
		},
		{
			name: 'Felipe',
			assessment: 'Supporter',
			dept: 'Back of House',
			role: 'Server',
			agitations: []
		},
		{
			name: 'Gloria',
			assessment: 'Unassessed',
			dept: 'Back of House',
			role: 'Server',
			agitations: []
		},
		{
			name: 'Hugo',
			assessment: 'Supporter',
			dept: 'Back of House',
			role: 'Server',
			agitations: [payId]
		}
	];
	for (const worker of crew) {
		await createWorker(request, {
			name: worker.name,
			assessment: worker.assessment,
			attributes: { [deptId]: worker.dept, [roleId]: worker.role },
			agitations: worker.agitations
		});
	}
	return { deptId, payId };
}

const byCard = (page: Page, name: string) => page.getByRole('region', { name: 'By ' + name });
const agitationsCard = (page: Page) => page.getByRole('region', { name: 'Agitations' });
const workerRows = (page: Page) => page.locator('tbody tr[data-worker-id]');
const workerCount = (page: Page) => page.getByTestId('worker-count');

async function openOverview(page: Page): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);
}

test("a group name opens exactly that department's Workers", async ({ page, request }) => {
	const { deptId } = await seedDashboard(request);
	await openOverview(page);

	const by = byCard(page, 'Department');
	const nameLink = by.getByRole('link', { name: 'Front of House' });
	await expect(nameLink).toBeVisible();
	// The group's size as Overview reads it: the total beside its name.
	const size = Number(await nameLink.locator('xpath=..').locator('span.text-xs').textContent());
	expect(size).toBe(3);

	await nameLink.click();
	await page.waitForURL(/\/workers/);
	await appReady(page);

	const filters = new URL(page.url()).searchParams.getAll('f');
	expect(filters).toContain(`${deptId}:${deptId}~Front of House`);
	await expect(workerCount(page)).toHaveText(`${size} workers`);
	await expect(workerRows(page)).toHaveCount(size);
	for (const name of ['Ana', 'Beto', 'Carla']) {
		await expect(workerRows(page).filter({ hasText: name })).toHaveCount(1);
	}
});

test("a matrix cell opens the group's holders of that Agitation", async ({ page, request }) => {
	const { deptId, payId } = await seedDashboard(request);
	await openOverview(page);

	const matrix = agitationsCard(page);
	const payRow = matrix.getByRole('row', { name: /Pay/ });
	// The drilldown builder encodes the value its own way (spaces as +); the cohort is
	// what matters, asserted on the Workers side below.
	const cell = payRow.locator(`a[href*="${deptId}%7EFront+of+House"]`);
	await expect(cell).toHaveText('2');

	// The link fills the cell, so the whole cell is the hit area.
	const cellBox = (await cell.locator('xpath=..').boundingBox())!;
	const linkBox = (await cell.boundingBox())!;
	expect(linkBox.width).toBeGreaterThanOrEqual(cellBox.width - 1);
	expect(linkBox.height).toBeGreaterThanOrEqual(cellBox.height - 1);

	await cell.click();
	await page.waitForURL(/\/workers/);
	await appReady(page);

	const url = new URL(page.url());
	expect(url.searchParams.getAll('f')).toContain(`${deptId}:${deptId}~Front of House`);
	expect(url.searchParams.getAll('agitation')).toEqual([payId]);
	await expect(workerCount(page)).toHaveText('2 workers');
	await expect(workerRows(page)).toHaveCount(2);
	for (const name of ['Ana', 'Beto']) {
		await expect(workerRows(page).filter({ hasText: name })).toHaveCount(1);
	}
});

test("an All cell opens the Agitation's full holder count", async ({ page, request }) => {
	const { payId } = await seedDashboard(request);
	await openOverview(page);

	const matrix = agitationsCard(page);
	const payRow = matrix.getByRole('row', { name: /Pay/ });
	const all = payRow.locator(`a[href="/workers?agitation=${payId}"]`);
	await expect(all).toHaveText('4');

	await all.click();
	await page.waitForURL(/\/workers/);
	await appReady(page);

	const url = new URL(page.url());
	expect(url.searchParams.getAll('f')).toEqual([]);
	expect(url.searchParams.getAll('agitation')).toEqual([payId]);
	await expect(workerCount(page)).toHaveText('4 workers');
	await expect(workerRows(page)).toHaveCount(4);
	for (const name of ['Ana', 'Beto', 'Elena', 'Hugo']) {
		await expect(workerRows(page).filter({ hasText: name })).toHaveCount(1);
	}
});

test('every dashboard Workers link is reachable by Tab and opens with Enter', async ({
	page,
	request,
	browserName
}) => {
	// Playwright's WebKit Tab skips links unless Option is held (the WKWebView tabFocusesLinks
	// default), so the harness cannot press its way to them. The Mac app itself was checked by
	// hand (Tom, Nov 11): Tab lands on the count links. Chromium covers the order.
	test.skip(browserName === 'webkit', 'WebKit Tab does not reach links without Option');
	await seedDashboard(request);
	await openOverview(page);

	// Two group names, four nonzero matrix cells and three All cells; zero cells stay plain.
	const hrefs = [
		...(await byCard(page, 'Department')
			.getByRole('link')
			.evaluateAll((elements) => elements.map((el) => el.getAttribute('href')))),
		...(await agitationsCard(page)
			.getByRole('link')
			.evaluateAll((elements) => elements.map((el) => el.getAttribute('href'))))
	];
	expect(hrefs).toHaveLength(9);
	expect(new Set(hrefs).size).toBe(9);

	for (const href of hrefs) {
		await openOverview(page);
		await tabTo(page, page.locator(`[data-dashboard] a[href="${href}"]`));
		await page.keyboard.press('Enter');
		await page.waitForURL(/\/workers/);
		await appReady(page);
		await expect(workerRows(page).first()).toBeVisible();
	}
});

/** Tabs from the address bar until the link itself holds focus. */
async function tabTo(page: Page, link: Locator): Promise<void> {
	const handle = await link.elementHandle();
	for (let i = 0; i < 120; i++) {
		const focused = await page.evaluate((el) => document.activeElement === el, handle);
		if (focused) return;
		await page.keyboard.press('Tab');
	}
	throw new Error('link never received focus by Tab');
}
test.describe('E6 folds product-gap-07 Support links', () => {
	type Seeded = { departmentId: string };

	const byCard = (page: Page) => page.getByRole('region', { name: /^By/ });
	const groupLink = (page: Page, title: string) =>
		byCard(page).locator(`ul li a[title="${title}"]`);
	const systemLink = (page: Page) => byCard(page).locator('ul li a[href*="missing="]');
	const rows = (page: Page) => page.locator('tbody tr[data-worker-id]');
	const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
	const count = (page: Page) => page.getByTestId('worker-count');
	const active = (page: Page) => page.getByTestId('active-condition');

	/** Follows one By-card group link and waits for the destination route, not just the shell. */
	async function followLink(page: Page, locator: ReturnType<typeof groupLink>): Promise<void> {
		await locator.click();
		await expect(page).toHaveURL(/\/workers/);
		await appReady(page);
	}

	function params(page: Page): { f: string[]; missing: string[] } {
		const search = new URL(page.url()).searchParams;
		return { f: search.getAll('f'), missing: search.getAll('missing') };
	}

	async function seedFixture(request: APIRequestContext): Promise<Seeded> {
		const [departmentId] = await addAttributes(request, [
			{ name: 'Department', kind: 'category', options: ['Packing', 'Delivery', 'No Department'] }
		]);
		await addWorkers(request, [
			{ name: 'Alex', assessment: 'Leader', attributes: { [departmentId]: 'Packing' } },
			{ name: 'Blair', assessment: 'Supporter', attributes: { [departmentId]: 'Delivery' } },
			{ name: 'Casey', assessment: 'Unassessed', attributes: { [departmentId]: '' } },
			{ name: 'Drew', assessment: 'Activist', attributes: { [departmentId]: 'No Department' } }
		]);

		return { departmentId };
	}
	test('@product-gap-07 each Support row opens exactly its Workers', async ({ page, request }) => {
		const seeded = await seedFixture(request);
		await openSharedOverview(page);

		// Packing: Alex.
		await followLink(page, groupLink(page, 'Packing'));
		expect(params(page)).toEqual({
			f: [`${seeded.departmentId}:${answerId(seeded.departmentId, 'Packing')}`],
			missing: []
		});
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Alex')).toBeVisible();
		await expect(active(page)).toContainText('Packing');

		// The link reloads to the same cohort.
		await page.reload();
		await appReady(page);
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Alex')).toBeVisible();

		// Back returns to Overview through normal history.
		await page.goBack();
		await appReady(page);
		await expect(page).toHaveURL(/\/overview$/);

		// Delivery: Blair.
		await followLink(page, groupLink(page, 'Delivery'));
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Blair')).toBeVisible();

		await page.goBack();
		await appReady(page);

		// The system No Department row: Casey, by the no-selection condition.
		await followLink(page, systemLink(page));
		expect(params(page)).toEqual({ f: [], missing: [seeded.departmentId] });
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();
		await expect(active(page)).toContainText('No Department');
		await expect(active(page)).toContainText('No selection');

		await page.goBack();
		await appReady(page);

		// The identically named real answer: Drew, by its answer id.
		await followLink(
			page,
			byCard(page).locator('ul li a[title="No Department"]:not([href*="missing="])')
		);
		expect(params(page)).toEqual({
			f: [`${seeded.departmentId}:${answerId(seeded.departmentId, 'No Department')}`],
			missing: []
		});
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Drew')).toBeVisible();
		await expect(active(page)).toContainText('No Department');
		await expect(active(page)).not.toContainText('No selection');
	});

	test('@product-gap-07 rows work from the keyboard and renames keep the destination', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openSharedOverview(page);

		// Keyboard activation produces the same destination as a pointer click.
		await groupLink(page, 'Packing').focus();
		await page.keyboard.press('Enter');
		await appReady(page);
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Alex')).toBeVisible();

		// A rename changes the label, not the membership: the URL carries the Attribute id.
		await page.goBack();
		await appReady(page);
		await followLink(page, systemLink(page));
		await expect(row(page, 'Casey')).toBeVisible();

		const renamed = await request.put('/api/attributes', {
			data: wireDefinitions([
				{
					id: seeded.departmentId,
					name: 'Team',
					kind: 'category',
					options: ['Packing', 'Delivery', 'No Department']
				}
			])
		});
		expect(renamed.ok(), await renamed.text()).toBeTruthy();

		await page.reload();
		await appReady(page);
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();
		await expect(active(page)).toContainText('No Team');

		// Zero-match recovery still works after arriving from a Support row.
		await page.getByRole('searchbox', { name: 'Search Name' }).fill('Nobody at all');
		await expect(count(page)).toHaveText('0 workers');
		await expect(page.getByText(/No workers match/)).toBeVisible();
	});
});
