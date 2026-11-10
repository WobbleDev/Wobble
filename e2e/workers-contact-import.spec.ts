import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { appReady } from './page-ready.ts';
import { expect, test } from './fixtures.ts';

// The dialog's phone handling end to end: the preview promises exactly what the core
// stores, and a bad phone never blocks the row.
test('the import dialog cleans, flags and imports phone numbers', async ({ page }) => {
	await page.goto('/workers');
	await appReady(page);
	await page.getByRole('button', { name: 'Import contacts' }).click();

	const importer = page.getByRole('dialog', { name: 'Import contacts from CSV' });
	await expect(importer).toBeVisible();
	await importer.getByLabel('CSV file').setInputFiles({
		name: 'phone-numbers.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(
			'Name,Phone\n' +
				'Ada Lovelace,5550100100\n' +
				'Grace Hopper,555.010.0100\n' +
				'Katherine Johnson,+1 555 010 0100\n' +
				'Dorothy Vaughan,\n' +
				'Mary Jackson,555-0101\n' +
				'Annie Easley,abc\n'
		)
	});

	// Three separators and a country prefix all land on the stored shape.
	await expect(importer.getByText('(555) 010-0100', { exact: true })).toHaveCount(3);

	// An unusable value keeps its own text and says in words why it will not import.
	await expect(importer.getByText('555-0101', { exact: true })).toBeVisible();
	await expect(importer.getByText('Not a 10-digit number', { exact: true })).toHaveCount(2);

	// The row still comes in; only its phone does not.
	await expect(importer.getByText('Ready, phone left blank')).toHaveCount(2);
	await expect(importer.getByText('Ready', { exact: true })).toHaveCount(4);

	// Every row is on the review, row 7 included.
	const summary = importer.getByRole('status');
	await expect(summary).toContainText('2 rows have a phone that is not a 10-digit number');
	await expect(summary).toContainText('CSV rows 6 and 7');
	await expect(importer.getByText('Annie Easley')).toBeVisible();

	// A phone problem never blocks the import, and the completion counts the blanks.
	await importer.getByRole('button', { name: 'Import 6 contacts' }).click();
	const completed = importer.getByRole('status').filter({ hasText: 'Imported' });
	await expect(completed).toContainText('Imported 6 contacts.');
	await expect(completed).toContainText('2 phone numbers were left blank.');

	// What the preview promised is what the Worksite now holds.
	const stored = await page.evaluate(async () => {
		const response = await fetch('/api/dataset');
		const dataset = (await response.json()) as {
			workers: { name: string; phone: string }[];
		};
		return Object.fromEntries(dataset.workers.map((worker) => [worker.name, worker.phone]));
	});
	expect(stored).toEqual({
		'Ada Lovelace': '(555) 010-0100',
		'Grace Hopper': '(555) 010-0100',
		'Katherine Johnson': '(555) 010-0100',
		'Dorothy Vaughan': '',
		'Mary Jackson': '',
		'Annie Easley': ''
	});
});

test('a row without a Name still reads as skipped and never blocks the import', async ({
	page
}) => {
	await page.goto('/workers');
	await appReady(page);
	await page.getByRole('button', { name: 'Import contacts' }).click();

	const importer = page.getByRole('dialog', { name: 'Import contacts from CSV' });
	await importer.getByLabel('CSV file').setInputFiles({
		name: 'missing-name.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('Name,Phone\n,abc\nAda Lovelace,5550100100\n')
	});

	await expect(importer.getByText('Skipped: Name required')).toBeVisible();
	await expect(importer.getByText('Ready', { exact: true })).toBeVisible();
	await expect(importer.getByRole('button', { name: 'Import 1 contact' })).toBeEnabled();

	// The bad phone on the skipped row is still counted: the summary covers every row.
	const phoneSummary = importer
		.getByRole('status')
		.filter({ hasText: 'phone that is not a 10-digit number' });
	await expect(phoneSummary).toContainText('1 row has a phone that is not a 10-digit number');
	await expect(phoneSummary).toContainText('CSV row 2');

	// It never comes in, so it also never counts as a phone left blank by the import.
	await importer.getByRole('button', { name: 'Import 1 contact' }).click();
	const completed = importer.getByRole('status').filter({ hasText: 'Imported' });
	await expect(completed).toContainText('Imported 1 contact.');
	await expect(completed).not.toContainText('left blank');
});

async function openImporter(page: import('@playwright/test').Page) {
	await page.goto('/workers');
	await appReady(page);
	await page.getByRole('button', { name: 'Import contacts' }).click();
	return page.getByRole('dialog', { name: 'Import contacts from CSV' });
}

test('later problems stay inspectable, with source rows, samples and a download without values', async ({
	page
}) => {
	const lines = Array.from({ length: 60 }, (_, index) =>
		index % 10 === 9
			? `,555-01${String(index).padStart(2, '0')}`
			: `Worker ${String(index + 1).padStart(2, '0')},5550100100`
	);
	const importer = await openImporter(page);
	await importer.getByLabel('CSV file').setInputFiles({
		name: 'sixty.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(`Name,Phone\n${lines.join('\n')}\n`)
	});

	// The Worksite and a sample of each mapped column are on the review.
	await expect(importer.getByText(/^Into /)).toBeVisible();
	await expect(importer.getByText('Sample: Worker 01 · Worker 02 · Worker 03')).toBeVisible();

	// All rows pages; a problem past the first page is one click away.
	await expect(importer.getByText('Page 1 of 3')).toBeVisible();
	await importer.getByRole('button', { name: 'Problems only (6)' }).click();
	await expect(importer.locator('tr[data-csv-row]')).toHaveCount(6);
	await expect(importer.locator('tr[data-csv-row="61"]')).toContainText('Skipped: Name required');

	// Skipped and blanked-phone rows read differently from each other.
	await importer.getByRole('button', { name: 'All rows (60)' }).click();
	await importer.getByRole('button', { name: 'Next page' }).click();
	await expect(importer.getByText('Page 2 of 3')).toBeVisible();
	await expect(importer.locator('tr[data-csv-row="31"]')).toContainText('Skipped: Name required');

	// The download names row, column and problem, and carries no cell text.
	const download = page.waitForEvent('download');
	await importer.getByRole('button', { name: 'Download problems' }).click();
	const path = await (await download).path();
	const csv = await readFile(path, 'utf8');
	expect(
		csv.startsWith('Row,Column,Problem\r\n11,Name,Name required\r\n11,Phone,Not a 10-digit number')
	).toBe(true);
	expect(csv).not.toMatch(/Worker|555/);
});

test('the template download is headers only', async ({ page }) => {
	const importer = await openImporter(page);
	const download = page.waitForEvent('download');
	await importer.getByRole('button', { name: 'Download template' }).click();
	expect(await readFile(await (await download).path(), 'utf8')).toBe('Name,Phone,Email\r\n');
});

test('an import opens its created Workers, first row first', async ({ page }) => {
	const importer = await openImporter(page);
	await importer.getByLabel('CSV file').setInputFiles({
		name: 'two.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('Name,Phone\n,abc\nAda Lovelace,\nGrace Hopper,\n')
	});
	await importer.getByRole('button', { name: 'Import 2 contacts' }).click();
	await expect(
		importer.getByRole('status').filter({ hasText: 'Imported 2 contacts.' })
	).toContainText('1 row was skipped.');
	await importer.getByRole('button', { name: 'View imported Workers' }).click();

	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(
		page.getByTestId('record-panel').getByRole('heading', { name: 'Ada Lovelace' })
	).toBeVisible();
	await page.getByRole('button', { name: 'Next', exact: true }).click();
	await expect(
		page.getByTestId('record-panel').getByRole('heading', { name: 'Grace Hopper' })
	).toBeVisible();
});

test('a vocabulary edit between review and commit blocks the import and creates nothing', async ({
	page,
	request
}) => {
	const name = `Worker ${randomUUID().slice(0, 8)}`;
	const importer = await openImporter(page);
	await importer.getByLabel('CSV file').setInputFiles({
		name: 'one.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(`Name,Phone\n${name},5550100100\n`)
	});
	await expect(importer.getByRole('button', { name: 'Import 1 contact' })).toBeEnabled();

	const dataset = (await (await request.get('/api/dataset')).json()) as { attributes: unknown[] };
	const changed = await request.put('/api/attributes', {
		data: [
			...dataset.attributes,
			{
				id: `stale-${randomUUID().slice(0, 8)}`,
				name: 'Added later',
				kind: 'tag',
				options: [{ id: `stale-${randomUUID().slice(0, 8)}~a`, value: 'A' }]
			}
		]
	});
	expect(changed.ok(), await changed.text()).toBeTruthy();

	await importer.getByRole('button', { name: 'Import 1 contact' }).click();
	await expect(importer.getByRole('alert')).toContainText('Attributes changed after this review');
	const after = (await (await request.get('/api/dataset')).json()) as {
		workers: { name: string }[];
	};
	expect(after.workers.filter((worker) => worker.name === name)).toHaveLength(0);

	// The review stays, read against the new vocabulary; importing again commits.
	await importer.getByRole('button', { name: 'Import 1 contact' }).click();
	await expect(importer.getByRole('status').filter({ hasText: 'Imported' })).toContainText(
		'Imported 1 contact.'
	);
});
