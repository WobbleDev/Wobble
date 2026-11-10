import { expect, test } from './fixtures.ts';
import { gridReport, workersNameRem } from './workers-table-grid.ts';
import { openWorkersTable } from './workers-table-page.ts';

const viewport = (page: import('@playwright/test').Page) =>
	page.getByTestId('workers-scroll-viewport');
const fade = (page: import('@playwright/test').Page) => page.getByTestId('workers-scroll-fade');

test('at 600px the table overflows, shows the rule and fade, and keeps Name pinned against the checkbox', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 600, height: 700 } });
	await expect(viewport(page)).toBeVisible();

	await expect(viewport(page)).toHaveAttribute('data-overflow', 'true');
	const nameHead = page.getByRole('columnheader', { name: 'Name' });
	await expect(nameHead).toHaveCSS('box-shadow', /inset/);
	await expect(fade(page)).toBeVisible();
	await expect(fade(page)).toHaveCSS('pointer-events', 'none');

	await viewport(page).evaluate((element) => (element.scrollLeft = 120));
	const boxes = await page.evaluate(() => {
		const scroller = document.querySelector('[data-testid="workers-scroll-viewport"]')!;
		const rect = (selector: string) => {
			const box = scroller.querySelector(selector)!.getBoundingClientRect();
			return { left: box.left, right: box.right };
		};
		return {
			scroller: rect('table'),
			frame: scroller.getBoundingClientRect().left,
			select: rect('tbody tr[data-index] td[data-pin="select"]'),
			name: rect('tbody tr[data-index] td[data-pin="name"]'),
			headSelect: rect('thead th[data-pin="select"]'),
			headName: rect('thead th[data-pin="name"]')
		};
	});
	// Name is still in view, and the two pinned columns touch without a gap.
	expect(boxes.name.left).toBeGreaterThanOrEqual(boxes.frame - 1);
	expect(boxes.select.right).toBeCloseTo(boxes.name.left, 0);
	expect(boxes.headSelect.right).toBeCloseTo(boxes.headName.left, 0);
	expect(boxes.scroller.left).toBeLessThan(boxes.frame);
});

test('scrolled fully right, the fade is hidden', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 600, height: 700 } });
	await expect(viewport(page)).toBeVisible();

	await expect(fade(page)).toBeVisible();
	await viewport(page).evaluate((element) => (element.scrollLeft = element.scrollWidth));
	const scroll = await gridReport(page);
	await expect(
		fade(page),
		`fade at scroll end: ${JSON.stringify({
			clientWidth: scroll.viewportWidth,
			offsetWidth: scroll.viewportOffsetWidth,
			scrollWidth: scroll.viewportScrollWidth,
			scrollLeft: scroll.viewportScrollLeft,
			scrollbarWidth: scroll.viewportScrollbarWidth,
			maxScrollLeft: scroll.maxScrollLeft,
			endGap: scroll.endGap,
			overflowX: scroll.computedOverflowX
		})}`
	).toHaveCount(0);
	await expect(viewport(page)).toHaveAttribute('data-overflow', 'true');
});

test('where nothing overflows there is no rule and no fade', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1920, height: 900 } });
	await expect(viewport(page)).toBeVisible();

	await expect(viewport(page)).toHaveAttribute('data-overflow', 'false');
	await expect(page.getByRole('columnheader', { name: 'Name' })).toHaveCSS('box-shadow', 'none');
	await expect(fade(page)).toHaveCount(0);
});

test('at 375px the Name column is pinned to its longest name', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 375, height: 800 } });
	await expect(viewport(page)).toBeVisible();

	// The phone frame is narrower than the floor, so the Workers table scrolls sideways;
	// Name keeps its longest-name width there like every other frame.
	const { width, rem } = await page.evaluate(() => ({
		width: document.querySelector('thead th[data-pin="name"]')!.getBoundingClientRect().width,
		rem: parseFloat(getComputedStyle(document.documentElement).fontSize)
	}));
	expect(width).toBe(workersNameRem() * rem);
});
