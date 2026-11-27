import { randomUUID } from 'node:crypto';
import { appReady } from './page-ready.ts';
import { expect, test } from './fixtures.ts';
import { seedWorkers } from './workers-table-grid.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';
import { addAttribute, openAttributeEditor, workerColumn } from './configuration-outline.ts';

// Pin the media features the layout depends on, as the other specs do.
test.use({
	colorScheme: 'light',
	reducedMotion: 'reduce',
	forcedColors: 'none',
	contrast: 'no-preference'
});

test('mobile navigation opens and closes after a route change', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/overview');
	await appReady(page);

	const openNavigation = page.getByRole('button', { name: 'Open navigation' });
	await expect(openNavigation).toBeVisible();
	await openNavigation.click();

	await expect(openNavigation).toHaveAttribute('aria-expanded', 'true');
	const workersLink = page.getByRole('link', { name: 'Workers' });
	await expect(workersLink).toBeVisible();
	await workersLink.click();

	await expect(page).toHaveURL(/\/workers$/);
	await expect(openNavigation).toHaveAttribute('aria-expanded', 'false');
});

test('mobile Workers keeps rows actionable and opens attributes without horizontal scrolling', async ({
	page,
	request
}) => {
	const departmentId = randomUUID();
	const shiftsId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: departmentId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House']
			},
			{ id: shiftsId, name: 'Shifts', kind: 'tag', options: ['Dinner', 'Brunch'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const created = await request.post('/api/workers', {
		data: {
			name: 'Alexander Fleming',
			email: 'taylor@example.test',
			phone: '',
			assessment: 'Supporter',
			attributes: wireWorkerAttributes({
				[departmentId]: 'Front of House',
				[shiftsId]: ['Dinner']
			}),
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		}
	});
	expect(created.status(), await created.text()).toBe(201);

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/workers');

	const viewport = page.getByTestId('workers-scroll-viewport');
	const workerRow = page.getByRole('row', { name: /Alexander Fleming/ });
	await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Columns' })).toBeHidden();
	await expect(page.getByRole('columnheader', { name: 'Department' })).toBeAttached();

	// The Attribute columns stay on a narrow screen; the pinned Name keeps the
	// rest reachable by scrolling the table sideways.
	const departmentCell = workerRow.getByRole('button', {
		name: 'Edit department for Alexander Fleming'
	});
	const shiftsCell = workerRow.getByRole('button', { name: 'Edit shifts for Alexander Fleming' });
	await departmentCell.scrollIntoViewIfNeeded();
	await expect(departmentCell).toBeVisible();
	await shiftsCell.scrollIntoViewIfNeeded();
	await expect(shiftsCell).toBeVisible();
	await expect(shiftsCell).toBeEnabled();

	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		const sizes = await viewport.evaluate((element) => ({
			clientWidth: element.clientWidth,
			scrollWidth: element.scrollWidth
		}));
		// The table scrolls inside its own viewport; the page never does.
		expect(sizes.scrollWidth).toBeGreaterThan(sizes.clientWidth);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			width
		);
	}
});

test('mobile Mapping gives the map a full-width canvas and explains its visual key', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/mapping');

	const mapCanvas = page.getByTestId('relationship-map-canvas');
	// The surface is the map's keyboard-operable region: `application`, because
	// arrow keys pan it rather than moving through the page, with the key
	// vocabulary in its accessible name.
	const mapRegion = page.getByRole('application', { name: /Relationship map/ });
	const legend = page.getByRole('group', { name: 'Assessment color key' });
	await expect(mapCanvas).toBeVisible();
	await expect(mapRegion).toHaveCount(1);
	await expect(legend).toBeVisible();
	const mapBounds = await mapCanvas.boundingBox();
	const legendBounds = await legend.boundingBox();

	expect(mapBounds).not.toBeNull();
	expect(legendBounds).not.toBeNull();
	expect(mapBounds!.width).toBeGreaterThanOrEqual(280);
	expect(mapBounds!.y + mapBounds!.height).toBeLessThanOrEqual(
		await page.evaluate(() => window.innerHeight)
	);
	await expect(
		page.getByRole('img', { name: 'Dot size shows Relationships, from 0 to 5 or more' })
	).toBeVisible();
	const assessmentItems = page
		.getByRole('group', { name: 'Assessment color key' })
		.getByRole('list')
		.getByRole('listitem');
	await expect(assessmentItems).toHaveText([
		/Unassessed\s+\d+/,
		/Leader\s+\d+/,
		/Activist\s+\d+/,
		/Supporter\s+\d+/,
		/Disengaged\s+\d+/,
		/Hostile\s+\d+/
	]);
	// The dot-size key is its own image with a text alternative and a caption.
	const dotSizeKey = page.getByRole('img', {
		name: 'Dot size shows Relationships, from 0 to 5 or more'
	});
	await expect(dotSizeKey).toBeVisible();
	await expect(dotSizeKey).toContainText('Relationships');
	// The dot-size key is the canvas's last strip, beneath the colour key.
	const dotSizeBounds = (await dotSizeKey.boundingBox())!;
	expect(dotSizeBounds.y).toBeGreaterThanOrEqual(legendBounds!.y + legendBounds!.height - 1);
	expect(
		mapBounds!.y + mapBounds!.height - dotSizeBounds.y - dotSizeBounds.height
	).toBeLessThanOrEqual(2);
	const assessmentItemLayout = await assessmentItems.evaluateAll((items) =>
		items.map((item) => {
			const { x, y } = item.getBoundingClientRect();
			return { x: Math.round(x), y: Math.round(y) };
		})
	);
	expect(assessmentItemLayout[1].y).toBe(assessmentItemLayout[0].y);
	expect(assessmentItemLayout[1].x).toBeGreaterThan(assessmentItemLayout[0].x);
	const assessmentItemRows = assessmentItemLayout.map(({ y }) => y);
	expect(new Set(assessmentItemRows).size).toBeGreaterThan(1);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
});

test('mobile Configuration keeps attribute options inside the viewport', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/configuration');
	await appReady(page);

	await addAttribute(page, 'Mobile check');
	const attributeTable = workerColumn(page);
	const table = attributeTable.getByRole('tree');
	await expect(table).toBeVisible();
	await expect(workerColumn(page).getByTestId('add-attribute')).toBeVisible();

	const tableBounds = await table.boundingBox();
	const wrapperBounds = await attributeTable.boundingBox();
	expect(tableBounds).not.toBeNull();
	expect(wrapperBounds).not.toBeNull();
	expect(tableBounds!.x).toBeGreaterThanOrEqual(wrapperBounds!.x);
	expect(tableBounds!.x + tableBounds!.width).toBeLessThanOrEqual(
		wrapperBounds!.x + wrapperBounds!.width
	);

	const dialog = await openAttributeEditor(page, 'Department');
	await expect(
		dialog.getByRole('textbox', { name: 'New value for Department', exact: true })
	).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('mobile Workers keeps the toolbar on two rows and the bulk bar on one line with rows still visible', async ({
	page,
	request
}) => {
	const created = await request.post('/api/workers', {
		data: Array.from({ length: 8 }, (_, index) => ({ name: `Bar Worker ${index + 1}` }))
	});
	expect(created.ok(), await created.text()).toBeTruthy();

	await page.setViewportSize({ width: 400, height: 844 });
	await page.goto('/workers');

	const toolbar = page.getByTestId('workers-toolbar');
	await expect(page.getByTestId('worker-count')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible();
	const toolbarBox = await toolbar.boundingBox();
	const searchBox = await page.getByRole('searchbox', { name: 'Search Name' }).boundingBox();
	const filtersBox = await page.getByRole('button', { name: 'Filters' }).boundingBox();
	// Two rows: the Filters button on the first, the search field full width on the
	// second, each a tap target plus padding.
	expect(searchBox!.y).toBeGreaterThanOrEqual(filtersBox!.y + filtersBox!.height);
	expect(toolbarBox!.height).toBeLessThanOrEqual(2 * 44 + 34 + 8);
	expect(filtersBox!.x + filtersBox!.width).toBeLessThanOrEqual(400);

	const firstRow = page.getByRole('row', { name: /Bar Worker 1/ });
	const before = await firstRow.boundingBox();

	for (let index = 1; index <= 3; index += 1) {
		await page.getByRole('checkbox', { name: `Select Bar Worker ${index}` }).check();
	}
	const bar = page.getByTestId('bulk-bar');
	await expect(bar).toContainText('3 selected');
	const barBox = await bar.boundingBox();
	const actionsBox = await bar.getByRole('button', { name: 'Actions' }).boundingBox();
	expect(barBox!.height).toBeLessThanOrEqual(44 + 16 + 2);
	expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(400);
	expect(
		Math.abs(actionsBox!.y + actionsBox!.height / 2 - (barBox!.y + barBox!.height / 2))
	).toBeLessThanOrEqual(2);
	// Pinned to the bottom of the table surface, not between the toolbar and the rows.
	const after = await firstRow.boundingBox();
	expect(after!.y).toBe(before!.y);

	const viewportBox = await page.getByTestId('workers-scroll-viewport').boundingBox();
	const rowBoxes = await page
		.getByRole('row', { name: /Bar Worker/ })
		.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect()));
	const visible = rowBoxes.filter(
		(box) => box.top >= viewportBox!.y && box.bottom <= viewportBox!.y + viewportBox!.height
	);
	expect(visible.length).toBeGreaterThanOrEqual(5);

	// The checkbox is drawn small inside a full tap target.
	const checkbox = page.getByRole('checkbox', { name: 'Select Bar Worker 1' });
	const drawn = await checkbox.boundingBox();
	const tap = await checkbox.locator('xpath=..').boundingBox();
	expect(drawn!.width).toBeGreaterThanOrEqual(16);
	expect(drawn!.width).toBeLessThanOrEqual(20);
	expect(tap!.width).toBeGreaterThanOrEqual(44);
	expect(tap!.height).toBeGreaterThanOrEqual(44);

	await page.getByRole('button', { name: 'Filters' }).click();
	const sheet = page.getByRole('dialog', { name: 'Filters' });
	await expect(sheet.getByText('Columns', { exact: true })).toBeVisible();
	await expect(sheet.getByRole('group', { name: 'Assessment' })).toBeVisible();
});

test('at 400px the bulk bar is pinned to the viewport bottom with no dead band under it', async ({
	page,
	request
}) => {
	// A long configured Attribute name makes the bulk report wrap at phone width, so the
	// status line is measured while it is taller than one row and carries the Undo.
	const fieldName = 'Emergency Contact Relationship Notes';
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: randomUUID(), name: fieldName, kind: 'category', options: ['Daughter', 'Friend'] }
		])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	const created = await request.post('/api/workers', {
		data: Array.from({ length: 6 }, (_, index) => ({ name: `Band Worker ${index + 1}` }))
	});
	expect(created.ok(), await created.text()).toBeTruthy();

	await page.setViewportSize({ width: 400, height: 844 });
	await page.goto('/workers');
	const bar = page.getByTestId('bulk-bar');
	const statusLine = page.getByTestId('status-line');
	// With nothing checked the bar is absent and the line draws nothing.
	await expect(bar).toHaveCount(0);
	await expect(statusLine).toHaveAttribute('data-empty', 'true');

	const firstRow = page.getByRole('row', { name: /Band Worker 1/ });
	const before = await firstRow.boundingBox();
	for (let index = 1; index <= 6; index += 1) {
		await page.getByRole('checkbox', { name: `Select Band Worker ${index}` }).check();
	}

	await expect(bar).toBeVisible();
	const barBox = await bar.boundingBox();
	const statusBox = await statusLine.boundingBox();
	expect(Math.abs(844 - (barBox!.y + barBox!.height))).toBeLessThanOrEqual(1);
	expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(barBox!.y + 1);
	// Rows do not shift when the bar appears.
	expect((await firstRow.boundingBox())!.y).toBe(before!.y);

	// A wrapping report and its visible Undo must stay clear of the bar's occupied area,
	// not only the empty line measured above.
	await bar.getByRole('button', { name: 'Actions' }).click();
	await page.getByRole('menuitem', { name: 'Attributes' }).click();
	await page.getByRole('menuitem', { name: `Set ${fieldName}` }).click();
	await page.getByRole('menuitemradio', { name: 'Daughter' }).click();
	await page.keyboard.press('Escape');

	await expect(statusLine).toContainText(`Saved ${fieldName} for 6 workers`);
	const messageLines = await statusLine
		.getByRole('status')
		.evaluate((element) => element.clientHeight / parseFloat(getComputedStyle(element).lineHeight));
	expect(messageLines).toBeGreaterThan(1);

	const undo = statusLine.getByRole('button', { name: 'Undo' });
	await expect(undo).toBeVisible();
	const reportedBarBox = await bar.boundingBox();
	const reportedStatusBox = await statusLine.boundingBox();
	const undoBox = await undo.boundingBox();
	expect(reportedStatusBox!.y + reportedStatusBox!.height).toBeLessThanOrEqual(
		reportedBarBox!.y + 1
	);
	expect(undoBox!.y + undoBox!.height).toBeLessThanOrEqual(reportedBarBox!.y + 1);
	// Operable: the bar never covers it, so the Undo takes the click.
	await undo.click();
	await expect(statusLine).toContainText('Undone');

	// Clearing the selection drops the bar and its measured offset: the line returns to
	// the plain corner inset instead of keeping a stale gap.
	await bar.getByRole('button', { name: 'Clear selection' }).click();
	await expect(bar).toHaveCount(0);
	const clearedBox = await statusLine.boundingBox();
	expect(Math.abs(844 - 16 - (clearedBox!.y + clearedBox!.height))).toBeLessThanOrEqual(1);
});

test('at 400px tapping the bulk bar count opens the sheet on the selection summary', async ({
	page,
	request
}) => {
	const created = await request.post('/api/workers', {
		data: Array.from({ length: 5 }, (_, index) => ({ name: `Count Worker ${index + 1}` }))
	});
	expect(created.ok(), await created.text()).toBeTruthy();

	await page.setViewportSize({ width: 400, height: 844 });
	await page.goto('/workers');
	for (let index = 1; index <= 3; index += 1) {
		await page.getByRole('checkbox', { name: `Select Count Worker ${index}` }).check();
	}
	await expect(page.getByRole('dialog')).toHaveCount(0);

	await page.getByTestId('bulk-bar').getByRole('button', { name: '3 selected' }).click();
	const sheet = page.getByRole('dialog', { name: /^Worker details/ });
	await expect(sheet.getByTestId('panel-selection-summary')).toHaveText('3 selected');

	// Closing it leaves the checked rows alone.
	await sheet.getByRole('button', { name: 'Close' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByTestId('bulk-bar')).toContainText('3 selected');

	// A resize never opens it by itself.
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.setViewportSize({ width: 400, height: 844 });
	await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('mobile Workers opens the record sheet only on a row tap, never from a resize', async ({
	page,
	request
}) => {
	await seedWorkers(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	const row = page.getByRole('row', { name: /Ada Lovelace/ });
	await row.locator('td[data-pin="name"]').click();
	await expect(page.getByRole('complementary', { name: /^Worker details: Ada/ })).toBeVisible();

	await page.setViewportSize({ width: 400, height: 800 });
	await expect(row).toHaveAttribute('aria-current', 'true');
	await expect(page.getByRole('dialog', { name: /^Worker details/ })).toHaveCount(0);

	await page.getByRole('button', { name: 'Show details for Ada Lovelace' }).click();
	const sheet = page.getByRole('dialog', { name: 'Worker details: Ada Lovelace' });
	await expect(sheet).toBeVisible();

	// Closing slides the sheet away without the empty hint appearing behind it.
	const hint = page.getByText('Select a worker to see their details');
	await sheet.getByRole('button', { name: 'Close' }).click();
	await expect(hint).toHaveCount(0);
	await expect(sheet).toHaveCount(0);
	await expect(hint).toHaveCount(0);

	// Widening again never reopens it either.
	await page.setViewportSize({ width: 800, height: 800 });
	await expect(page.getByRole('dialog', { name: /^Worker details/ })).toHaveCount(0);
});

/**
 * The five routes the issue covers, each measured at the phone every mobile screenshot
 * uses. The helpers below describe the shell and page frame in one place, so a route
 * test only names the controls it owns.
 */
const PHONE = { width: 390, height: 844 };
const LONG_WORKSITE = 'A Very Long Worksite Name That Will Not Fit On A Phone Breadcrumb';

async function renameWorksite(request: import('@playwright/test').APIRequestContext) {
	const renamed = await request.put('/api/worksite', { data: { name: LONG_WORKSITE } });
	expect(renamed.ok(), await renamed.text()).toBeTruthy();
}

/** The page and every shell viewport stay inside the phone; a panel may scroll itself. */
async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
	const report = await page.evaluate(() => ({
		document: {
			client: document.documentElement.clientWidth,
			scroll: document.documentElement.scrollWidth
		},
		viewports: [...document.querySelectorAll<HTMLElement>('[data-scroll-viewport]')].map(
			(viewport) => ({
				client: viewport.clientWidth,
				scroll: viewport.scrollWidth
			})
		)
	}));
	expect(report.document.scroll, 'document scrollWidth').toBeLessThanOrEqual(PHONE.width);
	expect(report.viewports.length).toBeGreaterThan(0);
	for (const viewport of report.viewports) {
		expect(viewport.scroll, '[data-scroll-viewport] scrollWidth').toBeLessThanOrEqual(
			viewport.client
		);
	}
}

/** The accessible names of visible controls below the 44px physical floor. */
async function tapTargetOffenders(controls: import('@playwright/test').Locator): Promise<string[]> {
	return controls.evaluateAll((elements) =>
		elements.flatMap((element) => {
			const box = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			if (box.width === 0 || box.height === 0) return [];
			if (style.display === 'none' || style.visibility === 'hidden') return [];
			if (element.closest('.sr-only')) return [];
			if (box.width >= 44 && box.height >= 44) return [];
			const name =
				element.getAttribute('aria-label') ||
				element.getAttribute('title') ||
				(element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60) ||
				element.tagName.toLowerCase();
			return [`${name} (${Math.round(box.width)}×${Math.round(box.height)})`];
		})
	);
}

async function expectTapTarget(
	locator: import('@playwright/test').Locator,
	what: string
): Promise<void> {
	await expect(locator, what).toBeVisible();
	const box = await locator.boundingBox();
	expect(box, `${what} has a box`).not.toBeNull();
	expect(box!.width, `${what} width`).toBeGreaterThanOrEqual(44);
	expect(box!.height, `${what} height`).toBeGreaterThanOrEqual(44);
}

/**
 * The header is one phone row: the breadcrumb items share one vertical centre, the
 * Worksite segment truncates its long name, and the compact Import control sits in the
 * row beside the theme control whenever the route can import.
 */
async function expectMobileHeader(
	page: import('@playwright/test').Page,
	{ importable, worksite: hasWorksite = true }: { importable: boolean; worksite?: boolean }
): Promise<void> {
	const header = page.locator('header').first();
	await expect(header).toBeVisible();
	const headerBox = (await header.boundingBox())!;
	expect(headerBox.height, 'header is one phone row').toBeLessThanOrEqual(68);

	const crumbs = await page.locator('[data-slot="breadcrumb-list"] > *').evaluateAll((items) =>
		items.flatMap((item) => {
			// A Range measures the crumb TEXT, not the list item: the Worksite link keeps a
			// 44px hit height, so its item box is centred even when its text is not.
			const range = document.createRange();
			range.selectNodeContents(item);
			const text = range.toString().trim();
			if (!text) return [];
			const box = range.getBoundingClientRect();
			return [{ centre: box.top + box.height / 2, text }];
		})
	);
	expect(crumbs.length, 'breadcrumb items').toBeGreaterThanOrEqual(hasWorksite ? 2 : 1);
	const centres = crumbs.map((crumb) => crumb.centre);
	expect(
		Math.max(...centres) - Math.min(...centres),
		`breadcrumb items share one line: ${crumbs.map((crumb) => crumb.text).join(' > ')}`
	).toBeLessThanOrEqual(1);

	if (hasWorksite) {
		const worksite = page.locator('[data-slot="breadcrumb-list"] a[href="/overview"]');
		await expect(worksite).toHaveAttribute('title', LONG_WORKSITE);
		const worksiteText = worksite.locator('span');
		await expect(worksiteText).toHaveText(LONG_WORKSITE);
		expect(
			await worksiteText.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
			'Worksite segment truncates'
		).toBe(true);
		expect(
			await worksiteText.evaluate((element) => getComputedStyle(element).textOverflow),
			'Worksite segment shows an ellipsis'
		).toBe('ellipsis');
	}

	if (!importable) {
		await expect(page.getByRole('button', { name: 'Import contacts' })).toHaveCount(0);
		return;
	}

	const importButton = page.getByRole('button', { name: 'Import contacts' });
	await expect(importButton).toBeVisible();
	const importBox = (await importButton.boundingBox())!;
	expect(importBox.width, 'compact Import trigger width').toBeLessThanOrEqual(48);
	expect(importBox.height, 'compact Import trigger height').toBeGreaterThanOrEqual(44);
	expect(importBox.y, 'Import is in the header').toBeGreaterThanOrEqual(headerBox.y);
	expect(importBox.y + importBox.height, 'Import is in the header').toBeLessThanOrEqual(
		headerBox.y + headerBox.height
	);
	// The label is present for the accessible name but visually hidden below lg.
	await expect(importButton.locator('span')).toBeHidden();
}

test('at 390x844 Overview fits the viewport and keeps its switcher and coverage tappable', async ({
	page,
	request
}) => {
	await seedWorkers(request);
	await renameWorksite(request);
	await page.setViewportSize(PHONE);
	await page.goto('/overview');
	await appReady(page);

	await expectNoHorizontalOverflow(page);
	await expectMobileHeader(page, { importable: true });
	await expectTapTarget(
		page.getByRole('button', { name: 'Department', exact: true }),
		'Department switcher'
	);
	await expectTapTarget(
		page.locator('[data-coverage-card] [data-coverage-marks]'),
		'Committee coverage'
	);
});

test('at 390x844 the empty Overview coverage control meets the tap floor too', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto('/overview');
	await appReady(page);

	await expectNoHorizontalOverflow(page);
	await expectTapTarget(
		page.locator('[data-coverage-card] [data-coverage-marks]'),
		'Empty coverage control'
	);
});

test('at 390x844 Workers filters, select all and the empty state stay inside the viewport', async ({
	page,
	request
}) => {
	const departmentId = randomUUID();
	const roleId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: departmentId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House']
			},
			{ id: roleId, name: 'Role', kind: 'category', options: ['Server', 'Cook'] }
		])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	for (const name of ['Spanish', 'Polish', 'Vietnamese']) {
		const created = await request.post('/api/languages', { data: { name } });
		expect(created.ok(), await created.text()).toBeTruthy();
	}
	await renameWorksite(request);

	await page.setViewportSize(PHONE);
	await page.goto('/workers');
	await appReady(page);

	await expectNoHorizontalOverflow(page);
	await expectMobileHeader(page, { importable: true });

	const emptyState = page.getByTestId('workers-empty-state');
	await expect(emptyState).toBeVisible();
	const emptyTitle = emptyState.getByText('No workers in this worksite yet.');
	const emptyBox = (await emptyTitle.boundingBox())!;
	expect(
		Math.abs(emptyBox.x + emptyBox.width / 2 - PHONE.width / 2),
		'empty state centre'
	).toBeLessThanOrEqual(2);

	await expectTapTarget(
		page.getByRole('button', { name: 'Filter Assessment' }),
		'Filter Assessment'
	);
	await expectTapTarget(page.getByRole('button', { name: 'Filter Languages' }), 'Filter Languages');
	const selectAll = page.getByRole('checkbox', { name: 'Select all matching workers' });
	await expectTapTarget(selectAll.locator('xpath=..'), 'Select all');

	// Below lg each header carries a 44px sort and a 44px filter beside a whole title.
	for (const title of ['Name', 'Assessment', 'Languages', 'Department', 'Role']) {
		const header = page.getByRole('columnheader', { name: title });
		await expect(header, `${title} column header`).toBeAttached();
		const sort = header.getByRole('button').first();
		await expectTapTarget(sort, `${title} sort`);
		const label = sort.locator('span[title]');
		await expect(label).toHaveText(title);
		const measured = await label.evaluate((element) => ({
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth
		}));
		expect(
			measured.scrollWidth,
			`${title} title is not truncated (${measured.scrollWidth}px in ${measured.clientWidth}px)`
		).toBeLessThanOrEqual(measured.clientWidth + 1);

		const filter = header.getByRole('button', { name: `Filter ${title}` });
		if (await filter.count()) await expectTapTarget(filter, `Filter ${title}`);
	}
});

test('at 390x844 Mapping zoom controls meet the tap floor and the route does not overflow', async ({
	page,
	request
}) => {
	await seedWorkers(request);
	await renameWorksite(request);
	await page.setViewportSize(PHONE);
	await page.goto('/mapping');
	await appReady(page);
	await expect(page.getByTestId('relationship-map-canvas')).toBeVisible();

	await expectNoHorizontalOverflow(page);
	await expectMobileHeader(page, { importable: true });
	for (const name of ['Zoom out', 'Zoom in', 'Reset zoom']) {
		await expectTapTarget(page.getByRole('button', { name }), name);
	}
});

test('at 390x844 Configuration meets the tap floor on every control in its attribute column', async ({
	page,
	request
}) => {
	await seedWorkers(request);
	// A fresh Worksite has no Agitations; the rename buttons measured below need two.
	for (const text of ['Hours', 'Pay']) {
		const created = await request.post('/api/agitations', { data: { text } });
		expect(created.ok(), await created.text()).toBeTruthy();
	}
	await renameWorksite(request);
	await page.setViewportSize(PHONE);
	await page.goto('/configuration');
	await appReady(page);
	await page.evaluate(() => document.fonts.ready);

	await expectNoHorizontalOverflow(page);
	await expectMobileHeader(page, { importable: false });

	// Add attribute, each Attribute's fold, rename, type switch and reorder handle.
	await expectTapTarget(page.getByTestId('add-attribute'), 'Add attribute');
	const column = page.getByTestId('worker-column');
	expect(await tapTargetOffenders(column.getByRole('button'))).toEqual([]);
	// Toggle Agitations shares the fold heading, below the Attributes column.
	await expectTapTarget(
		page.getByRole('button', { name: 'Toggle Agitations' }),
		'Toggle Agitations'
	);
	// Twelve per-Attribute controls plus Add attribute and Toggle Agitations.
	expect(
		await column
			.getByRole('button', { name: /^(Rename |Switch from |Reorder |Toggle options for )/ })
			.count()
	).toBe(12);

	// The Agitations chips' rename buttons are at least 44px wide below md.
	for (const name of ['Edit Hours', 'Edit Pay']) {
		await expectTapTarget(page.getByRole('button', { name, exact: true }), name);
	}
});

test('at 390x844 Settings search results meet the tap floor with no route overflow', async ({
	page
}) => {
	await page.setViewportSize(PHONE);
	await page.goto('/settings');
	await appReady(page);

	await expectNoHorizontalOverflow(page);
	await expectMobileHeader(page, { importable: false, worksite: false });

	const search = page.getByRole('searchbox', { name: 'Search settings' });
	await search.fill('data');
	const results = page.getByRole('list', { name: 'Matching sections' }).getByRole('link');
	await expect(results.first()).toBeVisible();
	expect(await results.count()).toBeGreaterThan(0);
	expect(await tapTargetOffenders(results)).toEqual([]);
});
