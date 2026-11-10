import type { APIRequestContext, Page } from '@playwright/test';
import { clippedContent, expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import {
	gridReport,
	workersMinFloorRem,
	workersNameRem,
	seedWorkers,
	widthOf
} from './workers-table-grid.ts';
import { openWorkers } from './pages.ts';
import { addAgitations, addAttributes, addLanguages, addWorkers } from './worksite-builder.ts';
import { ASSESSMENT_MIN_REM } from '../src/lib/features/workers/data-table/workers-table-width.ts';

test('the Workers table hides no value and holds its readable minima from 1280px up', async ({
	page,
	request
}) => {
	await seedWorkers(request);

	for (const width of [1280, 1440, 1920]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/workers');
		await appReady(page);

		const report = await gridReport(page);

		expect(await clippedContent(page), `hidden content at ${width}px`).toEqual([]);
		// A value that does not fit its column now wraps, and the grid may scroll
		// sideways inside its own scrollport — both are the approved policy, which
		// replaced the older one-line-rhythm promise (DESIGN.md, Workers table Allocation
		// Rule). What still holds is that nothing is hidden and the *document*
		// never scrolls: the scrollport absorbs any surplus, not the page.
		expect(report.documentOverflowX, `document scroll at ${width}px`).toBe(false);
		// Name holds its longest-name width at every window instead of a shrinking
		// share. (The window's surplus goes to the content columns, never to Name.)
		expect(widthOf(report, 'Name'), `Name holds its allocation at ${width}px`).toBe(
			workersNameRem() * report.rootFont
		);
	}
});

test('the header stays aligned with the columns beneath it', async ({ page, request }) => {
	await seedWorkers(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	const report = await gridReport(page);
	expect(report.cells).toHaveLength(report.widths.length);

	for (const [index, header] of report.widths.entries()) {
		const cell = report.cells[index];
		expect(cell.x, `${header.label} column x`).toBe(header.x);
		expect(cell.width, `${header.label} column width`).toBe(header.width);
	}
});

test('the Workers table shrinks to the 1024px window instead of scrolling', async ({
	page,
	request
}) => {
	await seedWorkers(request);
	await page.setViewportSize({ width: 1024, height: 700 });
	await page.goto('/workers');
	await appReady(page);

	const report = await gridReport(page);

	expect(await clippedContent(page)).toEqual([]);
	// The preferred sum no longer fits 1024px, but the minima do: the columns
	// shrink to the frame instead of scrolling — inside the scrollport either way.
	expect(report.overflowX).toBe(false);
	expect(report.documentOverflowX).toBe(false);
	await expect(page.getByTestId('workers-scroll-fade')).toHaveCount(0);
	// The table fills the frame but never goes below its minimum sum (the pinned
	// checkbox 2.75rem, Name at its longest name, Assessment 6rem, Languages and
	// the three Attributes at most 5rem each).
	expect(report.tableScrollWidth).toBeGreaterThanOrEqual(
		workersMinFloorRem() * report.rootFont - 2
	);
	expect(report.tableScrollWidth).toBeLessThanOrEqual(report.viewportWidth + 1);
	// Every column the Shell tier shows is still there, Languages included, and
	// Name holds its full allocation while the shrinkable columns give way.
	expect(report.widths.every((column) => column.width > 0)).toBe(true);
	expect(widthOf(report, 'Name')).toBe(workersNameRem() * report.rootFont);
	const assessment = widthOf(report, 'Assessment');
	expect(assessment).toBeLessThanOrEqual(9 * report.rootFont);
	expect(assessment).toBeGreaterThanOrEqual(ASSESSMENT_MIN_REM * report.rootFont - 1);
});

test('columns hold the content-derived floor and share the spare width with the window', async ({
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

	const atNarrow = await measure(390);
	const at1440 = await measure(1440);
	const at1920 = await measure(1920);

	// At a phone width even the minimum sum does not fit, so the table floors at
	// the shrink minima (workersMinFloorRem) and the scrollport scrolls.
	expect(atNarrow.overflowX).toBe(true);
	expect(
		Math.abs(atNarrow.tableScrollWidth - workersMinFloorRem() * atNarrow.rootFont)
	).toBeLessThanOrEqual(2);

	// Name is pinned to its longest name, and the checkbox holds
	// its length: a wider frame never stretches them.
	for (const label of ['select', 'Name']) {
		expect(widthOf(at1920, label), `${label} stays put`).toBe(widthOf(at1440, label));
	}
	expect(widthOf(at1440, 'Name')).toBe(workersNameRem() * at1440.rootFont);

	// The window's surplus is shared across the content columns, so they widen
	// with the frame instead of leaving a gap beside the table.
	for (const label of ['Assessment', 'Languages', 'Department', 'Role', 'Shifts']) {
		expect(widthOf(at1920, label), `${label} takes spare width`).toBeGreaterThan(
			widthOf(at1440, label)
		);
	}
});

test('the Workers table shows no clip head', async ({ page, request }) => {
	await seedWorkers(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	// The clip head was the bar above the Workers table holding the worksite reading,
	// the filter count and the region strip. `data-slot="toolbar"` was its own
	// marker and nothing else in the app carries it; the region strip's list was
	// the only list on this route with an accessible name.
	await expect(page.locator('[data-slot="toolbar"]')).toHaveCount(0);
	await expect(page.getByRole('list', { name: 'Region readings' })).toHaveCount(0);

	// The Workers table itself is untouched: its column header is now the held head, and
	// the page heading sits directly above the filter bar.
	await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible();
	await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
});

test('the narrow layout keeps every column and the page does not overflow', async ({
	page,
	request
}) => {
	await seedWorkers(request);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/workers');
	await appReady(page);

	for (const name of ['Name', 'Assessment', 'Languages', 'Department', 'Role', 'Shifts']) {
		await expect(page.getByRole('columnheader', { name })).toBeAttached();
	}
	await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible();
	expect((await gridReport(page)).documentOverflowX).toBe(false);
});
test.describe('E6 folds product-gap-08 menu sync', () => {
	type Seeded = {
		departmentId: string;
		rolesId: string;
		agitations: Record<string, string>;
		workerIds: Record<string, string>;
	};

	async function seedFixture(request: APIRequestContext): Promise<Seeded> {
		const [departmentId, rolesId] = await addAttributes(request, [
			{
				name: 'Department',
				kind: 'category',
				options: ['Packing', 'Delivery', 'No Department']
			},
			{ name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
		]);
		const [english, spanish] = await addLanguages(request, ['English', 'Spanish']);
		const [equipment, schedule] = await addAgitations(request, ['Equipment', 'Schedule']);
		const created = await addWorkers(request, [
			{
				name: 'Alex',
				assessment: 'Leader',
				attributes: { [departmentId]: 'Packing', [rolesId]: ['Trainer'] },
				languages: [english],
				agitations: [equipment]
			},
			{
				name: 'Blair',
				assessment: 'Supporter',
				attributes: { [departmentId]: 'Delivery', [rolesId]: ['Trainer', 'Steward'] },
				languages: [spanish],
				agitations: [schedule],
				// A contact field and a Note that name Alex and Equipment; Name search must not read them.
				email: 'alex@example.test',
				notes: [
					{
						id: 'note-blair',
						text: 'Alex asked about Equipment',
						timestamp: '2024-01-01T00:00:00.000Z'
					}
				]
			},
			{
				name: 'Casey',
				assessment: 'Unassessed',
				attributes: { [departmentId]: '', [rolesId]: [] },
				languages: [english, spanish],
				agitations: [equipment]
			},
			{
				name: 'Drew',
				assessment: 'Activist',
				attributes: { [departmentId]: 'No Department', [rolesId]: ['Steward'] }
			}
		]);
		const names = ['Alex', 'Blair', 'Casey', 'Drew'];
		const workerIds = Object.fromEntries(names.map((name, index) => [name, created[index]]));
		const agitations = { Equipment: equipment, Schedule: schedule };

		return { departmentId, rolesId, agitations, workerIds };
	}
	async function openFilter(page: Page, attributeName: string): Promise<void> {
		await page.getByRole('button', { name: `Filter ${attributeName}`, exact: true }).click();
	}
	const count = (page: Page) => page.getByTestId('worker-count');
	const conditions = (page: Page) => page.getByTestId('active-condition');

	function agitationParams(page: Page): string[] {
		return new URL(page.url()).searchParams.getAll('agitation');
	}

	/** The desktop toolbar Filters menu, opened. */
	async function openFiltersMenu(page: Page): Promise<void> {
		// Keyboard-open: an open Worker card can sit over the toolbar's right edge.
		await page.getByRole('button', { name: /^Filters/ }).focus();
		await page.keyboard.press('Enter');
	}

	/** The Agitations submenu of the desktop Filters menu. */
	async function openAgitations(page: Page): Promise<void> {
		await openFiltersMenu(page);
		await page.getByRole('menuitem', { name: /^Agitations/ }).click();
	}

	/** Closes every open menu layer, submenus first. */
	async function closeMenus(page: Page): Promise<void> {
		while ((await page.getByRole('menu').count()) > 0) {
			await page.keyboard.press('Escape');
		}
	}

	async function chooseAgitation(page: Page, text: string): Promise<void> {
		await page.getByRole('menuitemcheckbox', { name: text, exact: true }).click();
	}
	test('@product-gap-08 the Filters menu and a column header menu stay in step', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openWorkers(page);

		// Choosing in the toolbar Filters menu sets the shared state the header reads.
		await openAgitations(page);
		await chooseAgitation(page, 'Equipment');
		await closeMenus(page);
		await expect(count(page)).toHaveText('2 workers');
		await expect(conditions(page).filter({ hasText: 'Equipment' })).toHaveCount(1);
		await expect(page.getByRole('button', { name: /^Filters/ })).toContainText('1');

		// Choosing in a column header menu shows in the Filters submenu, checked and counted.
		await openFilter(page, 'Department');
		await page.getByRole('menuitemcheckbox', { name: 'Packing, 1 worker', exact: true }).click();
		await closeMenus(page);
		await expect(count(page)).toHaveText('1 worker');
		await expect(conditions(page).filter({ hasText: 'Packing' })).toHaveCount(1);
		expect(agitationParams(page)).toEqual([seeded.agitations.Equipment]);

		await openFiltersMenu(page);
		await page.getByRole('menuitem', { name: /^Department/ }).click();
		await expect(
			page.getByRole('menuitemcheckbox', { name: 'Packing', exact: true })
		).toHaveAttribute('aria-checked', 'true');
		await expect(page.getByRole('button', { name: /^Filters/ })).toContainText('2');
		await closeMenus(page);

		// Clearing from the Filters menu empties the header state as well.
		await openFiltersMenu(page);
		await page.getByRole('menuitem', { name: 'Clear filters', exact: true }).click();
		await expect(count(page)).toHaveText('4 workers');
		await expect(conditions(page)).toHaveCount(0);
	});
});
