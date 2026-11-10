import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { seedWorkers, seedWideWorkers } from './workers-table-grid.ts';
import { openWorkersTable } from './workers-table-page.ts';
import { openWorkers } from './pages.ts';
import {} from './page-ready.ts';
import { addAgitations, addAttributes, addLanguages, addWorkers } from './worksite-builder.ts';

/**
 * The Workers table as a keyboard grid (ticket 11): one Tab stop, an
 * active cell moved with the arrows, followed through sort and filter.
 */

const rows = (page: Page) => page.locator('tbody tr[data-worker-id]');
/** The cell at a column position of the nth row: 0 checkbox, 1 Name, 2 Assessment, 3 Languages. */
const cell = (page: Page, row: number, column: number) =>
	rows(page).nth(row).locator('td').nth(column);

/**
 * Tabs forward from the focused control until focus reaches the grid's one Tab stop.
 * That stop is the active cell once its row is mounted, or the scroll viewport while
 * the active virtual row is unmounted: the viewport is what receives the Tab and then
 * hands focus to the cell after the app scrolls the row in and mounts it.
 * It must not press past that stop, or it would race the handoff and leave the grid.
 */
async function tabIntoGrid(page: Page) {
	for (let press = 0; press < 40; press += 1) {
		await page.keyboard.press('Tab');
		const reached = await page.evaluate(() => {
			const active = document.activeElement;
			if (!active) return false;
			return (
				!!active.closest('tbody') ||
				active === document.querySelector('[data-testid="workers-scroll-viewport"]')
			);
		});
		if (reached) return;
	}
	throw new Error('Tab never reached the table.');
}

/** Focuses the Search field, then tabs into the grid from it. */
async function tabIntoBody(page: Page) {
	await page.getByLabel('Search Name').focus();
	await tabIntoGrid(page);
}

const focusedWorker = (page: Page) =>
	page.evaluate(() => {
		const row = document.activeElement?.closest('tr[data-worker-id]');
		return row?.querySelectorAll('td')[1]?.textContent?.trim() ?? null;
	});

test('Tab enters the table in one stop and the next Tab leaves it', async ({ page, request }) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await expect(cell(page, 0, 1)).toBeFocused();

	await page.keyboard.press('Tab');
	expect(await page.evaluate(() => !!document.activeElement?.closest('tbody'))).toBe(false);

	await page.keyboard.press('Shift+Tab');
	await expect(cell(page, 0, 1)).toBeFocused();
});

test('Up and Down move the active cell with the standard focus ring', async ({ page, request }) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await expect(cell(page, 0, 1)).toHaveCSS('outline-style', 'solid');
	await expect(cell(page, 0, 1)).toHaveCSS('outline-width', '2px');

	await page.keyboard.press('ArrowDown');
	await expect(cell(page, 1, 1)).toBeFocused();
	await expect(cell(page, 1, 1)).toHaveCSS('outline-style', 'solid');
	await page.keyboard.press('ArrowUp');
	await expect(cell(page, 0, 1)).toBeFocused();
});

test('Enter on the Name cell opens the Record panel', async ({ page, request }) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await page.keyboard.press('Enter');
	await expect(page.getByRole('complementary', { name: /^Worker details: / })).toHaveCount(1);
	await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');
});

test('clicking a cell makes it the active cell and keeps its click behaviour', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { rows: 8 });
	await cell(page, 3, 3).click({ position: { x: 2, y: 2 } });
	// Today's behaviour: a click on the row selects its Worker.
	await expect(rows(page).nth(3)).toHaveAttribute('aria-current', 'true');
	await page.keyboard.press('ArrowDown');
	await expect(cell(page, 4, 3)).toBeFocused();

	// Leaving and coming back lands on the last active cell.
	await page.keyboard.press('Tab');
	await page.keyboard.press('Shift+Tab');
	await expect(cell(page, 4, 3)).toBeFocused();
});

test('the active cell follows its Worker through a sort and falls back when filtered out', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	const worker = await focusedWorker(page);
	expect(worker).toBeTruthy();

	await page.getByRole('button', { name: /^Name/ }).first().click();
	await page.getByRole('button', { name: /^Name/ }).first().focus();
	await tabIntoGrid(page);
	expect(await focusedWorker(page)).toBe(worker);

	await page.getByLabel('Search Name').fill('zzz-none');
	await page.getByLabel('Search Name').fill(worker === 'Grace Hopper' ? 'Ada' : 'Grace');
	await expect(rows(page)).toHaveCount(1);
	await tabIntoBody(page);
	await expect(rows(page).first().locator('td').nth(1)).toBeFocused();
});

test('moving past the rendered window scrolls, then focuses the right row', async ({
	page,
	request
}) => {
	await seedWideWorkers(request);
	await page.goto('/workers');
	await expect(rows(page).first()).toBeVisible();
	const rendered = await rows(page).count();
	expect(rendered).toBeLessThan(50);

	await tabIntoBody(page);
	for (let step = 0; step < 40; step += 1) await page.keyboard.press('ArrowDown');
	await expect
		.poll(() =>
			page.evaluate(() => document.activeElement?.closest('tr')?.getAttribute('data-index'))
		)
		.toBe('40');
	const inView = await page.evaluate(() => {
		const active = document.activeElement?.getBoundingClientRect();
		const viewport = document
			.querySelector('[data-testid="workers-scroll-viewport"]')
			?.getBoundingClientRect();
		return !!active && !!viewport && active.top >= viewport.top && active.bottom <= viewport.bottom;
	});
	expect(inView).toBe(true);
});

test('Tab re-entry restores the active cell after its virtual row unmounts', async ({
	page,
	request
}) => {
	await seedWideWorkers(request);
	await page.goto('/workers');
	await tabIntoBody(page);
	await page.keyboard.press('Meta+ArrowDown');
	await expect(page.locator('td:focus').locator('..')).toHaveAttribute('aria-rowindex', '51');
	const activeCell = await page.evaluate(() => {
		const cell = document.activeElement as HTMLElement | null;
		return {
			workerId: cell?.closest('tr[data-worker-id]')?.getAttribute('data-worker-id') ?? null,
			columnId: cell?.getAttribute('data-column-id') ?? null
		};
	});
	expect(activeCell.workerId).toBeTruthy();
	expect(activeCell.columnId).toBe('name');

	// Scroll the virtual row out of the rendered window: the active cell leaves the DOM,
	// so focus cannot be put on it directly.
	await page.locator('[data-testid="workers-scroll-viewport"]').evaluate((node) => {
		node.scrollTop = 0;
	});
	await expect
		.poll(() => page.locator(`tbody tr[data-worker-id="${activeCell.workerId}"]`).count())
		.toBe(0);

	// Re-entry is a real Tab into the grid, then the app's own work: while the active row
	// is unmounted the grid's Tab stop is its scroll viewport, and the app scrolls the row
	// into view, mounts it, and hands actual focus back to the same Worker's same column.
	await page.getByLabel('Search Name').focus();
	await tabIntoGrid(page);
	const restored = page.locator(
		`tr[data-worker-id="${activeCell.workerId}"] td[data-column-id="${activeCell.columnId}"]:focus`
	);
	await expect(restored).toHaveCount(1);
	await expect
		.poll(() =>
			page.evaluate(() => {
				const focused = document.activeElement?.getBoundingClientRect();
				const viewport = document
					.querySelector('[data-testid="workers-scroll-viewport"]')
					?.getBoundingClientRect();
				return (
					!!focused &&
					!!viewport &&
					focused.top >= viewport.top &&
					focused.bottom <= viewport.bottom
				);
			})
		)
		.toBe(true);
});

test('Left, Right, Home and End move across the cells of a row', async ({ page, request }) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await expect(cell(page, 0, 1)).toBeFocused();
	await page.keyboard.press('ArrowLeft');
	await expect(cell(page, 0, 0)).toBeFocused();
	await page.keyboard.press('ArrowLeft');
	await expect(cell(page, 0, 0)).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await expect(cell(page, 0, 2)).toBeFocused();
	await page.keyboard.press('End');
	await expect(rows(page).first().locator('td').last()).toBeFocused();
	await page.keyboard.press('Home');
	await expect(cell(page, 0, 0)).toBeFocused();
	// The column carries to the next row.
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowDown');
	await expect(cell(page, 1, 2)).toBeFocused();
});

test('Enter opens the Assessment editor and Escape returns focus to the cell', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('menu')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(cell(page, 0, 2)).toBeFocused();
	// Escape with no editor open keeps its meaning: nothing selected, panel closed.
	await expect(page.getByRole('complementary', { name: /^Worker details: / })).toHaveCount(0);
});

test('a typing key opens the Language editor', async ({ page, request }) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('a');
	await expect(page.getByRole('menu')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(cell(page, 0, 3)).toBeFocused();
});

test('Enter opens an ordinary Attribute editor, which edits both kinds and clears them', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { rows: 8 });
	const dataset = (await (await request.get('/api/dataset')).json()) as {
		attributes: { id: string; name: string }[];
	};
	const department = dataset.attributes.find((attribute) => attribute.name === 'Department')!.id;
	const shifts = dataset.attributes.find((attribute) => attribute.name === 'Shifts')!.id;

	// A Single-Select cell opens on Enter and saves the chosen answer.
	const departmentCell = rows(page).first().locator(`td[data-column-id="${department}"]`);
	await departmentCell.focus();
	await page.keyboard.press('Enter');
	await page.getByRole('menuitemradio', { name: 'Middle of House' }).click();
	await expect(departmentCell).toContainText('Middle of House');

	// A Multi-Select cell opens the same way; unchecking every answer clears it.
	const shiftsCell = rows(page).first().locator(`td[data-column-id="${shifts}"]`);
	await shiftsCell.focus();
	await page.keyboard.press('Enter');
	await page.getByRole('menuitemcheckbox', { name: 'Dinner' }).uncheck();
	await expect(shiftsCell).toHaveAccessibleName(/Brunch/);
	await expect(shiftsCell).not.toHaveAccessibleName(/Dinner/);

	await shiftsCell.press('Enter');
	await page.getByRole('menuitemcheckbox', { name: 'Brunch' }).uncheck();
	await expect(shiftsCell).toContainText('No Shifts');
	await shiftsCell.press('Enter');
	await page.getByRole('menuitemcheckbox', { name: 'Brunch' }).check();
	await expect(shiftsCell).toHaveAccessibleName(/Brunch/);

	// None clears a Single-Select, and Escape closes the editor without writing.
	await departmentCell.press('Enter');
	await page.getByRole('menuitemradio', { name: 'None', exact: true }).click();
	await expect(departmentCell).toContainText('No Department');

	// The readings survive a reload.
	await page.reload();
	await expect(rows(page).first().locator(`td[data-column-id="${department}"]`)).toContainText(
		'No Department'
	);
	await expect(rows(page).first().locator(`td[data-column-id="${shifts}"]`)).toHaveAccessibleName(
		/Brunch/
	);
});

test('Space ticks the active row from any cell', async ({ page, request }) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Space');
	await expect(rows(page).first().getByRole('checkbox')).toBeChecked();
});

test('the hint line names the left and right arrows', async ({ page, request }) => {
	await openWorkersTable(page, request, { rows: 8 });
	await expect(page.getByTestId('shortcut-hint')).toContainText('↑↓←→ move');
});

test('Shift+Down then Shift+Up extends and shrinks the checked range', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await page.keyboard.press('Shift+ArrowDown');
	await page.keyboard.press('Shift+ArrowDown');
	await expect(cell(page, 2, 1)).toBeFocused();
	await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(3);
	await expect(rows(page).nth(3).getByRole('checkbox')).not.toBeChecked();
	await page.keyboard.press('Shift+ArrowUp');
	await expect(cell(page, 1, 1)).toBeFocused();
	await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(2);
});

test('Space confirms a Shift range once, then toggles the active row', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await page.keyboard.press('Shift+ArrowDown');
	await page.keyboard.press('Shift+ArrowDown');
	await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(3);

	await page.keyboard.press('Space');
	await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(3);
	await page.keyboard.press('Space');
	await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(2);
});

test('Cmd+Down and Cmd+Up jump to the last and first Worker in the same column', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Meta+ArrowDown');
	await expect(cell(page, 7, 2)).toBeFocused();
	await page.keyboard.press('Meta+ArrowUp');
	await expect(cell(page, 0, 2)).toBeFocused();
});

test('Cmd jumps mount the ends of a virtualized Workers table', async ({ page, request }) => {
	await seedWideWorkers(request);
	await page.goto('/workers');
	await tabIntoBody(page);
	await page.keyboard.press('Meta+ArrowDown');
	await expect(page.locator('td:focus').locator('..')).toHaveAttribute('aria-rowindex', '51');
	await page.keyboard.press('Meta+ArrowUp');
	await expect(page.locator('td:focus').locator('..')).toHaveAttribute('aria-rowindex', '2');
});

test('Tab back into the table returns to the last active cell', async ({ page, request }) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Tab');
	await page.keyboard.press('Shift+Tab');
	await expect(cell(page, 2, 2)).toBeFocused();
});

test('the table is a grid whose cells are named by Worker and column', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { rows: 8 });
	const grid = page.getByRole('grid');
	await expect(grid).toHaveCount(1);
	await expect(grid.getByRole('row').nth(1)).toHaveAttribute('aria-rowindex', '2');
	const name = (await cell(page, 0, 1).locator('[data-name-cell]').textContent())?.trim() ?? '';
	await expect(
		grid.getByRole('gridcell', { name: new RegExp(`^Assessment for ${name}: .+`) })
	).toHaveCount(1);
	await expect(cell(page, 0, 2)).toHaveAttribute('aria-colindex', '3');
});

test.describe('phone width', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('rows keep their own Tab stop and details toggle', async ({ page, request }) => {
		await seedWorkers(request);
		await page.goto('/workers');
		await expect(rows(page)).toHaveCount(8);
		await rows(page).first().focus();
		await expect(rows(page).first()).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(rows(page).nth(1)).toBeFocused();
		await rows(page).first().focus();
		// The row's own controls stay Tab stops here: Tab reaches the details toggle.
		const toggle = rows(page)
			.first()
			.getByRole('button', { name: /^Show details for/ });
		for (let press = 0; press < 4; press += 1) {
			if (await toggle.evaluate((node) => node === document.activeElement)) break;
			await page.keyboard.press('Tab');
		}
		await expect(toggle).toBeFocused();
	});
});

test('resizing to phone restores row controls to keyboard navigation', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { rows: 8 });
	await tabIntoBody(page);
	await page.setViewportSize({ width: 390, height: 844 });
	const firstRow = rows(page).first();
	await expect(firstRow).toHaveAttribute('tabindex', '0');
	await firstRow.focus();
	const toggle = firstRow.getByRole('button', { name: /^Show details for/ });
	for (let press = 0; press < 12; press += 1) {
		if (await toggle.evaluate((node) => node === document.activeElement)) break;
		await page.keyboard.press('Tab');
	}
	await expect(toggle).toBeFocused();
});
test.describe('E6 folds product-gap-06 Name search', () => {
	type Seeded = {
		departmentId: string;
		rolesId: string;
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

		return { departmentId, rolesId, workerIds };
	}
	const rows = (page: Page) => page.locator('tbody tr[data-worker-id]');
	const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
	const count = (page: Page) => page.getByTestId('worker-count');
	/** The system No Department choice, present even when a real answer reads the same. */

	/** The real answer literally named No Department. */
	test('@product-gap-06 Name search still reads Names only', async ({ page, request }) => {
		await seedFixture(request);
		await openWorkers(page);

		const search = page.getByRole('searchbox', { name: 'Search Name' });
		await search.fill('Alex');
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Alex')).toBeVisible();
		// Blair's contact field and Note name Alex; they must not make a Name match.
		await expect(row(page, 'Blair')).toHaveCount(0);

		await search.fill('Equipment');
		await expect(rows(page)).toHaveCount(0);
		await expect(page.getByText(/No workers match/)).toBeVisible();

		await search.fill('');
		await expect(count(page)).toHaveText('4 workers');
	});
});

test.describe('E6 folds product-gap-08 Name search', () => {
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
	const rows = (page: Page) => page.locator('tbody tr[data-worker-id]');
	const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
	const count = (page: Page) => page.getByTestId('worker-count');
	const conditions = (page: Page) => page.getByTestId('active-condition');

	function agitationParams(page: Page): string[] {
		return new URL(page.url()).searchParams.getAll('agitation');
	}
	test('@product-gap-08 Name search still reads Names only, even with Equipment in Notes and contact fields', async ({
		page,
		request
	}) => {
		await seedFixture(request);
		await openWorkers(page);

		const search = page.getByRole('searchbox', { name: 'Search Name' });
		await search.fill('Equipment');
		await expect(rows(page)).toHaveCount(0);
		await expect(page.getByText(/No workers match/)).toBeVisible();
		// No Agitation condition was added by searching.
		expect(agitationParams(page)).toEqual([]);
		await expect(conditions(page)).toHaveCount(0);

		await search.fill('Alex');
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Alex')).toBeVisible();
		// Blair's contact field and Note name Alex; they must not make a Name match.
		await expect(row(page, 'Blair')).toHaveCount(0);

		await search.fill('');
		await expect(count(page)).toHaveText('4 workers');
	});
});
