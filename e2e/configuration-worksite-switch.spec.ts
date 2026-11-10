import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { addAttribute } from './configuration-outline.ts';

test('configuration drafts survive Stay and a confirmed switch, while clean switches are immediate', async ({
	page
}) => {
	await page.goto('/overview');
	await appReady(page);

	const startingWorksite = await page.evaluate(async () => {
		const response = await fetch('/api/worksite', { method: 'POST' });
		return (await response.json()).worksite;
	});
	const targetWorksite = await page.evaluate(async () => {
		const response = await fetch('/api/worksite', { method: 'POST' });
		return (await response.json()).worksite;
	});
	const cleanTargetWorksite = await page.evaluate(async () => {
		const response = await fetch('/api/worksite', { method: 'POST' });
		return (await response.json()).worksite;
	});
	await page.evaluate(async (id) => {
		await fetch('/api/worksite/active', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id })
		});
	}, startingWorksite.id);

	await page.goto('/configuration');
	await appReady(page);
	await page.getByRole('button', { name: 'Edit worksite name' }).click();
	await page.getByRole('textbox', { name: 'Worksite name' }).fill('Unsaved Worksite name');
	await page.getByRole('textbox', { name: 'Worksite name' }).press('Enter');

	await addAttribute(page, 'Unsaved Attribute');

	await page.getByLabel('Add an agitation').fill('Unsaved Agitation');
	await page
		.getByRole('button', { name: 'Add', exact: true })
		.and(page.locator(':enabled'))
		.click();
	await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

	const selectionRequests: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/worksite/active') {
			selectionRequests.push(request.postData() ?? '');
		}
	});

	await page.getByRole('button', { name: `Active Worksite: ${startingWorksite.name}` }).click();
	await page.getByRole('menuitem', { name: targetWorksite.name, exact: true }).click();

	const discardDialog = page.getByRole('alertdialog');
	await expect(discardDialog).toContainText(targetWorksite.name);
	await expect(discardDialog.getByRole('button', { name: 'Keep editing' })).toBeVisible();
	await expect(
		discardDialog.getByRole('button', { name: 'Discard changes and switch' })
	).toBeVisible();
	await discardDialog.getByRole('button', { name: 'Keep editing' }).click();

	await expect(page).toHaveURL('/configuration');
	await expect(page.getByRole('button', { name: 'Edit worksite name' })).toContainText(
		'Unsaved Worksite name'
	);
	await expect(page.getByText('Unsaved Attribute', { exact: true })).toBeVisible();
	await expect(page.getByText('Unsaved Agitation', { exact: true })).toBeVisible();
	expect(selectionRequests).toEqual([]);

	await page.getByRole('button', { name: `Active Worksite: ${startingWorksite.name}` }).click();
	await page.getByRole('menuitem', { name: targetWorksite.name, exact: true }).click();
	await expect(page.getByRole('alertdialog')).toContainText(targetWorksite.name);

	const confirmedSelection = page.waitForRequest(
		(request) =>
			request.method() === 'PUT' &&
			new URL(request.url()).pathname === '/api/worksite/active' &&
			request.postData()?.includes(targetWorksite.id) === true
	);
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Discard changes and switch' })
		.click();
	await confirmedSelection;
	await expect(page).toHaveURL('/overview');
	await expect(
		page.getByRole('button', { name: `Active Worksite: ${targetWorksite.name}` })
	).toBeVisible();

	await page.getByRole('link', { name: 'Configuration', exact: true }).click();
	const immediateSelection = page.waitForRequest(
		(request) =>
			request.method() === 'PUT' &&
			new URL(request.url()).pathname === '/api/worksite/active' &&
			request.postData()?.includes(cleanTargetWorksite.id) === true
	);
	await page.getByRole('button', { name: `Active Worksite: ${targetWorksite.name}` }).click();
	await page.getByRole('menuitem', { name: cleanTargetWorksite.name, exact: true }).click();
	await immediateSelection;
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(page).toHaveURL('/overview');
	await expect(
		page.getByRole('button', { name: `Active Worksite: ${cleanTargetWorksite.name}` })
	).toBeVisible();

	await page.getByRole('link', { name: 'Configuration', exact: true }).click();
	await page.getByRole('button', { name: 'Edit worksite name' }).click();
	await page.getByRole('textbox', { name: 'Worksite name' }).fill('Unsaved before create');
	await page.getByRole('textbox', { name: 'Worksite name' }).press('Enter');

	let createRequests = 0;
	page.on('request', (request) => {
		if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/worksite') {
			createRequests += 1;
		}
	});
	await page.getByRole('button', { name: `Active Worksite: ${cleanTargetWorksite.name}` }).click();
	await page.getByRole('menuitem', { name: 'New Worksite' }).click();
	const createDialog = page.getByRole('alertdialog');
	await expect(createDialog).toContainText('Creating a new worksite');
	expect(createRequests).toBe(0);
	const createRequest = page.waitForRequest(
		(request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/worksite'
	);
	await createDialog.getByRole('button', { name: 'Discard changes and create' }).click();
	await createRequest;
	await expect(page).toHaveURL(/\/overview\?setup=1$/);
});
