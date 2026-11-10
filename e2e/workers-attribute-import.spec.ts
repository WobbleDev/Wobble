import { type APIRequestContext, type Page } from '@playwright/test';
import { appReady } from './page-ready.ts';
import { expect, test, testId } from './fixtures.ts';

type Dataset = {
	workers: { id: string; name: string; attributes: Record<string, string | string[]> }[];
};

async function configureTrade(request: APIRequestContext) {
	const id = testId('trade');
	const answers = {
		kitchen: `${id}~Kitchen`,
		cook: `${id}~Cook`,
		spanish: `${id}~Spanish`,
		forklift: `${id}~Forklift`
	};
	const response = await request.put('/api/attributes', {
		data: [
			{
				id,
				name: 'Trade',
				kind: 'tag',
				options: [
					{ id: answers.kitchen, value: 'Kitchen' },
					{ id: answers.cook, value: 'Cook', parentId: answers.kitchen },
					{ id: answers.spanish, value: 'Spanish' },
					{ id: answers.forklift, value: 'Forklift' }
				]
			}
		]
	});
	expect(response.ok(), await response.text()).toBeTruthy();
	return { id, answers };
}

async function openImporter(page: Page) {
	await page.goto('/workers');
	await appReady(page);
	await page.getByRole('button', { name: 'Import contacts' }).click();
	return page.getByRole('dialog', { name: 'Import contacts from CSV' });
}

test('a CSV imports answers for an existing Attribute, and an unknown value waits for a decision', async ({
	page,
	request
}) => {
	const trade = await configureTrade(request);
	const importer = await openImporter(page);
	await importer.getByLabel('CSV file').setInputFiles({
		name: 'trades.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(
			'Name,Trade\n' +
				'Worker 01,Kitchen > Cook; Spanish\n' +
				'Worker 02,Welding; Forklift\n' +
				'Worker 03,Spanish;;Forklift\n' +
				'Worker 04,Forklift\\\n'
		)
	});

	// The column named for the Attribute is mapped; what each cell reads shows beside the row.
	await expect(importer.locator('tr[data-csv-row="2"]')).toContainText('Trade: Cook and Spanish');
	await expect(importer.locator('tr[data-csv-row="4"]')).toContainText(
		'Trade: no answer in entry 2'
	);

	// Two rows carry problems; nothing is decided for the organizer, so the import is held.
	await expect(importer.getByText('2 rows need a decision.')).toBeVisible();
	await expect(importer.locator('tr[data-csv-row="3"]')).toContainText(
		'Trade: Welding, Not a value'
	);
	await expect(importer.locator('tr[data-csv-row="5"]')).toContainText('Ends with a backslash');
	await expect(importer.getByRole('button', { name: /^Import \d/ })).toBeDisabled();

	// Vocabulary is never created: the only choices are leaving the answer out or skipping.
	await importer.getByRole('button', { name: 'Leave out, CSV row 3' }).click();
	await importer.getByRole('button', { name: 'Skip row, CSV row 5' }).click();
	await expect(importer.getByRole('button', { name: 'Import 3 contacts' })).toBeEnabled();

	await importer.getByRole('button', { name: 'Import 3 contacts' }).click();
	await expect(importer.getByRole('status').filter({ hasText: 'Imported' })).toContainText(
		'Imported 3 contacts.'
	);

	const dataset = (await (await request.get('/api/dataset')).json()) as Dataset;
	const byName = Object.fromEntries(dataset.workers.map((worker) => [worker.name, worker]));
	expect(byName['Worker 01']?.attributes[trade.id]).toEqual([
		trade.answers.cook,
		trade.answers.spanish
	]);
	expect(byName['Worker 02']?.attributes[trade.id]).toEqual([trade.answers.forklift]);
	expect(byName['Worker 03']?.attributes[trade.id]).toEqual([
		trade.answers.spanish,
		trade.answers.forklift
	]);
	expect(byName['Worker 04']).toBeUndefined();

	// Still the one Attribute: nothing was added to the vocabulary.
	const after = (await (await request.get('/api/dataset')).json()) as {
		attributes: { id: string }[];
	};
	expect(after.attributes.map((attribute) => attribute.id)).toEqual([trade.id]);
});

test('a possible duplicate lists its reasons and waits for Skip or Create separate, then compares by hand', async ({
	page,
	request
}) => {
	const seeded = await request.post('/api/workers', {
		data: [{ name: 'Ada Lovelace', email: 'ada@example.test', phone: '(555) 010-0142' }]
	});
	expect(seeded.status(), await seeded.text()).toBe(200);
	const importer = await openImporter(page);
	await importer.getByLabel('CSV file').setInputFiles({
		name: 'maybe-duplicates.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(
			'Name,Phone,Email\n' + 'Worker 01,555 010 0142,\n' + 'lovelace ada,,\n' + 'Worker 03,,\n'
		)
	});

	// Reasons, never a score or a ranking.
	await expect(importer.locator('tr[data-csv-row="2"]')).toContainText('Ada Lovelace: same phone');
	await expect(importer.locator('tr[data-csv-row="3"]')).toContainText(
		'Ada Lovelace: similar name'
	);
	await expect(importer.locator('tr[data-csv-row="4"]')).not.toContainText('Ada Lovelace');
	await expect(importer.getByText('2 rows need a decision.')).toBeVisible();
	await expect(importer.getByRole('button', { name: /^Import \d/ })).toBeDisabled();

	await importer.getByRole('button', { name: 'Create separate, CSV row 2' }).click();
	await importer.getByRole('button', { name: 'Skip row, CSV row 3' }).click();
	await importer.getByRole('button', { name: 'Import 2 contacts' }).click();

	const completed = importer.getByRole('status').filter({ hasText: 'Imported' });
	await expect(completed).toContainText('Imported 2 contacts.');
	await expect(completed).toContainText('1 imported row may duplicate a Worker already there.');

	// Nothing merged: the new Worker and the existing one are both there.
	const dataset = (await (await request.get('/api/dataset')).json()) as Dataset;
	expect(dataset.workers.map((worker) => worker.name).sort()).toEqual([
		'Ada Lovelace',
		'Worker 01',
		'Worker 03'
	]);

	// The comparison opens the new Worker, then the existing one, for a manual merge.
	await importer.getByRole('button', { name: 'Compare with existing' }).click();
	const panel = page.getByTestId('record-panel');
	await expect(panel.getByRole('heading', { name: 'Worker 01' })).toBeVisible();
	await page.getByRole('button', { name: 'Next', exact: true }).click();
	await expect(panel.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible();
});

test('an answer removed between review and commit blocks the import and creates nothing', async ({
	page,
	request
}) => {
	const trade = await configureTrade(request);
	const importer = await openImporter(page);
	await importer.getByLabel('CSV file').setInputFiles({
		name: 'one-trade.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('Name,Trade\nWorker 01,Spanish\n')
	});
	await expect(importer.getByRole('button', { name: 'Import 1 contact' })).toBeEnabled();

	// Same Attribute, one answer fewer: the set of Attributes is unchanged.
	const changed = await request.put('/api/attributes', {
		data: [
			{
				id: trade.id,
				name: 'Trade',
				kind: 'tag',
				options: [
					{ id: trade.answers.kitchen, value: 'Kitchen' },
					{ id: trade.answers.cook, value: 'Cook', parentId: trade.answers.kitchen },
					{ id: trade.answers.forklift, value: 'Forklift' }
				]
			}
		]
	});
	expect(changed.ok(), await changed.text()).toBeTruthy();

	await importer.getByRole('button', { name: 'Import 1 contact' }).click();
	await expect(importer.getByRole('alert')).toContainText('Attributes changed after this review');
	const after = (await (await request.get('/api/dataset')).json()) as Dataset;
	expect(after.workers).toHaveLength(0);

	// Read against what the Worksite holds now, the row asks again; nothing is decided for it.
	await expect(importer.locator('tr[data-csv-row="2"]')).toContainText('Needs a decision');
	await expect(importer.getByRole('button', { name: /^Import \d/ })).toBeDisabled();
});
