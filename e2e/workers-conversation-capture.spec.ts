import { expect, test } from './fixtures.ts';
import type { APIRequestContext, Page } from '@playwright/test';
import { openWorkersTable } from './workers-table-page.ts';
import { addAttributes, addLanguages, addWorkers } from './worksite-builder.ts';

/** Ticket 10: what an organizer records during and after a conversation. */

async function seed(request: APIRequestContext) {
	const [departmentId] = await addAttributes(request, [
		{ name: 'Department', kind: 'category', options: ['Packing'] }
	]);
	const attributes = { [departmentId]: 'Packing' };
	const [english, spanish] = await addLanguages(request, ['English', 'Spanish']);
	const [grace] = await addWorkers(request, [
		{
			name: 'Grace Hopper',
			attributes,
			assessment: 'Supporter',
			email: 'grace@example.test',
			phone: '555-0100'
		}
	]);
	await addWorkers(request, [
		{
			name: 'Ada Lovelace',
			attributes,
			email: 'ada@example.test',
			phone: '555-0101',
			assessment: 'Supporter',
			languages: [english],
			relationships: [grace],
			notes: [
				{ id: 'n1', text: 'Asked about shifts', timestamp: '2024-01-01T09:00:00.000Z' },
				{ id: 'n2', text: 'Met at the door', timestamp: '2024-01-02T09:00:00.000Z' }
			]
		}
	]);
	void spanish;
}

const open = async (page: Page, name: string) => {
	await page
		.getByRole('row', { name: new RegExp(name) })
		.getByRole('gridcell', { name: `Name for ${name}: ${name}`, exact: true })
		.click();
	return page.getByRole('complementary', { name: `Worker details: ${name}` });
};

test('Languages show only the ones spoken; add and remove save from the record', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed });
	const record = await open(page, 'Ada Lovelace');
	const languages = record.locator('section[aria-labelledby="record-languages"]');

	// Only a spoken Language appears; the rest wait in the Add menu.
	await expect(languages.getByText('English', { exact: true })).toBeVisible();
	await expect(languages.getByText('Spanish', { exact: true })).toHaveCount(0);

	// Opening the menu moves nothing: the section keeps its height.
	const before = (await languages.boundingBox())!;
	await languages.getByRole('button', { name: 'Add language' }).click();
	const menu = page.getByRole('menu');
	await expect(menu.getByRole('menuitem', { name: 'English' })).toHaveCount(0);
	expect((await languages.boundingBox())!.height).toBe(before.height);
	await menu.getByRole('menuitem', { name: 'Spanish' }).click();

	await expect(languages.getByText('Spanish', { exact: true })).toBeVisible();
	await expect(page.getByText('Languages saved for Ada Lovelace')).toBeVisible();
	// Everything is spoken now, so there is nothing left to add.
	await expect(languages.getByRole('button', { name: 'Add language' })).toHaveCount(0);

	await languages.getByRole('button', { name: 'Remove language Spanish' }).click();
	await expect(languages.getByText('Spanish', { exact: true })).toHaveCount(0);
	await expect(languages.getByRole('button', { name: 'Add language' })).toBeVisible();
	await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();
	await expect(languages.getByText('Spanish', { exact: true })).toBeVisible();
});

test('contact values copy', async ({ page, request, context, browserName }) => {
	test.skip(
		browserName === 'webkit',
		'WebKit has no clipboard permission to grant (Unknown permission: clipboard-write), so copy-to-clipboard is checked on Chromium only.'
	);
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await openWorkersTable(page, request, { seed });
	const record = await open(page, 'Ada Lovelace');

	await record.getByRole('button', { name: 'Copy address' }).click();
	await expect(page.getByText('Copied Email')).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ada@example.test');
});

test('Relationships show a count and open the Worker on the Mapping', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed });
	const record = await open(page, 'Ada Lovelace');

	await expect(record.getByTestId('relationship-count')).toHaveText('1 linked');
	await record.getByRole('button', { name: 'Show on Mapping' }).click();
	await expect(page).toHaveURL(/\/mapping/);
	expect(new URL(page.url()).search).not.toContain('Ada');
});
