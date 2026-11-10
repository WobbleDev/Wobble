import type { APIRequestContext, BrowserContext, Locator, Page } from '@playwright/test';
import { appReady } from './page-ready.ts';
import { expect, test } from './fixtures.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

const deleteWorksiteButton = 'Delete Worksite';

type TestWorksite = { id: string; name: string };

/**
 * DELETE /api/worksite acts on the Active Worksite and re-selects the earliest survivor, so
 * repeated deletes drain the database. A null `worksite` (or a 409) means the list is empty.
 */
async function removeEveryWorksite(request: APIRequestContext): Promise<void> {
	for (let guard = 0; guard < 50; guard += 1) {
		const response = await request.delete('/api/worksite');
		if (response.status() === 409) return;
		expect(response.status()).toBe(200);
		if (((await response.json()) as { worksite: unknown }).worksite === null) return;
	}

	throw new Error('Worksites did not drain.');
}

async function createWorksite(context: BrowserContext): Promise<TestWorksite> {
	const created = await context.request.post('/api/worksite');
	expect(created.status()).toBe(201);

	return ((await created.json()) as { worksite: TestWorksite }).worksite;
}

async function activateWorksite(context: BrowserContext, id: string): Promise<void> {
	const selection = await context.request.put('/api/worksite/active', { data: { id } });
	expect(selection.ok()).toBeTruthy();
}

/** Leaves exactly one Worksite, selected in the browser context, and returns it. */
async function createSoleWorksite(context: BrowserContext): Promise<TestWorksite> {
	await removeEveryWorksite(context.request);
	const worksite = await createWorksite(context);
	await activateWorksite(context, worksite.id);

	return worksite;
}

/** Seeds a Worker with a Note through the supported operations, not raw database writes. */
async function seedWorkerWithNote(context: BrowserContext, name: string): Promise<void> {
	const attributes = await context.request.put('/api/attributes', { data: wireDefinitions([]) });
	expect(attributes.ok()).toBeTruthy();

	const created = await context.request.post('/api/workers', {
		data: {
			name,
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: wireWorkerAttributes({}),
			agitations: [],
			languages: [],
			relationships: [],
			notes: [
				{
					id: `${name}-note`,
					text: 'Kept until the Worksite is deleted.',
					timestamp: new Date().toISOString()
				}
			]
		}
	});
	expect(created.status()).toBe(201);
}

async function openConfirmation(page: Page, worksite: TestWorksite): Promise<Locator> {
	await page.goto('/configuration');
	await appReady(page);
	await expect(page.getByRole('region', { name: 'Danger zone' })).toBeVisible();
	await page.getByRole('button', { name: deleteWorksiteButton }).click();

	const dialog = page.getByRole('alertdialog');
	await expect(dialog.getByRole('heading', { name: `Delete ${worksite.name}?` })).toBeVisible();

	return dialog;
}

test.describe('Worksite deletion', () => {
	// The database is shared across a run, so these destructive cases must not race.
	test.describe.configure({ mode: 'serial' });

	test('exposes accessible names and descriptions for the zone, action, and confirmation', async ({
		page,
		activeWorksite
	}) => {
		await page.goto('/configuration');
		await appReady(page);

		const zone = page.getByRole('region', { name: 'Danger zone' });
		await expect(zone).toBeVisible();
		await expect(zone).toHaveAccessibleDescription(/permanently removes/);

		const deleteAction = zone.getByRole('button', { name: deleteWorksiteButton });
		await expect(deleteAction).toHaveAccessibleDescription(/permanently removes/);

		await deleteAction.click();
		const dialog = page.getByRole('alertdialog');
		await expect(dialog).toHaveAccessibleName(`Delete ${activeWorksite.name}?`);
		await expect(dialog).toHaveAccessibleDescription(/cannot be undone/);
		await expect(dialog).not.toContainText('Unsaved Configuration changes');
	});

	test('warns that unsaved Configuration changes are discarded with the Worksite', async ({
		page,
		activeWorksite
	}) => {
		await page.goto('/configuration');
		await appReady(page);
		await page.getByLabel('Add an agitation').fill('Unsaved agitation');

		await page.getByRole('button', { name: deleteWorksiteButton }).click();
		const dialog = page.getByRole('alertdialog');
		await expect(
			dialog.getByRole('heading', { name: `Delete ${activeWorksite.name}?` })
		).toBeVisible();
		await expect(dialog).toContainText(
			'Unsaved Configuration changes are discarded with this worksite.'
		);
	});

	test('cancelling the confirmation changes nothing', async ({ page, context, activeWorksite }) => {
		await seedWorkerWithNote(context, 'Kept Worker');

		const dialog = await openConfirmation(page, activeWorksite);
		await dialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(dialog).toBeHidden();

		await expect(page).toHaveURL(/\/configuration$/);
		const current = await context.request.get('/api/worksite');
		expect(((await current.json()) as { worksite: TestWorksite }).worksite.id).toBe(
			activeWorksite.id
		);
		await page.goto('/workers');
		// The Name cell holds the desktop span and the below-lg "Show details" button,
		// so the row is the one element that names the Worker exactly once.
		await expect(page.getByRole('row', { name: /Kept Worker/ })).toBeVisible();
	});

	test('names the Worker count and destruction scope, then lands on the survivor', async ({
		page,
		context
	}) => {
		await removeEveryWorksite(context.request);
		const doomed = await createWorksite(context);
		const survivor = await createWorksite(context);
		await activateWorksite(context, doomed.id);
		await seedWorkerWithNote(context, 'Doomed Worker');

		const dialog = await openConfirmation(page, doomed);
		await expect(dialog).toContainText('1 worker');
		await expect(dialog).toContainText('Notes');
		await expect(dialog).toContainText('Relationships');
		await expect(dialog).toContainText('Attributes');
		await expect(dialog).toContainText('Agitations');
		await expect(dialog).toContainText('cannot be undone');

		await dialog.getByRole('button', { name: deleteWorksiteButton }).click();

		await expect(page).toHaveURL(/\/overview$/);
		await expect(
			page.getByRole('button', { name: `Active Worksite: ${survivor.name}` })
		).toBeVisible();

		await page.getByRole('button', { name: `Active Worksite: ${survivor.name}` }).click();
		await expect(page.getByRole('menuitem', { name: doomed.name, exact: true })).toHaveCount(0);
	});

	test('warns it is the only Worksite and returns to the create-a-worksite state', async ({
		page,
		context
	}) => {
		const worksite = await createSoleWorksite(context);

		const dialog = await openConfirmation(page, worksite);
		await expect(dialog.getByText(/This is your only worksite/)).toBeVisible();

		await dialog.getByRole('button', { name: deleteWorksiteButton }).click();

		await expect(page).toHaveURL(/\/overview$/);
		const emptyShell = page.getByRole('heading', { name: 'Create a worksite to get started' });
		await expect(emptyShell).toBeVisible();

		// A Worksite-requiring page must not strand the user.
		await page.goto('/configuration');
		await expect(page).toHaveURL(/\/overview$/);
		await expect(emptyShell).toBeVisible();

		// From the empty shell the user can create and activate a new Worksite.
		await appReady(page);
		await page.getByRole('button', { name: 'New Worksite' }).click();
		await expect(page).toHaveURL(/\/overview\?setup=1$/);
		await page
			.getByRole('dialog', { name: 'Set up your worksite' })
			.getByRole('button', { name: 'Skip setup' })
			.click();
		await expect(page).toHaveURL(/\/overview$/);
		await expect(page.getByRole('button', { name: /^Active Worksite: / })).toBeVisible();
	});

	test('shows progress and disables both actions while the deletion is in flight', async ({
		page,
		context
	}) => {
		const worksite = await createSoleWorksite(context);
		const dialog = await openConfirmation(page, worksite);

		let releaseDelete: () => void = () => {};
		const deleteGate = new Promise<void>((resolve) => {
			releaseDelete = resolve;
		});
		await page.route('**/api/worksite', async (route) => {
			if (route.request().method() !== 'DELETE') {
				await route.continue();
				return;
			}

			await deleteGate;
			await route.continue();
		});

		await dialog.getByRole('button', { name: deleteWorksiteButton }).click();

		await expect(dialog.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
		await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();

		// Dismissal stays blocked while the deletion is in flight.
		await page.keyboard.press('Escape');
		await expect(dialog).toBeVisible();

		releaseDelete();
		await expect(page).toHaveURL(/\/overview$/);
	});

	test('a failed deletion keeps the dialog open, reports inline, and leaves the data intact', async ({
		page,
		context
	}) => {
		const worksite = await createSoleWorksite(context);
		await seedWorkerWithNote(context, 'Intact Worker');

		await page.route('**/api/worksite', async (route) => {
			if (route.request().method() !== 'DELETE') {
				await route.continue();
				return;
			}

			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'Could not delete the worksite.' })
			});
		});

		const dialog = await openConfirmation(page, worksite);
		await dialog.getByRole('button', { name: deleteWorksiteButton }).click();

		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('alert')).toHaveText('Could not delete the worksite.');
		await expect(page).toHaveURL(/\/configuration$/);
		await expect(dialog.getByRole('button', { name: deleteWorksiteButton })).toBeEnabled();
		await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeEnabled();

		// The Worksite and all of its records survive the failed request.
		await page.reload();
		await expect(
			page.getByRole('button', { name: `Active Worksite: ${worksite.name}` })
		).toBeVisible();
		await page.goto('/workers');
		await expect(page.getByRole('row', { name: /Intact Worker/ })).toBeVisible();
	});
});
