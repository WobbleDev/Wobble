import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';

test('the navigation rail creates and switches Worksites without carrying prior URL state', async ({
	page,
	activeWorksite
}) => {
	await page.goto('/workers?worksiteState=previous');
	await appReady(page);
	await expect(page.getByRole('link', { name: 'Configuration' })).toBeVisible();

	const createFirst = page.waitForResponse(
		(response) => response.url().endsWith('/api/worksite') && response.request().method() === 'POST'
	);
	await page.getByRole('button', { name: `Active Worksite: ${activeWorksite.name}` }).click();
	await page.getByRole('menuitem', { name: 'New Worksite' }).click();

	await expect(page).toHaveURL(/\/overview\?setup=1$/);
	const firstWorksiteResponse = await createFirst;
	const firstWorksite = (await firstWorksiteResponse.json()).worksite;
	await expect(
		page.getByRole('button', { name: `Active Worksite: ${firstWorksite.name}` })
	).toBeVisible();
	await page
		.getByRole('dialog', { name: 'Set up your worksite' })
		.getByRole('button', { name: 'Skip setup' })
		.click();

	const createSecond = page.waitForResponse(
		(response) => response.url().endsWith('/api/worksite') && response.request().method() === 'POST'
	);
	await page.getByRole('button', { name: `Active Worksite: ${firstWorksite.name}` }).click();
	await page.getByRole('menuitem', { name: 'New Worksite' }).click();

	await expect(page).toHaveURL(/\/overview\?setup=1$/);
	const secondWorksiteResponse = await createSecond;
	const secondWorksite = (await secondWorksiteResponse.json()).worksite;
	await expect(
		page.getByRole('button', { name: `Active Worksite: ${secondWorksite.name}` })
	).toBeVisible();

	await page.getByRole('button', { name: `Active Worksite: ${secondWorksite.name}` }).click();
	await expect(
		page.getByRole('menuitem', { name: activeWorksite.name, exact: true })
	).toBeVisible();
	await expect(page.getByRole('menuitem', { name: firstWorksite.name, exact: true })).toBeVisible();
	await expect(
		page.getByRole('menuitem', { name: secondWorksite.name, exact: true })
	).toBeVisible();
	await page.goto('/workers?worksiteState=previous');
	await appReady(page);
	await page.getByRole('button', { name: `Active Worksite: ${secondWorksite.name}` }).click();
	await page.getByRole('menuitem', { name: activeWorksite.name, exact: true }).click();

	await expect(page).toHaveURL(/\/overview$/);
	await expect(
		page.getByRole('button', { name: `Active Worksite: ${activeWorksite.name}` })
	).toBeVisible();

	await page.reload();
	await appReady(page);
	await expect(page).toHaveURL(/\/overview$/);
	await expect(
		page.getByRole('button', { name: `Active Worksite: ${activeWorksite.name}` })
	).toBeVisible();
});

/*
 * The same dialog, reached through the switcher instead of the empty shell, and the
 * other way out of it: "Finish setup" saves the name, closes the dialog and drops
 * `?setup=1`, where the "Skip setup" above only closes the dialog. Both name variants run
 * because an empty name skips the PUT, which isolates the dismissal from the save.
 */
for (const variant of [
	{ label: 'a typed name', typed: 'Switched Worksite' },
	{ label: 'an empty name', typed: '' }
] as const) {
	test(`Finish setup with ${variant.label} dismisses the setup dialog from the switcher`, async ({
		page,
		activeWorksite
	}) => {
		await page.goto('/workers');
		await appReady(page);
		await expect(page.getByRole('link', { name: 'Configuration' })).toBeVisible();

		const created = page.waitForResponse(
			(response) =>
				response.url().endsWith('/api/worksite') && response.request().method() === 'POST'
		);
		await page.getByRole('button', { name: `Active Worksite: ${activeWorksite.name}` }).click();
		await page.getByRole('menuitem', { name: 'New Worksite' }).click();

		await expect(page).toHaveURL(/\/overview\?setup=1$/);
		const { worksite } = (await (await created).json()) as {
			worksite: { id: string; name: string };
		};

		const puts: unknown[] = [];
		page.on('request', (sent) => {
			if (sent.url().endsWith('/api/worksite') && sent.method() === 'PUT') {
				puts.push(sent.postDataJSON());
			}
		});

		const setupDialog = page.getByRole('dialog', { name: 'Set up your worksite' });
		await expect(setupDialog).toBeVisible();
		await expect(setupDialog.getByLabel('Worksite name')).toHaveValue(worksite.name);

		await setupDialog.getByLabel('Worksite name').fill(variant.typed);
		await setupDialog.getByRole('button', { name: 'Finish setup' }).click();

		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
		await expect(page).toHaveURL(/\/overview$/);
		expect(new URL(page.url()).searchParams.has('setup')).toBe(false);

		console.log(`Finish setup with ${variant.label} sent PUT bodies:`, JSON.stringify(puts));
		expect(puts).toEqual(variant.typed ? [{ name: variant.typed }] : []);

		// Setup stays closed, and the new name is the Active Worksite's once the page has
		// read it back — nothing invalidates after the PUT, so the rail keeps its old
		// label until the next load.
		const expectedName = variant.typed || worksite.name;
		await page.reload();
		await appReady(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect(new URL(page.url()).searchParams.has('setup')).toBe(false);
		await expect(
			page.getByRole('button', { name: `Active Worksite: ${expectedName}` })
		).toBeVisible();
	});
}
