import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { appReady } from './page-ready.ts';
import { expect, test } from './fixtures.ts';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';

const agitationsCard = (page: Page) => page.getByRole('region', { name: 'Agitations' });
const byCard = (page: Page) => page.getByRole('region', { name: /^By/ });
const LONG_AGITATION =
	'The weekend rota is never posted before the Friday afternoon rush begins and changes again after closing';

async function seedEmpty(request: APIRequestContext) {
	const configured = await request.put('/api/attributes', { data: wireDefinitions([]) });
	expect(configured.ok()).toBeTruthy();
}

async function seedSixGroups(request: APIRequestContext) {
	const deptId = randomUUID();
	const groups = ['North', 'South', 'East', 'West', 'Central', 'Riverside'];
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([{ id: deptId, name: 'Department', kind: 'category', options: groups }])
	});
	expect(configured.ok()).toBeTruthy();
	const created = await request.post('/api/agitations', { data: { text: LONG_AGITATION } });
	expect(created.ok()).toBeTruthy();
	const agitationId = (await created.json()).agitation.id as string;
	for (const [index, group] of groups.entries()) {
		await createWorker(request, {
			name: `Worker ${index + 1}`,
			assessment: 'Supporter',
			attributes: { [deptId]: group },
			agitations: [agitationId]
		});
	}
	return groups;
}

async function openOverview(page: Page, width: number) {
	await page.setViewportSize({ width, height: 640 });
	await page.goto('/overview');
	await appReady(page);
}

test('omits the grouping selector when no attributes exist', async ({ page, request }) => {
	await seedEmpty(request);
	await openOverview(page, 1024);
	const by = byCard(page);
	await expect(by).toContainText('Nothing available to group by');
	await expect(by.getByRole('button')).toHaveCount(0);
	await expect(by.locator('[data-slot="select-trigger"]')).toHaveCount(0);
});

test('fits a long agitation with six groups at desktop and phone widths', async ({
	page,
	request
}) => {
	const groups = await seedSixGroups(request);
	for (const width of [1024, 390, 320]) {
		await openOverview(page, width);
		const card = agitationsCard(page);
		await expect(card).toHaveAttribute('data-agitations-ready', 'true');
		const row = card.locator('tbody th[title]').filter({ hasText: LONG_AGITATION });
		await expect(row).toHaveAttribute('title', LONG_AGITATION);
		const rowLayout = await row.evaluate((element) => ({
			text: element.textContent?.trim(),
			width: element.clientWidth,
			scrollWidth: element.scrollWidth,
			height: element.clientHeight,
			scrollHeight: element.scrollHeight,
			whiteSpace: getComputedStyle(element).whiteSpace
		}));
		expect(rowLayout.text, `complete row label is rendered at ${width}px`).toBe(LONG_AGITATION);
		expect(rowLayout.width, `row label has width at ${width}px`).toBeGreaterThan(0);
		expect(rowLayout.scrollWidth, `row label fits horizontally at ${width}px`).toBeLessThanOrEqual(
			rowLayout.width + 1
		);
		expect(rowLayout.scrollHeight, `row label fits vertically at ${width}px`).toBeLessThanOrEqual(
			rowLayout.height + 1
		);
		expect(rowLayout.whiteSpace, `row label wraps at ${width}px`).not.toBe('nowrap');
		await row.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: test.info().outputPath(`agitations-${width}.png`),
			fullPage: true
		});
		const seen = new Set<string>();
		for (let turn = 0; turn < 8; turn += 1) {
			const scroller = card.locator('[data-scroll-region]');
			const overflow = await scroller.evaluate((element) => ({
				clientWidth: element.clientWidth,
				scrollWidth: element.scrollWidth
			}));
			expect(
				overflow.scrollWidth,
				`matrix has no horizontal overflow at ${width}px on page ${turn + 1}`
			).toBeLessThanOrEqual(overflow.clientWidth + 1);
			for (const name of await card
				.locator('thead th[title] [data-group-name]')
				.allTextContents()) {
				if (name.trim()) seen.add(name.trim());
			}
			const next = card.getByRole('button', { name: 'Next agitations page' });
			if ((await next.count()) === 0) break;
			if (await next.isDisabled()) break;
			await next.click();
		}
		expect(
			groups.every((group) => seen.has(group)),
			`all groups are reachable at ${width}px`
		).toBe(true);
	}
});

test('keeps matrix counts reachable with 150% text', async ({ page, request }) => {
	await seedSixGroups(request);
	await openOverview(page, 1024);
	await page.evaluate(() => {
		document.documentElement.dataset.textSize = '150';
	});
	const card = agitationsCard(page);
	await expect(card).toHaveAttribute('data-agitations-ready', 'true');
	const longRow = card.locator('tbody th[title]').filter({ hasText: LONG_AGITATION });
	const longRowLayout = await longRow.evaluate((element) => ({
		text: element.textContent?.trim(),
		width: element.clientWidth,
		scrollWidth: element.scrollWidth,
		height: element.clientHeight,
		scrollHeight: element.scrollHeight
	}));
	expect(longRowLayout.text, '150% text keeps the complete row label').toBe(LONG_AGITATION);
	expect(longRowLayout.scrollWidth, '150% text row label fits horizontally').toBeLessThanOrEqual(
		longRowLayout.width + 1
	);
	expect(longRowLayout.scrollHeight, '150% text row label fits vertically').toBeLessThanOrEqual(
		longRowLayout.height + 1
	);
	const scroller = card.locator('[data-scroll-region]');
	const count = card.locator('tbody tr:first-child td:nth-child(3) a');
	await count.scrollIntoViewIfNeeded();
	const fit = await scroller.evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
		right: element.getBoundingClientRect().right
	}));
	const cellRight = await count.evaluate((element) => element.getBoundingClientRect().right);
	expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth + 1);
	expect(cellRight).toBeLessThanOrEqual(fit.right + 1);
	await count.focus();
	await expect(count).toBeFocused();
	await expect(count).toBeVisible();
});

test('keeps focus in the matrix card when Right pages from a count link', async ({
	page,
	request
}) => {
	await seedSixGroups(request);
	await openOverview(page, 390);
	const card = agitationsCard(page);
	await expect(card).toHaveAttribute('data-agitations-ready', 'true');
	const count = card.locator('tbody tr:first-child td:nth-child(3) a');
	await count.focus();
	await page.keyboard.press('ArrowRight');
	await expect(card.locator('[data-page-position]')).toHaveText(/^2 of \d+$/);
	await expect(card).toContainText(LONG_AGITATION);
	await expect(card.getByRole('button', { name: 'Previous agitations page' })).toBeFocused();
});

test('removes panel backdrop blur for reduced transparency', async ({ page, request }) => {
	await seedEmpty(request);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setEmulatedMedia', {
		features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
	});
	await openOverview(page, 1024);
	const panel = page.locator('.panel').first();
	await expect(panel).toBeVisible();
	await expect
		.poll(() => panel.evaluate((element) => getComputedStyle(element).backdropFilter))
		.toBe('none');
	await cdp.detach();
});
