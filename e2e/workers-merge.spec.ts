import { expect, test } from './fixtures.ts';
import { openWorkersTable } from './workers-table-page.ts';

const rows = (page: import('@playwright/test').Page) => page.locator('tbody tr[data-worker-id]');

// The merge Undo snapshot lives on the server, one per database, and a merge replaces it.
// The regular suite runs two workers, so these two tests would clobber each other's snapshot
// and one Undo would answer merge_undo_expired (#105). Run them one at a time.
test.describe.configure({ mode: 'serial' });

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

	// WebKit can press Undo before the status line has settled, so the click lands on
	// nothing and the merge stays. Wait for the control, press it, and let the "Undone"
	// message prove the press registered before counting the restored rows (#105).
	const statusLine = page.getByTestId('status-line');
	const undo = statusLine.getByRole('button', { name: 'Undo', exact: true });
	await expect(statusLine).toHaveAttribute('data-empty', 'false');
	await expect(undo).toBeVisible();
	await expect(undo).toBeEnabled();
	await undo.click();
	await expect(statusLine).toContainText('Undone');
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
