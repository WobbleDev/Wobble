import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.ts';

/**
 * Shared lookups for Configuration's page frame.
 *
 * The page is a Worksite card, one ordered Attributes column and the danger zone. The
 * column carries a stable hook, so a spec means that list rather than "the first thing
 * that matches".
 */

export const workerColumn = (page: Page): Locator => page.getByTestId('worker-column');

export const worksiteCard = (page: Page): Locator => page.getByTestId('worksite-card');

/** The list's add control. */
export function addAttributeTrigger(column: Locator): Locator {
	return column.getByTestId('add-attribute');
}

export function addAttributeForm(column: Locator): Locator {
	return column.getByTestId('add-attribute-form');
}

/** One Attribute's row within its column. */
export function attributeRow(column: Locator, name: string): Locator {
	return column.getByTestId('attribute-row').filter({ hasText: name });
}

/**
 * Adds an Attribute from the one list. Both types are offered in the form; the inline
 * type control on each row can change it later.
 */
export async function addAttribute(
	page: Page,
	name: string,
	options: { type?: 'single' | 'multi' } = {}
): Promise<void> {
	const target = workerColumn(page);
	await addAttributeTrigger(target).click();
	const form = addAttributeForm(target);
	await expect(form).toBeVisible();
	await form.getByLabel('Display name').fill(name);

	if (options.type === 'multi') {
		await form.getByRole('button', { name: /^Attribute type: Single-Select/ }).click();
		await page.getByRole('option', { name: /Multi-Select/ }).click();
	}

	await form.getByRole('button', { name: 'Add attribute', exact: true }).click();
	await expect(form).toHaveCount(0);
	await expect(attributeRow(target, name)).toBeVisible();
}

/** Opens an Attribute's existing detail editor by its name. */
export async function openAttribute(page: Page, name: string): Promise<Locator> {
	const row = page.getByTestId('attribute-row').filter({ hasText: name });
	await row.getByRole('button', { name: `Toggle options for ${name}` }).click();
	return row;
}

/** The Attribute row anywhere on the page, by name. */
export function attributeRowByName(page: Page, name: string): Locator {
	return page.getByTestId('attribute-row').filter({ hasText: name });
}

/** Unfolds an Attribute's answers (idempotent: an already-open Attribute is left open). */
export async function expandAttribute(page: Page, name: string): Promise<void> {
	const toggle = page.getByRole('button', { name: `Toggle options for ${name}` });
	if ((await toggle.getAttribute('aria-expanded')) === 'true') return;
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** Opens an Attribute row and unfolds its answers, without opening Settings. */
export async function openAttributeEditor(page: Page, name: string): Promise<Locator> {
	await expandAttribute(page, name);
	const id = await attributeRowByName(page, name).getAttribute('data-attribute-id');
	// Found by id, so the row stays the same row after the Attribute is renamed in place.
	const row = page.locator(`[data-testid="attribute-row"][data-attribute-id="${id}"]`);
	// The editor listed every answer flat, so unfold the nested ones too.
	const folded = row.locator('[aria-expanded="false"][aria-controls$="-answers"]');
	while ((await folded.count()) > 0) {
		await folded.first().click();
	}
	return row;
}

/** Nothing to close: editing happens on the rows, so no editor dialog may be left open. */
export async function closeAttributeEditor(page: Page): Promise<void> {
	await expect(page.getByTestId('attribute-editor-dialog')).toHaveCount(0);
}

/** One answer's row by its own accessible name, optionally scoped to one Attribute. */
export function answerRow(page: Page, text: string, attributeName?: string): Locator {
	const root = attributeName ? attributeRowByName(page, attributeName) : page;
	return root.getByRole('treeitem', { name: text, exact: true });
}

/** The row's own Workers cell (a treeitem also contains its descendants' cells). */
export function workerCountCell(row: Locator): Locator {
	return row.getByTestId('worker-count').first();
}

/** The Workers figure a row shows, read from its stable hook rather than its text. */
export async function workerCount(row: Locator): Promise<number> {
	const value = await workerCountCell(row).getAttribute('data-count');
	return Number(value ?? '0');
}

/** The visible reading of a count cell, including the dash. */
export function countText(locator: Locator): Locator {
	return locator.locator('[aria-hidden="true"]');
}

/** The Attribute rows' ids in the order the one list shows them. */
export async function attributeIds(page: Page): Promise<string[]> {
	return page
		.getByTestId('attribute-row')
		.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-attribute-id') ?? ''));
}

/** Types a new root value into an open Attribute and presses Enter. */
export async function addValue(page: Page, attributeName: string, value: string): Promise<void> {
	const editor = await openAttributeEditor(page, attributeName);
	const input = editor.getByRole('textbox', { name: `Add an option to ${attributeName}` });
	await input.fill(value);
	await input.press('Enter');
	await expect(input).toHaveValue('');
}

/** Types a new value and places it under an existing path, using the placement controls. */
export async function addValueUnder(
	page: Page,
	attributeName: string,
	value: string,
	parentPath: string
): Promise<void> {
	const editor = await openAttributeEditor(page, attributeName);
	const input = editor.getByRole('textbox', { name: `Add an option to ${attributeName}` });
	await input.fill(value);
	await editor.getByRole('button', { name: `Place new value ${value}`, exact: true }).click();
	await editor.getByRole('button', { name: `Place under ${parentPath}`, exact: true }).click();
	await expect(input).toHaveValue('');
}

/** Moves an existing value (by its full path) under another existing path. */
export async function moveValueUnder(
	page: Page,
	attributeName: string,
	path: string,
	parentPath: string
): Promise<void> {
	const editor = await openAttributeEditor(page, attributeName);
	await editor.getByRole('button', { name: `Place ${path}`, exact: true }).click();
	await editor.getByRole('button', { name: `Place under ${parentPath}`, exact: true }).click();
}

/** Clicks Save all, confirming a harmless preview when the core asks about a moved branch. */
export async function saveAll(page: Page): Promise<void> {
	const save = page.getByRole('button', { name: 'Save all', exact: true });
	await save.click();
	const confirm = page.getByRole('button', { name: 'Save changes', exact: true });
	await expect(async () => {
		if (await confirm.isVisible()) await confirm.click();
		await expect(save).toHaveCount(0);
	}).toPass();
}
