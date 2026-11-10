import { expect, test } from './fixtures.ts';
import { workerUpdateFrom } from './api.ts';
import { openWorkers } from './pages.ts';
import { appReady } from './page-ready.ts';
import type { APIRequestContext, Page } from '@playwright/test';
import { openWorkersTable } from './workers-table-page.ts';

/** The Workers table's checkbox for one Worker, by the name its label carries. */
function checkbox(page: Page, name: string) {
	return page.getByRole('checkbox', { name: `Select ${name}` });
}

/** The value a Worker's cell shows for one column, read off its editor's label. */
function cell(page: Page, column: string, workerName: string) {
	return page.getByRole('button', { name: `Edit ${column} for ${workerName}` });
}

/** Adds contacts through the same bulk import endpoint the app uses. */
async function seedContacts(request: APIRequestContext, names: string[]): Promise<void> {
	const created = await request.post('/api/workers', { data: names.map((name) => ({ name })) });
	expect(created.ok(), await created.text()).toBeTruthy();
}

/** The header checkbox, which governs the rows the filters match. */
function headerCheckbox(page: Page) {
	return page.getByRole('checkbox', { name: 'Select all matching workers' });
}

test('checkboxes select rows, the bar counts them and Clear empties it', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	const bar = page.getByTestId('bulk-bar');
	await expect(bar).toHaveCount(0);

	await checkbox(page, 'Ada Lovelace').check();
	await checkbox(page, 'Grace Hopper').check();

	await expect(bar).toBeVisible();
	await expect(bar).toContainText('2 selected');

	await bar.getByRole('button', { name: 'Clear selection' }).click();

	await expect(bar).toHaveCount(0);
	await expect(checkbox(page, 'Ada Lovelace')).not.toBeChecked();
});

test('select-all takes the whole Workers table and turns indeterminate on one departure', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	const bar = page.getByTestId('bulk-bar');
	await headerCheckbox(page).check();

	await expect(bar).toContainText('8 selected');
	await expect(headerCheckbox(page)).toBeChecked();

	await checkbox(page, 'Grace Hopper').uncheck();

	await expect(bar).toContainText('7 selected');
	await expect(headerCheckbox(page)).toHaveJSProperty('indeterminate', true);
});

test('the header checkbox selects only the rows the filters match', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	await seedContacts(
		request,
		Array.from({ length: 50 }, (_, index) => `Filler ${String(index + 1).padStart(3, '0')}`)
	);
	await page.reload();
	await appReady(page);

	await page.getByRole('searchbox', { name: 'Search Name' }).fill('Ada');

	const bar = page.getByTestId('bulk-bar');
	await headerCheckbox(page).check();

	// One row matches, so exactly one Worker is selected — not the whole Worksite.
	await expect(bar).toContainText('1 selected');
	await expect(bar).not.toContainText('outside filters');
	await expect(checkbox(page, 'Ada Lovelace')).toBeChecked();

	await headerCheckbox(page).uncheck();
	await expect(bar).toHaveCount(0);
});

test('the header selects matches that virtualization never mounted', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	// More matches than the Workers table can mount at 1440x900, so selecting them all
	// has to come from the filtered row model rather than the rendered rows.
	await seedContacts(
		request,
		Array.from({ length: 120 }, (_, index) => `Virtual Worker ${String(index + 1)}`)
	);
	await page.reload();
	await appReady(page);

	await page.getByRole('searchbox', { name: 'Search Name' }).fill('Virtual Worker');

	// The virtualizer renders a slice, and the header still counts every match.
	expect(await page.getByRole('row').count()).toBeLessThan(120);

	await headerCheckbox(page).check();

	await expect(page.getByTestId('bulk-bar')).toContainText('120 selected');
});

test('a hidden hand-picked selection is counted as outside the filters', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	const bar = page.getByTestId('bulk-bar');
	// Pick a Worker, then filter them out of sight.
	await checkbox(page, 'Grace Hopper').check();
	await page.getByRole('searchbox', { name: 'Search Name' }).fill('Ada');

	await expect(bar).toContainText('1 selected');
	await expect(bar).toContainText('1 outside filters');

	// The header still governs the matches only: checking it adds Ada, not Grace.
	await headerCheckbox(page).check();
	await expect(bar).toContainText('2 selected');
	await expect(bar).toContainText('1 outside filters');
});

test('Set assessment saves Hostile at once and one Undo restores the batch', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	const bar = page.getByTestId('bulk-bar');
	await checkbox(page, 'Ada Lovelace').check();
	await checkbox(page, 'Grace Hopper').check();

	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Set Assessment' }).click();
	await page.getByRole('menuitem', { name: 'Hostile' }).click();

	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(page.getByText('Saved Assessment for 2 workers')).toBeVisible();
	await expect(cell(page, 'assessment', 'Ada Lovelace')).toHaveText('Hostile');
	await expect(cell(page, 'assessment', 'Grace Hopper')).toHaveText('Hostile');

	await page.getByRole('button', { name: 'Undo' }).click();

	await expect(cell(page, 'assessment', 'Ada Lovelace')).toHaveText('Supporter');
	await expect(cell(page, 'assessment', 'Grace Hopper')).toHaveText('Supporter');
});

test('a Language is added to and removed from the whole selection', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	const bar = page.getByTestId('bulk-bar');
	await checkbox(page, 'Ada Lovelace').check();
	await checkbox(page, 'Grace Hopper').check();

	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Edit Languages' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Vietnamese' }).check();

	await expect(page.getByText('Saved Languages for 2 workers')).toBeVisible();
	// The batch menu closes itself once the save lands: an open menu holds the
	// body's pointer events, which reads as the whole app freezing in place.
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(cell(page, 'languages', 'Ada Lovelace')).toHaveAccessibleName(/Vietnamese/);
	await expect(cell(page, 'languages', 'Grace Hopper')).toHaveAccessibleName(/Vietnamese/);

	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Edit Languages' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Vietnamese' }).uncheck();

	await expect(page.getByText('Saved Languages for 2 workers')).toBeVisible();
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(cell(page, 'languages', 'Ada Lovelace')).not.toHaveAccessibleName(/Vietnamese/);
	await expect(cell(page, 'languages', 'Grace Hopper')).not.toHaveAccessibleName(/Vietnamese/);
});

test('a Category answer is set across the selection and undone', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	const bar = page.getByTestId('bulk-bar');
	await checkbox(page, 'Ada Lovelace').check();
	await checkbox(page, 'Grace Hopper').check();

	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Set Department' }).click();
	await page.getByRole('menuitemradio', { name: 'Middle of House' }).click();

	await expect(page.getByText('Saved Department for 2 workers')).toBeVisible();
	await expect(cell(page, 'department', 'Ada Lovelace')).toHaveText('Middle of House');
	await expect(cell(page, 'department', 'Grace Hopper')).toHaveText('Middle of House');

	await page.getByRole('button', { name: 'Undo' }).click();

	await expect(cell(page, 'department', 'Ada Lovelace')).toHaveText('Front of House');

	// Setting None clears the whole selection, and Undo restores each Worker's own answer.
	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Set Department' }).click();
	await page.getByRole('menuitemradio', { name: 'None', exact: true }).click();
	await expect(cell(page, 'department', 'Ada Lovelace')).toHaveText('No Department');
	await expect(cell(page, 'department', 'Grace Hopper')).toHaveText('No Department');
	await page.getByRole('button', { name: 'Undo' }).click();
	// Grace's own answer was Middle of House; Undo puts each Worker's value back.
	await expect(cell(page, 'department', 'Grace Hopper')).toHaveText('Middle of House');
});

test('a Multi-Select value is added, removed and cleared across the selection, with Undo', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	const bar = page.getByTestId('bulk-bar');
	await checkbox(page, 'Ada Lovelace').check();
	await checkbox(page, 'Grace Hopper').check();

	// Remove one held answer from both; the menu closes once the batch lands.
	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Edit Shifts' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Dinner' }).uncheck();
	await expect(page.getByText('Saved Shifts for 2 workers')).toBeVisible();
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(cell(page, 'shifts', 'Ada Lovelace')).not.toHaveAccessibleName(/Dinner/);
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(cell(page, 'shifts', 'Ada Lovelace')).toHaveAccessibleName(/Dinner/);

	// Clear every value on the selection in one action, then put each Worker's own back.
	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Edit Shifts' }).click();
	await page.getByRole('menuitem', { name: 'Clear for all' }).click();
	await expect(page.getByText('Saved Shifts for 2 workers')).toBeVisible();
	await expect(cell(page, 'shifts', 'Ada Lovelace')).toHaveText('No Shifts');
	await expect(cell(page, 'shifts', 'Grace Hopper')).toHaveText('No Shifts');
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(cell(page, 'shifts', 'Ada Lovelace')).toHaveAccessibleName(/Dinner/);
	await expect(cell(page, 'shifts', 'Ada Lovelace')).toHaveAccessibleName(/Brunch/);
});

test('bulk Delete removes the selection and offers no Undo', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	const bar = page.getByTestId('bulk-bar');
	await checkbox(page, 'Ada Lovelace').check();
	await checkbox(page, 'Grace Hopper').check();

	await bar.getByRole('button', { name: 'Delete' }).click();

	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toHaveAccessibleName('Delete 2 workers?');
	await expect(dialog).toContainText('their recorded Relationships');
	await expect(dialog).toContainText('This cannot be undone');
	await dialog.getByRole('button', { name: 'Delete' }).click();

	await expect(page.getByText('2 workers deleted')).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: 'Ada Lovelace' })).toHaveCount(0);
	await expect(page.getByRole('row').filter({ hasText: 'Grace Hopper' })).toHaveCount(0);

	// The records are gone from the core, and nothing offers to put them back.
	const dataset = (await (await request.get('/api/dataset')).json()) as {
		workers: { name: string }[];
	};
	const names = dataset.workers.map((worker) => worker.name);
	expect(names).not.toContain('Ada Lovelace');
	expect(names).not.toContain('Grace Hopper');

	await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
	// The selection went with the records it held.
	await expect(bar).toHaveCount(0);
});

test('bulk Delete removes the Relationships that pointed at the deleted Workers', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	type DatasetWorker = {
		id: string;
		name: string;
		email: string;
		phone: string;
		assessment: string;
		attributes: Record<string, unknown>;
		agitations: string[];
		languages: string[];
		relationships: string[];
		notes: unknown[];
	};

	const workers = async () => {
		const body = (await (await request.get('/api/dataset')).json()) as {
			workers: DatasetWorker[];
		};
		return body.workers;
	};

	const named = new Map((await workers()).map((worker) => [worker.name, worker]));
	const ada = named.get('Ada Lovelace')!;
	const grace = named.get('Grace Hopper')!;
	const katherine = named.get('Katherine Johnson')!;

	// Ada and Grace point at each other and at a Worker who survives the deletion.
	const relate = async (worker: DatasetWorker, relationships: string[]) => {
		const fields = workerUpdateFrom(worker);
		const put = await request.put(`/api/workers/${worker.id}`, {
			data: { ...fields, relationships }
		});
		expect(put.ok(), await put.text()).toBeTruthy();
	};
	await relate(ada, [grace.id, katherine.id]);
	await relate(grace, [ada.id, katherine.id]);
	await relate(katherine, [ada.id, grace.id]);

	await page.reload();
	await appReady(page);

	await checkbox(page, 'Ada Lovelace').check();
	await checkbox(page, 'Grace Hopper').check();
	await page.getByTestId('bulk-bar').getByRole('button', { name: 'Delete' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByText('2 workers deleted')).toBeVisible();

	const remaining = await workers();
	const names = remaining.map((worker) => worker.name);
	expect(names).not.toContain('Ada Lovelace');
	expect(names).not.toContain('Grace Hopper');
	// The surviving Worker keeps no dangling Relationship to either deleted record.
	expect(remaining.find((worker) => worker.name === 'Katherine Johnson')?.relationships).toEqual(
		[]
	);
});

test('a batch that fails part-way reloads, counts what saved and undoes only that', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	// The second PATCH is refused; everything else reaches the core.
	let patches = 0;
	await page.route('**/api/workers/*', async (route) => {
		if (route.request().method() !== 'PATCH') return route.continue();
		patches += 1;
		if (patches === 2) {
			return route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'Injected failure' })
			});
		}
		return route.continue();
	});

	const bar = page.getByTestId('bulk-bar');
	await checkbox(page, 'Ada Lovelace').check();
	await checkbox(page, 'Grace Hopper').check();

	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Set Assessment' }).click();
	await page.getByRole('menuitem', { name: 'Leader' }).click();

	// The count is explicit and the endpoint's own failure stays visible.
	await expect(page.getByText('Saved Assessment for 1 of 2 workers')).toBeVisible();
	await expect(page.getByRole('alert')).toContainText('Some changes could not be saved.');

	// The Workers table shows what the core holds, not what the batch hoped for.
	await expect(cell(page, 'assessment', 'Ada Lovelace')).toHaveText('Leader');
	await expect(cell(page, 'assessment', 'Grace Hopper')).toHaveText('Supporter');

	const storedAssessment = async (name: string) => {
		const dataset = (await (await request.get('/api/dataset')).json()) as {
			workers: { name: string; assessment: string }[];
		};
		return dataset.workers.find((worker) => worker.name === name)?.assessment;
	};

	expect(await storedAssessment('Ada Lovelace')).toBe('Leader');
	expect(await storedAssessment('Grace Hopper')).toBe('Supporter');

	await page.getByRole('button', { name: 'Undo' }).click();

	// Undo takes back the one update that saved, and only that one: the report
	// becomes a restoration announcement and offers no further recovery.
	await expect(page.getByText('Undone')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
	await expect(cell(page, 'assessment', 'Ada Lovelace')).toHaveText('Supporter');
	expect(await storedAssessment('Ada Lovelace')).toBe('Supporter');
	expect(await storedAssessment('Grace Hopper')).toBe('Supporter');
});

test('the record panel reads Contact, Notes, Relationships and Agitations in the rail and in the narrow sheet', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	await page
		.getByRole('row', { name: /Ada Lovelace/ })
		.getByRole('gridcell', { name: 'Name for Ada Lovelace: Ada Lovelace', exact: true })
		.click();

	const sections = ['Contact', 'Notes', 'Relationships', 'Agitations'];
	const rail = page.getByRole('complementary', { name: 'Worker details: Ada Lovelace' });
	for (const name of sections) {
		await expect(rail.getByRole('heading', { level: 3, name })).toBeVisible();
	}

	await page.setViewportSize({ width: 390, height: 844 });
	// Narrowing leaves the sheet shut; a tap on the row opens it.
	await page.getByRole('button', { name: 'Show details for Ada Lovelace' }).click();
	const sheet = page.getByRole('dialog', { name: 'Worker details: Ada Lovelace' });
	await expect(sheet).toBeVisible();
	for (const name of sections) {
		await expect(sheet.getByRole('heading', { level: 3, name })).toBeVisible();
	}
});

test('the bar folds its actions into one menu below the Shell tier', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	await checkbox(page, 'Ada Lovelace').check();
	const bar = page.getByTestId('bulk-bar');
	await expect(bar).toContainText('1 selected');

	await page.setViewportSize({ width: 390, height: 844 });

	const actions = bar.getByRole('button', { name: 'Actions' });
	await expect(actions).toBeInViewport();
	await expect(bar.getByRole('button', { name: 'Delete' })).toHaveCount(0);
	await actions.click();
	await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
});

/** Three contacts; Ada and Grace speak French, Katherine does not. */
async function seedFrench(request: APIRequestContext) {
	const created = await request.post('/api/languages', { data: { name: 'French' } });
	expect(created.ok(), await created.text()).toBeTruthy();
	const frenchId = (await created.json()).language.id as string;
	await seedContacts(request, ['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson']);
	const workers = await storedWorkers(request);
	for (const name of ['Ada Lovelace', 'Grace Hopper']) {
		const id = workers.find((worker) => worker.name === name)!.id;
		const patched = await request.patch(`/api/workers/${id}`, {
			data: { field: 'languages', value: [frenchId] }
		});
		expect(patched.ok(), await patched.text()).toBeTruthy();
	}
	return frenchId;
}

async function storedWorkers(request: APIRequestContext) {
	const body = (await (await request.get('/api/dataset')).json()) as {
		workers: { id: string; name: string; languages: string[] }[];
	};
	return body.workers;
}

test('a Language some checked workers hold reads (some), and one click gives it to all, with Undo', async ({
	page,
	request
}) => {
	const frenchId = await seedFrench(request);
	await openWorkers(page);
	for (const name of ['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson']) {
		await checkbox(page, name).check();
	}
	const bar = page.getByTestId('bulk-bar');
	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Edit Languages' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'French (some)' }).click();

	await expect(page.getByTestId('status-line')).toContainText('3 workers');
	for (const worker of await storedWorkers(request)) {
		expect(worker.languages, worker.name).toContain(frenchId);
	}

	await page.keyboard.press('Escape');
	await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByTestId('status-line')).toContainText('Undone');
	const after = await storedWorkers(request);
	expect(after.find((worker) => worker.name === 'Katherine Johnson')!.languages).not.toContain(
		frenchId
	);
	expect(after.find((worker) => worker.name === 'Ada Lovelace')!.languages).toContain(frenchId);
	expect(after.find((worker) => worker.name === 'Grace Hopper')!.languages).toContain(frenchId);
});

test('search stays usable while rows are checked, and filtering keeps the checked rows', async ({
	page,
	request
}) => {
	await seedFrench(request);
	await openWorkers(page);
	await checkbox(page, 'Ada Lovelace').check();
	await checkbox(page, 'Grace Hopper').check();
	const search = page.getByRole('searchbox', { name: 'Search Name' });
	await expect(search).toBeVisible();
	await search.fill('Grace');
	await expect(page.getByTestId('bulk-bar')).toContainText('2 selected');
	await expect(page.getByTestId('worker-count')).toHaveText('1 worker');
});

test('bulk menus read Set for one choice and Edit for many', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	await page.getByRole('row').nth(1).getByRole('checkbox').check();
	const bar = page.getByTestId('bulk-bar');
	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'Set Assessment' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Edit Languages' })).toBeVisible();
	await page.keyboard.press('Escape');
	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	// seedWorkers configures Category "Department" and Tag "Shifts".
	await expect(page.getByRole('menuitem', { name: 'Set Department' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Edit Shifts' })).toBeVisible();
});

test('the worker count reads the rows the filters match', async ({ page, request }) => {
	await seedFrench(request);
	await openWorkers(page);
	await expect(page.getByTestId('worker-count')).toHaveText('3 workers');
});

test('the open Worker is current, only checked rows are selected, and checking a row closes the panel', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	const adaRow = page.getByRole('row', { name: /Ada Lovelace/ });
	const graceRow = page.getByRole('row', { name: /Grace Hopper/ });
	await adaRow.getByRole('gridcell', { name: 'Name for Ada Lovelace: Ada Lovelace' }).click();

	const rail = page.getByRole('complementary', { name: 'Worker details: Ada Lovelace' });
	await expect(rail).toBeVisible();
	await expect(adaRow).toHaveAttribute('aria-current', 'true');
	await expect(adaRow).toHaveAttribute('aria-selected', 'false');
	await expect(adaRow).not.toHaveAttribute('data-state', 'selected');

	await checkbox(page, 'Grace Hopper').check();
	await expect(graceRow).toHaveAttribute('aria-selected', 'true');
	await expect(graceRow).toHaveAttribute('data-state', 'selected');
	await expect(graceRow).not.toHaveAttribute('aria-current', 'true');
	// Checking a row closes the card rather than summarising the selection.
	await expect(rail).toBeHidden();
	await expect(page.getByTestId('panel-selection-summary')).toHaveCount(0);

	// A bulk Set Assessment touches the checked worker, not the open one.
	await page.getByTestId('bulk-bar').getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Set Assessment' }).click();
	await page.getByRole('menuitem', { name: 'Leader' }).click();
	await expect(cell(page, 'assessment', 'Grace Hopper')).toHaveText('Leader');
	await expect(cell(page, 'assessment', 'Ada Lovelace')).toHaveText('Supporter');

	await page.getByTestId('bulk-bar').getByRole('button', { name: 'Clear selection' }).click();
	await expect(rail).toBeHidden();
	await expect(adaRow).not.toHaveAttribute('aria-current', 'true');
});

test('shift-click checks a contiguous range and the bar count matches', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	const rows = page.locator('tbody tr[data-worker-id]');
	await rows.nth(1).getByRole('checkbox').check();
	await rows
		.nth(4)
		.getByRole('checkbox')
		.click({ modifiers: ['Shift'] });

	await expect(page.getByTestId('bulk-bar')).toContainText('4 selected');
	for (const i of [1, 2, 3, 4]) await expect(rows.nth(i).getByRole('checkbox')).toBeChecked();
	await expect(rows.nth(0).getByRole('checkbox')).not.toBeChecked();
	await expect(rows.nth(5).getByRole('checkbox')).not.toBeChecked();
});

test('Space checks the focused row', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	const rows = page.locator('tbody tr[data-worker-id]');
	await rows.nth(2).locator('td').nth(1).focus();
	await page.keyboard.press('Space');
	await expect(rows.nth(2).getByRole('checkbox')).toBeChecked();
	await expect(page.getByTestId('bulk-bar')).toContainText('1 selected');
	await page.keyboard.press('Space');
	await expect(rows.nth(2).getByRole('checkbox')).not.toBeChecked();
});

test('the shortcut hint is visible', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	await expect(page.getByTestId('shortcut-hint')).toBeVisible();
	await expect(page.getByTestId('shortcut-hint')).toContainText('space check');
});

test('Esc clears the checked rows from the table', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	const rows = page.locator('tbody tr[data-worker-id]');
	await rows.nth(1).getByRole('checkbox').check();
	await expect(page.getByTestId('bulk-bar')).toContainText('1 selected');
	await rows.nth(1).locator('td').nth(1).focus();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
});

test('record-panel Delete asks with the same solid confirm as bulk Delete', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	const open = async () => {
		const remove = page.getByRole('button', { name: 'Delete worker' });
		// The record stays open after a dismissed confirm, so select only once.
		if (!(await remove.isVisible())) {
			await page
				.getByRole('row', { name: /Grace Hopper/ })
				.getByRole('gridcell', { name: 'Name for Grace Hopper: Grace Hopper', exact: true })
				.click();
		}
		await remove.click();
		const dialog = page.getByRole('alertdialog');
		await expect(dialog).toHaveAccessibleName('Delete Grace Hopper?');
		return dialog;
	};

	// Cancel keeps the Worker.
	let dialog = await open();
	await expect(dialog.getByRole('button', { name: 'Delete Grace Hopper' })).toHaveClass(
		/(^|\s)bg-destructive(\s|$)/
	);
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole('row', { name: /Grace Hopper/ })).toBeVisible();

	// So does Escape.
	dialog = await open();
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole('row', { name: /Grace Hopper/ })).toBeVisible();

	// Confirming deletes and reports.
	dialog = await open();
	await dialog.getByRole('button', { name: 'Delete Grace Hopper' }).click();
	await expect(page.getByRole('row', { name: /Grace Hopper/ })).toHaveCount(0);
});

test('Edit languages offers a search field only once the list is long', async ({
	page,
	request
}) => {
	const frenchId = await seedFrench(request);
	await openWorkers(page);

	const bar = page.getByTestId('bulk-bar');
	await checkbox(page, 'Ada Lovelace').check();
	await checkbox(page, 'Katherine Johnson').check();
	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Edit Languages' }).click();
	await expect(page.getByRole('menuitemcheckbox', { name: /French/ })).toBeVisible();
	await expect(page.getByRole('searchbox', { name: 'Search Languages' })).toHaveCount(0);
	await page.keyboard.press('Escape');

	for (const name of ['Aaa', 'Bbb', 'Ccc', 'Ddd', 'Eee', 'Fff', 'Ggg', 'Hhh', 'Iii']) {
		const created = await request.post('/api/languages', { data: { name: `Lang ${name}` } });
		expect(created.ok(), await created.text()).toBeTruthy();
	}
	await page.reload();
	await appReady(page);
	await checkbox(page, 'Ada Lovelace').check();
	await checkbox(page, 'Katherine Johnson').check();
	await bar.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Edit Languages' }).click();

	const search = page.getByRole('searchbox', { name: 'Search Languages' });
	await expect(search).toBeVisible();
	await search.fill('fren');
	await expect(page.getByRole('menuitemcheckbox', { name: 'Lang Aaa' })).toHaveCount(0);
	// Filtering keeps the shared/mixed state: one of the two holds French.
	const french = page.getByRole('menuitemcheckbox', { name: /French/ });
	await expect(french).toContainText('(some)');
	await expect(french).not.toBeChecked();

	await search.fill('zzz');
	await expect(page.getByText('No languages match')).toBeVisible();
	expect(frenchId).toBeTruthy();
});
