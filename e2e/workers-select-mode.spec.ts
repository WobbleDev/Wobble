import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { answerId } from './answer-wire.ts';
import { createWorker, worksiteDataset } from './api.ts';
import { openWorkersTable } from './workers-table-page.ts';

/**
 * ADR 0043 in the record panel: Department is Single-Select at the top level, and its Front
 * of House group is Multi-Select. The Attribute's editor is a checkbox list, so several
 * sub-values of that group stay checked together, while a branch of a different top-level
 * value replaces them. The fixture is seeded through the API; the record is driven in the UI.
 */

type Dataset = {
	workers: { id: string; name: string; attributes: Record<string, string | string[]> }[];
};

/** Front of House is Multi-Select; Back of House follows the Attribute (Single-Select). */
function departmentAttribute(department: string) {
	const answer = (text: string) => answerId(department, text);
	return {
		id: department,
		name: 'Department',
		kind: 'category',
		options: [
			{ id: answer('Front of House'), value: 'Front of House', mode: 'multi' },
			{ id: answer('Server'), value: 'Server', parentId: answer('Front of House') },
			{ id: answer('Host'), value: 'Host', parentId: answer('Front of House') },
			{ id: answer('Busser'), value: 'Busser', parentId: answer('Front of House') },
			{ id: answer('Back of House'), value: 'Back of House' },
			{ id: answer('Cook'), value: 'Cook', parentId: answer('Back of House') }
		]
	};
}

async function seedDepartment(
	request: APIRequestContext,
	department: string,
	workerName: string
): Promise<void> {
	const configured = await request.put('/api/attributes', {
		data: [departmentAttribute(department)]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	await createWorker(request, { name: workerName, attributes: { [department]: ['Server'] } });
}

const workerRow = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name) });

/** Selects a Worker the way an organizer does: a click on their name cell. */
const selectWorker = (page: Page, name: string) =>
	workerRow(page, name)
		.getByRole('gridcell', { name: `Name for ${name}: ${name}`, exact: true })
		.or(workerRow(page, name).getByRole('cell', { name: `Show details for ${name}`, exact: true }))
		.click();

const inspector = (page: Page, name: string) =>
	page.getByRole('complementary', { name: `Worker details: ${name}` });

/** The record panel's Attributes section, and one Attribute's row and reading inside it. */
const attributeRow = (region: Locator, name: string) =>
	region
		.locator('section[aria-labelledby="record-attributes"]')
		.locator('dl > div')
		.filter({ hasText: name });
const attributeReading = (region: Locator, name: string) =>
	attributeRow(region, name).locator('dd');

async function storedDepartment(
	request: APIRequestContext,
	workerName: string,
	department: string
): Promise<string | string[] | undefined> {
	const view = await worksiteDataset<Dataset>(request);
	return view.workers.find((worker) => worker.name === workerName)?.attributes[department];
}

test('checking several sub-values of a Multi-Select group keeps them all, and a sibling top-level branch leaves only itself', async ({
	page,
	request
}) => {
	const department = randomUUID();
	const ada = 'Ada Select ' + randomUUID().slice(0, 6);
	await openWorkersTable(page, request, {
		seed: (api) => seedDepartment(api, department, ada)
	});
	await selectWorker(page, ada);
	const panel = inspector(page, ada);
	await expect(panel).toBeVisible();
	await expect(attributeReading(panel, 'Department')).toContainText('Server');

	// The editor lists every value as a checkbox. Host and Busser join Server: both stay checked.
	const row = attributeRow(panel, 'Department');
	await row.getByRole('button', { name: 'Edit Department', exact: true }).click();
	await expect(row.getByRole('checkbox', { name: 'Server', exact: true })).toBeChecked();
	await row.getByRole('checkbox', { name: 'Host', exact: true }).check();
	await row.getByRole('checkbox', { name: 'Busser', exact: true }).check();
	await row.getByRole('button', { name: 'Save', exact: true }).click();

	await expect(attributeReading(panel, 'Department')).toContainText('Server, Host, Busser');
	expect(await storedDepartment(request, ada, department)).toEqual([
		answerId(department, 'Server'),
		answerId(department, 'Host'),
		answerId(department, 'Busser')
	]);

	// Cook sits under Back of House, a different top-level branch: the Attribute is single
	// at the top level, so Server, Host and Busser all come off and only Cook remains.
	await row.getByRole('button', { name: 'Edit Department', exact: true }).click();
	await expect(row.getByRole('checkbox', { name: 'Server', exact: true })).toBeChecked();
	await expect(row.getByRole('checkbox', { name: 'Host', exact: true })).toBeChecked();
	await expect(row.getByRole('checkbox', { name: 'Busser', exact: true })).toBeChecked();
	await row.getByRole('checkbox', { name: 'Cook', exact: true }).check();
	await expect(row.getByRole('checkbox', { name: 'Cook', exact: true })).toBeChecked();
	await expect(row.getByRole('checkbox', { name: 'Server', exact: true })).not.toBeChecked();
	await expect(row.getByRole('checkbox', { name: 'Host', exact: true })).not.toBeChecked();
	await expect(row.getByRole('checkbox', { name: 'Busser', exact: true })).not.toBeChecked();
	await row.getByRole('button', { name: 'Save', exact: true }).click();

	await expect(attributeReading(panel, 'Department')).toContainText('Cook');
	await expect(attributeReading(panel, 'Department')).not.toContainText('Server');
	expect(await storedDepartment(request, ada, department)).toEqual([answerId(department, 'Cook')]);
});
