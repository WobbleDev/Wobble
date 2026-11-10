import { expect, test } from '@playwright/test';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ownedShim } from './owned-shim.ts';

const passphrase = '  exact á fixture passphrase  ';

test('boot supports English and Spanish at narrow widths without clearing an unsubmitted credential', async ({
	page
}) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto('/configuration');
	await expect(page.getByRole('heading', { name: 'Create a passphrase' })).toBeVisible();
	await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
	await page.getByRole('button', { name: 'Español', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Crear una frase de contraseña' })).toBeVisible();
	await expect(page.getByLabel('Frase de contraseña', { exact: true })).toHaveValue(passphrase);
	await expect(page).toHaveURL(/\/configuration$/);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	for (const label of await page.locator('label').all()) {
		expect(await label.evaluate((element) => getComputedStyle(element).textTransform)).toBe('none');
		expect(await label.evaluate((element) => getComputedStyle(element).fontFamily)).toContain(
			'Public Sans'
		);
	}
	for (const button of await page.getByRole('button').all())
		expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await page.screenshot({ path: test.info().outputPath('boot-spanish-375.png') });
	await page.getByRole('button', { name: 'English', exact: true }).click();
	await page.getByLabel('Confirm passphrase', { exact: true }).fill('different');
	await page.getByRole('button', { name: 'Create passphrase', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('do not match');
	await expect(page.getByLabel('Passphrase', { exact: true })).toHaveValue('');
	await expect(page.getByLabel('Confirm passphrase', { exact: true })).toHaveValue('');
	await expect(page.getByRole('navigation')).toHaveCount(0);
});

test('a new process locks existing data and exact credentials restore the same dataset', async ({
	page,
	playwright
}) => {
	const app = await ownedShim(playwright.request);
	const consoleText: string[] = [];
	page.on('console', (message) => consoleText.push(message.text()));
	try {
		await app.start();
		await page.goto(`${app.url}/configuration`);
		expect((await app.request.get('/api/settings')).status()).toBe(423);
		expect((await app.request.post('/api/worksite')).status()).toBe(423);
		await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
		await page.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase);
		await page.getByRole('button', { name: 'Create passphrase', exact: true }).click();
		await expect
			.poll(async () => (await (await app.request.get('/api/boot-status')).json()).state)
			.toBe('open');
		const created = await app.request.post('/api/worksite');
		expect(created.status()).toBe(201);
		const renamed = await app.request.put('/api/worksite', { data: { name: 'Private Worksite' } });
		expect(renamed.status()).toBe(200);
		const before = await (await app.request.get('/api/dataset')).json();
		await app.stop();
		await app.start();
		await page.goto(`${app.url}/configuration`);
		await expect(page.getByRole('heading', { name: 'Unlock Wobble' })).toBeVisible();
		await expect(page).toHaveURL(/\/configuration$/);
		expect((await app.request.get('/api/dataset')).status()).toBe(423);
		await page.getByLabel('Passphrase', { exact: true }).fill(passphrase.trim());
		await page.getByRole('button', { name: 'Unlock', exact: true }).click();
		await expect(page.getByRole('alert')).toContainText('did not unlock');
		await expect(page.getByLabel('Passphrase', { exact: true })).toHaveValue('');
		await expect(page.getByText('Private Worksite', { exact: true })).toHaveCount(0);
		await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
		await page.getByRole('button', { name: 'Unlock', exact: true }).click();
		await expect
			.poll(async () => (await (await app.request.get('/api/boot-status')).json()).state)
			.toBe('open');
		expect(await (await app.request.get('/api/dataset')).json()).toEqual(before);
		await expect(page.getByRole('heading', { name: 'Unlock Wobble' })).toHaveCount(0);
		const storage = await page.evaluate(() =>
			JSON.stringify({
				local: { ...localStorage },
				session: { ...sessionStorage },
				url: location.href
			})
		);
		expect(storage).not.toContain(passphrase);
		expect(consoleText.join('\n')).not.toContain(passphrase);
		expect((await readFile(app.database)).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
	} finally {
		await app.dispose();
	}
});

test('legacy conversion shows verified encrypted paths before loading any dataset', async ({
	page,
	context,
	playwright
}) => {
	const fixture = resolve('contract/fixtures/rust-v12.sqlite');
	const unchanged = await readFile(fixture);
	const app = await ownedShim(playwright.request, fixture);
	let datasetReads = 0;
	page.on('request', (request) => {
		if (new URL(request.url()).pathname === '/api/dataset') datasetReads += 1;
	});
	try {
		await app.start();
		expect(await readFile(app.database)).toEqual(unchanged);
		await page.goto(`${app.url}/overview`);
		await expect(page.getByRole('heading', { name: 'Encrypt existing data' })).toBeVisible();
		expect(datasetReads).toBe(0);
		await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
		await page.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase);
		await page.getByRole('button', { name: 'Encrypt and open', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Existing data encrypted' })).toBeVisible();
		expect(datasetReads).toBe(0);
		await expect(
			page.getByText('Earlier exports and filesystem remnants may remain unencrypted.')
		).toBeVisible();
		const paths = await page.locator('code[data-selectable]').allTextContents();
		expect(paths).toHaveLength(2);
		expect(paths[0]).toBe(await realpath(app.database));
		for (const path of paths)
			expect((await readFile(path)).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.getByRole('button', { name: 'Copy path', exact: true }).first().click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(paths[0]);
		await page.screenshot({ path: test.info().outputPath('converted-receipts.png') });
		await page.getByRole('button', { name: 'Continue', exact: true }).click();
		await expect.poll(() => datasetReads).toBeGreaterThan(0);
		await expect(page.getByRole('heading', { name: 'Existing data encrypted' })).toHaveCount(0);
		expect((await (await app.request.get('/api/dataset')).json()).worksites.length).toBeGreaterThan(
			0
		);
		expect(await readFile(fixture)).toEqual(unchanged);
	} finally {
		await app.dispose();
	}
});
