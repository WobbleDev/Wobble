import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { openWorkersTable } from './workers-table-page.ts';

test('editing an Assessment reloads the dataset once', async ({ page, request }) => {
	await openWorkersTable(page, request, { rows: 8 });

	let datasetRequests = 0;
	page.on('request', (sent) => {
		if (new URL(sent.url()).pathname === '/api/dataset') datasetRequests += 1;
	});

	const ada = page.locator('tbody tr[data-worker-id]').filter({ hasText: 'Ada Lovelace' });
	const assessment = ada.locator('td').nth(2);
	await assessment.click();
	await expect(page.getByRole('menu')).toBeVisible();
	await page.getByRole('menuitemradio', { name: 'Leader' }).click();
	await expect(assessment).toHaveText('Leader');
	await expect.poll(() => datasetRequests).toBe(1);
});

test('an inline Attribute edit and a bulk Attribute edit each reload the dataset once', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { rows: 8 });
	const dataset = (await (await request.get('/api/dataset')).json()) as {
		attributes: { id: string; name: string }[];
	};
	const department = dataset.attributes.find((attribute) => attribute.name === 'Department')!.id;

	let datasetRequests = 0;
	page.on('request', (sent) => {
		if (new URL(sent.url()).pathname === '/api/dataset') datasetRequests += 1;
	});

	const ada = page.locator('tbody tr[data-worker-id]').filter({ hasText: 'Ada Lovelace' });
	const cell = ada.locator(`td[data-column-id="${department}"]`);
	await cell.click();
	await page.getByRole('menuitemradio', { name: 'Middle of House' }).click();
	await expect(cell).toContainText('Middle of House');
	await expect.poll(() => datasetRequests).toBe(1);

	// A batch writes one call per Worker, and still reloads the dataset once.
	datasetRequests = 0;
	await page.getByRole('checkbox', { name: 'Select Ada Lovelace' }).check();
	await page.getByRole('checkbox', { name: 'Select Grace Hopper' }).check();
	await page.getByTestId('bulk-bar').getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Set Department' }).click();
	await page.getByRole('menuitemradio', { name: 'Middle of House' }).click();
	await expect(page.getByText('Saved Department for 2 workers')).toBeVisible();
	await expect.poll(() => datasetRequests).toBe(1);
});

test('an edit still saves when the remembered Worksite id is gone from the database', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { rows: 8 });
	// A database swapped under the app, or a Worksite deleted elsewhere, leaves this id behind.
	// Reads fall back to the first Worksite, so the page looks healthy while writes were refused.
	// The fixture names the real Worksite on every request; drop that so the page's own memory is what is sent.
	await page.context().setExtraHTTPHeaders({});
	// The fixture's init script re-stores the real id on every load; this one runs after it.
	await page.addInitScript(() =>
		localStorage.setItem('wobble.active-worksite-id', 'worksite-gone')
	);
	await page.reload();
	await appReady(page);
	// The fallback is the installation's first Worksite, which is whichever Worksite the run made first,
	// so nothing here may depend on what it holds: edit its first Worker whatever that is.
	const rows = page.locator('tbody tr[data-worker-id]');
	await expect(rows.first()).toBeVisible();

	const assessment = rows.first().locator('td').nth(2);
	await assessment.click();
	const other = page.getByRole('menuitemradio', { checked: false }).first();
	const name = (await other.textContent())?.trim() ?? '';
	await other.click();
	await expect(assessment).toHaveText(name);
	await expect(page.getByText(/Could not save/)).toHaveCount(0);
});
