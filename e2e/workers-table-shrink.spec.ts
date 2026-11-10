import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { gridReport, workersNameRem, seedWorkers, widthOf } from './workers-table-grid.ts';

/**
 * Shrink-then-scroll: shrinkable columns interpolate between their preferred
 * and minimum widths, and the scrollport scrolls only below the minimum sum.
 */
test('columns shrink just under the preferred sum and scroll below the minima', async ({
	page,
	request
}) => {
	await seedWorkers(request);

	// Slightly under the preferred sum (1024px window): the table fits its frame.
	await page.setViewportSize({ width: 1024, height: 700 });
	await page.goto('/workers');
	await appReady(page);
	const shrunk = await gridReport(page);
	expect(shrunk.overflowX).toBe(false);
	expect(shrunk.tableScrollWidth).toBeLessThanOrEqual(shrunk.viewportWidth + 1);
	await expect(page.getByTestId('workers-scroll-viewport')).toHaveAttribute(
		'data-overflow',
		'false'
	);
	await expect(page.getByTestId('workers-scroll-fade')).toHaveCount(0);

	// Below the minimum sum (phone width): the table floors and scrolls sideways.
	await page.setViewportSize({ width: 390, height: 844 });
	await appReady(page);
	const floored = await gridReport(page);
	expect(floored.overflowX).toBe(true);
	expect(floored.tableScrollWidth).toBeGreaterThan(floored.viewportWidth);
	await expect(page.getByTestId('workers-scroll-viewport')).toHaveAttribute(
		'data-overflow',
		'true'
	);
});

test('a wide frame still shares its surplus across the content columns', async ({
	page,
	request
}) => {
	await seedWorkers(request);

	const measure = async (width: number) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/workers');
		await appReady(page);
		return gridReport(page);
	};

	const at1440 = await measure(1440);
	const at1920 = await measure(1920);

	expect(widthOf(at1920, 'Name')).toBe(workersNameRem() * at1920.rootFont);
	for (const label of ['Assessment', 'Languages', 'Department', 'Role', 'Shifts']) {
		expect(widthOf(at1920, label), `${label} takes spare width`).toBeGreaterThan(
			widthOf(at1440, label)
		);
	}
});
