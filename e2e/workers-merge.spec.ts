import { expect, test } from './fixtures.ts';
import { openWorkersTable } from './workers-table-page.ts';

const rows = (page: import('@playwright/test').Page) => page.locator('tbody tr[data-worker-id]');

test('Merge is offered for exactly two selected workers and works from the keyboard, then Undo restores both', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 }, rows: 8 });
	const bar = page.getByTestId('bulk-bar');
	const merge = bar.getByRole('button', { name: 'Merge', exact: true });

	await page.getByRole('checkbox', { name: 'Select Ada Lovelace' }).check();
	await expect(merge).toHaveCount(0);
	await page.getByRole('checkbox', { name: 'Select Grace Hopper' }).check();
	await expect(merge).toBeVisible();

	await merge.focus();
	await page.keyboard.press('Enter');
	const dialog = page.getByTestId('merge-dialog');
	await expect(dialog).toBeVisible();
	const confirm = dialog.getByRole('button', { name: 'Merge', exact: true });

	// No surviving Worker is chosen for the person: nothing merges until they pick one.
	await expect(confirm).toBeDisabled();
	const keep = dialog.getByRole('group', { name: 'Keep' });
	await expect(keep.getByRole('radio', { checked: true })).toHaveCount(0);
	await keep.getByRole('radio').first().focus();
	await page.keyboard.press('Space');
	await expect(keep.getByRole('radio').first()).toBeChecked();

	// Every conflict needs its own decision, made with Space on the focused radio.
	await expect(dialog.getByRole('group', { name: 'Name' })).toBeVisible();
	await expect(confirm).toBeDisabled();
	const groups = dialog.getByRole('group');
	const count = await groups.count();
	for (let index = 1; index < count; index += 1) {
		await groups.nth(index).getByRole('radio').last().focus();
		await page.keyboard.press('Space');
	}
	await expect(confirm).toBeEnabled();
	await confirm.focus();
	await page.keyboard.press('Enter');

	await expect(dialog).toHaveCount(0);
	await expect(page.getByText(/^Merged .+ into .+$/)).toBeVisible();
	await expect(rows(page)).toHaveCount(7);

	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(rows(page)).toHaveCount(8);
	await expect(page.getByRole('checkbox', { name: 'Select Ada Lovelace' })).toBeVisible();
	await expect(page.getByRole('checkbox', { name: 'Select Grace Hopper' })).toBeVisible();
});

test('an edit to the merged worker expires Undo and leaves the merge in place', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { viewport: { width: 1440, height: 900 }, rows: 8 });
	await page.getByRole('checkbox', { name: 'Select Ada Lovelace' }).check();
	await page.getByRole('checkbox', { name: 'Select Grace Hopper' }).check();
	await page.getByTestId('bulk-bar').getByRole('button', { name: 'Merge', exact: true }).click();
	const dialog = page.getByTestId('merge-dialog');
	await dialog.getByRole('group', { name: 'Keep' }).getByRole('radio').first().check();
	const groups = dialog.getByRole('group');
	await expect(dialog.getByRole('group', { name: 'Name' })).toBeVisible();
	const count = await groups.count();
	for (let index = 1; index < count; index += 1) {
		await groups.nth(index).getByRole('radio').first().check();
	}
	await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
	await expect(rows(page)).toHaveCount(7);

	const dataset = (await (await request.get('/api/dataset')).json()) as {
		workers: { id: string; name: string }[];
	};
	const survivor = dataset.workers.find((worker) => worker.name === 'Ada Lovelace')!;
	const edited = await request.patch(`/api/workers/${survivor.id}`, {
		data: { field: 'email', value: 'ada@example.org' }
	});
	expect(edited.ok(), await edited.text()).toBeTruthy();

	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByText('Could not undo that change.')).toBeVisible();
	await expect(rows(page)).toHaveCount(7);
});
