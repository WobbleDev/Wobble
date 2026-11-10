import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { choose } from './select.ts';
import { openConfiguration } from './pages.ts';
import { answerRow, attributeRowByName } from './configuration-outline.ts';

/**
 * Focus and bulk resolution on the outline: Delete lands on the row that took the
 * removed row's place, Escape closes the parent-removal choice and returns to its row,
 * a dialog hands focus back when cancelled, and one choice resolves every holder.
 */

type Ids = {
	location: string;
	downtown: string;
	mainStreet: string;
	harbor: string;
	uptown: string;
	westside: string;
};

function ids(): Ids {
	const location = `location-${randomUUID().slice(0, 8)}`;
	return {
		location,
		downtown: `${location}~downtown`,
		mainStreet: `${location}~main-street`,
		harbor: `${location}~harbor`,
		uptown: `${location}~uptown`,
		westside: `${location}~westside`
	};
}

async function seed(
	request: APIRequestContext,
	settings: Ids,
	harborHolders: number,
	extraAnswers = 0
) {
	const configured = await request.put('/api/attributes', {
		data: [
			{
				id: settings.location,
				name: 'Location',
				kind: 'category',
				options: [
					{ id: settings.downtown, value: 'Downtown' },
					{ id: settings.mainStreet, value: 'Main Street', parentId: settings.downtown },
					{ id: settings.uptown, value: 'Uptown' },
					{ id: settings.westside, value: 'Westside' },
					{ id: settings.harbor, value: 'Harbor' },
					...Array.from({ length: extraAnswers }, (_, index) => ({
						id: `${settings.location}~overflow-${index + 1}`,
						value: `Overflow answer ${index + 1}`
					}))
				]
			}
		]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	for (let index = 0; index < harborHolders; index += 1) {
		const created = await request.post('/api/workers', {
			data: {
				name: `Harbor Holder ${index} ${randomUUID().slice(0, 4)}`,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: { [settings.location]: settings.harbor },
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}
}

async function unfoldLocation(page: Page) {
	const location = attributeRowByName(page, 'Location');
	await location.focus();
	await page.keyboard.press('ArrowRight');
	await expect(location).toHaveAttribute('aria-expanded', 'true');
}

const saveAll = (page: Page) => page.getByRole('button', { name: 'Save all', exact: true });
const previewDialog = (page: Page) => page.getByTestId('configuration-preview-dialog');

test('Escape closes the parent-removal choice and returns to the parent row', async ({
	page,
	request
}) => {
	await seed(request, ids(), 0);
	await openConfiguration(page);
	await page.evaluate(() => document.fonts.ready);
	await unfoldLocation(page);

	const downtown = answerRow(page, 'Downtown');
	await downtown.focus();
	await page.keyboard.press('Delete');

	const choice = page.getByTestId('parent-removal-choice');
	await expect(choice).toBeVisible();
	await expect(choice.getByRole('combobox')).toBeFocused();

	await page.keyboard.press('Escape');
	await expect(choice).toHaveCount(0);
	await expect(answerRow(page, 'Downtown')).toBeFocused();
});

test('one choice resolves every holder, and cancelling the preview keeps focus on the page', async ({
	page,
	request
}) => {
	await seed(request, ids(), 3);
	await openConfiguration(page);
	await page.evaluate(() => document.fonts.ready);
	await unfoldLocation(page);

	await answerRow(page, 'Harbor').focus();
	await page.keyboard.press('Delete');
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	const confirm = preview.getByRole('button', { name: /^Save and discard/ });
	await expect(confirm).toBeDisabled();
	await expect(preview.locator('[data-resolution-holder] [role="combobox"]')).toHaveCount(3);
	// Rows read by worker and answer, never by a raw id.
	await expect(preview).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-/);

	await choose(preview.getByTestId('configuration-apply-to-all'), '__none__');
	for (const select of await preview.locator('[data-resolution-holder] [role="combobox"]').all()) {
		await expect(select).toHaveAttribute('data-value', '__none__');
	}
	await expect(confirm).toBeEnabled();

	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
});

test('an attribute card keeps its height when a row opens, pins its headings, and does not rubber-band', async ({
	page,
	request
}) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await seed(request, ids(), 0, 24);
	await openConfiguration(page);
	await page.evaluate(() => document.fonts.ready);

	const card = page.getByTestId('worker-column');
	const before = (await card.boundingBox())!;
	// The cards take most of the window and leave the next row peeking at its foot.
	const agitations = (await page.getByTestId('agitations-card').boundingBox())!;
	expect(agitations.y).toBeLessThan(900);
	expect(before.y + before.height).toBeGreaterThan(600);

	await unfoldLocation(page);
	await answerRow(page, 'Downtown').click();
	const after = (await card.boundingBox())!;
	expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);

	const scrolls = await card.evaluate((element) => {
		element.scrollTop = 300;
		return element.scrollHeight > element.clientHeight;
	});
	expect(scrolls).toBe(true);
	expect(await card.evaluate((element) => getComputedStyle(element).overscrollBehaviorY)).toBe(
		'none'
	);

	// The card's title row and the column labels stay in view.
	const top = (await card.boundingBox())!.y;
	const title = (await card.getByRole('heading', { name: 'About each Worker' }).boundingBox())!;
	expect(title.y - top).toBeLessThan(80);
	const labels = (await card.getByTestId('worker-count-header').boundingBox())!;
	expect(labels.y - top).toBeLessThan(120);
});

for (const viewport of [
	{ width: 1280, height: 900 },
	{ width: 390, height: 844 }
]) {
	test(`an open attribute keeps editing and deletion on its row at ${viewport.width}px`, async ({
		page,
		request
	}) => {
		await page.setViewportSize(viewport);
		await seed(request, ids(), 0);
		await openConfiguration(page);
		await page.evaluate(() => document.fonts.ready);
		await unfoldLocation(page);

		const location = attributeRowByName(page, 'Location');
		const tools = page.getByTestId('attribute-tools');
		await expect(page.getByRole('button', { name: 'Rename Location' })).toBeVisible();
		await expect(tools.getByLabel('Name', { exact: true })).toHaveCount(0);
		await expect(tools.getByRole('textbox', { name: /^Add an option/ })).toBeVisible();
		await expect(tools.getByTestId('attribute-parent')).toHaveCount(0);
		await expect(tools.getByTestId('attribute-move-disclosure')).toHaveCount(0);
		await expect(tools.getByRole('button', { name: /^Scope:/ })).toHaveCount(0);
		await expect(tools.getByTestId('attribute-settings')).toHaveCount(0);
		await expect(location.getByRole('button', { name: 'Delete Location' })).toBeVisible();
		await expect(location.getByRole('button', { name: /^Reorder Location/ })).toBeVisible();
		await expect(tools.getByTestId('attribute-parent')).toHaveCount(0);
		await expect(tools.getByTestId('attribute-move-disclosure')).toHaveCount(0);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
		).toBe(true);
	});
}
