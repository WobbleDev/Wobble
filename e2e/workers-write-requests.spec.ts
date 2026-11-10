import { expect, test } from './fixtures.ts';
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
