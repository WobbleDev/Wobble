import { appReady } from './page-ready.ts';
import { expect, test } from './fixtures.ts';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { openWorkersTable, seedInspectorWorkers } from './workers-table-page.ts';
import { workerUpdateFrom } from './api.ts';
import { answerId } from './answer-wire.ts';
import { openWorkers } from './pages.ts';
import { waitForMapReady } from './map.ts';
import { addAgitations, addAttributes, addLanguages, addWorkers } from './worksite-builder.ts';

/**
 * The desktop record panel (ticket 01 of workers-record-panel).
 *
 * Desktop shows the table and a permanent record panel side by side: an
 * `aside` named `Worker details` when empty, `Worker details: <name>` when a
 * row is selected. Selection is one Worker, chosen by clicking the row, and is
 * separate from the bulk-edit checkboxes. Below the desktop
 * breakpoint the same record opens in a sheet instead; the two never mount together.
 */

/** The row's details toggle, which exists below the desktop breakpoint only. */
const toggle = (page: Page, name: string) =>
	page.getByRole('button', { name: `Show details for ${name}` });

/** The row for one Worker. */
const workerRow = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name) });

/** The Name cell: at the Shell tier the grid cell, not the row, takes focus. */
const nameCell = (page: Page, name: string) => workerRow(page, name).locator('td').nth(1);

/** Selects a Worker the way an organizer does: a click on their name cell. */
const selectWorker = (page: Page, name: string) =>
	// Below the desktop rail the name cell holds the "Show details" button.
	workerRow(page, name)
		.getByRole('gridcell', { name: `Name for ${name}: ${name}`, exact: true })
		// The grid role is off below the desktop rail, leaving plain cells.
		.or(workerRow(page, name).getByRole('cell', { name: `Show details for ${name}`, exact: true }))
		.click();

/** The overlay card, whatever it shows (absent with nothing selected on desktop). */
const panel = (page: Page) => page.getByTestId('record-panel');

/** The panel while it shows one Worker. */
const inspector = (page: Page, name: string) =>
	page.getByRole('complementary', { name: `Worker details: ${name}` });

/** The panel while it shows any Worker (absent when it is empty). */
const anyInspector = (page: Page) => page.getByRole('complementary', { name: /^Worker details: / });

/** The retired inline band: no surface mounts it any more. */
const inlineBands = (page: Page) => page.locator('[data-slot="record-reveal"]');

/** The record body's term for one field, by its label. */
const term = (region: Locator, label: string) => region.locator('dt').filter({ hasText: label });

/** The Notes section's own list, which is where a Note's order is read. */
const noteItems = (region: Locator) =>
	region.locator('section[aria-labelledby="record-notes"] ul li');

/** The ordinary Attributes section, and one Attribute's row and reading inside it. */
const attributesSection = (region: Locator, id = 'record-attributes') =>
	region.locator(`section[aria-labelledby="${id}"]`);
const attributeRow = (region: Locator, name: string, id = 'record-attributes') =>
	attributesSection(region, id).locator('dl > div').filter({ hasText: name });
const attributeReading = (region: Locator, name: string) =>
	attributeRow(region, name).locator('dd');

test('the panel is absent until a row is selected, then opens as a card', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });

	await expect(panel(page)).toHaveCount(0);
	await expect(anyInspector(page)).toHaveCount(0);
	// No details chevron on desktop: selection replaces expansion.
	await expect(toggle(page, 'Ada Lovelace')).toBeHidden();
	await expect(inlineBands(page)).toHaveCount(0);

	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	await expect(ada).toBeVisible();
	await expect(ada.locator('h2')).toHaveText('Ada Lovelace');
	await expect(ada).toHaveAttribute('id', /^worker-.*-details$/);

	await selectWorker(page, 'Grace Hopper');
	await expect(inspector(page, 'Grace Hopper')).toBeVisible();
	await expect(anyInspector(page)).toHaveCount(1);
	await expect(inlineBands(page)).toHaveCount(0);
});

test('the card reaches the foot of the navigation rail at any window height', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();

	for (const height of [900, 700]) {
		await page.setViewportSize({ width: 1440, height });
		// The card's fly-in settles before its box is read.
		await expect
			.poll(async () => {
				const card = await page.getByTestId('record-card').boundingBox();
				const rail = await page.locator('[data-sidebar="sidebar"]').boundingBox();
				return Math.round(card!.y + card!.height - (rail!.y + rail!.height));
			})
			.toBe(0);
	}
});

test('with nothing selected the table is as wide as its frame', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await expect(panel(page)).toHaveCount(0);
	const viewport = await page.getByTestId('workers-scroll-viewport').boundingBox();
	const table = await page.getByRole('grid').first().boundingBox();
	expect(viewport && table).toBeTruthy();
	expect(Math.abs(table!.width - viewport!.width)).toBeLessThanOrEqual(1);
});

test('opening the card does not move the header cells or the bulk bar', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	const headers = page.getByRole('columnheader');
	const boxes = async () =>
		Promise.all((await headers.all()).map((header) => header.boundingBox()));
	await page.getByRole('checkbox', { name: /Select Grace Hopper/ }).check();
	const bulk = page.getByTestId('bulk-bar');
	await expect(bulk).toBeVisible();
	const bulkBefore = await bulk.boundingBox();
	const before = await boxes();
	await selectWorker(page, 'Ada Lovelace');
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();
	expect(await boxes()).toEqual(before);
	expect(await bulk.boundingBox()).toEqual(bulkBefore);
});

test('Escape and the Close button each close the card, clear the selection and focus the row', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	for (const how of ['Escape', 'Close'] as const) {
		await selectWorker(page, 'Ada Lovelace');
		await expect(inspector(page, 'Ada Lovelace')).toBeVisible();
		if (how === 'Escape') await nameCell(page, 'Ada Lovelace').press('Escape');
		else await inspector(page, 'Ada Lovelace').getByRole('button', { name: 'Close' }).click();
		await expect(panel(page)).toHaveCount(0);
		await expect(workerRow(page, 'Ada Lovelace')).not.toHaveAttribute('aria-current');
		await expect(nameCell(page, 'Ada Lovelace')).toBeFocused();
	}
});

test.describe('card motion', () => {
	test.use({ reducedMotion: 'reduce' });

	test('with reduced motion the card appears and goes at once, and a row switch keeps its element', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		const card = page.getByTestId('record-card');
		await selectWorker(page, 'Ada Lovelace');
		await expect(card).toHaveCount(1, { timeout: 100 });
		await card.evaluate((el) => el.setAttribute('data-tag', 'same'));
		await selectWorker(page, 'Grace Hopper');
		await expect(inspector(page, 'Grace Hopper')).toBeVisible();
		await expect(card).toHaveAttribute('data-tag', 'same');
		await nameCell(page, 'Grace Hopper').press('Escape');
		await expect(card).toHaveCount(0, { timeout: 100 });
	});
});

test('the departing card keeps showing its Worker while it slides out', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();
	// The aside is named at once; its content shows once the stored draft has been read.
	await expect(page.getByTestId('record-card')).toContainText('Ada Lovelace');
	const seen = page.evaluate(
		() =>
			new Promise<string[]>((resolve) => {
				const texts: string[] = [];
				const tick = () => {
					const node = document.querySelector('[data-testid="record-card"]');
					if (!node) return resolve(texts);
					texts.push(node.textContent ?? '');
					requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			})
	);
	await nameCell(page, 'Ada Lovelace').press('Escape');
	const texts = await seen;
	expect(texts.length).toBeGreaterThan(0);
	for (const text of texts) {
		expect(text).toContain('Ada Lovelace');
		expect(text).not.toMatch(/Selected/);
	}
});

test('clicking the selected row again keeps the card open', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	await selectWorker(page, 'Ada Lovelace');
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();
});

test('the selected row, and only it, is aria-selected', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });

	await expect(workerRow(page, 'Ada Lovelace')).not.toHaveAttribute('aria-current');
	await selectWorker(page, 'Ada Lovelace');
	await expect(workerRow(page, 'Ada Lovelace')).toHaveAttribute('aria-current', 'true');
	await expect(workerRow(page, 'Grace Hopper')).not.toHaveAttribute('aria-current');

	await selectWorker(page, 'Grace Hopper');
	await expect(workerRow(page, 'Grace Hopper')).toHaveAttribute('aria-current', 'true');
	await expect(workerRow(page, 'Ada Lovelace')).not.toHaveAttribute('aria-current');
});

test('checking a row closes the desktop detail card', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();

	await page.getByRole('checkbox', { name: 'Select Grace Hopper' }).check();
	await expect(page.getByTestId('bulk-bar')).toContainText('1 selected');
	await expect(inspector(page, 'Ada Lovelace')).toHaveCount(0);
	await expect(workerRow(page, 'Grace Hopper')).toHaveAttribute('aria-selected', 'true');
	await expect(workerRow(page, 'Grace Hopper')).not.toHaveAttribute('aria-current');
});

test('a cell dropdown on another row does not change the selection', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();

	await workerRow(page, 'Katherine Johnson')
		.getByRole('button', { name: 'Edit assessment for Katherine Johnson' })
		.click();
	await expect(page.getByRole('menuitemradio', { name: 'Leader' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();
	await expect(workerRow(page, 'Katherine Johnson')).toHaveAttribute('aria-selected', 'false');
});

test('checking the selected row closes the desktop detail card', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');

	await page.getByRole('checkbox', { name: 'Select Ada Lovelace' }).check();
	await expect(page.getByTestId('bulk-bar')).toContainText('1 selected');
	await expect(inspector(page, 'Ada Lovelace')).toHaveCount(0);
});

test('the panel keeps its Worker identity through a sort', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');

	const nameHeader = page.getByRole('columnheader', { name: 'Name' });
	await nameHeader.getByRole('button').click();
	await expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
	await expect(inspector(page, 'Ada Lovelace')).toContainText('ada@example.test');
});

test('searching the selected worker out rebuilds the list and opens its first Worker', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();

	await page.getByRole('searchbox', { name: 'Search Name' }).fill('Grace');
	await expect(inspector(page, 'Grace Hopper')).toBeVisible();
	await expect(page.getByTestId('workers-cohort-notice')).toContainText(
		'List changed: Grace Hopper'
	);

	// A record still among the rebuilt rows keeps its place.
	await page.getByRole('searchbox', { name: 'Search Name' }).fill('');
	await expect(inspector(page, 'Grace Hopper')).toBeVisible();
	await expect(page.getByTestId('workers-cohort-notice')).toContainText('2 of 3');
});

test('deleting the selected worker empties the panel', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Grace Hopper');
	await expect(inspector(page, 'Grace Hopper')).toBeVisible();

	await inspector(page, 'Grace Hopper').getByRole('button', { name: 'Delete worker' }).click();
	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toHaveAccessibleName('Delete Grace Hopper?');
	await dialog.getByRole('button', { name: 'Delete' }).click();

	await expect(page.getByRole('row', { name: /Grace Hopper/ })).toHaveCount(0);
	await expect(anyInspector(page)).toHaveCount(0);
	await expect(panel(page)).toHaveCount(0);
});

test('switching Worksite empties the panel', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();

	const created = await request.post('/api/worksite');
	expect(created.status(), await created.text()).toBe(201);
	const other = ((await created.json()) as { worksite: { id: string; name: string } }).worksite;
	await page.reload();
	await appReady(page);

	await page.getByRole('button', { name: /^Active Worksite: / }).click();
	await page.getByRole('menuitem', { name: other.name, exact: true }).click();
	await expect(page).toHaveURL(/\/overview$/);

	await page.goto('/workers');
	await appReady(page);
	await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible();
	await expect(page.getByRole('row', { name: /Ada Lovelace/ })).toHaveCount(0);
	await expect(anyInspector(page)).toHaveCount(0);
	await expect(panel(page)).toHaveCount(0);
});

test('an ordinary save updates the panel without losing the selection', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	await expect(ada).toBeVisible();

	// The same control exists in the row's cell, so this one is named by its region.
	await ada.getByRole('button', { name: 'Edit assessment for Ada Lovelace' }).click();
	await page.getByRole('menuitemradio', { name: 'Leader' }).click();

	await expect(page.getByText("Saved Ada Lovelace's Assessment")).toBeVisible();
	await expect(ada).toBeVisible();
	await expect(ada.getByText('Leader', { exact: true })).toBeVisible();
});

/**
 * The panel header's Assessment (ticket 09) is the table cell's own dropdown:
 * picking an option saves at once, updates the row, and reports with Undo.
 */
test('changing Assessment in the panel header updates the row, and Undo puts it back', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const header = inspector(page, 'Ada Lovelace').getByRole('button', {
		name: 'Edit assessment for Ada Lovelace'
	});
	const cell = workerRow(page, 'Ada Lovelace').getByRole('button', {
		name: 'Edit assessment for Ada Lovelace'
	});
	await expect(header).toContainText('Supporter');

	await header.click();
	await page.getByRole('menuitemradio', { name: 'Leader' }).click();

	await expect(page.getByTestId('status-line')).toContainText("Saved Ada Lovelace's Assessment");
	await expect(header).toContainText('Leader');
	await expect(cell).toContainText('Leader');

	await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();
	await expect(header).toContainText('Supporter');
	await expect(cell).toContainText('Supporter');
});

test('a negative Assessment in the panel header saves at once, with no confirm', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const header = inspector(page, 'Ada Lovelace').getByRole('button', {
		name: 'Edit assessment for Ada Lovelace'
	});

	await header.click();
	await page.getByRole('menuitemradio', { name: 'Hostile' }).click();

	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(page.getByTestId('status-line')).toContainText("Saved Ada Lovelace's Assessment");
	await expect(header).toContainText('Hostile');
	await expect(
		workerRow(page, 'Ada Lovelace').getByRole('button', {
			name: 'Edit assessment for Ada Lovelace'
		})
	).toContainText('Hostile');
});

/**
 * The panel's own field editors (ticket 10): Name, Email and Phone are value
 * buttons that turn into a full-width input with Save and Cancel beneath it.
 */
test('editing Email saves it, offers Undo, and Undo puts the old address back', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Edit email' }).click();
	const input = ada.getByLabel('Email');
	await expect(input).toHaveValue('ada@example.test');

	await input.fill('ada.king@example.test');
	await input.press('Enter');

	await expect(ada.getByRole('button', { name: 'Edit email' })).toBeFocused();
	await expect(ada).toContainText('ada.king@example.test');
	await expect(page.getByTestId('status-line')).toContainText("Saved Ada Lovelace's Email");

	const stored = (await (await request.get('/api/dataset')).json()) as {
		workers: { name: string; email: string }[];
	};
	expect(stored.workers.find((worker) => worker.name === 'Ada Lovelace')?.email).toBe(
		'ada.king@example.test'
	);

	await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();
	await expect(inspector(page, 'Ada Lovelace')).toContainText('ada@example.test');
});

test('a saved Email is still there after a reload', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Edit email' }).click();
	await ada.getByLabel('Email').fill('ada.king@example.test');
	await ada.getByRole('button', { name: 'Save' }).click();
	await expect(ada).toContainText('ada.king@example.test');

	await page.reload();
	await appReady(page);
	await selectWorker(page, 'Ada Lovelace');
	await expect(inspector(page, 'Ada Lovelace')).toContainText('ada.king@example.test');
});

test('Escape puts the Phone back and returns focus to its value button', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	const phone = ada.getByRole('button', { name: 'Edit phone' });

	await phone.click();
	const input = ada.getByLabel('Phone');
	await input.fill('555-9999');
	await input.press('Escape');

	await expect(phone).toBeFocused();
	await expect(ada).toContainText('555-0100');
	await expect(ada).not.toContainText('555-9999');
	await expect(page.getByTestId('status-line')).not.toContainText('Saved');

	const stored = (await (await request.get('/api/dataset')).json()) as {
		workers: { name: string; phone: string }[];
	};
	expect(stored.workers.find((worker) => worker.name === 'Ada Lovelace')?.phone).toBe('555-0100');
});

test('clearing the Name is refused with a message and the old name stays', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Edit name' }).click();
	const input = ada.getByLabel('Name');
	await input.fill('');
	await input.press('Enter');

	await expect(ada.getByText(/needs a name/i)).toBeVisible();
	await expect(input).toBeVisible();
	await expect(page.getByTestId('status-line')).not.toContainText('Saved');

	await input.press('Escape');
	await expect(ada.locator('h2')).toHaveText('Ada Lovelace');
	await expect(workerRow(page, 'Ada Lovelace')).toBeVisible();
});

test('a commit that changes nothing writes nothing and reports nothing', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Edit email' }).click();
	await ada.getByLabel('Email').press('Enter');

	await expect(ada.getByRole('button', { name: 'Edit email' })).toBeFocused();
	await expect(ada).toContainText('ada@example.test');
	await expect(page.getByTestId('status-line')).not.toContainText('Saved');
});

/**
 * Phone entry (ticket 01): the field is a digits-only mask that lays the number out
 * `(555) 010-0100`, saves empty or complete, refuses an incomplete one in the UI's
 * own words, and sends the previous stored value back through the restore patch on Undo.
 */
test.describe('Phone entry (ticket 01)', () => {
	/** Opens Ada's Phone editor. The seeded phone is the legacy, non-number "555-0100". */
	async function openPhone(page: Page) {
		const ada = inspector(page, 'Ada Lovelace');
		await ada.getByRole('button', { name: 'Edit phone' }).click();
		return { ada, input: ada.getByLabel('Phone') };
	}

	/** Puts the caret in a masked input once its formatting tick has settled. */
	async function placeCaret(input: Locator, start: number, end = start) {
		await input.evaluate(
			(element, [start, end]) =>
				new Promise<void>((resolve) => {
					requestAnimationFrame(() =>
						requestAnimationFrame(() => {
							(element as HTMLInputElement).setSelectionRange(start, end);
							resolve();
						})
					);
				}),
			[start, end] as [number, number]
		);
	}

	/** Ada's stored Phone, read through the same dataset route the app reads. */
	async function storedPhone(request: APIRequestContext): Promise<string> {
		const body = (await (await request.get('/api/dataset')).json()) as {
			workers: { name: string; phone: string }[];
		};
		return body.workers.find((worker) => worker.name === 'Ada Lovelace')?.phone ?? '';
	}

	async function adaId(request: APIRequestContext): Promise<string> {
		const body = (await (await request.get('/api/dataset')).json()) as {
			workers: { id: string; name: string }[];
		};
		return body.workers.find((worker) => worker.name === 'Ada Lovelace')!.id;
	}

	test('typing shows the mask progressively, ignores letters, and stops at 10 digits', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const { input } = await openPhone(page);

		await expect(input).toHaveAttribute('type', 'tel');
		await expect(input).toHaveAttribute('inputmode', 'numeric');
		await expect(inspector(page, 'Ada Lovelace')).not.toContainText('10 digits');

		await input.fill('');
		await input.pressSequentially('555');
		await expect(input).toHaveValue('(555)');
		await input.pressSequentially('010');
		await expect(input).toHaveValue('(555) 010');
		await input.pressSequentially('0100');
		await expect(input).toHaveValue('(555) 010-0100');

		// An 11th digit is ignored.
		await input.pressSequentially('9');
		await expect(input).toHaveValue('(555) 010-0100');

		// Letters and symbols cannot be typed.
		await input.fill('');
		await input.pressSequentially('5a5b5');
		await expect(input).toHaveValue('(555)');
	});

	test('pasting punctuated numbers and a country prefix lands in the same shape', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const { input } = await openPhone(page);

		for (const pasted of [
			'555.010.0100',
			'555-010-0100',
			'(555) 010-0100',
			'+1 555 010 0100',
			'1-555-010-0100',
			'5550100100',
			'55501001000'
		]) {
			await input.fill(pasted);
			await expect(input, pasted).toHaveValue('(555) 010-0100');
		}
	});

	test('backspace removes a digit through the punctuation', async ({ page, request }) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const { input } = await openPhone(page);

		await input.fill('5550100100');
		await expect(input).toHaveValue('(555) 010-0100');
		// Put the caret just after the closing parenthesis, on punctuation.
		await placeCaret(input, 5);
		await input.press('Backspace');

		await expect(input).toHaveValue('(550) 100-100');
	});

	test('editing in the middle keeps the caret on the same digit', async ({ page, request }) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const { input } = await openPhone(page);

		await input.fill('5550100100');
		await expect(input).toHaveValue('(555) 010-0100');
		// Select the sixth digit and replace it with a 7.
		await placeCaret(input, 8, 9);
		await input.press('7');

		await expect(input).toHaveValue('(555) 017-0100');
		await expect.poll(() => input.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(9);
	});

	test('saving 7 digits is refused with the UI message and keeps what was typed', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const { ada, input } = await openPhone(page);

		await input.fill('5550100');
		await expect(input).toHaveValue('(555) 010-0');
		await input.press('Enter');

		await expect(ada.getByRole('alert')).toContainText(/10 digits/i);
		await expect(input).toHaveValue('(555) 010-0');
		await expect(page.getByTestId('status-line')).not.toContainText("Saved Ada Lovelace's Phone");
		expect(await storedPhone(request)).toBe('555-0100');

		// Finishing the number saves it in its stored shape and shows it on the record.
		await input.pressSequentially('100');
		await input.press('Enter');
		await expect(page.getByTestId('status-line')).toContainText("Saved Ada Lovelace's Phone");
		await expect(ada).toContainText('(555) 010-0100');
		expect(await storedPhone(request)).toBe('(555) 010-0100');
	});

	test('clearing the Phone and saving removes it', async ({ page, request }) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const { ada, input } = await openPhone(page);

		await input.fill('');
		await expect(input).toHaveAttribute('placeholder', '(xxx) xxx-xxxx');
		await input.press('Enter');

		await expect(page.getByTestId('status-line')).toContainText("Saved Ada Lovelace's Phone");
		await expect(ada.getByRole('button', { name: 'Edit phone' })).toContainText('Add phone');
		expect(await storedPhone(request)).toBe('');
	});

	test('re-saving the same number sends no request and reports nothing', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');

		const phonePatches: string[] = [];
		page.on('request', (sent) => {
			const body = sent.postData() ?? '';
			if (sent.method() === 'PATCH' && body.includes('"field":"phone"')) {
				phonePatches.push(body);
			}
		});

		const { input } = await openPhone(page);
		await input.fill('5550100100');
		await input.press('Enter');
		await expect(page.getByTestId('status-line')).toContainText("Saved Ada Lovelace's Phone");
		expect(phonePatches).toHaveLength(1);

		const reopened = inspector(page, 'Ada Lovelace');
		await reopened.getByRole('button', { name: 'Edit phone' }).click();
		await reopened.getByLabel('Phone').press('Enter');

		// The editor closes without a write: the value already matched the record.
		await expect(reopened.getByRole('button', { name: 'Edit phone' })).toBeFocused();
		await expect.poll(() => phonePatches.length).toBe(1);
	});

	test('Undo restores the previous phone even when it is not a formatted number', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const { ada, input } = await openPhone(page);

		await input.fill('5550100100');
		await input.press('Enter');
		await expect(ada).toContainText('(555) 010-0100');

		await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();

		await expect(
			inspector(page, 'Ada Lovelace').getByRole('button', { name: 'Edit phone' })
		).toContainText('555-0100');
		await expect.poll(() => storedPhone(request)).toBe('555-0100');
	});

	test('a worker with a non-number phone still opens, edits another field, and can be corrected', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const ada = inspector(page, 'Ada Lovelace');
		await expect(ada.getByRole('button', { name: 'Edit phone' })).toContainText('555-0100');

		await ada.getByRole('button', { name: 'Edit email' }).click();
		await ada.getByLabel('Email').fill('ada.corrected@example.test');
		await ada.getByLabel('Email').press('Enter');
		await expect(page.getByTestId('status-line')).toContainText("Saved Ada Lovelace's Email");

		const { input } = await openPhone(page);
		await input.fill('5550100100');
		await input.press('Enter');
		await expect(page.getByTestId('status-line')).toContainText("Saved Ada Lovelace's Phone");
		expect(await storedPhone(request)).toBe('(555) 010-0100');
	});

	test('a half-typed Phone survives switching Workers and reopens where it was', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const { input } = await openPhone(page);

		await input.fill('55501');
		await expect(input).toHaveValue('(555) 01');

		// The switch is not blocked by a half-entered number: it is a draft, not a save.
		await selectWorker(page, 'Grace Hopper');
		await expect(inspector(page, 'Grace Hopper')).toBeVisible();

		// Leaving the Worker wrote the half-typed value to its draft before unmounting.
		const id = await adaId(request);
		await expect
			.poll(
				async () =>
					(
						(await (await request.get(`/api/worker-drafts/${id}`)).json()) as {
							draft: { update: { phone: string } } | null;
						}
					).draft?.update.phone
			)
			.toBe('(555) 01');

		// Coming back reopens the Phone editor with what was typed.
		await selectWorker(page, 'Ada Lovelace');
		await expect(
			inspector(page, 'Ada Lovelace').getByRole('textbox', { name: 'Phone' })
		).toHaveValue('(555) 01');
	});

	test('unsaved Phone typing is kept in the draft as shown', async ({ page, request }) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const { input } = await openPhone(page);

		await input.fill('55501');
		await expect(input).toHaveValue('(555) 01');

		const id = await adaId(request);
		await expect
			.poll(
				async () =>
					(
						(await (await request.get(`/api/worker-drafts/${id}`)).json()) as {
							draft: { update: { phone: string } } | null;
						}
					).draft?.update.phone
			)
			.toBe('(555) 01');

		await page.reload();
		await appReady(page);
		await selectWorker(page, 'Ada Lovelace');
		await expect(
			inspector(page, 'Ada Lovelace').getByRole('textbox', { name: 'Phone' })
		).toHaveValue('(555) 01');
	});
});

test('a long email is edited in a full-width input, not a clipped inline one', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Edit email' }).click();
	const input = ada.getByLabel('Email');
	await input.fill('ada.lovelace.king.byron@a-very-long-domain.example.test');

	// The editor takes the record's whole content width, so a long address is
	// readable in place rather than cut off beside its label.
	const inputBox = await input.boundingBox();
	const contactBox = await ada.locator('section').first().boundingBox();
	expect(Math.abs((inputBox?.width ?? 0) - (contactBox?.width ?? 0))).toBeLessThanOrEqual(1);
	expect(inputBox?.width ?? 0).toBeGreaterThan(200);
});

test('a half-typed Email is saved when another row is clicked', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	// Typed, never committed by hand: the row click must save it, not drop it.
	await ada.getByRole('button', { name: 'Edit email' }).click();
	await ada.getByLabel('Email').fill('ada.flush@example.test');

	await selectWorker(page, 'Grace Hopper');
	await expect(inspector(page, 'Grace Hopper')).toBeVisible();
	await expect(page.getByTestId('status-line')).toContainText("Saved Ada Lovelace's Email");

	await page.reload();
	await appReady(page);
	await selectWorker(page, 'Ada Lovelace');
	await expect(inspector(page, 'Ada Lovelace')).toContainText('ada.flush@example.test');
});

test('a refused Name keeps the selection when another row is clicked', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Edit name' }).click();
	const input = ada.getByLabel('Name');
	await input.fill('');

	await selectWorker(page, 'Grace Hopper');

	// The write was refused, so the organizer does not leave the Worker who
	// needs the fix: same record, same editor, focus in the field.
	await expect(input).toBeFocused();
	await expect(ada.getByText(/needs a name/i)).toBeVisible();
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();
	await expect(workerRow(page, 'Ada Lovelace')).toHaveAttribute('aria-current', 'true');
	await expect(workerRow(page, 'Grace Hopper')).not.toHaveAttribute('aria-current');
});

test('a refused Name keeps the selection when the Down arrow moves it', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Edit name' }).click();
	const input = ada.getByLabel('Name');
	await input.fill('');

	await nameCell(page, 'Ada Lovelace').focus();
	await page.keyboard.press('ArrowDown');

	await expect(input).toBeFocused();
	await expect(ada.getByText(/needs a name/i)).toBeVisible();
	await expect(workerRow(page, 'Ada Lovelace')).toHaveAttribute('aria-current', 'true');
	await expect(workerRow(page, 'Grace Hopper')).not.toHaveAttribute('aria-current');
});

test('a refused draft keeps the row unchecked and the editor open', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	await ada.getByRole('button', { name: 'Edit email' }).click();
	await ada.getByLabel('Email').fill('not-an-email');

	const box = page.getByRole('checkbox', { name: 'Select Grace Hopper' });
	await box.check({ force: true, noWaitAfter: true }).catch(() => {});
	await expect(ada.getByRole('alert')).toBeVisible();
	await expect(ada.getByLabel('Email')).toHaveValue('not-an-email');
	await expect(box).not.toBeChecked();
	await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
});

test('a bulk edit saves what is being typed in the panel first', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Edit email' }).click();
	await ada.getByLabel('Email').fill('ada.bulk@example.test');

	await page.getByRole('checkbox', { name: 'Select Ada Lovelace' }).check();
	await page.getByTestId('bulk-bar').getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Set Assessment' }).click();
	await page.getByRole('menuitem', { name: 'Leader' }).click();

	await expect(page.getByTestId('status-line')).toContainText('Saved Assessment for 1 worker');
	// Checking a row closes the panel, so open the record again to see what was saved.
	await page.getByRole('checkbox', { name: 'Select Ada Lovelace' }).uncheck();
	await selectWorker(page, 'Ada Lovelace');
	await expect(inspector(page, 'Ada Lovelace')).toContainText('ada.bulk@example.test');
});

/** The sheet, which is the below-desktop surface for the same record. */
const sheet = (page: Page, name: string) =>
	page.getByRole('dialog', { name: `Worker details: ${name}` });

test('at 375px a tap opens the record in a 352px sheet and closing clears the selection', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, {
		seed: seedInspectorWorkers,
		viewport: { width: 375, height: 812 }
	});

	await expect(panel(page)).toHaveCount(0);
	await selectWorker(page, 'Ada Lovelace');

	const open = sheet(page, 'Ada Lovelace');
	await expect(open).toBeVisible();
	await expect(open.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible();
	await expect(inlineBands(page)).toHaveCount(0);
	await expect.poll(async () => (await open.boundingBox())?.width).toBe(352);

	await open.getByRole('button', { name: 'Close' }).click();
	await expect(open).toHaveCount(0);
	await expect(workerRow(page, 'Ada Lovelace')).toHaveAttribute('aria-selected', 'false');
});

test('the page has no horizontal overflow at 375px with the sheet closed or open', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, {
		seed: seedInspectorWorkers,
		viewport: { width: 375, height: 812 }
	});
	const overflow = () =>
		page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);

	expect(await overflow()).toBeLessThanOrEqual(0);
	await toggle(page, 'Ada Lovelace').click();
	await expect(sheet(page, 'Ada Lovelace')).toBeVisible();
	expect(await overflow()).toBeLessThanOrEqual(0);
});

test('resizing keeps the same open worker between the rail and a closed sheet', async ({
	page,
	request
}) => {
	await seedInspectorWorkers(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	await selectWorker(page, 'Grace Hopper');
	await expect(inspector(page, 'Grace Hopper')).toBeVisible();

	// Narrowing never opens the sheet by itself; only a tap on the row does.
	await page.setViewportSize({ width: 800, height: 900 });
	await expect(anyInspector(page)).toHaveCount(0);
	await expect(sheet(page, 'Grace Hopper')).toHaveCount(0);
	await expect(workerRow(page, 'Grace Hopper')).toHaveAttribute('aria-current', 'true');

	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(inspector(page, 'Grace Hopper')).toBeVisible();
	await expect(sheet(page, 'Grace Hopper')).toHaveCount(0);
	await expect(workerRow(page, 'Grace Hopper')).toHaveAttribute('aria-current', 'true');
});

test('the inspector reads the whole record and the page never overflows sideways', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });

	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	await expect(ada).toBeVisible();

	// Name as the region's heading, then the sections in order.
	await expect(ada.locator('h2')).toHaveText('Ada Lovelace');
	const name = ada.locator('h2 .prose-value');
	await expect(name).toHaveCSS('font-size', '20px');
	await expect(name).toHaveCSS('font-weight', '600');
	await expect(name).toHaveCSS('letter-spacing', '-0.2px');
	await expect(ada.getByText('Supporter', { exact: true })).toBeVisible();
	await expect(ada.locator('h3')).toHaveText([
		'Contact',
		'Attributes',
		'Languages',
		'Notes',
		'Relationships',
		'Agitations'
	]);
	// Both ordinary kinds read their stored answer in the configured order.
	await expect(attributeReading(ada, 'Department')).toContainText('Front of House');
	await expect(attributeReading(ada, 'Shifts')).toContainText('Dinner');
	for (const label of ['Email', 'Phone']) {
		const key = term(ada, label);
		await expect(key).toHaveCSS('font-size', '10.5px');
		await expect(key).toHaveCSS('font-family', /Roboto Mono Variable/);
		await expect(key).toHaveCSS('text-transform', 'uppercase');
	}
	await expect(ada).toContainText('ada@example.test');
	await expect(ada).toContainText('555-0100');
	await expect(ada.getByRole('button', { name: 'Add relationship' })).toBeVisible();
	await expect(ada.getByText('No relationships')).toHaveCount(0);
	await expect(ada.getByText('Pay')).toBeVisible();
	await expect(ada.getByText('Ada Lovelace notes')).toBeVisible();

	// The horizontal scroller absorbs the panel's width; the document does not.
	for (const [width, height] of [
		[1280, 720],
		[1024, 640]
	]) {
		await page.setViewportSize({ width, height });
		await expect(ada).toBeVisible();
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow, `document overflow at ${width}x${height}`).toBeLessThanOrEqual(1);
	}
});

test.describe('ordinary Attribute editing in the record panel (ticket 05)', () => {
	/** The id of the configured Attribute with this name. */
	async function attributeIdFor(request: APIRequestContext, name: string): Promise<string> {
		const body = (await (await request.get('/api/dataset')).json()) as {
			attributes: { id: string; name: string }[];
		};
		const attribute = body.attributes.find((candidate) => candidate.name === name);
		if (!attribute) throw new Error(`No Attribute named ${name}.`);
		return attribute.id;
	}

	/** The answer id a seeded text has, through the helper the seeds use. */
	async function answerIdFor(
		request: APIRequestContext,
		attributeName: string,
		text: string
	): Promise<string> {
		return answerId(await attributeIdFor(request, attributeName), text);
	}

	/** The stored Attribute value for one Worker, by Attribute id. */
	async function storedAttribute(
		request: APIRequestContext,
		workerName: string,
		attributeId: string
	) {
		const body = (await (await request.get('/api/dataset')).json()) as {
			workers: { name: string; attributes: Record<string, string | string[]> }[];
		};
		return body.workers.find((worker) => worker.name === workerName)?.attributes[attributeId];
	}

	test('edits a Single-Select, clears it, undoes, and keeps the reading after reload', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const ada = inspector(page, 'Ada Lovelace');
		const row = attributeRow(ada, 'Department');
		const trigger = row.getByRole('button', { name: 'Edit Department', exact: true });

		// Escape closes the editor without writing and hands focus back to the reading.
		await trigger.click();
		await row.getByRole('combobox', { name: 'Department' }).press('Escape');
		await expect(trigger).toBeFocused();

		await trigger.click();
		const select = row.getByRole('combobox', { name: 'Department' });
		await expect(select).toBeFocused();
		await expect(select).toHaveValue(await answerIdFor(request, 'Department', 'Front of House'));
		await select.selectOption({ label: 'Back of House' });
		await row.getByRole('button', { name: 'Save', exact: true }).click();

		await expect(page.getByTestId('status-line')).toContainText("Saved Ada Lovelace's Department");
		await expect(row.locator('dd')).toContainText('Back of House');
		await expect(trigger).toBeFocused();
		const departmentId = await attributeIdFor(request, 'Department');
		expect(await storedAttribute(request, 'Ada Lovelace', departmentId)).toBe(
			await answerIdFor(request, 'Department', 'Back of House')
		);

		// Undo puts the earlier answer back, and a reload shows the same reading.
		await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();
		await expect(row.locator('dd')).toContainText('Front of House');
		await page.reload();
		await appReady(page);
		await selectWorker(page, 'Ada Lovelace');
		await expect(attributeReading(inspector(page, 'Ada Lovelace'), 'Department')).toContainText(
			'Front of House'
		);

		// A Single-Select holds one answer or none: None clears it.
		const reopened = attributeRow(inspector(page, 'Ada Lovelace'), 'Department');
		await reopened.getByRole('button', { name: 'Edit Department', exact: true }).click();
		await reopened.getByRole('combobox', { name: 'Department' }).selectOption({ label: 'None' });
		await reopened.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(reopened.locator('dd')).toContainText('No Department');
		expect(await storedAttribute(request, 'Ada Lovelace', departmentId)).toBe('');
	});

	test('adds and removes Multi-Select answers, clears them, and undoes', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const ada = inspector(page, 'Ada Lovelace');
		const row = attributeRow(ada, 'Shifts');
		const shiftsId = await attributeIdFor(request, 'Shifts');
		const trigger = row.getByRole('button', { name: 'Edit Shifts', exact: true });

		await trigger.click();
		const brunch = row.getByRole('checkbox', { name: 'Brunch', exact: true });
		await expect(brunch).not.toBeChecked();
		await brunch.check();
		await row.getByRole('button', { name: 'Save', exact: true }).click();

		await expect(row.locator('dd')).toContainText('Dinner, Brunch');
		expect(await storedAttribute(request, 'Ada Lovelace', shiftsId)).toEqual([
			await answerIdFor(request, 'Shifts', 'Dinner'),
			await answerIdFor(request, 'Shifts', 'Brunch')
		]);

		// Removing one answer keeps the other; Undo restores the pair.
		await trigger.click();
		await row.getByRole('checkbox', { name: 'Dinner', exact: true }).uncheck();
		await row.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(row.locator('dd')).toContainText('Brunch');
		await expect(row.locator('dd')).not.toContainText('Dinner');
		await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();
		await expect(row.locator('dd')).toContainText('Dinner, Brunch');

		// Clearing the last answer is the same removal, and reads as the shared no-value line.
		await trigger.click();
		await row.getByRole('checkbox', { name: 'Dinner', exact: true }).uncheck();
		await row.getByRole('checkbox', { name: 'Brunch', exact: true }).uncheck();
		await row.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(row.locator('dd')).toContainText('No Shifts');
		expect(await storedAttribute(request, 'Ada Lovelace', shiftsId)).toEqual([]);
	});

	test('a refused Attribute save keeps the editor open with the UI message and nothing written', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const row = attributeRow(inspector(page, 'Ada Lovelace'), 'Department');
		const departmentId = await attributeIdFor(request, 'Department');
		const before = await storedAttribute(request, 'Ada Lovelace', departmentId);

		await page.route('**/api/workers/*', async (route) => {
			if (route.request().method() !== 'PATCH') return route.continue();
			return route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'Injected attribute failure' })
			});
		});

		await row.getByRole('button', { name: 'Edit Department', exact: true }).click();
		await row
			.getByRole('combobox', { name: 'Department' })
			.selectOption({ label: 'Back of House' });
		await row.getByRole('button', { name: 'Save', exact: true }).click();

		// The editor stays open holding the choice, says so in the UI's own words, and
		// the core's diagnostic never reaches the screen. The stored value is unchanged.
		await expect(row.getByRole('alert')).toHaveText('Could not save the Department. Try again.');
		await expect(row.getByRole('combobox', { name: 'Department' })).toBeFocused();
		await expect(row.getByRole('combobox', { name: 'Department' })).toHaveValue(
			await answerIdFor(request, 'Department', 'Back of House')
		);
		await expect(page.getByTestId('status-line').getByRole('button', { name: 'Undo' })).toHaveCount(
			0
		);
		expect(await storedAttribute(request, 'Ada Lovelace', departmentId)).toBe(before);

		// A retry writes it and closes the editor.
		await page.unroute('**/api/workers/*');
		await row.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(row.locator('dd')).toContainText('Back of House');
		expect(await storedAttribute(request, 'Ada Lovelace', departmentId)).toBe(
			await answerIdFor(request, 'Department', 'Back of House')
		);
	});

	test('shows several answers and none, tells same-named paths apart, and records a parent alone', async ({
		page,
		request
	}) => {
		const locationId = 'attribute-location';
		const departmentId = 'attribute-department';
		const answers = {
			north: 'answer-north',
			northCentral: 'answer-north-central',
			northLeaf: 'answer-north-leaf',
			south: 'answer-south',
			southLeaf: 'answer-south-leaf',
			ops: 'answer-ops'
		};
		const configured = await request.put('/api/attributes', {
			data: [
				{
					id: locationId,
					name: 'Location',
					kind: 'tag',
					options: [
						{ id: answers.north, value: 'North' },
						{ id: answers.northCentral, value: 'Central', parentId: answers.north },
						{
							id: answers.northLeaf,
							value: 'Packing',
							parentId: answers.northCentral
						},
						{ id: answers.south, value: 'South' },
						{ id: answers.southLeaf, value: 'Packing', parentId: answers.south }
					]
				},
				{
					id: departmentId,
					name: 'Department',
					kind: 'category',
					options: [
						{ id: answers.ops, value: 'Operations' },
						{ id: answers.ops + '-sales', value: 'Sales' }
					]
				}
			]
		});
		expect(configured.ok(), await configured.text()).toBeTruthy();

		/** Ada holds two same-named leaves; Bea holds no Location and one Department. */
		const people = [
			{
				name: 'Ada Lovelace',
				attributes: { [locationId]: [answers.northLeaf, answers.southLeaf], [departmentId]: '' }
			},
			{
				name: 'Emmy Noether',
				attributes: { [locationId]: [], [departmentId]: answers.ops }
			}
		];
		for (const person of people) {
			const created = await request.post('/api/workers', {
				data: {
					name: person.name,
					email: '',
					phone: '',
					assessment: 'Unassessed',
					attributes: person.attributes,
					agitations: [],
					languages: [],
					relationships: [],
					notes: []
				}
			});
			expect(created.status(), await created.text()).toBe(201);
		}

		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/workers');
		await appReady(page);

		// The table cell names both branches by path and the empty Department by the shared line.
		const adaLocations = page
			.getByRole('row', { name: /Ada Lovelace/ })
			.locator(`td[data-column-id="${locationId}"]`);
		await expect(adaLocations).toHaveAttribute(
			'aria-label',
			/Location for Ada Lovelace: North \/ Central \/ Packing, South \/ Packing/
		);
		await expect(
			page
				.getByRole('row', { name: /Ada Lovelace/ })
				.locator(`td[data-column-id="${departmentId}"]`)
		).toHaveAttribute('aria-label', 'Department for Ada Lovelace: No Department');

		await selectWorker(page, 'Ada Lovelace');
		const ada = inspector(page, 'Ada Lovelace');
		await expect(attributeReading(ada, 'Location')).toContainText(
			'North / Central / Packing, South / Packing'
		);
		await expect(attributeReading(ada, 'Department')).toContainText('No Department');

		// Bea holds nothing for Location: the same no-value reading, not a blank.
		await selectWorker(page, 'Emmy Noether');
		const bea = inspector(page, 'Emmy Noether');
		await expect(attributeReading(bea, 'Location')).toContainText('No Location');
		await expect(attributeReading(bea, 'Department')).toContainText('Operations');

		// Selecting the parent records its id alone, never the descendants it covers.
		const row = attributeRow(bea, 'Location');
		await row.getByRole('button', { name: 'Edit Location', exact: true }).click();
		await row.getByRole('checkbox', { name: 'North', exact: true }).check();
		await row.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(row.locator('dd')).toContainText('North');
		expect(await storedAttribute(request, 'Emmy Noether', locationId)).toEqual([answers.north]);
	});
});

test('a Relationship chip names the Assessment and selects that worker', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	const grace = await (await request.get('/api/dataset')).json();
	const graceId = (grace.workers as { id: string; name: string }[]).find(
		(worker) => worker.name === 'Grace Hopper'
	)!.id;
	const ada = (grace.workers as { id: string; name: string }[]).find(
		(worker) => worker.name === 'Ada Lovelace'
	)!;
	const put = await request.put(`/api/workers/${ada.id}`, {
		data: { ...workerUpdateFrom(ada), relationships: [graceId] }
	});
	expect(put.ok(), await put.text()).toBeTruthy();
	await page.reload();
	await appReady(page);

	await selectWorker(page, 'Ada Lovelace');
	const chip = inspector(page, 'Ada Lovelace').getByRole('button', {
		name: 'Grace Hopper, Supporter'
	});
	await expect(chip).toBeVisible();
	await chip.click();
	await expect(inspector(page, 'Grace Hopper').locator('h2')).toHaveText('Grace Hopper');
	await expect(workerRow(page, 'Grace Hopper')).toHaveAttribute('aria-current', 'true');
});

/**
 * Removing a Relationship (ticket 15). A Relationship is one normalized pair, so
 * taking it off either Worker's record takes it off both; the status line's Undo
 * puts the pair back.
 */
test('removing a Relationship takes it off both workers, and Undo puts it back', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	const dataset = await (await request.get('/api/dataset')).json();
	const workers = dataset.workers as { id: string; name: string }[];
	const graceId = workers.find((worker) => worker.name === 'Grace Hopper')!.id;
	const adaRecord = workers.find((worker) => worker.name === 'Ada Lovelace')!;
	const put = await request.put(`/api/workers/${adaRecord.id}`, {
		data: { ...workerUpdateFrom(adaRecord), relationships: [graceId] }
	});
	expect(put.ok(), await put.text()).toBeTruthy();
	await page.reload();
	await appReady(page);

	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	const chip = ada.getByRole('button', { name: 'Grace Hopper, Supporter' });
	await expect(chip).toBeVisible();

	await ada.getByRole('button', { name: 'Remove relationship with Grace Hopper' }).click();
	await expect(ada).not.toContainText('Grace Hopper');
	await expect(page.getByTestId('status-line')).toContainText(
		'Removed relationship between Ada Lovelace and Grace Hopper'
	);

	// The same pair is gone from the other Worker's record.
	await selectWorker(page, 'Grace Hopper');
	const grace = inspector(page, 'Grace Hopper');
	await expect(grace).not.toContainText('Ada Lovelace');

	// Undo restores the pair, so both records read it again.
	await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();
	await expect(grace).toContainText('Ada Lovelace');
	await selectWorker(page, 'Ada Lovelace');
	await expect(ada).toContainText('Grace Hopper');

	// And the restored pair is stored, not just shown.
	await page.reload();
	await appReady(page);
	await selectWorker(page, 'Ada Lovelace');
	await expect(inspector(page, 'Ada Lovelace')).toContainText('Grace Hopper');
});

/**
 * The Notes composer (ticket 12): one multi-line field, the day it happened, and
 * Ctrl/Cmd+Enter or Save to add. Enter is the organizer's own line break.
 */
test('a two-line Note is added with Ctrl+Enter and is still there after a reload', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	const composer = ada.getByRole('textbox', { name: 'Note' });
	await expect(composer).toHaveValue('');

	await composer.click();
	await expect(ada.getByText(/Enter to save/)).toBeVisible();
	await composer.pressSequentially('Upset about the rota.');
	await composer.press('Enter');
	await composer.pressSequentially('Mentioned Priya.');
	await expect(composer).toHaveValue('Upset about the rota.\nMentioned Priya.');

	await composer.press('ControlOrMeta+Enter');

	const added = noteItems(ada).filter({ hasText: 'Upset about the rota.' });
	await expect(added).toContainText('Mentioned Priya.');
	await expect(page.getByTestId('status-line')).toContainText('Added note for Ada Lovelace');
	await expect(composer).toHaveValue('');
	await expect(composer).toBeFocused();

	await page.reload();
	await appReady(page);
	await selectWorker(page, 'Ada Lovelace');
	await expect(
		noteItems(inspector(page, 'Ada Lovelace')).filter({ hasText: 'Upset about the rota.' })
	).toContainText('Mentioned Priya.');
});

test('the Note composer starts collapsed, expands on focus and keeps its draft when collapsed', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	const composer = ada.getByRole('textbox', { name: 'Note' });
	const save = ada.getByRole('button', { name: 'Save', exact: true });

	// Collapsed: one "Add a note" line and no Save.
	await expect(composer).toHaveAttribute('placeholder', 'Add a note');
	await expect(composer).toBeEnabled();
	await expect(save).toHaveCount(0);

	await composer.focus();
	await expect(save).toBeVisible();

	await composer.fill('Half-written thought');
	await ada.getByRole('heading', { name: 'Notes' }).click();
	await expect(save).toHaveCount(0);
	await expect(composer).toHaveValue('Half-written thought');

	await composer.focus();
	await expect(save).toBeVisible();
	await expect(composer).toHaveValue('Half-written thought');
});

test('the newest Note is listed first and shows no date field', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	const composer = ada.getByRole('textbox', { name: 'Note' });
	await composer.focus();
	await expect(ada.getByLabel('Happened on')).toHaveCount(0);

	await composer.fill('First, on the shop floor');
	await composer.press('ControlOrMeta+Enter');
	await expect(noteItems(ada).filter({ hasText: 'First, on the shop floor' })).toBeVisible();

	await composer.fill('Second, by the loading bay');
	await composer.press('ControlOrMeta+Enter');
	await expect(noteItems(ada).filter({ hasText: 'Second, by the loading bay' })).toBeVisible();

	const shown = await noteItems(ada).allInnerTexts();
	const first = shown.findIndex((entry) => entry.includes('First, on the shop floor'));
	const second = shown.findIndex((entry) => entry.includes('Second, by the loading bay'));
	expect(second).toBeGreaterThanOrEqual(0);
	expect(first).toBeGreaterThan(second);
});

test('typing a Note and clicking another worker saves it on the first', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	await inspector(page, 'Ada Lovelace')
		.getByRole('textbox', { name: 'Note' })
		.fill('Written on the way out');

	await selectWorker(page, 'Grace Hopper');
	await expect(inspector(page, 'Grace Hopper')).toBeVisible();

	const stored = (await (await request.get('/api/dataset')).json()) as {
		workers: { name: string; notes: { text: string }[] }[];
	};
	const ada = stored.workers.find((worker) => worker.name === 'Ada Lovelace');
	const grace = stored.workers.find((worker) => worker.name === 'Grace Hopper');
	expect(ada?.notes.some((note) => note.text === 'Written on the way out')).toBe(true);
	expect(grace?.notes.some((note) => note.text === 'Written on the way out')).toBe(false);
});

test('Undo after adding a Note takes it back off the record', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('textbox', { name: 'Note' }).fill('Temporary observation');
	await ada.getByRole('textbox', { name: 'Note' }).press('ControlOrMeta+Enter');
	await expect(ada).toContainText('Temporary observation');

	await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();
	await expect(ada).not.toContainText('Temporary observation');

	const stored = (await (await request.get('/api/dataset')).json()) as {
		workers: { name: string; notes: { text: string }[] }[];
	};
	expect(
		stored.workers
			.find((worker) => worker.name === 'Ada Lovelace')
			?.notes.some((note) => note.text === 'Temporary observation')
	).toBe(false);
});

test.describe('a Note’s written time', () => {
	// The seeded Note was written at 2024-01-01T00:00:00Z: midnight UTC, 09:00 in Tokyo.
	// Date and Time formats are left on "same as this computer" here, so pin the browser's
	// locale to keep the expected shape stable.
	test.use({ timezoneId: 'Asia/Tokyo', locale: 'en-GB' });

	test('reads in the browser’s own zone, not UTC', async ({ page, request }) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');

		// Chromium joins date and time with ", ", WebKit with " at ".
		await expect(inspector(page, 'Ada Lovelace')).toContainText(/Written 1 Jan 2024(,| at) 09:00/);
	});
});

test('Up and Down move focus and selection between visible rows, and stop at the ends', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	const rows = page.locator('tbody tr[data-worker-id]');
	const names = page.locator('tbody tr[data-worker-id] td:nth-child(2)');
	await names.first().focus();
	await page.keyboard.press('ArrowUp');
	await expect(names.first()).toBeFocused();
	await expect(anyInspector(page)).toHaveCount(0);

	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await expect(names.nth(2)).toBeFocused();
	await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true');
	await expect(anyInspector(page)).toHaveCount(1);
	await expect(anyInspector(page)).toContainText(
		(await rows.nth(2).getByRole('gridcell').nth(1).innerText()).trim()
	);

	await page.keyboard.press('ArrowUp');
	await expect(names.nth(1)).toBeFocused();
	await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');

	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await expect(names.nth(2)).toBeFocused();
	await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true');
});

test('Enter selects the focused row', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	const rows = page.locator('tbody tr[data-worker-id]');
	const names = page.locator('tbody tr[data-worker-id] td:nth-child(2)');
	await names.nth(1).focus();
	await page.keyboard.press('Enter');
	await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
	await names.nth(0).focus();
	await page.keyboard.press('Enter');
	await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
	await expect(rows.nth(1)).not.toHaveAttribute('aria-current');
});

test('arrow keys inside a control do not move the row selection', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	const rows = page.locator('tbody tr[data-worker-id]');
	const names = page.locator('tbody tr[data-worker-id] td:nth-child(2)');
	await names.nth(0).focus();
	await page.keyboard.press('Enter');
	await rows.nth(0).getByRole('checkbox').focus();
	await page.keyboard.press('ArrowDown');
	await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
	await expect(rows.nth(1)).not.toHaveAttribute('aria-current');
});

/** Adds one Note through the composer and answers the panel. */
async function withNote(page: Page, request: APIRequestContext, text: string) {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	await ada.getByRole('textbox', { name: 'Note' }).fill(text);
	await ada.getByRole('textbox', { name: 'Note' }).press('ControlOrMeta+Enter');
	await expect(ada).toContainText(text);
	return ada;
}

/** The stored Note on Ada Lovelace whose text matches. */
async function storedNote(request: APIRequestContext, text: RegExp) {
	const stored = (await (await request.get('/api/dataset')).json()) as {
		workers: { name: string; notes: { text: string; timestamp: string; editedAt?: string }[] }[];
	};
	return stored.workers
		.find((worker) => worker.name === 'Ada Lovelace')
		?.notes.find((note) => text.test(note.text));
}

test.describe('editing a Note in place (ticket 13)', () => {
	test('saving new text marks it edited and keeps the written time', async ({ page, request }) => {
		const ada = await withNote(page, request, 'Talked about rota');
		const before = await storedNote(request, /^Talked about rota$/);

		await noteItems(ada)
			.filter({ hasText: 'Talked about rota' })
			.getByRole('button', { name: /^Edit note from/ })
			.click();
		const editor = ada.getByRole('textbox', { name: 'Edit note' });
		await editor.fill('Talked about the rota\nand breaks');
		await editor.press('ControlOrMeta+Enter');

		await expect(ada).toContainText('and breaks');
		await expect(noteItems(ada).filter({ hasText: 'and breaks' })).toContainText('Edited');
		const after = await storedNote(request, /and breaks/);
		expect(after?.timestamp).toBe(before?.timestamp);
		expect(after?.editedAt).toBeTruthy();
		await expect(page.getByTestId('status-line')).toContainText('Saved note for Ada Lovelace');

		await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();
		await expect(noteItems(ada).filter({ hasText: 'Talked about rota' })).not.toContainText(
			'Edited'
		);
		expect((await storedNote(request, /^Talked about rota$/))?.editedAt).toBeUndefined();
	});

	test('Escape leaves the Note unchanged and returns focus to it', async ({ page, request }) => {
		const ada = await withNote(page, request, 'Keep me');
		const entry = noteItems(ada)
			.filter({ hasText: 'Keep me' })
			.getByRole('button', { name: /^Edit note from/ });
		await entry.click();
		await ada.getByRole('textbox', { name: 'Edit note' }).fill('Changed');
		await ada.getByRole('textbox', { name: 'Edit note' }).press('Escape');

		await expect(ada).toContainText('Keep me');
		await expect(entry).toBeFocused();
		expect((await storedNote(request, /^Keep me$/))?.editedAt).toBeUndefined();
	});

	test('an open Note edit is saved when another worker is selected', async ({ page, request }) => {
		const ada = await withNote(page, request, 'Before switching');
		await noteItems(ada)
			.filter({ hasText: 'Before switching' })
			.getByRole('button', { name: /^Edit note from/ })
			.click();
		await ada.getByRole('textbox', { name: 'Edit note' }).fill('After switching');

		await selectWorker(page, 'Grace Hopper');
		await expect(inspector(page, 'Grace Hopper')).toBeVisible();
		expect(await storedNote(request, /^After switching$/)).toBeTruthy();
	});
});

test.describe('deleting a Note with Undo (ticket 14)', () => {
	/** The Undo the status line offers for the change it last reported. */
	const undo = (page: Page) =>
		page.getByTestId('status-line').getByRole('button', { name: 'Undo' });

	test('the Note’s own Delete removes it and Undo puts it back with its written time', async ({
		page,
		request
	}) => {
		const ada = await withNote(page, request, 'Recover me');
		const stored = await storedNote(request, /^Recover me$/);
		const entry = noteItems(ada).filter({ hasText: 'Recover me' });

		await entry.getByRole('button', { name: /^Delete note from/ }).click();
		await expect(ada).not.toContainText('Recover me');
		await expect(page.getByTestId('status-line')).toContainText('Deleted note for Ada Lovelace');
		expect(await storedNote(request, /^Recover me$/)).toBeUndefined();

		await undo(page).click();
		// The same Note, in the same place, with the written time it had before.
		await expect(noteItems(ada).filter({ hasText: 'Recover me' })).toBeVisible();
		const back = await storedNote(request, /^Recover me$/);
		expect(back?.timestamp).toBe(stored?.timestamp);

		// Undo survived the write, so a reload still shows the Note.
		await page.reload();
		await appReady(page);
		await selectWorker(page, 'Ada Lovelace');
		await expect(inspector(page, 'Ada Lovelace')).toContainText('Recover me');
	});

	test('Delete in the open editor removes the Note, and it stays gone once the line clears', async ({
		page,
		request
	}) => {
		const ada = await withNote(page, request, 'Delete me for good');
		await noteItems(ada)
			.filter({ hasText: 'Delete me for good' })
			.getByRole('button', { name: /^Edit note from/ })
			.click();

		// Exact: the seeded Note's own icon is named "Delete note from <time>" too.
		await ada.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(ada).not.toContainText('Delete me for good');
		await expect(page.getByTestId('status-line')).toContainText('Deleted note for Ada Lovelace');
		expect(await storedNote(request, /^Delete me for good$/)).toBeUndefined();

		// The status line clears on its own; nothing brings the Note back with it.
		await expect(undo(page)).toHaveCount(0, { timeout: 15_000 });
		await page.reload();
		await appReady(page);
		await selectWorker(page, 'Ada Lovelace');
		await expect(inspector(page, 'Ada Lovelace')).not.toContainText('Delete me for good');
	});
});

test.describe('Undo reaches the Worker the edit started on (ticket 25)', () => {
	const undo = (page: Page) =>
		page.getByTestId('status-line').getByRole('button', { name: 'Undo' });

	/** The stored Notes and Email of one Worker. */
	async function stored(request: APIRequestContext, name: string) {
		const dataset = (await (await request.get('/api/dataset')).json()) as {
			workers: { name: string; email: string; notes: { text: string }[] }[];
		};
		return dataset.workers.find((worker) => worker.name === name)!;
	}

	test('deleting a Note on Ada, selecting Grace, then Undo restores it on Ada only', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const ada = inspector(page, 'Ada Lovelace');
		await noteItems(ada)
			.filter({ hasText: 'Ada Lovelace notes' })
			.getByRole('button', { name: /^Delete note from/ })
			.click();
		await expect(ada).not.toContainText('Ada Lovelace notes');

		await selectWorker(page, 'Grace Hopper');
		await expect(inspector(page, 'Grace Hopper')).toBeVisible();
		await undo(page).click();

		await expect
			.poll(async () => (await stored(request, 'Ada Lovelace')).notes.map((n) => n.text))
			.toEqual(['Ada Lovelace notes']);
		expect((await stored(request, 'Grace Hopper')).notes.map((n) => n.text)).toEqual([
			'Grace Hopper notes'
		]);
	});

	test('adding a Note on Ada, selecting Grace, then Undo takes back only that Note', async ({
		page,
		request
	}) => {
		const ada = await withNote(page, request, 'Added on Ada');
		await expect(ada).toContainText('Added on Ada');

		await selectWorker(page, 'Grace Hopper');
		await expect(inspector(page, 'Grace Hopper')).toBeVisible();
		await undo(page).click();

		await expect
			.poll(async () => (await stored(request, 'Ada Lovelace')).notes.map((n) => n.text))
			.toEqual(['Ada Lovelace notes']);
		expect((await stored(request, 'Grace Hopper')).notes.map((n) => n.text)).toEqual([
			'Grace Hopper notes'
		]);
	});

	test('editing Ada’s Email, selecting Grace, then Undo restores Ada’s and leaves Grace’s', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		const ada = inspector(page, 'Ada Lovelace');
		await ada.getByRole('button', { name: 'Edit email' }).click();
		const input = ada.getByLabel('Email');
		await input.fill('ada.king@example.test');
		await input.press('Enter');
		await expect(ada).toContainText('ada.king@example.test');

		await selectWorker(page, 'Grace Hopper');
		await expect(inspector(page, 'Grace Hopper')).toBeVisible();
		await undo(page).click();

		await expect
			.poll(async () => (await stored(request, 'Ada Lovelace')).email)
			.toBe('ada@example.test');
		expect((await stored(request, 'Grace Hopper')).email).toBe('grace@example.test');
	});

	test('changing Ada’s Assessment, selecting Grace, then Undo restores Ada’s only', async ({
		page,
		request
	}) => {
		await openWorkersTable(page, request, { seed: seedInspectorWorkers });
		await selectWorker(page, 'Ada Lovelace');
		await inspector(page, 'Ada Lovelace')
			.getByRole('button', { name: 'Edit assessment for Ada Lovelace' })
			.click();
		await page.getByRole('menuitemradio', { name: 'Leader' }).click();
		await expect(page.getByTestId('status-line')).toContainText("Saved Ada Lovelace's Assessment");

		await selectWorker(page, 'Grace Hopper');
		await expect(inspector(page, 'Grace Hopper')).toBeVisible();
		await undo(page).click();

		const assessmentOf = async (name: string) =>
			(
				(await (await request.get('/api/dataset')).json()) as {
					workers: { name: string; assessment: string }[];
				}
			).workers.find((worker) => worker.name === name)?.assessment;
		await expect.poll(() => assessmentOf('Ada Lovelace')).toBe('Supporter');
		expect(await assessmentOf('Grace Hopper')).toBe('Supporter');
	});
});

/**
 * Adding a Relationship (ticket 16): a searchable list inside the section. Choosing
 * a Worker adds one symmetric pair at once, and the list closes.
 */
test('adding a Relationship shows on both workers, and Undo takes it off both', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Add relationship' }).click();
	const list = ada.getByRole('list', { name: 'Workers you can relate' });
	await ada.getByRole('searchbox', { name: 'Search workers to relate' }).fill('grace');
	await list.getByRole('button', { name: /^Grace Hopper/ }).click();

	await expect(list).toBeHidden();
	await expect(ada.getByRole('button', { name: 'Grace Hopper, Supporter' })).toBeVisible();
	await expect(page.getByTestId('status-line')).toContainText(
		'Added relationship between Ada Lovelace and Grace Hopper'
	);

	await selectWorker(page, 'Grace Hopper');
	const grace = inspector(page, 'Grace Hopper');
	await expect(grace.getByRole('button', { name: 'Ada Lovelace, Supporter' })).toBeVisible();

	// Undo with Grace selected removes the pair from both records.
	await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();
	await expect(grace.getByRole('button', { name: 'Ada Lovelace, Supporter' })).toBeHidden();
	await selectWorker(page, 'Ada Lovelace');
	await expect(ada.getByRole('button', { name: 'Grace Hopper, Supporter' })).toBeHidden();
});

test('the add list leaves out the worker and their relationships, filters by name and shows the first Category answer', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Add relationship' }).click();
	const list = ada.getByRole('list', { name: 'Workers you can relate' });
	// Not Ada herself.
	await expect(list.getByRole('button')).toHaveCount(2);
	await expect(list).not.toContainText('Ada Lovelace');
	// The first Category answer tells similar workers apart.
	await expect(list.getByRole('button', { name: /^Grace Hopper/ })).toContainText('Front of House');

	// Typing narrows by name.
	await ada.getByRole('searchbox', { name: 'Search workers to relate' }).fill('kath');
	await expect(list.getByRole('button')).toHaveCount(1);
	await expect(list).toContainText('Katherine Johnson');

	// Escape closes the list and focus returns to the opener.
	await page.keyboard.press('Escape');
	await expect(list).toBeHidden();
	await expect(ada.getByRole('button', { name: 'Add relationship' })).toBeFocused();

	// Someone already related is no longer offered.
	await ada.getByRole('button', { name: 'Add relationship' }).click();
	await list.getByRole('button', { name: /^Grace Hopper/ }).click();
	await ada.getByRole('button', { name: 'Add relationship' }).click();
	await expect(list.getByRole('button')).toHaveCount(1);
	await expect(list).not.toContainText('Grace Hopper');
	await ada.getByRole('button', { name: 'Done' }).click();
	await expect(list).toBeHidden();
});

/** The seeded Workers, with two more worksite Agitations; Ada holds only "Pay". */
const seedWithHoursAndSundays = async (request: APIRequestContext) => {
	await seedInspectorWorkers(request);
	for (const text of ['Hours', 'Sundays off']) {
		const created = await request.post('/api/agitations', { data: { text } });
		expect(created.ok(), await created.text()).toBeTruthy();
	}
};

/**
 * Adding an Agitation (qf-004, ticket 01): the same inline panel as Add Relationship.
 * It lists the worksite's Agitations this Worker does not hold, filtered as the
 * organizer types, with a top row that creates one from the typed text.
 */
test('Add agitation lists the unheld worksite Agitations, and typing filters them', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedWithHoursAndSundays });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Add agitation' }).click();
	const list = ada.getByRole('list', { name: 'Agitations you can add' });
	// Pay is held by Ada, so only the other two are offered.
	await expect(list.getByRole('button')).toHaveCount(2);
	await expect(list).not.toContainText('Pay');

	await ada.getByRole('searchbox', { name: 'Agitation' }).fill('sun');
	await expect(list.getByRole('button')).toHaveCount(1);
	await expect(list).toContainText('Sundays off');

	// Escape closes the panel and focus returns to the opener.
	await page.keyboard.press('Escape');
	await expect(list).toBeHidden();
	await expect(ada.getByRole('button', { name: 'Add agitation' })).toBeFocused();
});

test('the top row is disabled while the box is empty, and absent on an exact match', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedWithHoursAndSundays });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Add agitation' }).click();
	const search = ada.getByRole('searchbox', { name: 'Agitation' });
	await expect(
		ada.getByRole('button', { name: 'Type a name to add a new agitation' })
	).toBeDisabled();

	// Exact matches are existing Agitations, held or not, so no add row appears.
	const addRow = ada.getByRole('button', { name: /as a new agitation/ });
	await search.fill('pay');
	await expect(addRow).toHaveCount(0);
	await search.fill('HOURS');
	await expect(addRow).toHaveCount(0);
	await expect(
		ada.getByRole('list', { name: 'Agitations you can add' }).getByRole('button', { name: 'Hours' })
	).toBeVisible();

	// A new name offers the add row with the typed text, trimmed.
	await search.fill('  Quiet hours ');
	await expect(
		ada.getByRole('button', { name: 'Add "Quiet hours" as a new agitation' })
	).toBeVisible();

	// Done closes the panel and focus returns to the opener.
	await ada.getByRole('button', { name: 'Done' }).click();
	await expect(search).toBeHidden();
	await expect(ada.getByRole('button', { name: 'Add agitation' })).toBeFocused();
});

test('choosing the top row creates the Agitation once, assigns it, and closes the panel', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedWithHoursAndSundays });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	const countBefore = (await (await request.get('/api/dataset')).json()).agitations.length;

	await ada.getByRole('button', { name: 'Add agitation' }).click();
	await ada.getByRole('searchbox', { name: 'Agitation' }).fill('Quiet hours');
	await ada.getByRole('button', { name: 'Add "Quiet hours" as a new agitation' }).click();

	await expect(ada.getByRole('button', { name: 'Remove agitation Quiet hours' })).toBeVisible();
	await expect(ada.getByRole('searchbox', { name: 'Agitation' })).toBeHidden();
	await expect(ada.getByRole('button', { name: 'Add agitation' })).toBeFocused();
	await expect(ada.getByText("Added to the worksite's agitations").first()).toBeVisible();
	await expect(page.getByTestId('status-line')).toContainText('Added agitation for Ada Lovelace');
	const dataset = await (await request.get('/api/dataset')).json();
	expect(dataset.agitations).toHaveLength(countBefore + 1);
});

test('a refused create keeps the panel open with the retry message and the typed text', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedWithHoursAndSundays });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');

	await ada.getByRole('button', { name: 'Add agitation' }).click();
	await ada.getByRole('searchbox', { name: 'Agitation' }).fill('Quiet hours');
	await page.route('**/api/agitations', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		await route.fulfill({ status: 500, json: { message: 'Synthetic agitation create failure.' } });
	});
	await ada.getByRole('button', { name: 'Add "Quiet hours" as a new agitation' }).click();

	await expect(ada.getByRole('alert')).toContainText('Could not add the Agitation. Try again.');
	await expect(ada.getByRole('searchbox', { name: 'Agitation' })).toHaveValue('Quiet hours');
	await expect(ada.getByRole('button', { name: 'Remove agitation Quiet hours' })).toHaveCount(0);
	await page.unroute('**/api/agitations');
});

/**
 * Removing an Agitation (ticket 17). The chip's × unassigns it from this Worker only;
 * the worksite's Agitation and other Workers' assignments stay, and Undo assigns it
 * again to the Worker the removal started on.
 */
test('typing an existing Agitation assigns it without changing Configuration', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	const dataset = await (await request.get('/api/dataset')).json();
	const adaRecord = (dataset.workers as { id: string; [key: string]: unknown }[]).find(
		(worker) => worker.name === 'Ada Lovelace'
	)!;
	const updated = await request.put(`/api/workers/${adaRecord.id}`, {
		data: { ...workerUpdateFrom(adaRecord), agitations: [] }
	});
	expect(updated.ok(), await updated.text()).toBeTruthy();
	await page.reload();
	await appReady(page);
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	const countBefore = dataset.agitations.length;

	await ada.getByRole('button', { name: 'Add agitation' }).click();
	const input = ada.getByRole('searchbox', { name: 'Agitation' });
	await input.fill('  pAy  ');
	await expect(
		ada.getByRole('list', { name: 'Agitations you can add' }).getByRole('button', { name: 'Pay' })
	).toBeVisible();
	// Enter on a name that matches an existing Agitation assigns that one.
	await input.press('Enter');

	await expect(ada.getByRole('button', { name: 'Remove agitation Pay' })).toBeVisible();
	await expect(input).toBeHidden();
	await expect(page.getByTestId('status-line')).toContainText('Added agitation for Ada Lovelace');
	expect((await (await request.get('/api/dataset')).json()).agitations).toHaveLength(countBefore);
});

test('typing a new Agitation creates it once, reports shared vocabulary, and Undo only unassigns it', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	await ada.getByRole('button', { name: 'Add agitation' }).click();
	const input = ada.getByRole('searchbox', { name: 'Agitation' });
	await input.fill('Closed on Sundays');
	await input.press('Enter');

	await expect(
		ada.getByRole('button', { name: 'Remove agitation Closed on Sundays' })
	).toBeVisible();
	await expect(input).toBeHidden();
	await expect(ada.getByRole('button', { name: 'Add agitation' })).toBeFocused();
	await expect(ada.getByText("Added to the worksite's agitations").first()).toBeVisible();
	await expect(page.getByTestId('status-line')).toContainText('Added agitation for Ada Lovelace');
	const configuration = await page.context().newPage();
	await configuration.goto('/configuration');
	await expect(configuration.getByText('Closed on Sundays', { exact: true })).toBeVisible();

	await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();
	await expect(ada.getByRole('button', { name: 'Remove agitation Closed on Sundays' })).toHaveCount(
		0
	);
	await expect((await (await request.get('/api/dataset')).json()).agitations).toHaveLength(2);
	await expect(configuration.getByText('Closed on Sundays', { exact: true })).toBeVisible();
	await configuration.close();
});

test('removing an Agitation leaves other workers alone, and Undo assigns it again', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	await expect(ada.getByRole('listitem').filter({ hasText: 'Pay' })).toBeVisible();

	await ada.getByRole('button', { name: 'Remove agitation Pay' }).click();
	await expect(ada.getByText('No agitations')).toHaveCount(0);
	await expect(ada.getByRole('button', { name: 'Add agitation' })).toBeVisible();
	await expect(page.getByTestId('status-line')).toContainText('Removed agitation for Ada Lovelace');

	// Grace still has hers, and the worksite still lists the Agitation.
	await selectWorker(page, 'Grace Hopper');
	const grace = inspector(page, 'Grace Hopper');
	await expect(grace.getByRole('button', { name: 'Remove agitation Pay' })).toBeVisible();
	const dataset = await (await request.get('/api/dataset')).json();
	expect(dataset.agitations).toHaveLength(1);

	// Undo with Grace selected still puts the Agitation back on Ada (ticket 25).
	await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();
	await selectWorker(page, 'Ada Lovelace');
	await expect(ada.getByRole('button', { name: 'Remove agitation Pay' })).toBeVisible();

	// And the restored assignment is stored, not just shown.
	await page.reload();
	await appReady(page);
	await selectWorker(page, 'Ada Lovelace');
	await expect(
		inspector(page, 'Ada Lovelace').getByRole('button', { name: 'Remove agitation Pay' })
	).toBeVisible();
});

/** The Name cells of the worker rows, top to bottom. */
const rowNames = async (page: Page) =>
	(await page.locator('tbody tr[data-worker-id] td[data-pin="name"]').allInnerTexts()).map((text) =>
		text.trim()
	);

test('New Worker creates a named Worker in name order and keeps it selected', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	const dataset = (await (await request.get('/api/dataset')).json()) as {
		attributes: { id: string; name: string }[];
	};
	const department = dataset.attributes.find((attribute) => attribute.name === 'Department')!.id;
	const shifts = dataset.attributes.find((attribute) => attribute.name === 'Shifts')!.id;

	await page.getByRole('button', { name: 'New Worker', exact: true }).click();
	await expect(page.getByTestId('new-worker-row')).toContainText('Unnamed worker');
	const creating = inspector(page, 'Unnamed worker');
	const name = creating.getByLabel('Name');
	await expect(name).toBeFocused();
	await expect(name).toHaveAttribute('placeholder', 'Add name');

	// The creating panel offers every Attribute before the record exists.
	const creatingDepartment = attributeRow(creating, 'Department', 'record-create-attributes');
	await creatingDepartment.getByRole('button', { name: 'Edit Department', exact: true }).click();
	await creatingDepartment
		.getByRole('combobox', { name: 'Department' })
		.selectOption({ label: 'Back of House' });
	await creatingDepartment.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(creatingDepartment.locator('dd')).toContainText('Back of House');

	const creatingShifts = attributeRow(creating, 'Shifts', 'record-create-attributes');
	await creatingShifts.getByRole('button', { name: 'Edit Shifts', exact: true }).click();
	await creatingShifts.getByRole('checkbox', { name: 'Brunch', exact: true }).check();
	await creatingShifts.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(creatingShifts.locator('dd')).toContainText('Brunch');

	await name.fill('Ada Test');
	await name.press('Enter');

	await expect(inspector(page, 'Ada Test')).toBeVisible();
	await expect(page.getByTestId('new-worker-row')).toHaveCount(0);
	await expect(workerRow(page, 'Ada Test')).toHaveAttribute('aria-current', 'true');
	await expect(page.getByTestId('status-line')).toContainText('Added Ada Test');
	expect(await rowNames(page)).toEqual([
		'Ada Lovelace',
		'Ada Test',
		'Grace Hopper',
		'Katherine Johnson'
	]);

	// The create request carried the chosen answers as their ids.
	const stored = (await (await request.get('/api/dataset')).json()) as {
		workers: {
			name: string;
			assessment: string;
			email: string;
			phone: string;
			attributes: Record<string, string | string[]>;
		}[];
	};
	expect(stored.workers.find((worker) => worker.name === 'Ada Test')).toMatchObject({
		assessment: 'Unassessed',
		email: '',
		phone: '',
		attributes: {
			[department]: answerId(department, 'Back of House'),
			[shifts]: [answerId(shifts, 'Brunch')]
		}
	});
	const created = inspector(page, 'Ada Test');
	await expect(attributeReading(created, 'Department')).toContainText('Back of House');
	await expect(attributeReading(created, 'Shifts')).toContainText('Brunch');
});

test('Escape on New Worker removes the placeholder and selects the previous Worker again', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Grace Hopper');
	// The open record panel may cover New Worker; this test is about Escape, not reachability.
	await page.getByRole('button', { name: 'New Worker', exact: true }).dispatchEvent('click');
	const name = inspector(page, 'Unnamed worker').getByLabel('Name');
	await expect(name).toBeFocused();
	await name.press('Escape');

	await expect(page.getByTestId('new-worker-row')).toHaveCount(0);
	await expect(inspector(page, 'Grace Hopper')).toBeVisible();
	await expect(workerRow(page, 'Grace Hopper')).toHaveAttribute('aria-current', 'true');
	const stored = (await (await request.get('/api/dataset')).json()) as { workers: unknown[] };
	expect(stored.workers).toHaveLength(3);
});

test('Undo after New Worker deletes the created Worker', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await page.getByRole('button', { name: 'New Worker', exact: true }).click();
	const name = inspector(page, 'Unnamed worker').getByLabel('Name');
	await name.fill('Ada Test');
	await name.press('Enter');
	await expect(inspector(page, 'Ada Test')).toBeVisible();
	// Undo must reach the created Worker even after the selection has moved (ticket 25).
	await selectWorker(page, 'Grace Hopper');
	await page.getByTestId('status-line').getByRole('button', { name: 'Undo' }).click();

	await expect(workerRow(page, 'Ada Test')).toHaveCount(0);
	const stored = (await (await request.get('/api/dataset')).json()) as {
		workers: { name: string }[];
	};
	expect(stored.workers.some((worker) => worker.name === 'Ada Test')).toBe(false);
});

test('a malformed Email is refused in the panel and the stored address stays', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	await ada.getByRole('button', { name: 'Edit email' }).click();
	await ada.getByLabel('Email').fill('not-an-email');
	await ada.getByLabel('Email').press('Enter');
	await expect(ada.getByRole('alert')).toHaveText(
		"That doesn't look like an email address. Check it, then save."
	);
	await expect(ada.getByLabel('Email')).toHaveValue('not-an-email');
	const stored = (await (await request.get('/api/dataset')).json()) as {
		workers: { name: string; email: string }[];
	};
	expect(stored.workers.find((worker) => worker.name === 'Ada Lovelace')?.email).toBe(
		'ada@example.test'
	);
});

test('saving for a Worker deleted elsewhere says so and keeps the typing', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const ada = inspector(page, 'Ada Lovelace');
	await page.route('**/api/workers/*', (route) =>
		route.request().method() === 'PATCH'
			? route.fulfill({
					status: 404,
					contentType: 'application/json',
					body: JSON.stringify({ message: 'Worker not found.', code: 'worker_not_found' })
				})
			: route.continue()
	);
	await ada.getByRole('button', { name: 'Edit email' }).click();
	await ada.getByLabel('Email').fill('new@example.test');
	await ada.getByLabel('Email').press('Enter');
	await expect(ada.getByRole('alert')).toHaveText(
		'This worker was deleted, so the change could not be saved.'
	);
	await expect(ada.getByLabel('Email')).toHaveValue('new@example.test');
});

test('a legacy worker id in the URL is ignored and stripped; the open record survives in-app return and clears on reload', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	// The panel DOM id is worker-<id>-details; read the Worker id from it.
	const domId = await inspector(page, 'Ada Lovelace').getAttribute('id');
	const adaId = domId?.replace(/^worker-/, '').replace(/-details$/, '') ?? '';
	expect(adaId).not.toBe('');

	// In-app navigation away and back keeps the private selection.
	await page.getByRole('link', { name: 'Mapping', exact: true }).first().click();
	await waitForMapReady(page);
	await page.getByRole('link', { name: 'Workers', exact: true }).first().click();
	await appReady(page);
	await expect(inspector(page, 'Ada Lovelace')).toBeVisible();
	expect(new URL(page.url()).searchParams.has('worker')).toBe(false);

	// A reload drops it; a legacy link neither selects nor keeps the parameter.
	await page.goto(`/workers?worker=${adaId}&q=Ada&sel=${adaId}`);
	await appReady(page);
	await expect(anyInspector(page)).toHaveCount(0);
	await expect
		.poll(() => [...new URL(page.url()).searchParams.keys()].filter((key) => key !== 'f'))
		.toEqual([]);
});

test('the collapsed Note composer shows a border and is not disabled', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers });
	await selectWorker(page, 'Ada Lovelace');
	const composer = inspector(page, 'Ada Lovelace').getByRole('textbox', { name: 'Note' });
	await expect(composer).toBeEnabled();
	await expect(composer).toHaveCSS('border-top-width', '1px');
	await expect(composer).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
});
test.describe('E6 folds product-gap-06 selected Worker', () => {
	type Seeded = {
		departmentId: string;
		rolesId: string;
		workerIds: Record<string, string>;
	};

	async function seedFixture(request: APIRequestContext): Promise<Seeded> {
		const [departmentId, rolesId] = await addAttributes(request, [
			{
				name: 'Department',
				kind: 'category',
				options: ['Packing', 'Delivery', 'No Department']
			},
			{ name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
		]);
		const [english, spanish] = await addLanguages(request, ['English', 'Spanish']);
		const [equipment, schedule] = await addAgitations(request, ['Equipment', 'Schedule']);
		const created = await addWorkers(request, [
			{
				name: 'Alex',
				assessment: 'Leader',
				attributes: { [departmentId]: 'Packing', [rolesId]: ['Trainer'] },
				languages: [english],
				agitations: [equipment]
			},
			{
				name: 'Blair',
				assessment: 'Supporter',
				attributes: { [departmentId]: 'Delivery', [rolesId]: ['Trainer', 'Steward'] },
				languages: [spanish],
				agitations: [schedule],
				// A contact field and a Note that name Alex and Equipment; Name search must not read them.
				email: 'alex@example.test',
				notes: [
					{
						id: 'note-blair',
						text: 'Alex asked about Equipment',
						timestamp: '2024-01-01T00:00:00.000Z'
					}
				]
			},
			{
				name: 'Casey',
				assessment: 'Unassessed',
				attributes: { [departmentId]: '', [rolesId]: [] },
				languages: [english, spanish],
				agitations: [equipment]
			},
			{
				name: 'Drew',
				assessment: 'Activist',
				attributes: { [departmentId]: 'No Department', [rolesId]: ['Steward'] }
			}
		]);
		const names = ['Alex', 'Blair', 'Casey', 'Drew'];
		const workerIds = Object.fromEntries(names.map((name, index) => [name, created[index]]));

		return { departmentId, rolesId, workerIds };
	}
	const count = (page: Page) => page.getByTestId('worker-count');

	async function openFilter(page: Page, attributeName: string): Promise<void> {
		await page.getByRole('button', { name: `Filter ${attributeName}`, exact: true }).click();
	}

	/** The system No Department choice, present even when a real answer reads the same. */

	/** The real answer literally named No Department. */
	test('@product-gap-06 filter changes keep the selected Worker open and out of the address', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openWorkers(page, `/workers?missing=${seeded.departmentId}`);
		await selectWorker(page, 'Casey');
		await expect(page.getByRole('complementary', { name: 'Worker details: Casey' })).toBeVisible();
		await expect(count(page)).toHaveText('1 worker');

		await openFilter(page, 'Department');
		await page.getByRole('menuitemcheckbox', { name: 'Delivery, 1 worker', exact: true }).click();
		await page.keyboard.press('Escape');

		// The unrelated selection stays in the address while the filter changes.
		const afterFilter = new URL(page.url());
		expect(afterFilter.searchParams.has('worker')).toBe(false);
		expect(afterFilter.searchParams.getAll('missing')).toEqual([seeded.departmentId]);
		expect(afterFilter.searchParams.getAll('f')).toEqual([
			`${seeded.departmentId}:${answerId(seeded.departmentId, 'Delivery')}`
		]);
		await expect(count(page)).toHaveText('2 workers');

		await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
		const afterClear = new URL(page.url());
		expect(afterClear.searchParams.has('worker')).toBe(false);
		expect(afterClear.searchParams.getAll('f')).toEqual([]);
		expect(afterClear.searchParams.getAll('missing')).toEqual([]);
		await expect(count(page)).toHaveText('4 workers');
	});
});

test.describe('E6 folds product-gap-08 selected Worker', () => {
	type Seeded = {
		departmentId: string;
		rolesId: string;
		agitations: Record<string, string>;
		workerIds: Record<string, string>;
	};

	async function seedFixture(request: APIRequestContext): Promise<Seeded> {
		const [departmentId, rolesId] = await addAttributes(request, [
			{
				name: 'Department',
				kind: 'category',
				options: ['Packing', 'Delivery', 'No Department']
			},
			{ name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
		]);
		const [english, spanish] = await addLanguages(request, ['English', 'Spanish']);
		const [equipment, schedule] = await addAgitations(request, ['Equipment', 'Schedule']);
		const created = await addWorkers(request, [
			{
				name: 'Alex',
				assessment: 'Leader',
				attributes: { [departmentId]: 'Packing', [rolesId]: ['Trainer'] },
				languages: [english],
				agitations: [equipment]
			},
			{
				name: 'Blair',
				assessment: 'Supporter',
				attributes: { [departmentId]: 'Delivery', [rolesId]: ['Trainer', 'Steward'] },
				languages: [spanish],
				agitations: [schedule],
				// A contact field and a Note that name Alex and Equipment; Name search must not read them.
				email: 'alex@example.test',
				notes: [
					{
						id: 'note-blair',
						text: 'Alex asked about Equipment',
						timestamp: '2024-01-01T00:00:00.000Z'
					}
				]
			},
			{
				name: 'Casey',
				assessment: 'Unassessed',
				attributes: { [departmentId]: '', [rolesId]: [] },
				languages: [english, spanish],
				agitations: [equipment]
			},
			{
				name: 'Drew',
				assessment: 'Activist',
				attributes: { [departmentId]: 'No Department', [rolesId]: ['Steward'] }
			}
		]);
		const names = ['Alex', 'Blair', 'Casey', 'Drew'];
		const workerIds = Object.fromEntries(names.map((name, index) => [name, created[index]]));
		const agitations = { Equipment: equipment, Schedule: schedule };

		return { departmentId, rolesId, agitations, workerIds };
	}
	const count = (page: Page) => page.getByTestId('worker-count');

	/** The desktop toolbar Filters menu, opened. */
	async function openFiltersMenu(page: Page): Promise<void> {
		// Keyboard-open: an open Worker card can sit over the toolbar's right edge.
		await page.getByRole('button', { name: /^Filters/ }).focus();
		await page.keyboard.press('Enter');
	}

	/** The Agitations submenu of the desktop Filters menu. */
	async function openAgitations(page: Page): Promise<void> {
		await openFiltersMenu(page);
		await page.getByRole('menuitem', { name: /^Agitations/ }).click();
	}

	/** Closes every open menu layer, submenus first. */
	async function closeMenus(page: Page): Promise<void> {
		while ((await page.getByRole('menu').count()) > 0) {
			await page.keyboard.press('Escape');
		}
	}

	async function chooseAgitation(page: Page, text: string): Promise<void> {
		await page.getByRole('menuitemcheckbox', { name: text, exact: true }).click();
	}
	test('@product-gap-08 changing the Agitation facet preserves the selected Worker in the address', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openWorkers(page, `/workers?agitation=${seeded.agitations.Equipment}`);
		await selectWorker(page, 'Casey');
		await expect(page.getByRole('complementary', { name: 'Worker details: Casey' })).toBeVisible();
		await expect(count(page)).toHaveText('2 workers');

		await openAgitations(page);
		await chooseAgitation(page, 'Schedule');
		await closeMenus(page);

		const after = new URL(page.url());
		expect(after.searchParams.has('worker')).toBe(false);
		expect(after.searchParams.getAll('agitation')).toEqual([
			seeded.agitations.Equipment,
			seeded.agitations.Schedule
		]);
		await expect(count(page)).toHaveText('3 workers');
	});
});

test.describe('E6 folds product-gap-10 Languages card', () => {
	type Seeded = { languages: Record<string, string>; workerIds: Record<string, string> };

	const record = (page: Page) => page.getByRole('region', { name: 'Worker record' });

	async function seedFixture(request: APIRequestContext): Promise<Seeded> {
		const [departmentId] = await addAttributes(request, [
			{ name: 'Department', kind: 'category', options: ['Packing'] }
		]);
		const [english, spanish] = await addLanguages(request, ['English', 'Spanish']);
		const languages = { English: english, Spanish: spanish };
		const names = ['Alex', 'Blair', 'Casey', 'Drew'];
		const created = await addWorkers(request, [
			{
				name: 'Alex',
				assessment: 'Leader',
				attributes: { [departmentId]: 'Packing' },
				languages: [languages.English]
			},
			{
				name: 'Blair',
				assessment: 'Supporter',
				attributes: { [departmentId]: 'Packing' },
				languages: [languages.Spanish]
			},
			{
				name: 'Casey',
				assessment: 'Unassessed',
				attributes: { [departmentId]: 'Packing' },
				languages: [languages.English, languages.Spanish]
			},
			{
				name: 'Drew',
				assessment: 'Activist',
				attributes: { [departmentId]: 'Packing' }
			}
		]);
		const workerIds = Object.fromEntries(names.map((name, index) => [name, created[index]]));

		return { languages, workerIds };
	}

	async function openMapping(page: Page): Promise<void> {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/mapping');
		await waitForMapReady(page, 15000);
		await expect(page.getByRole('region', { name: 'Map table' })).toBeAttached();
	}

	async function selectWorker(page: Page, name: string): Promise<void> {
		await page.locator('[data-map-table-row]').filter({ hasText: name }).dispatchEvent('click');
		await expect(record(page)).toContainText(name);
	}
	test('@product-gap-10 the card lists the recorded Languages in vocabulary order', async ({
		page,
		request
	}) => {
		await seedFixture(request);
		await openMapping(page);

		await selectWorker(page, 'Alex');
		await expect(record(page)).toContainText('Languages');
		await expect(record(page)).toContainText('English');
		await expect(record(page)).not.toContainText('Spanish');

		await selectWorker(page, 'Blair');
		await expect(record(page)).toContainText('Spanish');
		await expect(record(page)).not.toContainText('English');

		// Two recorded Languages keep both, in Worksite vocabulary order (English, Spanish).
		await selectWorker(page, 'Casey');
		await expect(record(page)).toContainText('English, Spanish');

		// Moving selection does not retain the previous Worker's Languages.
		await selectWorker(page, 'Drew');
		await expect(record(page)).toContainText('No languages recorded.');
		await expect(record(page)).not.toContainText('English');
		await expect(record(page)).not.toContainText('Spanish');

		// Existing actions stay available.
		await expect(record(page).getByRole('button', { name: 'Isolate' })).toBeVisible();
		await expect(record(page).getByRole('link', { name: 'Open in Workers' })).toBeVisible();
	});

	test('@product-gap-10 renaming a Language updates its name without changing assignments', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openMapping(page);
		await selectWorker(page, 'Casey');
		await expect(record(page)).toContainText('English, Spanish');

		// Rename the whole Language set through the normal save shape, ids unchanged.
		const listed = await request.get('/api/languages');
		const current = (await listed.json()) as { languages: { id: string; name: string }[] };
		const renamed = await request.put('/api/languages', {
			data: current.languages.map((language) =>
				language.id === seeded.languages.Spanish ? { ...language, name: 'Español' } : language
			)
		});
		expect(renamed.ok(), await renamed.text()).toBeTruthy();

		await page.reload();
		await waitForMapReady(page, 15000);
		// A reload clears the private selection, so Casey is selected again.
		await expect(record(page)).toHaveCount(0);
		await selectWorker(page, 'Casey');
		await expect(record(page)).toContainText('English, Español');
		await expect(record(page)).not.toContainText('Spanish');

		// Blair still holds the renamed Language, and Drew still holds none.
		await selectWorker(page, 'Blair');
		await expect(record(page)).toContainText('Español');
		await selectWorker(page, 'Drew');
		await expect(record(page)).toContainText('No languages recorded.');
	});

	test('@product-gap-10 reading Languages issues no mutation requests', async ({
		page,
		request
	}) => {
		await seedFixture(request);
		const mutations: string[] = [];
		page.on('request', (mutation) => {
			const method = mutation.method();
			if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && mutation.url().includes('/api/')) {
				mutations.push(`${method} ${mutation.url()}`);
			}
		});

		await openMapping(page);
		await selectWorker(page, 'Alex');
		await selectWorker(page, 'Casey');
		await selectWorker(page, 'Drew');

		expect(mutations).toEqual([]);
	});
});
