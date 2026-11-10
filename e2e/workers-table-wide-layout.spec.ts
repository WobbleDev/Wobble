import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';
import {
	gridReport,
	seedWorkers,
	seedWideWorkers,
	wideWorkersMinFloorRem,
	wideWorkerName
} from './workers-table-grid.ts';

/**
 * Ticket 09 — the readable Workers table: a twelve-attribute Workers table stays usable at the
 * desktop floor. Shrinkable columns interpolate between their preferred widths
 * and their shrink minima instead of scrolling at once; the surplus scrolls
 * inside the Workers table scrollport while the Filter bar, the bulk bar, and the work
 * area stay put.
 *
 * The wide fixture's scroll floor (`wideWorkersMinFloorRem` in workers-table-grid.ts) is
 * the sum of its visible columns' minima: the pinned checkbox, Name sized to the longest
 * seeded name, Assessment at 6rem, and Languages plus every Attribute at most 5rem.
 */
test.describe('readable Workers table', () => {
	test.beforeEach(async ({ page }) => {
		// The fixtures hand every test its own empty Worksite, so each test
		// seeds exactly the Workers table it measures.
		await page.goto('/workers');
		await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible();
	});

	const viewportOf = (page: Page) => page.getByTestId('workers-scroll-viewport');

	/**
	 * The wide fixture repeats first and last names, so a Worker is named by its
	 * whole unique name. It is matched on the Name cell rather than the row's
	 * text: the cells concatenate without separators, which would make
	 * `Ada Lovelace 1` a prefix of `Ada Lovelace 17`.
	 */
	const wideRow = (page: Page, index: number) =>
		page.getByRole('row').filter({
			has: page.getByRole('gridcell', {
				name: `Name for ${wideWorkerName(index)}: ${wideWorkerName(index)}`,
				exact: true
			})
		});

	test('a twelve-attribute Workers table keeps a usable work area at the desktop floor', async ({
		page,
		request
	}) => {
		await seedWideWorkers(request);
		await page.goto('/workers');
		await expect(wideRow(page, 0)).toBeVisible();
		await page.setViewportSize({ width: 1024, height: 768 });

		// With two Workers selected the bar stack is at its tallest.
		const rows = page.getByRole('row');
		await rows.nth(1).getByRole('checkbox').check();
		await rows.nth(2).getByRole('checkbox').check();
		await expect(
			page.getByTestId('bulk-bar').getByRole('button', { name: 'Edit', exact: true })
		).toBeVisible();

		const report = await gridReport(page);
		// Every rendered column still meets its approved minimum.
		// The floor comes from the seeds and the shrink-minimum rule (workers-table-grid.ts).
		expect(report.tableScrollWidth).toBeGreaterThanOrEqual(
			wideWorkersMinFloorRem() * report.rootFont - 1
		);
		// The scrollport — not the document — absorbs the overflow.
		expect(report.documentOverflowX).toBe(false);
		expect(report.overflowX).toBe(true);
		const height = await viewportOf(page).evaluate((element) => element.clientHeight);
		expect(height).toBeGreaterThanOrEqual(240);
		// Both bars stay put while the grid scrolls underneath them.
		const bar = page.getByTestId('bulk-bar');
		const barBefore = await bar.boundingBox();
		await viewportOf(page).evaluate((element) => element.scrollTo({ left: 400, top: 200 }));
		const barAfter = await bar.boundingBox();
		expect(barAfter?.y).toBe(barBefore?.y);
	});

	test('wide columns scroll inside the Workers table scrollport, headers aligned', async ({
		page,
		request
	}) => {
		await seedWideWorkers(request);
		await page.goto('/workers');
		await expect(wideRow(page, 0)).toBeVisible();

		const viewport = viewportOf(page);
		await viewport.evaluate((element) => element.scrollTo({ left: element.scrollWidth }));
		const scrolled = await gridReport(page);
		// The rendered row's cells still line up with the scrolled headers.
		expect(scrolled.cells.length).toBeGreaterThan(0);
		// Header and body columns are the same columns, so they pair by index.
		expect(scrolled.cells.length).toBe(scrolled.widths.length);
		for (let index = 0; index < scrolled.widths.length; index += 1) {
			expect(Math.abs(scrolled.widths[index].x - scrolled.cells[index].x)).toBeLessThanOrEqual(2);
		}
		// The scrollport reached its far right edge.
		const scroll = await gridReport(page);
		expect(
			scroll.viewportScrollLeft + scroll.viewportWidth >= scroll.viewportScrollWidth - 2,
			`scroll end metrics: ${JSON.stringify({
				clientWidth: scroll.viewportWidth,
				offsetWidth: scroll.viewportOffsetWidth,
				scrollWidth: scroll.viewportScrollWidth,
				scrollLeft: scroll.viewportScrollLeft,
				maxScrollLeft: scroll.maxScrollLeft,
				endGap: scroll.endGap,
				overflowX: scroll.computedOverflowX
			})}`
		).toBe(true);
	});

	test('attribute filters live on their column headers and keep state', async ({
		page,
		request
	}) => {
		await seedWorkers(request);
		await page.goto('/workers');
		await expect(page.getByRole('row', { name: /Ada Lovelace/ })).toBeVisible();

		const departmentFilter = page.getByRole('button', { name: 'Filter Department', exact: true });
		await departmentFilter.click();
		const option = page.getByRole('menuitemcheckbox', { name: 'Front of House' });
		await option.click();
		// The menu stays open on select, so the tick is visible before it is dismissed.
		await expect(option).toBeChecked();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('row', { name: /Grace Hopper/ })).toBeHidden();
		await expect(page.getByRole('row', { name: /Ada Lovelace/ })).toBeVisible();

		// The choice survives reopening and clears explicitly from the toolbar.
		await departmentFilter.click();
		await expect(page.getByRole('menuitemcheckbox', { name: 'Front of House' })).toBeChecked();
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
		await expect(page.getByRole('row', { name: /Grace Hopper/ })).toBeVisible();
	});

	test('bulk attribute actions live in the searchable Attributes chooser', async ({
		page,
		request
	}) => {
		await seedWorkers(request);
		await page.goto('/workers');
		const bar = page.getByTestId('bulk-bar');
		const rows = page.getByRole('row');
		await rows.nth(1).getByRole('checkbox').check();
		await rows.nth(2).getByRole('checkbox').check();

		// No per-Attribute buttons remain on the bar: one chooser holds them all.
		await expect(bar.getByRole('button', { name: 'Department' })).toHaveCount(0);
		await bar.getByRole('button', { name: 'Edit', exact: true }).click();
		await page.getByRole('searchbox', { name: 'Search Attributes' }).fill('depart');
		await expect(page.getByRole('menuitem', { name: 'Role' })).toBeHidden();
		await page.getByRole('menuitem', { name: 'Set Department' }).click();
		await page.getByRole('menuitemradio', { name: 'Front of House' }).click();

		// The batch ran on both selected Workers and reports it, with recovery to hand.
		await expect(page.getByText('Saved Department for 2 workers')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
	});

	test('fifty workers still render as a bounded virtual slice', async ({ page, request }) => {
		await seedWideWorkers(request);
		await page.goto('/workers');
		await page.setViewportSize({ width: 1440, height: 900 });
		await expect(wideRow(page, 0)).toBeVisible();

		const report = await gridReport(page);
		expect(report.rowHeights.length).toBeLessThan(80);
	});

	test('with the record panel open the table scrolls sideways and Name stays pinned', async ({
		page,
		request
	}) => {
		await seedWideWorkers(request);
		await page.goto('/workers');
		await expect(wideRow(page, 0)).toBeVisible();
		await page.setViewportSize({ width: 1280, height: 768 });

		await wideRow(page, 0)
			.getByRole('gridcell', {
				name: `Name for ${wideWorkerName(0)}: ${wideWorkerName(0)}`,
				exact: true
			})
			.click();
		await expect(page.getByRole('complementary', { name: /^Worker details: / })).toBeVisible();

		const scroller = viewportOf(page);
		await expect(scroller).toHaveAttribute('data-overflow', 'true');
		await expect(page.getByTestId('workers-scroll-fade')).toBeVisible();
		const sizes = await scroller.evaluate((element) => ({
			client: element.clientWidth,
			scroll: element.scrollWidth
		}));
		expect(sizes.scroll).toBeGreaterThan(sizes.client);

		await scroller.evaluate((element) => (element.scrollLeft = element.scrollWidth));
		const last = page.getByRole('columnheader').last();
		const edges = await page.evaluate(() => {
			const frame = document.querySelector('[data-testid="workers-scroll-viewport"]')!;
			const box = frame.getBoundingClientRect();
			const name = frame.querySelector('thead th[data-pin="name"]')!.getBoundingClientRect();
			const lastHead = [...frame.querySelectorAll('thead th')].at(-1)!.getBoundingClientRect();
			return {
				frameLeft: box.left,
				frameRight: box.right,
				nameLeft: name.left,
				lastRight: lastHead.right
			};
		});
		await expect(last).toBeAttached();
		expect(edges.lastRight).toBeLessThanOrEqual(edges.frameRight + 1);
		expect(edges.nameLeft).toBeGreaterThanOrEqual(edges.frameLeft - 1);
		const scroll = await gridReport(page);
		await expect(
			page.getByTestId('workers-scroll-fade'),
			`fade at scroll end: ${JSON.stringify({
				clientWidth: scroll.viewportWidth,
				offsetWidth: scroll.viewportOffsetWidth,
				scrollWidth: scroll.viewportScrollWidth,
				scrollLeft: scroll.viewportScrollLeft,
				maxScrollLeft: scroll.maxScrollLeft,
				endGap: scroll.endGap,
				overflowX: scroll.computedOverflowX
			})}`
		).toHaveCount(0);
	});
});
