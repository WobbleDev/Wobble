import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { openConfiguration } from './pages.ts';
import {
	addAttributeForm,
	answerRow,
	attributeIds,
	attributeRowByName,
	workerColumn,
	workerCountCell
} from './configuration-outline.ts';

/**
 * Ticket 03: the outline is a tree for keyboard and assistive-technology users — one
 * tab stop per column, arrow-key walking, announced levels/expanded state and count
 * names, long names shortened only visually, and the tap floor on coarse pointers.
 */

type Ids = {
	location: string;
	crew: string;
	downtown: string;
	mainStreet: string;
	harbor: string;
	uptown: string;
	longAnswer: string;
	central: string;
};

const longName =
	'A very long answer name that must be shortened visually without hiding its count or its full accessible name, used by the outline keyboard check';

function ids(): Ids {
	const suffix = randomUUID().slice(0, 8);
	const location = `location-${suffix}`;
	const crew = `crew-${suffix}`;
	return {
		location,
		crew,
		downtown: `${location}~downtown`,
		mainStreet: `${location}~main-street`,
		harbor: `${location}~harbor`,
		uptown: `${location}~uptown`,
		longAnswer: `${location}~long`,
		central: `${crew}~central`
	};
}

async function seed(request: APIRequestContext, settings: Ids): Promise<void> {
	const configured = await request.put('/api/attributes', {
		data: [
			{
				id: settings.location,
				name: 'Location',
				kind: 'category',
				options: [
					{ id: settings.downtown, value: 'Downtown' },
					{ id: settings.mainStreet, value: 'Main Street', parentId: settings.downtown },
					{ id: settings.harbor, value: 'Harbor', parentId: settings.downtown },
					{ id: settings.uptown, value: 'Uptown' },
					{ id: settings.longAnswer, value: longName }
				]
			},
			{
				id: settings.crew,
				name: 'Crew',
				kind: 'tag',
				options: [{ id: settings.central, value: 'Central' }]
			}
		]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	const workers: [string, string][] = [
		['Ada Lovelace', settings.downtown],
		['Grace Hopper', settings.mainStreet],
		['Alan Turing', settings.harbor]
	];
	for (const [name, answer] of workers) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: { [settings.location]: answer, [settings.crew]: [] },
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}
}

const workerTree = (page: Page) => page.getByRole('tree', { name: 'About each Worker' });

test('exposes the outline as a tree with levels, expanded state and one tab stop', async ({
	page,
	request
}) => {
	const settings = ids();
	await seed(request, settings);
	await openConfiguration(page);
	await page.evaluate(() => document.fonts.ready);

	const tree = workerTree(page);
	await expect(tree).toBeVisible();

	const location = attributeRowByName(page, 'Location');
	await expect(location).toHaveRole('treeitem');
	await expect(location).toHaveAttribute('aria-level', '1');
	await expect(location).toHaveAttribute('aria-expanded', 'false');
	await expect(location).toHaveAccessibleName('Location, Single-Select');

	// Exactly one row in this tree is the column's tab stop.
	await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);

	await location.focus();
	await expect(location).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(location).toHaveAttribute('aria-expanded', 'true');
	await expect(location).toBeFocused();

	// Right again moves into the first child; the child exposes its deeper level.
	await page.keyboard.press('ArrowRight');
	const downtown = answerRow(page, 'Downtown');
	await expect(downtown).toBeFocused();
	await expect(downtown).toHaveAttribute('aria-level', '2');
	await expect(downtown).toHaveAccessibleName('Downtown');

	// Down reaches the next visible row; Left walks back to the parent.
	await page.keyboard.press('ArrowDown');
	await expect(answerRow(page, 'Uptown')).toBeFocused();
	await page.keyboard.press('ArrowLeft');
	await expect(location).toBeFocused();

	// Left on the opened Attribute folds it and keeps focus on the row.
	await page.keyboard.press('ArrowLeft');
	await expect(location).toHaveAttribute('aria-expanded', 'false');
	await expect(location).toBeFocused();
	await expect(answerRow(page, 'Downtown')).toHaveCount(0);

	// A deeper level: Downtown's children are level 3 and only shown when it is open.
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowRight');
	await expect(answerRow(page, 'Main Street')).toBeVisible();
	await expect(answerRow(page, 'Main Street')).toHaveAttribute('aria-level', '3');

	// The counts say what they count, including the dash.
	await expect(workerCountCell(downtown)).toContainText('3 Workers');
	await expect(workerCountCell(answerRow(page, 'Main Street'))).toContainText('1 Worker');
	await expect(workerCountCell(answerRow(page, 'Harbor'))).toContainText('1 Worker');
	const midtown = answerRow(page, longName);
	await expect(workerCountCell(midtown)).toContainText('No Workers');
	await expect(workerCountCell(midtown)).toContainText('—');

	// The second Attribute is in the same tree, so the list has one roving tab stop.
	await expect(page.getByRole('tree')).toHaveCount(1);
	await expect(answerRow(page, 'Central')).toHaveCount(0);
});

test('creates an Attribute, a root value and a nested value with the keyboard only', async ({
	page
}) => {
	await openConfiguration(page);
	await page.evaluate(() => document.fonts.ready);

	// The add control, form, submit and both value fields are reachable and operable by keyboard.
	await workerColumn(page).getByTestId('add-attribute').focus();
	await page.keyboard.press('Enter');
	const form = addAttributeForm(workerColumn(page));
	await expect(form).toBeVisible();
	await page.keyboard.type('Keyboard Skill');
	await page.keyboard.press('Enter');
	await expect(attributeRowByName(page, 'Keyboard Skill')).toBeVisible();

	// Creating the Attribute leaves focus in its value field, ready for the first root value.
	const editor = attributeRowByName(page, 'Keyboard Skill');
	const option = editor.getByRole('textbox', { name: 'Add an option to Keyboard Skill' });
	await expect(option).toBeFocused();
	await page.keyboard.type('Downtown');
	await page.keyboard.press('Enter');

	// The pending value's placement handle and every valid destination are buttons.
	await option.pressSequentially('Main Street');
	await editor.getByRole('button', { name: 'Place new value Main Street', exact: true }).focus();
	await page.keyboard.press('Enter');
	await editor.getByRole('button', { name: 'Place under Downtown', exact: true }).focus();
	await page.keyboard.press('Enter');

	await expect(answerRow(page, 'Main Street', 'Keyboard Skill')).toHaveAttribute('data-depth', '3');
	await expect(page.getByRole('tree').locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
});

test('reorders an Attribute with Alt+Arrow, announcing the move', async ({ page, request }) => {
	const settings = ids();
	await seed(request, settings);
	await openConfiguration(page);
	await page.evaluate(() => document.fonts.ready);

	const announcement = page.getByTestId('attribute-move-announcement');
	await expect(announcement).toHaveText('');
	expect(await attributeIds(page)).toEqual([settings.location, settings.crew]);

	// Alt+ArrowDown moves the focused row one place and names the move.
	const location = attributeRowByName(page, 'Location');
	await location.focus();
	await page.keyboard.press('Alt+ArrowDown');
	await expect.poll(() => attributeIds(page)).toEqual([settings.crew, settings.location]);
	await expect(location).toBeFocused();
	await expect(announcement).toHaveText('Location moved down.');
});

test('shortens a long answer name visually but keeps the full name and the count', async ({
	page,
	request
}) => {
	const settings = ids();
	await seed(request, settings);
	await page.setViewportSize({ width: 1100, height: 900 });
	await openConfiguration(page);
	await page.evaluate(() => document.fonts.ready);

	await attributeRowByName(page, 'Location').focus();
	await page.keyboard.press('ArrowRight');
	const longRow = answerRow(page, longName);
	await expect(longRow).toBeVisible();
	await expect(longRow).toHaveAccessibleName(longName);

	const nameSpan = longRow.locator(`span[title="${longName}"]`);
	await expect(nameSpan).toHaveAttribute('title', longName);
	const truncated = await nameSpan.evaluate((element) => ({
		clipped: element.scrollWidth > element.clientWidth + 1,
		title: element.getAttribute('title'),
		text: element.textContent?.trim()
	}));
	expect(truncated).toEqual({ clipped: true, title: longName, text: longName });

	// The count gives way to nothing.
	await expect(workerCountCell(longRow)).toBeVisible();
	await expect(workerCountCell(longRow)).toContainText('No Workers');
});

test.describe('coarse pointer', () => {
	test.use({ hasTouch: true });

	test('rows meet the tap size', async ({ page, request }) => {
		const settings = ids();
		await seed(request, settings);
		await openConfiguration(page);
		await page.evaluate(() => document.fonts.ready);

		expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

		const row = attributeRowByName(page, 'Location');
		const box = await row.locator(':scope > div').first().boundingBox();
		expect(box).not.toBeNull();
		expect(box!.height).toBeGreaterThanOrEqual(44);

		await expandForTouch(row);
		const answer = answerRow(page, 'Downtown');
		const answerBox = await answer.locator(':scope > div').first().boundingBox();
		expect(answerBox).not.toBeNull();
		expect(answerBox!.height).toBeGreaterThanOrEqual(44);

		// The reorder controls take the same tap floor as the row's other icon buttons.
		const controlBox = await row.locator('[data-action="reorder"]').boundingBox();
		expect(controlBox).not.toBeNull();
		expect(controlBox!.width).toBeGreaterThanOrEqual(44);
		expect(controlBox!.height).toBeGreaterThanOrEqual(44);
	});
});

async function expandForTouch(row: import('@playwright/test').Locator): Promise<void> {
	await row.focus();
	await row.press('ArrowRight');
}
