import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
	addAttribute,
	closeAttributeEditor,
	openAttributeEditor,
	workerColumn
} from './configuration-outline.ts';

test('the Configuration tab speaks Attributes', async ({ page }) => {
	await page.goto('/configuration');
	await appReady(page);

	await expect(page.getByRole('heading', { name: 'About each Worker' })).toBeVisible();
	await expect(
		workerColumn(page).getByRole('heading', { name: 'Attributes', exact: true })
	).toBeVisible();
	await expect(workerColumn(page).getByTestId('add-attribute')).toBeVisible();
	await expect(workerColumn(page).getByTestId('add-attribute')).toContainText('Add attribute');
	await expect(page.getByTestId('assignment-column')).toHaveCount(0);
	await expect(page.getByText('About each Work Assignment')).toHaveCount(0);
	await expect(page.getByText('Scope', { exact: true })).toHaveCount(0);
	// The one count column counts Workers, never assignments.
	await expect(workerColumn(page).getByTestId('worker-count-header')).toHaveText('Workers');
	await expect(workerColumn(page).getByText(/assignment/i)).toHaveCount(0);
});

test('agitations can be added with Enter or the Add button and discarded', async ({ page }) => {
	await page.goto('/configuration');
	await appReady(page);

	const input = page.getByRole('textbox', { name: 'Add an agitation' });
	await input.fill('Agitation added with Enter');
	await input.press('Enter');
	await expect(page.getByText('Agitation added with Enter', { exact: true })).toBeVisible();
	await expect(input).toHaveValue('');

	await input.fill('Agitation added with button');
	await page
		.getByRole('button', { name: 'Add', exact: true })
		.and(page.locator(':enabled'))
		.click();
	await expect(page.getByText('Agitation added with button', { exact: true })).toBeVisible();
	await expect(input).toHaveValue('');

	await page.getByRole('button', { name: 'Discard' }).click();
	await expect(page.getByText('Agitation added with Enter', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Agitation added with button', { exact: true })).toHaveCount(0);
});

test('languages can be added with Enter or the Add button and discarded', async ({ page }) => {
	await page.goto('/configuration');
	await appReady(page);

	const input = page.getByRole('textbox', { name: 'Add a language' });
	await input.fill('Language added with Enter');
	await input.press('Enter');
	await expect(page.getByText('Language added with Enter', { exact: true })).toBeVisible();
	await expect(input).toHaveValue('');

	await input.fill('Language added with button');
	await page
		.getByRole('button', { name: 'Add', exact: true })
		.and(page.locator(':enabled'))
		.click();
	await expect(page.getByText('Language added with button', { exact: true })).toBeVisible();
	await expect(input).toHaveValue('');

	await page.getByRole('button', { name: 'Discard' }).click();
	await expect(page.getByText('Language added with Enter', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Language added with button', { exact: true })).toHaveCount(0);
});

test('cancelling attribute deletion closes the dialog without deleting the attribute', async ({
	page
}) => {
	await page.goto('/configuration');
	await appReady(page);
	const departmentEditor = await openAttributeEditor(page, 'Department');
	await departmentEditor.getByRole('button', { name: 'Delete Department' }).click();

	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('heading', { name: 'Delete Department?' })).toBeVisible();

	await dialog.getByRole('button', { name: 'Cancel' }).click();

	await expect(dialog).toHaveCount(0);
	await closeAttributeEditor(page);
	const reopenedEditor = await openAttributeEditor(page, 'Department');
	await expect(reopenedEditor.getByRole('button', { name: 'Delete Department' })).toBeVisible();
	await closeAttributeEditor(page);
	await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);
});

test('partial configuration saves retry only unsaved sections', async ({ page }) => {
	const suffix = Date.now().toString();
	const attributeName = `Saved attribute ${suffix}`;
	const agitationName = `Unsaved agitation ${suffix}`;
	let attributeWrites = 0;
	let agitationWrites = 0;

	await page.route('**/api/attributes', async (route) => {
		if (route.request().method() === 'PUT') {
			attributeWrites += 1;
			await route.fulfill({ status: 200, json: { attributes: [] } });
			return;
		}

		await route.continue();
	});
	await page.route('**/api/agitations', async (route) => {
		if (route.request().method() === 'PUT') {
			agitationWrites += 1;
			await route.fulfill({
				status: 500,
				json: { message: 'Synthetic agitation save failure.' }
			});
			return;
		}

		await route.continue();
	});

	await page.goto('/configuration');
	await appReady(page);
	await addAttribute(page, attributeName);

	const agitationInput = page.getByRole('textbox', { name: 'Add an agitation' });
	await agitationInput.fill(agitationName);
	await agitationInput.press('Enter');

	const waitForAgitationFailure = () =>
		page.waitForResponse(
			(response) =>
				response.url().endsWith('/api/agitations') &&
				response.request().method() === 'PUT' &&
				response.status() === 500
		);

	const firstFailure = waitForAgitationFailure();
	await page.getByRole('button', { name: 'Save all' }).click();
	await firstFailure;
	await expect(
		page.getByText('Could not save these Configuration changes. Your draft is still here.')
	).toBeVisible();
	await expect(page.getByText('Refreshing shared data…')).toHaveCount(0);

	const retryFailure = waitForAgitationFailure();
	await page.getByRole('button', { name: 'Save all' }).click();
	await retryFailure;
	await expect(
		page.getByText('Could not save these Configuration changes. Your draft is still here.')
	).toBeVisible();
	expect(attributeWrites).toBe(1);
	expect(agitationWrites).toBe(2);

	await page.getByRole('button', { name: 'Discard' }).click();
	await expect(
		page.getByRole('button', { name: `Toggle options for ${attributeName}` })
	).toBeVisible();
	await expect(page.getByText(agitationName, { exact: true })).toHaveCount(0);
});

test('attribute edits made while saving remain unsaved', async ({ page }) => {
	const suffix = Date.now().toString();
	const attributeName = `Pending attribute ${suffix}`;
	const editedAttributeName = `Edited attribute ${suffix}`;
	let attributeWrites = 0;
	let signalRequestStarted: () => void = () => {};
	let releaseResponse: () => void = () => {};
	const requestStarted = new Promise<void>((resolve) => {
		signalRequestStarted = resolve;
	});
	const responseGate = new Promise<void>((resolve) => {
		releaseResponse = resolve;
	});

	await page.route('**/api/attributes', async (route) => {
		if (route.request().method() !== 'PUT') {
			await route.continue();
			return;
		}

		attributeWrites += 1;
		if (attributeWrites === 1) {
			signalRequestStarted();
			await responseGate;
		}
		await route.fulfill({ status: 200, json: { attributes: [] } });
	});

	await page.goto('/configuration');
	await appReady(page);
	await addAttribute(page, attributeName);

	const waitForAttributeWrite = () =>
		page.waitForResponse(
			(response) =>
				response.url().endsWith('/api/attributes') &&
				response.request().method() === 'PUT' &&
				response.status() === 200
		);

	const firstWrite = waitForAttributeWrite();
	await page.getByRole('button', { name: 'Save all' }).click();
	await requestStarted;
	const dialog = await openAttributeEditor(page, attributeName);
	await dialog.getByRole('button', { name: `Rename ${attributeName}` }).click();
	const nameInput = dialog.getByRole('textbox', { name: 'Name', exact: true });
	await nameInput.fill(editedAttributeName);
	await nameInput.press('Enter');
	releaseResponse();
	await firstWrite;
	await expect(dialog.getByRole('button', { name: `Rename ${editedAttributeName}` })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save all' })).toBeEnabled();

	const secondWrite = waitForAttributeWrite();
	await page.getByRole('button', { name: 'Save all' }).click();
	await secondWrite;
	await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);
	expect(attributeWrites).toBe(2);
});

test('an Attribute name edits inline, cancels with Escape, and commits on Enter or blur', async ({
	page,
	request
}) => {
	const departmentId = `department-${randomUUID()}`;
	const locationId = `location-${randomUUID()}`;
	const configured = await request.put('/api/attributes', {
		data: [
			{
				id: departmentId,
				name: 'Department',
				kind: 'category',
				options: [
					{ id: `${departmentId}~front`, value: 'Front' },
					{ id: `${departmentId}~packing`, value: 'Packing' },
					{ id: `${departmentId}~shipping`, value: 'Shipping' }
				]
			},
			{
				id: locationId,
				name: 'Location',
				kind: 'category',
				options: [
					{ id: `${locationId}~store`, value: 'Store' },
					{ id: `${locationId}~warehouse`, value: 'Warehouse' },
					{ id: `${locationId}~office`, value: 'Office' }
				]
			}
		]
	});
	expect(configured.ok()).toBeTruthy();
	await page.goto('/configuration');
	await appReady(page);
	const inlineQaDirectory = process.env.DISTILL_QA_DIR;
	if (inlineQaDirectory) {
		await mkdir(inlineQaDirectory, { recursive: true });
		for (const viewport of [
			{ width: 1280, height: 900, label: 'desktop' },
			{ width: 390, height: 844, label: 'phone' }
		]) {
			await page.setViewportSize(viewport);
			await page.goto('/configuration');
			await appReady(page);
			const captureRow = await openAttributeEditor(page, 'Department');
			await openAttributeEditor(page, 'Location');
			await captureRow.getByRole('button', { name: 'Rename Department' }).scrollIntoViewIfNeeded();
			await page.screenshot({
				path: join(inlineQaDirectory, `attribute-distill-${viewport.label}.png`),
				fullPage: false
			});
			if (viewport.label === 'phone') {
				await captureRow.getByRole('button', { name: 'Rename Department' }).click();
				const nameInput = captureRow.getByRole('textbox', { name: 'Name', exact: true });
				const deleteButton = captureRow.getByRole('button', { name: 'Delete Department' });
				const workerCount = captureRow.getByTestId('worker-count').first();
				const [inputBox, deleteBox, countBox] = await Promise.all([
					nameInput.boundingBox(),
					deleteButton.boundingBox(),
					workerCount.boundingBox()
				]);
				expect(inputBox).not.toBeNull();
				expect(deleteBox).not.toBeNull();
				expect(countBox).not.toBeNull();
				const overlaps = (
					left: NonNullable<typeof inputBox>,
					right: NonNullable<typeof deleteBox>
				) =>
					left.x < right.x + right.width &&
					left.x + left.width > right.x &&
					left.y < right.y + right.height &&
					left.y + left.height > right.y;
				expect(overlaps(inputBox!, deleteBox!)).toBe(false);
				expect(overlaps(inputBox!, countBox!)).toBe(false);
				expect(inputBox!.width).toBeGreaterThanOrEqual(96);
				await page.screenshot({
					path: join(inlineQaDirectory, 'attribute-distill-phone-editing.png'),
					fullPage: false
				});
				await nameInput.press('Escape');
			}
		}
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto('/configuration');
		await appReady(page);
	}
	const row = await openAttributeEditor(page, 'Department');
	const id = await row.getAttribute('data-attribute-id');
	expect(id).toBe(departmentId);
	await expect(row.getByRole('textbox', { name: 'Name', exact: true })).toHaveCount(0);
	await expect(
		row.getByRole('button', { name: 'Switch from Single-Select to Multi-Select' })
	).toBeVisible();

	await row.getByRole('button', { name: 'Rename Department' }).click();
	const name = row.getByRole('textbox', { name: 'Name', exact: true });
	await expect(name).toBeFocused();
	await name.fill('Discarded name');
	await name.press('Escape');
	await expect(row.getByRole('button', { name: 'Rename Department' })).toBeVisible();
	await expect(row.getByRole('button', { name: 'Rename Department' })).toBeFocused();
	await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);

	await row.getByRole('button', { name: 'Rename Department' }).click();
	await name.fill('Location');
	await name.press('Enter');
	await expect(name).toHaveAttribute('aria-invalid', 'true');
	await expect(row.getByText('An attribute with this name already exists.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);
	await name.press('Escape');

	await row.getByRole('button', { name: 'Rename Department' }).click();
	await name.fill('Department renamed');
	await name.press('Enter');
	await expect(row.getByRole('button', { name: 'Rename Department renamed' })).toBeVisible();
	await expect(row.getByRole('button', { name: 'Rename Department renamed' })).toBeFocused();

	await row.getByRole('button', { name: 'Rename Department renamed' }).click();
	await name.fill('Department final');
	await name.press('Tab');
	await expect(row.getByRole('button', { name: 'Rename Department final' })).toBeVisible();
	await expect(row).toHaveAttribute('data-attribute-id', id!);

	await page.getByRole('button', { name: 'Save all' }).click();
	await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);
	await page.reload();
	await appReady(page);
	const reloaded = page.locator(`[data-testid="attribute-row"][data-attribute-id="${id}"]`);
	await expect(reloaded.getByRole('button', { name: 'Rename Department final' })).toBeVisible();
});
