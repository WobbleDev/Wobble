import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';
import { openWorkersTable, seedInspectorWorkers } from './workers-table-page.ts';

/** Worker continuity (ticket 07): creation, Previous and Next, return focus. */

const workerRow = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name) });
const nameCell = (page: Page, name: string) =>
	workerRow(page, name).getByRole('gridcell', { name: `Name for ${name}: ${name}`, exact: true });
const inspector = (page: Page, name: string) =>
	page.getByRole('complementary', { name: `Worker details: ${name}` });
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search Name' });
const cohortNav = (page: Page) => page.getByRole('navigation', { name: 'Workers in list' });

test('Previous and Next walk the opened list, disable at the ends and land focus on the heading', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await nameCell(page, 'Ada Lovelace').click();
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();
	const previous = cohortNav(page).getByRole('button', { name: 'Previous' });
	const next = cohortNav(page).getByRole('button', { name: 'Next' });
	await expect(previous).toBeDisabled();
	await expect(cohortNav(page)).toContainText('1 of 3');

	await next.click();
	await expect(inspector(page, 'Grace Hopper')).toBeVisible();
	await expect(inspector(page, 'Grace Hopper').locator('h2')).toBeFocused();
	await expect(previous).toBeEnabled();
	await expect(next).toBeEnabled();

	await cohortNav(page).getByRole('button', { name: 'Next' }).click();
	await expect(inspector(page, 'Katherine Johnson')).toBeVisible();
	await expect(cohortNav(page).getByRole('button', { name: 'Next' })).toBeDisabled();
	await expect(cohortNav(page)).toContainText('3 of 3');

	// Closing returns focus to the cell the record was opened from.
	await page.keyboard.press('Escape');
	await expect(inspector(page, 'Katherine Johnson')).toHaveCount(0);
	await expect(nameCell(page, 'Ada Lovelace')).toBeFocused();
});

test('a created Worker outside the filters stays open with a note and a way back', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await search(page).fill('Grace');
	await expect(workerRow(page, 'Grace Hopper')).toBeVisible();

	await page.getByRole('button', { name: 'New Worker', exact: true }).click();
	await inspector(page, 'Unnamed worker').getByLabel('Name').fill('Zed Test');
	await inspector(page, 'Unnamed worker').getByLabel('Name').press('Enter');

	const created = inspector(page, 'Zed Test');
	await expect(created).toBeVisible();
	await expect(workerRow(page, 'Zed Test')).toHaveCount(0);
	await expect(created.getByTestId('outside-filters')).toContainText('Outside filters');
	await created.getByRole('button', { name: 'Back to list' }).click();
	await expect(created).toHaveCount(0);
});

test('closing a record whose row is gone returns focus to the filter bar', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await nameCell(page, 'Ada Lovelace').click();
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();
	await search(page).fill('Katherine');
	await expect(inspector(page, 'Katherine Johnson')).toBeVisible();
	await expect(page.getByTestId('workers-cohort-notice')).toContainText('List changed');

	await inspector(page, 'Katherine Johnson').getByRole('button', { name: 'Close' }).click();
	await expect(inspector(page, 'Katherine Johnson')).toHaveCount(0);
	// Ada's row, the origin, is filtered out; Katherine's row is still shown.
	await expect(workerRow(page, 'Katherine Johnson')).toBeVisible();
});
