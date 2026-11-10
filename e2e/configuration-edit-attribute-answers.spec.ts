import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { openConfiguration } from './pages.ts';
import { appReady } from './page-ready.ts';
import { waitForMapReady } from './map.ts';
import { answerId, wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';
import {
	answerRow,
	closeAttributeEditor,
	expandAttribute,
	openAttributeEditor
} from './configuration-outline.ts';

/**
 * Editing Attribute answers in place: rename (Category and Tag), cancel, blank, merge
 * (cancel and confirm), Discard, the unsaved-changes warning, and the renamed answer in
 * the Workers table, its filter, Mapping and Overview. Each test runs on a fresh Worksite.
 */

/**
 * Seeds a Category Role (Server, Cook) and a Tag Shifts (Dinner, Breakfast) with two Workers.
 * Attribute ids are unique across Worksites, so each test mints its own.
 */
async function seedAttributes(request: APIRequestContext) {
	const suffix = randomUUID().slice(0, 8);
	const role = `role-${suffix}`;
	const shifts = `shifts-${suffix}`;
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: role, name: 'Role', kind: 'category', options: ['Server', 'Cook'] },
			{ id: shifts, name: 'Shifts', kind: 'tag', options: ['Dinner', 'Breakfast'] }
		])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	const workers: [string, string, string[]][] = [
		['Ada Lovelace', 'Server', ['Dinner']],
		['Grace Hopper', 'Cook', ['Dinner', 'Breakfast']]
	];
	for (const [name, roleText, shiftTexts] of workers) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({ [role]: roleText, [shifts]: shiftTexts }),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}
	return { role, shifts };
}

async function saveAll(page: Page) {
	await clickSaveAll(page);
	await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);
}

/** Starts Save all when a consequence preview (and its confirmation) will follow. */
async function clickSaveAll(page: Page) {
	await page.getByRole('button', { name: 'Save all' }).click();
}

async function workerRow(page: Page, name: string) {
	return page.getByRole('row').filter({ hasText: name });
}

test.describe('Attribute answers', () => {
	test('renames a Category and a Tag answer, keeps Workers, and the new text shows after Save', async ({
		page,
		request
	}) => {
		const { role } = await seedAttributes(request);
		await openConfiguration(page);

		await openAttributeEditor(page, 'Role');
		await page.getByRole('button', { name: 'Edit Server' }).click();
		const category = page.getByRole('textbox', { name: 'Rename Server' });
		await category.fill('Lead server');
		await category.press('Enter');
		await expect(page.getByRole('button', { name: 'Edit Lead server' })).toBeVisible();
		await closeAttributeEditor(page);

		await openAttributeEditor(page, 'Shifts');
		await page.getByRole('button', { name: 'Edit Dinner' }).click();
		const tag = page.getByRole('textbox', { name: 'Rename Dinner' });
		await tag.fill('Supper');
		await tag.press('Enter');
		await closeAttributeEditor(page);
		await saveAll(page);

		await page.goto('/workers');
		await appReady(page);
		await expect((await workerRow(page, 'Ada Lovelace')).getByText('Lead server')).toBeVisible();
		await expect((await workerRow(page, 'Ada Lovelace')).getByText('Supper')).toBeVisible();
		await expect(page.getByText('Server', { exact: true })).toHaveCount(0);

		// The filter keeps working on the renamed answer: its id did not change.
		await page.goto(`/workers?f=${role}:${encodeURIComponent(answerId(role, 'Server'))}`);
		await appReady(page);
		await expect(page.getByRole('row').filter({ hasText: 'Ada Lovelace' })).toBeVisible();
		await expect(page.getByRole('row').filter({ hasText: 'Grace Hopper' })).toHaveCount(0);
	});

	test('a renamed Category answer shows its new text in Mapping and Overview', async ({
		page,
		request
	}) => {
		const { role } = await seedAttributes(request);
		await openConfiguration(page);
		await openAttributeEditor(page, 'Role');
		await page.getByRole('button', { name: 'Edit Server' }).click();
		const category = page.getByRole('textbox', { name: 'Rename Server' });
		await category.fill('Lead server');
		await category.press('Enter');
		await closeAttributeEditor(page);
		await saveAll(page);

		// Mapping draws the group under the new text; the answer id it groups by is unchanged.
		await page.goto(`/mapping?group=${role}`);
		await waitForMapReady(page);
		await expect(page.locator('svg text:text-is("Lead server")')).toBeVisible();
		await expect(page.locator('svg text:text-is("Server")')).toHaveCount(0);

		// Overview breaks the Workers down by the same Category under the new text.
		await page.goto(`/overview?by=${role}`);
		await appReady(page);
		await expect(page.getByText('Lead server').first()).toBeVisible();
		await expect(page.getByText('Server', { exact: true })).toHaveCount(0);
	});

	test('Escape cancels an edit, and a blank edit is rejected inline', async ({ page, request }) => {
		await seedAttributes(request);
		await openConfiguration(page);
		await openAttributeEditor(page, 'Role');

		await page.getByRole('button', { name: 'Edit Cook' }).click();
		const input = page.getByRole('textbox', { name: 'Rename Cook' });
		await input.fill('Abandoned');
		await input.press('Escape');
		await expect(input).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Edit Cook' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);

		await page.getByRole('button', { name: 'Edit Cook' }).click();
		const blank = page.getByRole('textbox', { name: 'Rename Cook' });
		await blank.fill('   ');
		await blank.press('Enter');
		await expect(blank).toBeVisible();
		await expect(page.getByRole('alert')).toContainText('Enter a value.');
	});

	test('a duplicate edit opens the merge dialog; Cancel restores the text', async ({
		page,
		request
	}) => {
		await seedAttributes(request);
		await openConfiguration(page);
		await openAttributeEditor(page, 'Role');

		await page.getByRole('button', { name: 'Edit Server' }).click();
		const input = page.getByRole('textbox', { name: 'Rename Server' });
		await input.fill('cook');
		await input.press('Enter');

		const dialog = page.getByRole('alertdialog');
		await expect(dialog).toContainText('Merge Cook?');
		await expect(dialog).toContainText('cook will be merged into the existing Cook.');
		await dialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Edit Server' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);
	});

	test('Confirm merges a Category into the survivor; Discard undoes it and shows the warning', async ({
		page,
		request
	}) => {
		await seedAttributes(request);
		await openConfiguration(page);
		await openAttributeEditor(page, 'Role');

		await page.getByRole('button', { name: 'Edit Server' }).click();
		const input = page.getByRole('textbox', { name: 'Rename Server' });
		await input.fill('Cook');
		await input.press('Enter');
		await page.getByRole('alertdialog').getByRole('button', { name: 'Merge', exact: true }).click();
		// The merged answer leaves the outline once it is out of the way of the dialog.
		await expect(page.getByRole('textbox', { name: 'Rename Server' })).toHaveCount(0);
		await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
		await closeAttributeEditor(page);

		await page.getByRole('button', { name: 'Discard' }).click();
		// Discard collapses the open rows, so the outline is opened again to read them.
		await expandAttribute(page, 'Role');
		await expect(answerRow(page, 'Server')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);
	});

	test('Confirm on a merged Category moves its holders to the survivor after Save', async ({
		page,
		request
	}) => {
		await seedAttributes(request);
		await openConfiguration(page);
		await openAttributeEditor(page, 'Role');

		await page.getByRole('button', { name: 'Edit Server' }).click();
		const input = page.getByRole('textbox', { name: 'Rename Server' });
		await input.fill('Cook');
		await input.press('Enter');
		await page.getByRole('alertdialog').getByRole('button', { name: 'Merge', exact: true }).click();
		await closeAttributeEditor(page);
		await clickSaveAll(page);

		// A merge preserves answers, so the preview states that rather than warning.
		const preview = page.getByTestId('configuration-preview-dialog');
		await expect(preview).toBeVisible();
		const cookMerge = preview
			.locator('li[data-preview-change]')
			.filter({ hasText: 'Merge Server into Cook' });
		await expect(cookMerge).toBeVisible();
		await expect(preview.getByRole('button', { name: 'Save and discard values' })).toHaveCount(0);
		await preview.getByRole('button', { name: 'Save changes' }).click();
		await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);

		await page.goto('/workers');
		await appReady(page);
		await expect(page.getByText('Server', { exact: true })).toHaveCount(0);
		await expect((await workerRow(page, 'Ada Lovelace')).getByText('Cook')).toBeVisible();
	});

	test('a merged Tag holds the survivor once for a Worker who held both', async ({
		page,
		request
	}) => {
		await seedAttributes(request);
		await openConfiguration(page);
		await openAttributeEditor(page, 'Shifts');

		await page.getByRole('button', { name: 'Edit Dinner' }).click();
		const input = page.getByRole('textbox', { name: 'Rename Dinner' });
		await input.fill('breakfast');
		await input.press('Enter');
		await page.getByRole('alertdialog').getByRole('button', { name: 'Merge', exact: true }).click();
		await closeAttributeEditor(page);
		await clickSaveAll(page);

		const preview = page.getByTestId('configuration-preview-dialog');
		await expect(preview).toBeVisible();
		const breakfastMerge = preview
			.locator('li[data-preview-change]')
			.filter({ hasText: 'Merge Dinner into Breakfast' });
		await expect(breakfastMerge).toBeVisible();
		await preview.getByRole('button', { name: 'Save changes' }).click();
		await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);

		await page.goto('/workers');
		await appReady(page);
		const grace = await workerRow(page, 'Grace Hopper');
		await expect(grace.getByText('Breakfast', { exact: true })).toHaveCount(1);
		await expect(grace.getByText('Dinner', { exact: true })).toHaveCount(0);
	});
});
