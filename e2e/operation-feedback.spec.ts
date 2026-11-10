import { EDIT_STATUS_MS } from '../src/lib/features/workers/edit-status.ts';
import { expect, test } from './fixtures.ts';
import type { APIRequestContext, Page } from '@playwright/test';
import { openWorkersTable } from './workers-table-page.ts';
import { answerId } from './answer-wire.ts';

/**
 * The Workers status line: one footer message per saved change, with Undo while
 * it is visible, replaced by the next change, and gone after about 8 seconds.
 */

function checkbox(page: Page, name: string) {
	return page.getByRole('checkbox', { name: `Select ${name}` });
}

/** The value a Worker's cell shows for one column, read off its editor's label. */
function cell(page: Page, column: string, workerName: string) {
	return page.getByRole('button', { name: `Edit ${column} for ${workerName}` });
}

function statusLine(page: Page) {
	return page.getByTestId('status-line');
}

function undoButton(page: Page) {
	return statusLine(page).getByRole('button', { name: 'Undo' });
}

async function storedAssessment(request: APIRequestContext, name: string) {
	const dataset = (await (await request.get('/api/dataset')).json()) as {
		workers: { name: string; assessment: string }[];
	};
	return dataset.workers.find((worker) => worker.name === name)?.assessment;
}

/** The Department answer one Worker holds, as the answer id the seed gave its text. */
async function storedDepartment(request: APIRequestContext, name: string) {
	const dataset = (await (await request.get('/api/dataset')).json()) as {
		attributes: { id: string; name: string }[];
		workers: { name: string; attributes: Record<string, string | string[]> }[];
	};
	const department = dataset.attributes.find((attribute) => attribute.name === 'Department')!;
	return {
		id: department.id,
		value: dataset.workers.find((worker) => worker.name === name)?.attributes[department.id]
	};
}

async function setAssessmentInCell(page: Page, workerName: string, assessment: string) {
	await cell(page, 'assessment', workerName).click();
	await page.getByRole('menuitemradio', { name: assessment }).click();
}

test(
	'a cell edit reports in the footer and Undo restores the Assessment',
	{ tag: '@smoke' },
	async ({ page, request }) => {
		await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
		await setAssessmentInCell(page, 'Ada Lovelace', 'Leader');

		await expect(statusLine(page)).toContainText("Saved Ada Lovelace's Assessment");
		await expect(statusLine(page).getByRole('status')).toHaveAttribute('aria-live', 'polite');
		await expect(cell(page, 'assessment', 'Ada Lovelace')).toHaveText('Leader');

		await undoButton(page).click();

		await expect(statusLine(page)).toContainText('Undone');
		await expect(undoButton(page)).toHaveCount(0);
		await expect(cell(page, 'assessment', 'Ada Lovelace')).toHaveText('Supporter');

		await page.reload();
		await expect(cell(page, 'assessment', 'Ada Lovelace')).toHaveText('Supporter');
		expect(await storedAssessment(request, 'Ada Lovelace')).toBe('Supporter');
	}
);

test('a tag cell edit closes its menu, leaving the page interactive', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });

	await cell(page, 'shifts', 'Ada Lovelace').click();
	await page.getByRole('menuitemcheckbox', { name: 'Dinner' }).click();

	await expect(statusLine(page)).toContainText("Saved Ada Lovelace's Shifts");
	// The multi menu closes itself once the save lands: an open menu holds the
	// body's pointer events, which reads as the whole app freezing in place.
	await expect(page.getByRole('menu')).toHaveCount(0);
	// The next edit starts without an Escape to dismiss anything left behind.
	await cell(page, 'shifts', 'Grace Hopper').click();
	await expect(page.getByRole('menu')).toHaveCount(1);
});

test('the message goes away after about eight seconds', async ({ page, request }) => {
	await page.clock.install();
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	await setAssessmentInCell(page, 'Ada Lovelace', 'Leader');
	await expect(statusLine(page)).toContainText("Saved Ada Lovelace's Assessment");

	// Deliberate: the message lasts EDIT_STATUS_MS, so Undo is still there before it ends.
	await page.clock.fastForward(EDIT_STATUS_MS - 2000);
	await expect(undoButton(page)).toBeVisible();

	// Past EDIT_STATUS_MS (8100ms of fake time) the message and Undo are gone.
	await page.clock.fastForward(2100);
	await expect(statusLine(page)).not.toContainText('Saved');
	await expect(undoButton(page)).toHaveCount(0);
});

test('a new edit replaces the message and Undo works from the keyboard', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	await setAssessmentInCell(page, 'Ada Lovelace', 'Leader');
	await setAssessmentInCell(page, 'Grace Hopper', 'Activist');

	await expect(statusLine(page)).toContainText("Saved Grace Hopper's Assessment");
	await expect(statusLine(page)).not.toContainText("Saved Ada Lovelace's Assessment");

	await undoButton(page).focus();
	await page.keyboard.press('Enter');
	await expect(cell(page, 'assessment', 'Grace Hopper')).toHaveText('Supporter');
	await expect(cell(page, 'assessment', 'Ada Lovelace')).toHaveText('Leader');
});

test('a failed write keeps the cell value and says so in plain words', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	await page.route('**/api/workers/*', async (route) => {
		if (route.request().method() !== 'PATCH') return route.continue();
		return route.fulfill({
			status: 500,
			contentType: 'application/json',
			body: JSON.stringify({ message: 'Injected failure' })
		});
	});

	await setAssessmentInCell(page, 'Ada Lovelace', 'Leader');

	await expect(statusLine(page)).toContainText('Could not save assessment.');
	await expect(statusLine(page)).not.toContainText('Injected');
	await expect(undoButton(page)).toHaveCount(0);
	await expect(cell(page, 'assessment', 'Ada Lovelace')).toHaveText('Supporter');
	expect(await storedAssessment(request, 'Ada Lovelace')).toBe('Supporter');
});

test('a bulk Attribute edit reports its count and one Undo restores every Worker', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	await checkbox(page, 'Ada Lovelace').check();
	await checkbox(page, 'Grace Hopper').check();
	await page.getByTestId('bulk-bar').getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Set Department' }).click();
	await page.getByRole('menuitemradio', { name: 'Middle of House' }).click();

	await expect(statusLine(page)).toContainText('Saved Department for 2 workers');
	const department = await storedDepartment(request, 'Ada Lovelace');
	expect(department.value).toBe(answerId(department.id, 'Middle of House'));
	await undoButton(page).click();

	// The seed alternates the Department: Ada had Front of House, Grace Middle of House.
	await expect(cell(page, 'department', 'Ada Lovelace')).toHaveText('Front of House');
	await expect(cell(page, 'department', 'Grace Hopper')).toHaveText('Middle of House');
	expect((await storedDepartment(request, 'Ada Lovelace')).value).toBe(
		answerId(department.id, 'Front of House')
	);
	// The Assessment bulk path is unchanged; the Attribute path is the one under test.
	expect(await storedAssessment(request, 'Ada Lovelace')).toBe('Supporter');
});

test('a failed Undo says so and can be tried again', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	await setAssessmentInCell(page, 'Ada Lovelace', 'Leader');
	await expect(statusLine(page)).toContainText("Saved Ada Lovelace's Assessment");

	const undoRoute = '**/api/workers/*';
	await page.route(undoRoute, async (route) => {
		if (route.request().method() !== 'PATCH') return route.continue();
		return route.fulfill({
			status: 500,
			contentType: 'application/json',
			body: JSON.stringify({ message: 'Injected undo failure' })
		});
	});
	await undoButton(page).click();

	await expect(statusLine(page).getByRole('alert')).toContainText('Could not undo that change.');
	await expect(cell(page, 'assessment', 'Ada Lovelace')).toHaveText('Leader');

	await page.unroute(undoRoute);
	await statusLine(page).getByRole('button', { name: 'Try undo again' }).click();

	await expect(cell(page, 'assessment', 'Ada Lovelace')).toHaveText('Supporter');
	await expect(statusLine(page)).toContainText('Undone');
});

test('a bulk Delete reports completion with no Undo', async ({ page, request }) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 } });
	await checkbox(page, 'Ada Lovelace').check();
	await page.getByTestId('bulk-bar').getByRole('button', { name: 'Delete' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();

	await expect(statusLine(page)).toContainText('1 worker deleted');
	await expect(undoButton(page)).toHaveCount(0);
});
