import { appReady } from './page-ready.ts';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { addAgitations, addAttributes, addWorkers } from './worksite-builder.ts';
import { expect, test, testId } from './fixtures.ts';
import { answerId, wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';

/**
 * Ticket 02: the Overview Agitations card pages horizontally instead of
 * scrolling. Each page shows whole group columns beside a pinned All column,
 * a range footer (Groups 1–N of total, Previous, Next) plus card-scoped Left/Right arrows turn
 * pages, the separate header stays fixed during vertical scrolling, the shade
 * key is gone, and page state stays local.
 */

const agitationsCard = (page: Page) => page.getByRole('region', { name: 'Agitations' });
const byCard = (page: Page, name: string) => page.getByRole('region', { name: 'By ' + name });
const pageControls = (page: Page) =>
	agitationsCard(page).locator('[data-agitations-page-controls]');
const prevButton = (page: Page) =>
	pageControls(page).getByRole('button', { name: 'Previous agitations page' });
const nextButton = (page: Page) =>
	pageControls(page).getByRole('button', { name: 'Next agitations page' });
const position = (page: Page) => pageControls(page).locator('[data-page-position]');
const announcement = (page: Page) => pageControls(page).locator('span[aria-live]');
const groupHeaders = (page: Page) =>
	agitationsCard(page)
		.locator('table[data-agitations-headers] thead th[title] [data-group-name]')
		.allTextContents();

/** Every matrix cell holder count to its computed backgrounds. */
async function cellShades(page: Page): Promise<Record<string, string[]>> {
	return agitationsCard(page).evaluate((card) => {
		const shades: Record<string, string[]> = {};
		for (const cell of card.querySelectorAll('tbody td')) {
			const text = (cell.textContent ?? '').trim();
			if (!/^\d+$/.test(text)) continue;
			const background = getComputedStyle(cell).backgroundColor;
			const list = shades[text];
			if (list) list.push(background);
			else shades[text] = [background];
		}
		return shades;
	});
}

async function openOverview(page: Page): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);
}

/** The card has measured its columns, so the page controls (or their absence) settle. */
async function awaitAgitationsReady(page: Page): Promise<void> {
	await expect(agitationsCard(page)).toHaveAttribute('data-agitations-ready', 'true');
}

async function seedWide(
	request: APIRequestContext,
	groupCount = 10
): Promise<{ deptId: string; roleId: string; payId: string }> {
	const deptId = testId();
	const roleId = testId();
	const groups = Array.from(
		{ length: groupCount },
		(_, i) => 'Team ' + String(i + 1).padStart(2, '0')
	);
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: groups },
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
	const ids = [payId, hoursId, snacksId];

	for (let i = 0; i < groupCount; i += 1) {
		await createWorker(request, {
			name: 'Worker ' + (i + 1),
			assessment: i % 3 === 0 ? 'Leader' : 'Supporter',
			attributes: { [deptId]: groups[i]!, [roleId]: i % 2 === 0 ? 'Cook' : 'Server' },
			agitations: [ids[i % ids.length]!, ids[(i + 1) % ids.length]!]
		});
	}
	return { deptId, roleId, payId };
}

async function seedNarrow(request: APIRequestContext): Promise<void> {
	const deptId = testId();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: ['North', 'South'] }
		])
	});
	expect(configured.ok()).toBeTruthy();
	const pay = await request.post('/api/agitations', { data: { text: 'Pay' } });
	expect(pay.ok()).toBeTruthy();
	const payId = (await pay.json()).agitation.id as string;
	await createWorker(request, {
		name: 'Ana',
		assessment: 'Leader',
		attributes: { [deptId]: 'North' },
		agitations: [payId]
	});
	await createWorker(request, {
		name: 'Beto',
		assessment: 'Supporter',
		attributes: { [deptId]: 'South' },
		agitations: [payId]
	});
}

test('pages whole group columns with All pinned on every page', async ({
	page,
	request,
	browserName
}) => {
	await seedWide(request);
	await openOverview(page);
	await awaitAgitationsReady(page);

	const card = agitationsCard(page);
	await expect(pageControls(page)).toBeVisible();
	await expect(prevButton(page)).toBeDisabled();
	await expect(nextButton(page)).toBeEnabled();
	// The position reads its 1-based place; the exact page count follows the width.
	await expect(position(page)).toHaveText(/^1 of \d+$/);

	const firstPage = await groupHeaders(page);
	expect(firstPage.length).toBeGreaterThan(0);
	// All repeats on the first page beside the groups.
	await expect(card.getByRole('columnheader', { name: 'All' })).toBeVisible();
	const firstShades = await cellShades(page);

	await nextButton(page).click();
	await expect(position(page)).toHaveText(/^2 of \d+$/);
	const secondPage = await groupHeaders(page);
	expect(secondPage.length).toBeGreaterThan(0);
	// Whole columns move together: no group repeats across the turn.
	expect(secondPage.filter((name) => firstPage.includes(name))).toEqual([]);
	// All stays pinned on the turned page.
	await expect(card.getByRole('columnheader', { name: 'All' })).toBeVisible();

	// Cell shading keeps its global meaning across the turn: every holder count
	// shared by both pages reads the same computed background on each.
	const secondShades = await cellShades(page);
	const shared = Object.keys(firstShades).filter((count) => secondShades[count]);
	expect(shared.length).toBeGreaterThan(0);
	for (const count of shared) {
		expect(new Set([...firstShades[count]!, ...secondShades[count]!]).size).toBe(1);
	}

	// The invoked control keeps focus after the turn. WebKit never focuses a button on a mouse
	// click (macOS convention), so a click-made turn has nothing to keep there; the turns that
	// disable a button still move focus, which is asserted below on every browser.
	if (browserName !== 'webkit') await expect(nextButton(page)).toBeFocused();

	// To the last page: Next disables there, Prev enables.
	for (let i = 0; i < 10; i += 1) {
		if (await nextButton(page).isDisabled()) break;
		await nextButton(page).click();
	}
	await expect(nextButton(page)).toBeDisabled();
	await expect(prevButton(page)).toBeEnabled();
	// Next disabled itself on the last turn, so focus moved to Previous.
	await expect(prevButton(page)).toBeFocused();

	await prevButton(page).click();
	if (browserName !== 'webkit') await expect(prevButton(page)).toBeFocused();

	// Back to the first page: Previous disables itself and focus moves to Next.
	for (let i = 0; i < 10; i += 1) {
		if (await prevButton(page).isDisabled()) break;
		await prevButton(page).click();
	}
	await expect(prevButton(page)).toBeDisabled();
	await expect(nextButton(page)).toBeEnabled();
	await expect(nextButton(page)).toBeFocused();
});

test('turns pages with card-scoped Left and Right arrows', async ({ page, request }) => {
	await seedWide(request);
	await openOverview(page);
	await awaitAgitationsReady(page);
	await expect(pageControls(page)).toBeVisible();

	// Focus inside the card: Right steps forward, Left steps back.
	await cardFirstCellLink(page).focus();
	await page.keyboard.press('ArrowRight');
	await expect(position(page)).toHaveText(/^2 of \d+$/);
	await page.keyboard.press('ArrowLeft');
	await expect(position(page)).toHaveText(/^1 of \d+$/);

	// Outside the card the arrows never page.
	await byCard(page, 'Department').getByRole('button', { name: 'Department' }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(position(page)).toHaveText(/^1 of \d+$/);
});

function cardFirstCellLink(page: Page) {
	return agitationsCard(page).locator('tbody a').first();
}

test('announces the page position politely', async ({ page, request }) => {
	await seedWide(request);
	await openOverview(page);
	await awaitAgitationsReady(page);

	await expect(announcement(page)).toHaveAttribute('aria-live', 'polite');
	await expect(announcement(page)).toHaveAttribute('aria-atomic', 'true');
	await expect(announcement(page)).toContainText('Agitations page');
	await nextButton(page).click();
	await expect(position(page)).toHaveText(/^2 of \d+$/);
});

test('keeps a disabled footer when every group fits', async ({ page, request }) => {
	await seedNarrow(request);
	await openOverview(page);
	await awaitAgitationsReady(page);

	const card = agitationsCard(page);
	await expect(card.getByRole('columnheader', { name: 'North' })).toBeVisible();
	await expect(card.getByRole('columnheader', { name: 'South' })).toBeVisible();
	await expect(pageControls(page)).toBeVisible();
	await expect(pageControls(page).locator('[data-group-range]')).toHaveText('Groups 1–2 of 2');
	await expect(prevButton(page)).toBeDisabled();
	await expect(nextButton(page)).toBeDisabled();
	await expect(position(page)).toHaveText('1 of 1');
});

test('keeps the empty message with no page controls when nothing is held', async ({
	page,
	request
}) => {
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: testId(), name: 'Department', kind: 'category', options: ['North', 'South'] }
		])
	});
	expect(configured.ok()).toBeTruthy();
	await openOverview(page);

	const card = agitationsCard(page);
	await expect(card).toContainText('No Workers in this worksite have Agitations recorded.');
	await expect(card.locator('table')).toHaveCount(0);
	await expect(pageControls(page)).toHaveCount(0);
});

test('resets to the first page when the grouping changes and on reload', async ({
	page,
	request
}) => {
	await seedWide(request);
	await openOverview(page);
	await awaitAgitationsReady(page);
	await expect(pageControls(page)).toBeVisible();

	await nextButton(page).click();
	await expect(position(page)).toHaveText(/^2 of \d+$/);

	// A reload opens the first page: the page never enters the address.
	await page.reload();
	await appReady(page);
	await awaitAgitationsReady(page);
	await expect(position(page)).toHaveText(/^1 of \d+$/);
	await expect(page).toHaveURL(/\/overview(\?.*)?$/);

	// Changing the grouping resets to the first page.
	await nextButton(page).click();
	await expect(position(page)).toHaveText(/^2 of \d+$/);
	await byCard(page, 'Department').getByRole('button', { name: 'Department' }).click();
	await page.getByRole('option', { name: 'Role' }).click();
	await appReady(page);
	const roleControls = pageControls(page);
	if ((await roleControls.count()) > 0) {
		await expect(position(page)).toHaveText(/^1 of \d+$/);
	}
	await byCard(page, 'Role').getByRole('button', { name: 'Role' }).click();
	await page.getByRole('option', { name: 'Department' }).click();
	await appReady(page);
	await expect(position(page)).toHaveText(/^1 of \d+$/);
});

test('keeps the visible header fixed during vertical scroll and preserves cell links', async ({
	page,
	request
}) => {
	const { deptId, roleId } = await seedWide(request);
	const extraAgitations: string[] = [];
	for (let i = 0; i < 12; i += 1) {
		const response = await request.post('/api/agitations', { data: { text: `Scroll issue ${i}` } });
		expect(response.ok()).toBeTruthy();
		extraAgitations.push((await response.json()).agitation.id);
	}
	await createWorker(request, {
		name: 'Scroll fixture',
		attributes: { [deptId]: 'Team 01', [roleId]: 'Cook' },
		agitations: extraAgitations
	});
	await openOverview(page);
	await awaitAgitationsReady(page);

	// The vertical scroller still fades only at its vertical edges: no horizontal fade.
	const scroller = agitationsCard(page).locator('[data-scroll-region]');
	await expect(scroller).toHaveAttribute('data-left', 'false');
	await expect(scroller).toHaveAttribute('data-right', 'false');

	// The visible header is a sibling of the row scroller, stays in place when
	// rows scroll, and sits directly above the scrolling region.
	const card = agitationsCard(page);
	const header = card.locator('table[data-agitations-headers] thead');
	const headerBoxBefore = await header.boundingBox();
	const scrollerBox = await scroller.boundingBox();
	expect(headerBoxBefore).not.toBeNull();
	expect(scrollerBox).not.toBeNull();
	expect(scrollerBox!.y).toBeGreaterThanOrEqual(headerBoxBefore!.y + headerBoxBefore!.height - 1);
	await scroller.evaluate((el) => el.scrollTo({ top: Math.min(120, el.scrollHeight) }));
	await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
	const headerBoxAfter = await header.boundingBox();
	expect(headerBoxAfter).not.toBeNull();
	expect(Math.abs(headerBoxAfter!.y - headerBoxBefore!.y)).toBeLessThanOrEqual(1);

	// Every cell and All link keeps its Workers destination on a turned page.
	await nextButton(page).click();
	const turned = await groupHeaders(page);
	expect(turned.length).toBeGreaterThan(0);
	const cell = agitationsCard(page).locator('tbody td a').first();
	await expect(cell).toBeVisible();
	const href = await cell.getAttribute('href');
	expect(href).toMatch(/^\/workers\?/);
	await cell.click();
	await page.waitForURL(/\/workers/);
	await appReady(page);
	await expect(page.locator('tbody tr[data-worker-id]').first()).toBeVisible();
});

test('keeps All fixed and left-aligns a short last page', async ({ page, request }) => {
	// Eleven groups: prime, so any per-page count below eleven leaves a short page.
	await seedWide(request, 11);
	await openOverview(page);
	await awaitAgitationsReady(page);
	await expect(pageControls(page)).toBeVisible();

	const all = agitationsCard(page).locator('table[data-agitations-headers] thead th').nth(1);
	const original = await all.boundingBox();
	expect(original).not.toBeNull();
	for (let i = 0; i < 10; i += 1) {
		if (await nextButton(page).isDisabled()) break;
		await nextButton(page).click();
		const current = await all.boundingBox();
		expect(current).not.toBeNull();
		expect(
			Math.abs(current!.x - original!.x),
			'All stays at the same x on every page'
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(current!.width - original!.width),
			'All keeps its width on every page'
		).toBeLessThanOrEqual(1);
	}
	await expect(nextButton(page)).toBeDisabled();

	// Eleven groups never divide evenly into whole pages at this width, so the last
	// page is short: its last data column ends before the scroller does, leaving
	// unused tracks blank rather than shifting All or stretching the remaining group.
	const gap = await agitationsCard(page).evaluate((card) => {
		const scroller = card.querySelector('[data-scroll-region]') as HTMLElement;
		const lastGroup = card.querySelector(
			'table[data-agitations-headers] thead th:last-child'
		) as HTMLElement;
		const scrollerBox = scroller.getBoundingClientRect();
		const tableBox = lastGroup.getBoundingClientRect();
		return scrollerBox.right - tableBox.right;
	});
	expect(gap).toBeGreaterThan(8);
});

const breakdownCard = (page: Page) => byCard(page, 'Department');
const breakdownPager = (page: Page) => breakdownCard(page).locator('[data-group-pager]');
const visibleBreakdownLinks = (page: Page) => breakdownCard(page).getByRole('link');

async function expectWholeBreakdownRows(page: Page) {
	const geometry = await breakdownCard(page)
		.locator('[data-breakdown-rows]')
		.evaluate((list) => {
			const bounds = list.getBoundingClientRect();
			return [...list.querySelectorAll<HTMLElement>('[data-group-row]:not([inert])')].map((row) => {
				const box = row.getBoundingClientRect();
				return { top: box.top - bounds.top, bottom: bounds.bottom - box.bottom };
			});
		});
	expect(geometry.length).toBeGreaterThan(0);
	for (const row of geometry) {
		expect(row.top).toBeGreaterThanOrEqual(-1);
		expect(row.bottom).toBeGreaterThanOrEqual(-1);
	}
}

test('matching range footers page every support group independently without scrolling', async ({
	page,
	request
}) => {
	await seedWide(request, 11);
	await openOverview(page);
	await expect(breakdownCard(page)).toHaveAttribute('data-breakdown-ready', 'true');
	const by = breakdownCard(page);
	const pager = breakdownPager(page);
	await expect(pager).toBeVisible();
	await expect(by.locator('[data-scroll-region]')).toHaveCount(0);
	await expect(pager.locator('[data-group-range]')).toContainText(/^Groups 1–\d+ of 11$/);
	await expect(pager.locator('[aria-live]')).toHaveAttribute('aria-live', 'polite');
	await expect(
		pager.getByRole('button', { name: 'Previous support breakdown page' })
	).toBeDisabled();
	const matrixRange = await pageControls(page).locator('[data-group-range]').textContent();
	const matrixFooter = await pageControls(page).boundingBox();
	const matrixScroller = await agitationsCard(page).locator('[data-scroll-region]').boundingBox();
	expect(matrixFooter!.y).toBeGreaterThanOrEqual(matrixScroller!.y + matrixScroller!.height - 1);
	const seen: string[] = [];
	for (let turn = 0; turn < 11; turn += 1) {
		await expectWholeBreakdownRows(page);
		seen.push(...(await visibleBreakdownLinks(page).allTextContents()));
		if (await pager.getByRole('button', { name: 'Next support breakdown page' }).isDisabled())
			break;
		await pager.getByRole('button', { name: 'Next support breakdown page' }).click();
	}
	expect(seen).toHaveLength(11);
	expect(new Set(seen).size).toBe(11);
	await expect(pager.locator('[data-group-range]')).toContainText(/–11 of 11$/);
	await expect(pageControls(page).locator('[data-group-range]')).toHaveText(matrixRange!);
	// Both footers are the same component, including their responsive layout.
	await expect(pager).toHaveClass(
		(await pageControls(page).locator('[data-group-pager]').getAttribute('class'))!
	);
	const link = visibleBreakdownLinks(page).last();
	const href = await link.getAttribute('href');
	expect(href).toMatch(/^\/workers\?/);
	await link.click();
	await page.waitForURL(/\/workers/);
	await appReady(page);
	await expect(page.locator('tbody tr[data-worker-id]')).toHaveCount(1);
});

test('support paging keeps keyboard focus reachable, refits on resize, and resets on regrouping', async ({
	page,
	request
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await seedWide(request, 11);
	await page.setViewportSize({ width: 1024, height: 640 });
	await page.goto('/overview');
	await appReady(page);
	const by = breakdownCard(page);
	const pager = breakdownPager(page);
	await expect(by).toHaveAttribute('data-breakdown-ready', 'true');
	await visibleBreakdownLinks(page).first().focus();
	await page.keyboard.press('ArrowRight');
	await expect(pager.locator('[data-page-position]')).toHaveText(/^2 of /);
	await expect(
		pager.getByRole('button', { name: 'Previous support breakdown page' })
	).toBeFocused();
	await expectWholeBreakdownRows(page);
	await page.keyboard.press('ArrowLeft');
	await expect(pager.locator('[data-page-position]')).toHaveText(/^1 of /);
	await expectWholeBreakdownRows(page);
	await pager.getByRole('button', { name: 'Next support breakdown page' }).click();

	for (let turn = 0; turn < 11; turn += 1) {
		const next = pager.getByRole('button', { name: 'Next support breakdown page' });
		if (await next.isDisabled()) break;
		await next.click();
	}
	await page.setViewportSize({ width: 1440, height: 1000 });
	await expectWholeBreakdownRows(page);
	// The resize refits the pages and clamps the current one after a frame, so a key sent
	// before then can be lost. Left at the first page is a no-op, so retrying is safe.
	await expect(async () => {
		await pager.getByRole('button', { name: 'Previous support breakdown page' }).focus();
		await page.keyboard.press('ArrowLeft');
		await expect(pager.locator('[data-page-position]')).toHaveText(/^1 of /, { timeout: 1000 });
	}).toPass({ timeout: 10_000 });
	await by.getByRole('button', { name: 'Department' }).click();
	await page.getByRole('option', { name: 'Role' }).click();
	await appReady(page);
	const rolePager = byCard(page, 'Role').locator('[data-group-pager]');
	await expect(rolePager).toBeVisible();
	await expect(rolePager.locator('[data-group-range]')).toHaveText('Groups 1–2 of 2');
	await expect(
		rolePager.getByRole('button', { name: 'Previous support breakdown page' })
	).toBeDisabled();
	await expect(
		rolePager.getByRole('button', { name: 'Next support breakdown page' })
	).toBeDisabled();
	await byCard(page, 'Role').getByRole('button', { name: 'Role' }).click();
	await page.getByRole('option', { name: 'Department' }).click();
	await appReady(page);
	await expect(breakdownPager(page).locator('[data-page-position]')).toHaveText(/^1 of /);
	expect(errors).toEqual([]);
});

test('both footers stay disabled when the group readings fit', async ({ page, request }) => {
	await seedNarrow(request);
	await openOverview(page);
	await expect(breakdownCard(page)).toHaveAttribute('data-breakdown-ready', 'true');
	await expect(breakdownPager(page)).toBeVisible();
	await expect(breakdownPager(page).locator('[data-group-range]')).toHaveText('Groups 1–2 of 2');
	await expect(
		breakdownPager(page).getByRole('button', { name: 'Previous support breakdown page' })
	).toBeDisabled();
	await expect(
		breakdownPager(page).getByRole('button', { name: 'Next support breakdown page' })
	).toBeDisabled();
	await expect(visibleBreakdownLinks(page)).toHaveCount(2);
	await expect(pageControls(page)).toBeVisible();
	await expect(pageControls(page).locator('[data-group-range]')).toHaveText('Groups 1–2 of 2');
	await expect(prevButton(page)).toBeDisabled();
	await expect(nextButton(page)).toBeDisabled();
});
test.describe('E6 folds product-gap-05 agitations matrix', () => {
	const agitationsCard = (page: Page) => page.getByRole('region', { name: 'Agitations' });
	const matrix = (page: Page) => agitationsCard(page).locator('table');
	const groupHeaders = (page: Page) =>
		agitationsCard(page).locator('table[data-agitations-headers] thead th[title]');
	const headings = (page: Page) =>
		agitationsCard(page).locator(
			'table[data-agitations-headers] thead th[title] [data-group-name]'
		);
	const agitationRows = (page: Page) => matrix(page).locator('tbody tr');
	const rowByName = (page: Page, name: string) => agitationRows(page).filter({ hasText: name });

	async function agitationId(request: APIRequestContext, text: string): Promise<string> {
		const created = await request.post('/api/agitations', { data: { text } });
		expect(created.ok(), await created.text()).toBeTruthy();
		return ((await created.json()) as { agitation: { id: string } }).agitation.id;
	}

	test('@product-gap-05 grouped Agitations include the no-value group and omit empty ones', async ({
		page,
		request
	}) => {
		const departmentId = testId();
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
		const equipment = await agitationId(request, 'Equipment');
		const schedule = await agitationId(request, 'Schedule');

		for (const worker of [
			{ name: 'Alex', assessment: 'Leader', department: 'Packing', agitations: [equipment] },
			{ name: 'Blair', assessment: 'Supporter', department: 'Delivery', agitations: [schedule] },
			{ name: 'Casey', assessment: 'Unassessed', department: '', agitations: [equipment] },
			// Drew holds the literal answer named No Department but no Agitation, so the
			// literal answer's group is omitted.
			{ name: 'Drew', assessment: 'Activist', department: 'No Department', agitations: [] }
		] as const) {
			await createWorker(request, {
				name: worker.name,
				assessment: worker.assessment,
				attributes: { [departmentId]: worker.department },
				agitations: [...worker.agitations]
			});
		}

		await page.setViewportSize({ width: 2400, height: 1080 });
		await page.goto('/overview');
		await appReady(page);

		// Department is the only Single-Select Attribute, so the dashboard groups by it
		// on its own. The matrix lists every group: Packing, Delivery, the literal
		// answer named No Department (zeros: it holds no Agitation), then the system
		// no-value group.
		await expect(headings(page)).toHaveCount(4);
		await expect(groupHeaders(page).nth(0)).toHaveAttribute('title', 'Packing');
		await expect(groupHeaders(page).nth(1)).toHaveAttribute('title', 'Delivery');
		await expect(groupHeaders(page).nth(2)).toHaveAttribute('title', 'No Department');
		await expect(groupHeaders(page).nth(3)).toHaveAttribute('title', 'No Department');

		// Two Agitations are held: Equipment (Alex and Casey) and Schedule (Blair).
		// The All column links the full holder count of each.
		await expect(agitationRows(page)).toHaveCount(2);
		const equipmentRow = rowByName(page, 'Equipment');
		const scheduleRow = rowByName(page, 'Schedule');
		await expect(equipmentRow.locator('td').nth(0).getByRole('link')).toHaveText('2');
		await expect(scheduleRow.locator('td').nth(0).getByRole('link')).toHaveText('1');

		// Equipment appears for Packing and for the system group; Schedule for Delivery.
		// Zero cells are plain text, so the empty literal group offers no links.
		await expect(equipmentRow.locator('td').nth(1).getByRole('link')).toHaveText('1');
		await expect(equipmentRow.locator('td').nth(2)).toContainText('0');
		await expect(equipmentRow.locator('td').nth(2).getByRole('link')).toHaveCount(0);
		await expect(equipmentRow.locator('td').nth(3).getByRole('link')).toHaveCount(0);
		await expect(equipmentRow.locator('td').nth(4).getByRole('link')).toHaveText('1');
		await expect(scheduleRow.locator('td').nth(2).getByRole('link')).toHaveText('1');
		await expect(scheduleRow.locator('td').nth(1).getByRole('link')).toHaveCount(0);
	});
});

test.describe('E6 folds product-gap-09 agitation links', () => {
	type Seeded = { departmentId: string; equipmentId: string };

	/**
	 * The dashboard's Agitations matrix: one row per held Agitation, an All column,
	 * then one column per Department group (Packing, Delivery, the literal
	 * No Department answer, the system no-value group). A nonzero cell is a link
	 * showing its count; a zero cell is plain text.
	 */
	const agitationsCard = (page: Page) => page.getByRole('region', { name: 'Agitations' });
	const matrix = (page: Page) => agitationsCard(page).locator('table');
	const groupHeaders = (page: Page) =>
		agitationsCard(page).locator('table[data-agitations-headers] thead th[title]');
	const groupHeadings = (page: Page) =>
		agitationsCard(page).locator(
			'table[data-agitations-headers] thead th[title] [data-group-name]'
		);
	const equipmentRow = (page: Page) =>
		matrix(page).locator('tbody tr').filter({ hasText: 'Equipment' });
	/** nth(0) is All, then Packing, Delivery, the literal answer, the system group. */
	const equipmentCell = (page: Page, index: number) => equipmentRow(page).locator('td').nth(index);
	const rows = (page: Page) => page.locator('tbody tr[data-worker-id]');
	const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
	const count = (page: Page) => page.getByTestId('worker-count');
	const active = (page: Page) => page.getByTestId('active-condition');

	function params(page: Page): { f: string[]; missing: string[]; agitation: string[] } {
		const search = new URL(page.url()).searchParams;
		return {
			f: search.getAll('f'),
			missing: search.getAll('missing'),
			agitation: search.getAll('agitation')
		};
	}

	async function seedFixture(request: APIRequestContext): Promise<Seeded> {
		const [departmentId] = await addAttributes(request, [
			{ name: 'Department', kind: 'category', options: ['Packing', 'Delivery', 'No Department'] }
		]);
		const [equipment, schedule] = await addAgitations(request, ['Equipment', 'Schedule']);
		await addWorkers(request, [
			{
				name: 'Alex',
				assessment: 'Leader',
				attributes: { [departmentId]: 'Packing' },
				agitations: [equipment]
			},
			{
				name: 'Blair',
				assessment: 'Supporter',
				attributes: { [departmentId]: 'Delivery' },
				agitations: [schedule]
			},
			{
				name: 'Casey',
				assessment: 'Unassessed',
				attributes: { [departmentId]: '' },
				agitations: [equipment]
			},
			{
				name: 'Drew',
				assessment: 'Activist',
				attributes: { [departmentId]: 'No Department' }
			}
		]);

		return { departmentId, equipmentId: equipment };
	}

	async function openAgitations(page: Page): Promise<void> {
		await page.setViewportSize({ width: 2400, height: 1080 });
		await page.goto('/overview');
		await appReady(page);
	}

	async function groupByDepartment(page: Page): Promise<void> {
		// Department is the only Single-Select Attribute, so the dashboard groups by it
		// on its own: the matrix shows All plus the four groups in reading order.
		await expect(groupHeadings(page)).toHaveCount(4);
		await expect(groupHeaders(page).nth(0)).toHaveAttribute('title', 'Packing');
		await expect(groupHeaders(page).nth(1)).toHaveAttribute('title', 'Delivery');
		await expect(groupHeaders(page).nth(2)).toHaveAttribute('title', /^No Department/);
		await expect(groupHeaders(page).nth(3)).toHaveAttribute('title', /No Department/);
	}

	async function follow(link: Locator, page: Page): Promise<void> {
		await link.click();
		await expect(page).toHaveURL(/\/workers/);
		await appReady(page);
	}
	test('@product-gap-09 a flat Agitation opens its holders', async ({ page, request }) => {
		const seeded = await seedFixture(request);
		await openAgitations(page);

		await follow(equipmentCell(page, 0).getByRole('link'), page);
		expect(params(page)).toEqual({ f: [], missing: [], agitation: [seeded.equipmentId] });
		await expect(count(page)).toHaveText('2 workers');
		await expect(row(page, 'Alex')).toBeVisible();
		await expect(row(page, 'Casey')).toBeVisible();
		await expect(active(page)).toContainText('Equipment');

		// Reload keeps the cohort; Back returns to the Overview reading.
		await page.reload();
		await appReady(page);
		await expect(count(page)).toHaveText('2 workers');
		await expect(row(page, 'Casey')).toBeVisible();

		await page.goBack();
		await appReady(page);
		await expect(page).toHaveURL(/\/overview/);
	});

	test('@product-gap-09 a grouped Agitation retains its group and the Agitation', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openAgitations(page);
		await groupByDepartment(page);

		// Equipment appears under Packing and under the system no-value group; the first
		// group column opens Packing's holder only.
		await follow(equipmentCell(page, 1).getByRole('link'), page);
		await expect(page).toHaveURL(/\/workers/);
		await appReady(page);
		expect(params(page)).toEqual({
			f: [`${seeded.departmentId}:${answerId(seeded.departmentId, 'Packing')}`],
			missing: [],
			agitation: [seeded.equipmentId]
		});
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Alex')).toBeVisible();
		await expect(active(page)).toHaveCount(2);
		await expect(active(page).filter({ hasText: 'Equipment' })).toHaveCount(1);
		await expect(active(page).filter({ hasText: 'Packing' })).toHaveCount(1);

		// Removing the Agitation leaves the group's Workers.
		await page.getByRole('button', { name: 'Remove Equipment' }).click();
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Alex')).toBeVisible();
		expect(params(page).agitation).toEqual([]);
	});
	test('@product-gap-09 a grouped Agitation in the no-value group keeps both conditions', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openAgitations(page);
		await groupByDepartment(page);

		// The system group is the last group column; click it with the keyboard to prove
		// the cell is operable without a pointer.
		await equipmentCell(page, 4).getByRole('link').focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/workers/);
		await appReady(page);
		expect(params(page)).toEqual({
			f: [],
			missing: [seeded.departmentId],
			agitation: [seeded.equipmentId]
		});
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();
		await expect(active(page)).toHaveCount(2);
		await expect(active(page).filter({ hasText: 'No selection' })).toHaveCount(1);

		// Removing the group condition leaves every holder of the Agitation.
		await page.getByRole('button', { name: 'Remove No Department (No selection)' }).click();
		await expect(count(page)).toHaveText('2 workers');
		await expect(row(page, 'Alex')).toBeVisible();
		await expect(row(page, 'Casey')).toBeVisible();
	});

	test('@product-gap-09 a renamed Agitation keeps the cohort and reads its new name', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openAgitations(page);
		await follow(equipmentCell(page, 0).getByRole('link'), page);

		// Rename through the normal save shape: the whole set, same ids.
		const schedule = await request.get('/api/agitations');
		const current = (await schedule.json()) as { agitations: { id: string; text: string }[] };
		const next = current.agitations.map((agitation) =>
			agitation.id === seeded.equipmentId ? { ...agitation, text: 'Gear' } : agitation
		);
		const updated = await request.put('/api/agitations', { data: next });
		expect(updated.ok(), await updated.text()).toBeTruthy();

		await page.reload();
		await appReady(page);
		await expect(count(page)).toHaveText('2 workers');
		await expect(row(page, 'Alex')).toBeVisible();
		await expect(active(page)).toContainText('Gear');
		expect(params(page).agitation).toEqual([seeded.equipmentId]);
	});
});
