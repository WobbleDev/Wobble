import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { answerId, wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';
import { createWorker, worksiteDataset } from './api.ts';
import { openConfiguration } from './pages.ts';
import { appReady } from './page-ready.ts';
import {
	addAttributeForm,
	answerRow,
	closeAttributeEditor,
	openAttributeEditor,
	workerColumn
} from './configuration-outline.ts';

/**
 * ADR 0043: every value with sub-values carries its own Single-Select or Multi-Select mode.
 * Configuration shows that mode as a chip on each value that has sub-values, and switching
 * a Multi-Select group to Single-Select while a Worker holds several of its branches goes
 * through the Save preview, which names the Worker and what they keep and lose. The
 * fixture is seeded through the API; the chip, the preview and Save are driven in the UI.
 */

type Dataset = {
	workers: { id: string; name: string; attributes: Record<string, string | string[]> }[];
};

/**
 * Department is Single-Select at the top level. Front of House is Multi-Select, so its
 * branches (Server, Host, Busser) may be held together; Back of House follows the
 * Attribute and is Single-Select over its branch (Cook).
 */
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

async function seedDepartment(request: APIRequestContext, department: string): Promise<void> {
	const configured = await request.put('/api/attributes', {
		data: [departmentAttribute(department)]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
}

/** The select-mode chip on one value's own row inside the Department outline. */
const chipOf = (page: Page, value: string) =>
	answerRow(page, value, 'Department').getByTestId('answer-select-mode');

const previewDialog = (page: Page) => page.getByTestId('configuration-preview-dialog');
const confirmButton = (page: Page) =>
	previewDialog(page).getByRole('button', { name: 'Save and discard values', exact: true });

async function storedDepartment(
	request: APIRequestContext,
	workerName: string,
	department: string
): Promise<string | string[] | undefined> {
	const view = await worksiteDataset<Dataset>(request);
	return view.workers.find((worker) => worker.name === workerName)?.attributes[department];
}

test('only a value with sub-values shows a select-mode chip, and the chip toggles the draft', async ({
	page,
	request
}) => {
	const department = randomUUID();
	await seedDepartment(request, department);
	await openConfiguration(page);
	await openAttributeEditor(page, 'Department');

	// Front of House is Multi-Select; Back of House follows the Attribute and reads Single-Select.
	const front = chipOf(page, 'Front of House');
	await expect(front).toHaveText('Multi-Select');
	await expect(front).toHaveAttribute('aria-pressed', 'true');
	await expect(chipOf(page, 'Back of House')).toHaveText('Single-Select');

	// A leaf value has no sub-values, so its row carries no chip.
	await expect(answerRow(page, 'Server', 'Department')).toBeVisible();
	await expect(chipOf(page, 'Server')).toHaveCount(0);
	await expect(page.getByText('Unsaved changes', { exact: true })).toHaveCount(0);

	// The chip flips the value's own mode in the draft, which is now unsaved.
	await front.click();
	await expect(front).toHaveText('Single-Select');
	await expect(front).toHaveAttribute('aria-pressed', 'false');
	await expect(
		page.getByRole('button', {
			name: 'Switch the sub-values of Front of House from Single-Select to Multi-Select',
			exact: true
		})
	).toBeVisible();
	await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

	await front.click();
	await expect(front).toHaveText('Multi-Select');
});

test('switching Front of House to Single-Select previews the Worker it trims, then keeps only the first branch', async ({
	page,
	request
}) => {
	const department = randomUUID();
	const ada = 'Ada Select ' + randomUUID().slice(0, 6);
	await seedDepartment(request, department);
	await createWorker(request, { name: ada, attributes: { [department]: ['Server', 'Host'] } });
	await openConfiguration(page);
	await openAttributeEditor(page, 'Department');

	await chipOf(page, 'Front of House').click();
	await expect(chipOf(page, 'Front of House')).toHaveText('Single-Select');
	await page.getByRole('button', { name: 'Save all', exact: true }).click();

	// Ada holds two branches of a group that is now Single-Select, so the preview names her
	// and the branch she keeps (first in value order) and loses. The lost value makes the
	// Save destructive, and naming the group is the only choice it asks for.
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(
		preview.getByRole('heading', { name: 'Save changes and discard values?' })
	).toBeVisible();
	const resolutions = preview.getByTestId('configuration-resolutions');
	await expect(
		resolutions.getByRole('heading', { name: 'Review the Department select-mode change' })
	).toBeVisible();
	await expect(
		resolutions.getByText(ada + ' keeps Server and loses Host.', { exact: true })
	).toBeVisible();
	await expect(confirmButton(page)).toBeEnabled();

	await confirmButton(page).click();
	await expect(preview).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Save all', exact: true })).toHaveCount(0);

	// The core writes one id once no Multi-Select group remains, so Ada holds Server alone.
	await expect
		.poll(async () => storedDepartment(request, ada, department))
		.toBe(answerId(department, 'Server'));

	// The mode change persisted: Configuration reads Front of House as Single-Select again.
	await openConfiguration(page);
	await openAttributeEditor(page, 'Department');
	await expect(chipOf(page, 'Front of House')).toHaveText('Single-Select');

	await page.goto('/workers');
	await appReady(page);
	const row = page.getByRole('row', { name: new RegExp(ada) });
	await expect(row.getByText('Server', { exact: true })).toBeVisible();
	await expect(row.getByText('Host', { exact: true })).toHaveCount(0);
});

async function seedCardinalities(request: APIRequestContext) {
	const suffix = randomUUID().slice(0, 8);
	const departmentId = `department-${suffix}`;
	const rolesId = `roles-${suffix}`;

	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: departmentId, name: 'Department', kind: 'category', options: ['Packing', 'Delivery'] },
			{ id: rolesId, name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
		])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	const workers = [
		{ name: 'Alex', department: 'Packing', roles: ['Trainer'] },
		{ name: 'Blair', department: 'Delivery', roles: ['Trainer', 'Steward'] },
		{ name: 'Casey', department: '', roles: [] }
	];
	for (const worker of workers) {
		const created = await request.post('/api/workers', {
			data: {
				name: worker.name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({
					[departmentId]: worker.department,
					[rolesId]: worker.roles
				}),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}

	return { departmentId, rolesId };
}

test('[folded from product-gap-02] Configuration names Single-Select and Multi-Select with cardinality help', async ({
	page,
	request
}) => {
	await seedCardinalities(request);
	await openConfiguration(page);

	// The kind is part of each row's accessible name whether or not the column has room to draw it.
	await expect(page.getByRole('treeitem', { name: /^Department, Single-Select/ })).toBeVisible();
	await expect(page.getByRole('treeitem', { name: /^Roles, Multi-Select/ })).toBeVisible();

	const department = await openAttributeEditor(page, 'Department');
	await expect(
		department.getByRole('button', { name: 'Switch from Single-Select to Multi-Select' })
	).toBeVisible();
	await expect(
		department.getByRole('button', { name: 'Switch from Single-Select to Multi-Select' })
	).toHaveAttribute('title', 'Single-Select: One value, or none');
	await expect(department.getByTestId('attribute-settings')).toHaveCount(0);
	await expect(department.getByRole('button', { name: 'Rename Department' })).toBeVisible();
	await expect(department.getByRole('button', { name: 'Delete Department' })).toBeVisible();
	await closeAttributeEditor(page);

	const roles = await openAttributeEditor(page, 'Roles');
	await expect(
		roles.getByRole('button', { name: 'Switch from Multi-Select to Single-Select' })
	).toBeVisible();
	await expect(
		roles.getByRole('button', { name: 'Switch from Multi-Select to Single-Select' })
	).toHaveAttribute('title', 'Multi-Select: Several values, or none');
	await closeAttributeEditor(page);

	await workerColumn(page).getByTestId('add-attribute').click();
	const addType = page.getByRole('button', {
		name: 'Attribute type: Single-Select. One value, or none'
	});
	await expect(addType).toBeVisible();
	await expect(
		addAttributeForm(workerColumn(page)).getByText('Single-Select takes one value, or none.')
	).toBeVisible();

	await addType.click();
	await expect(page.getByRole('option', { name: /Single-Select/ })).toBeVisible();
	await expect(page.getByRole('option', { name: /Multi-Select/ })).toBeVisible();
	await expect(page.getByRole('option', { name: /One value, or none/ })).toBeVisible();
	await page.getByRole('option', { name: /Multi-Select/ }).click();
	await expect(
		page.getByRole('button', { name: 'Attribute type: Multi-Select. Several values, or none' })
	).toBeVisible();
	await expect(
		addAttributeForm(workerColumn(page)).getByText('Multi-Select takes several values, or none.')
	).toBeVisible();
	await page.getByRole('button', { name: 'Cancel' }).click();
});
