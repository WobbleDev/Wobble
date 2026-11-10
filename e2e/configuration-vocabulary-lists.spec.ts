import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { createWorkerWithIds, readDataset } from './api.ts';
import { openConfiguration } from './pages.ts';
import {
	addAttribute,
	addValue,
	attributeRowByName,
	openAttributeEditor,
	saveAll
} from './configuration-outline.ts';

// The pointer-grip reorder test is a known load flake on shared CI runners: one retry there.
test.describe.configure({ retries: process.env.CI ? 1 : 0 });

/**
 * Ticket 16: sibling reorder from the grip (Configuration 05) and the folding Agitation and
 * Language lists with distinct-Worker counts (Configuration 08).
 */

const grip = (page: Page, path: string): Locator =>
	page.getByRole('button', { name: 'Place ' + path, exact: true });

async function rootValues(page: Page, attribute: string): Promise<string[]> {
	const row = attributeRowByName(page, attribute);
	return row
		.getByTestId('answer-row')
		.evaluateAll((rows) => rows.map((answer) => answer.getAttribute('aria-label') ?? ''));
}

test('a value reorders among its siblings from the grip: Space picks up, arrows move, Escape cancels, Space drops', async ({
	page
}) => {
	await openConfiguration(page);
	const name = 'Reorder ' + Date.now();
	await addAttribute(page, name);
	for (const value of ['Alpha', 'Beta', 'Gamma']) await addValue(page, name, value);
	await openAttributeEditor(page, name);
	await saveAll(page);
	// The save bar unmounts before the refresh ends, and the grips ignore keys until it has.
	await expect(page.getByTestId('configuration-save-announcement')).toHaveText('Changes saved');
	expect(await rootValues(page, name)).toEqual(['Alpha', 'Beta', 'Gamma']);

	const announcement = page.getByTestId('answer-reorder-announcement');
	const beta = grip(page, 'Beta');
	await beta.focus();
	await page.keyboard.press('Space');
	await expect(announcement).toHaveText('Beta picked up, 2 of 3.');
	await expect(beta).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('ArrowUp');
	await expect(announcement).toHaveText('Beta moved to 1 of 3.');
	expect(await rootValues(page, name)).toEqual(['Beta', 'Alpha', 'Gamma']);
	await expect(beta).toBeFocused();

	// Escape puts the saved order back.
	await page.keyboard.press('Escape');
	await expect(announcement).toHaveText('Reorder of Beta cancelled.');
	expect(await rootValues(page, name)).toEqual(['Alpha', 'Beta', 'Gamma']);
	await expect(page.getByRole('button', { name: 'Save all', exact: true })).toHaveCount(0);

	// Drop keeps the move in the draft; Save and reload keep it; Discard would not.
	await beta.focus();
	await page.keyboard.press('Space');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await expect(announcement).toHaveText('Beta stays at 3 of 3.');
	await page.keyboard.press('Space');
	await expect(announcement).toHaveText('Beta dropped at 3 of 3.');
	expect(await rootValues(page, name)).toEqual(['Alpha', 'Gamma', 'Beta']);
	await saveAll(page);
	await page.reload();
	await openAttributeEditor(page, name);
	expect(await rootValues(page, name)).toEqual(['Alpha', 'Gamma', 'Beta']);
});

test('a value reorders among its siblings by dragging the grip to a row edge; Escape cancels', async ({
	page
}) => {
	await openConfiguration(page);
	const name = 'Drag ' + Date.now();
	await addAttribute(page, name);
	for (const value of ['Alpha', 'Beta', 'Gamma']) await addValue(page, name, value);
	await openAttributeEditor(page, name);
	await saveAll(page);
	await expect(page.getByTestId('configuration-save-announcement')).toHaveText('Changes saved');

	const row = (value: string) =>
		attributeRowByName(page, name).locator(`[data-testid="answer-row"][aria-label="${value}"]`);
	const dragGrip = async (
		value: string,
		to: string,
		fraction: number,
		finish: () => Promise<void>
	) => {
		const from = (await grip(page, value).boundingBox())!;
		const box = (await row(to).locator('[data-reorder-row]').first().boundingBox())!;
		await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2, box.y + box.height * fraction, { steps: 8 });
		await finish();
	};

	// Escape mid-drag leaves the order alone.
	await dragGrip('Gamma', 'Alpha', 0.1, async () => {
		await expect(page.getByTestId('placement-drop-indicator')).toBeVisible();
		await page.keyboard.press('Escape');
		await page.mouse.up();
	});
	expect(await rootValues(page, name)).toEqual(['Alpha', 'Beta', 'Gamma']);
	await expect(page.getByRole('button', { name: 'Save all', exact: true })).toHaveCount(0);

	// Dropping on the top edge of Alpha puts Gamma first; Save and reload keep it.
	await dragGrip('Gamma', 'Alpha', 0.1, async () => {
		await expect(page.getByTestId('placement-drop-indicator')).toBeVisible();
		await page.mouse.up();
	});
	expect(await rootValues(page, name)).toEqual(['Gamma', 'Alpha', 'Beta']);
	await saveAll(page);
	await page.reload();
	await openAttributeEditor(page, name);
	expect(await rootValues(page, name)).toEqual(['Gamma', 'Alpha', 'Beta']);
});

test('Agitation and Language lists fold and count distinct Workers holding them', async ({
	page,
	request
}) => {
	await openConfiguration(page);
	const suffix = String(Date.now());
	const lists = [
		{ section: 'agitations-section', input: 'Add an agitation', kind: 'agitations' as const },
		{ section: 'languages-section', input: 'Add a language', kind: 'languages' as const }
	];
	for (const list of lists) {
		const input = page.getByRole('textbox', { name: list.input });
		for (const value of ['One ' + suffix, 'Two ' + suffix]) {
			await input.fill(value);
			await input.press('Enter');
		}
	}
	await saveAll(page);

	const dataset = await readDataset<{
		agitations: { id: string; text: string }[];
		languages: { id: string; name: string }[];
		attributes: { id: string; kind: string }[];
	}>(request);
	const agitation = (text: string) =>
		dataset.agitations.find((entry) => entry.text === text + ' ' + suffix)!.id;
	const language = (text: string) =>
		dataset.languages.find((entry) => entry.name === text + ' ' + suffix)!.id;
	// A Worker answers every configured Attribute: blank for each.
	const blank = Object.fromEntries(
		dataset.attributes.map((attribute) => [attribute.id, attribute.kind === 'tag' ? [] : ''])
	);
	await createWorkerWithIds(request, {
		attributes: blank,
		name: 'Holder A ' + suffix,
		agitations: [agitation('One'), agitation('Two')],
		languages: [language('One')]
	});
	await createWorkerWithIds(request, {
		attributes: blank,
		name: 'Holder B ' + suffix,
		agitations: [agitation('One')],
		languages: []
	});
	await page.reload();

	const section = page.getByTestId('agitations-section');
	const before = Number(
		await section
			.getByTestId('list-holders')
			.getByTestId('list-worker-count')
			.getAttribute('data-count')
	);
	expect(before).toBeGreaterThanOrEqual(2);
	const chipCount = (scope: Locator, text: string) =>
		scope
			.locator('span.inline-flex', { hasText: text + ' ' + suffix })
			.getByTestId('list-worker-count');
	await expect(chipCount(section, 'One')).toHaveAttribute('data-count', '2');
	await expect(chipCount(section, 'Two')).toHaveAttribute('data-count', '1');
	await expect(chipCount(section, 'Two')).toContainText('1 Worker');
	const languages = page.getByTestId('languages-section');
	await expect(chipCount(languages, 'One')).toHaveAttribute('data-count', '1');
	// A value nobody holds shows a dash and says so.
	await expect(chipCount(languages, 'Two')).toHaveAttribute('data-count', '0');
	await expect(chipCount(languages, 'Two')).toContainText('No Workers');
	await expect(chipCount(languages, 'Two').locator('[aria-hidden="true"]')).toHaveText('—');

	// Folding hides the list but keeps the summary.
	const toggle = section.getByRole('button', { name: 'Toggle Agitations' });
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(section.getByRole('textbox', { name: 'Add an agitation' })).toHaveCount(0);
	await expect(section.getByTestId('list-holders')).toBeVisible();
	await toggle.click();
	await expect(section.getByRole('textbox', { name: 'Add an agitation' })).toBeVisible();

	// A merge in the draft counts the folded value's holders toward the survivor, once each.
	await section.getByRole('button', { name: 'Edit Two ' + suffix, exact: true }).click();
	await section
		.getByRole('textbox')
		.first()
		.fill('One ' + suffix);
	await section.getByRole('textbox').first().press('Enter');
	await page.getByRole('button', { name: /Merge/ }).click();
	await expect(chipCount(section, 'One')).toHaveAttribute('data-count', '2');
});
