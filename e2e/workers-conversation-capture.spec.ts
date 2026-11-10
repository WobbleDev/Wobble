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

test('Languages toggle and save from the record, with the status line reporting', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed });
	const record = await open(page, 'Ada Lovelace');

	const spanish = record.getByRole('button', { name: 'Spanish' });
	await expect(record.getByRole('button', { name: 'English' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(spanish).toHaveAttribute('aria-pressed', 'false');
	await spanish.click();
	await expect(spanish).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByText('Languages saved for Ada Lovelace')).toBeVisible();
});

test('contact values copy', async ({ page, request, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await openWorkersTable(page, request, { seed });
	const record = await open(page, 'Ada Lovelace');

	await record.getByRole('button', { name: 'Copy address' }).click();
	await expect(page.getByText('Copied Email')).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ada@example.test');
});

test('Notes search narrows the record Notes', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed });
	const record = await open(page, 'Ada Lovelace');

	await record.getByRole('searchbox', { name: 'Search notes' }).fill('door');
	await expect(record.getByText('Met at the door')).toBeVisible();
	await expect(record.getByText('Asked about shifts')).toHaveCount(0);
	await record.getByRole('searchbox', { name: 'Search notes' }).fill('nothing');
	await expect(record.getByText('No matching notes')).toBeVisible();
});

test('Relationships show a count and open the Worker on the Mapping', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed });
	const record = await open(page, 'Ada Lovelace');

	await expect(record.getByTestId('relationship-count')).toHaveText('1 linked');
	await record.getByRole('button', { name: 'Show on Mapping' }).click();
	await expect(page).toHaveURL(/\/mapping/);
	expect(new URL(page.url()).search).not.toContain('Ada');
});

test('Add another saves the open Note draft and opens a new Worker', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed });
	const record = await open(page, 'Ada Lovelace');

	await record.getByRole('textbox', { name: 'Note', exact: true }).fill('Follow up Friday');
	await record.getByRole('button', { name: 'Add another' }).click();
	await expect(page.getByRole('complementary', { name: /Unnamed worker/ })).toBeVisible();
	await page.keyboard.press('Escape');

	const again = await open(page, 'Ada Lovelace');
	await expect(again.getByText('Follow up Friday')).toBeVisible();
});
