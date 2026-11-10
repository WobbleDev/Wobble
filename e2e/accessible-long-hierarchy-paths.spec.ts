import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test, clippedContent, scrollableOverflow } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { choose, optionLabels } from './select.ts';
import { nextFrames } from './frames.ts';
import { waitForMapReady } from './map.ts';
import { closeAttributeEditor, openAttributeEditor } from './configuration-outline.ts';

/**
 * Ticket 27: long workplace paths, translated labels, larger text and keyboard-only
 * workflows stay usable across Configuration, Workers, Overview and Mapping.
 *
 * The fixture names every branch with a full workplace sentence, and repeats two leaf
 * labels on purpose: "Packing and Fulfilment" sits under two different Central campuses
 * and "Front of House Team" under two divisions. A path is therefore the only way to
 * tell those answers apart, at every place the interface offers or reads one.
 */

const NORTH = 'Northern Coastal Distribution and Logistics Division';
const SOUTH = 'Southern Regional Distribution and Logistics Division';
const CENTRAL = 'Central Fulfilment and Receiving Campus';
const STORE_A = 'Store A — Riverside Loading Dock and Night Receiving';
const LEAF = 'Packing and Fulfilment';
const OPS = 'Operations and Workplace Support Division';
const REGIONAL = 'Regional Support and Logistics Division';
const FRONT = 'Front of House Team';
const BACK = 'Back of House Team';

const path = (...parts: string[]) => parts.join(' / ');
const northLeafPath = path(NORTH, CENTRAL, STORE_A, LEAF);
const northCentralLeafPath = path(NORTH, CENTRAL, LEAF);
const southLeafPath = path(SOUTH, CENTRAL, LEAF);
const northCentralPath = path(NORTH, CENTRAL);
const northStoreAPath = path(NORTH, CENTRAL, STORE_A);
const frontAPath = path(OPS, FRONT);
const frontBPath = path(REGIONAL, FRONT);

type Seeded = {
	locationId: string;
	jobId: string;
	departmentId: string;
	answers: Record<
		| 'north'
		| 'northCentral'
		| 'northStoreA'
		| 'northLeaf'
		| 'northCentralLeaf'
		| 'south'
		| 'southCentral'
		| 'southLeaf'
		| 'cashier'
		| 'stocker'
		| 'ops'
		| 'regional'
		| 'frontA'
		| 'backA'
		| 'frontB',
		string
	>;
	workers: Record<string, string>;
};

/** Seeds the long hierarchical vocabulary and six Workers through the request boundary. */
async function seed(
	request: APIRequestContext,
	options: { caseySecondLocation?: boolean } = {}
): Promise<Seeded> {
	const locationId = 'location-' + randomUUID();
	const jobId = 'job-' + randomUUID();
	const departmentId = 'department-' + randomUUID();
	const id = (text: string) => text + '-' + randomUUID().slice(0, 8);
	const answers = {
		north: id('north'),
		northCentral: id('north-central'),
		northStoreA: id('north-store-a'),
		northLeaf: id('north-leaf'),
		northCentralLeaf: id('north-central-leaf'),
		south: id('south'),
		southCentral: id('south-central'),
		southLeaf: id('south-leaf'),
		cashier: id('cashier'),
		stocker: id('stocker'),
		ops: id('ops'),
		regional: id('regional'),
		frontA: id('front-a'),
		backA: id('back-a'),
		frontB: id('front-b'),
		teamLead: id('team-lead')
	};

	const configured = await request.put('/api/attributes', {
		data: [
			{
				id: locationId,
				name: 'Location',
				kind: 'tag',
				options: [
					{ id: answers.north, value: NORTH },
					{ id: answers.northCentral, value: CENTRAL, parentId: answers.north },
					{ id: answers.northStoreA, value: STORE_A, parentId: answers.northCentral },
					{ id: answers.northLeaf, value: LEAF, parentId: answers.northStoreA },
					{ id: answers.northCentralLeaf, value: LEAF, parentId: answers.northCentral },
					{ id: answers.south, value: SOUTH },
					{ id: answers.southCentral, value: CENTRAL, parentId: answers.south },
					{ id: answers.southLeaf, value: LEAF, parentId: answers.southCentral }
				]
			},
			{
				id: jobId,
				name: 'Job',
				kind: 'tag',
				options: [
					{ id: answers.cashier, value: 'Cashier' },
					{ id: answers.stocker, value: 'Stocker' }
				]
			},
			{
				id: departmentId,
				name: 'Department',
				kind: 'category',
				options: [
					{ id: answers.ops, value: OPS },
					{ id: answers.frontA, value: FRONT, parentId: answers.ops },
					{ id: answers.teamLead, value: 'Team Lead', parentId: answers.frontA },
					{ id: answers.backA, value: BACK, parentId: answers.ops },
					{ id: answers.regional, value: REGIONAL },
					{ id: answers.frontB, value: FRONT, parentId: answers.regional }
				]
			}
		]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	type Person = {
		key: string;
		name: string;
		department: string;
		locations: string[];
		jobs: string[];
	};
	const people: Person[] = [
		{
			key: 'casey',
			name: 'Rachel Carson',
			department: answers.frontA,
			locations:
				options.caseySecondLocation === false
					? [answers.northLeaf]
					: [answers.northLeaf, answers.southLeaf],
			jobs:
				options.caseySecondLocation === false
					? [answers.cashier]
					: [answers.cashier, answers.stocker]
		},
		{
			key: 'drew',
			name: 'Enrico Fermi',
			department: answers.frontA,
			locations: [answers.northCentralLeaf],
			jobs: [answers.cashier]
		},
		{
			key: 'erin',
			name: 'Florence Nightingale',
			department: answers.backA,
			locations: [answers.north],
			jobs: [answers.stocker]
		},
		{
			key: 'frankie',
			name: 'Nikola Tesla',
			department: answers.frontB,
			locations: [answers.south],
			jobs: [answers.cashier]
		},
		{ key: 'gray', name: 'Srinivasa Ramanujan', department: answers.ops, locations: [], jobs: [] },
		{
			key: 'hana',
			name: 'Sophie Germain',
			department: answers.backA,
			// A known Job with no Location is an ordinary missing Attribute value.
			locations: [],
			jobs: [answers.cashier]
		}
	];

	const workers: Record<string, string> = {};
	for (const person of people) {
		const created = await request.post('/api/workers', {
			data: {
				name: person.name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: {
					[departmentId]: person.department,
					[locationId]: person.locations,
					[jobId]: person.jobs
				},
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
		workers[person.key] = ((await created.json()) as { worker: { id: string } }).worker.id;
	}

	return { locationId, jobId, departmentId, answers, workers };
}

/**
 * Opens a route and waits for the shell. The first load after a fresh e2e server
 * can be slower than the shared five-second expectation, so this ticket's runs use
 * a wider mount window rather than a retry.
 */
async function openPage(page: Page, path: string): Promise<void> {
	await page.goto(path);
	await expect(page.locator('#splash')).toHaveCount(0, { timeout: 20_000 });
	await expect(page.locator('main')).toBeVisible({ timeout: 20_000 });
}

/** The document's own horizontal overflow; a value may never widen the page. */
function documentOverflow(page: Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

/** The page widens only while a closing popover fades; the settled surface must not. */
function expectNoPageOverflow(page: Page) {
	return expect.poll(() => documentOverflow(page)).toBeLessThanOrEqual(1);
}

/** Whether a block/flex label's text is cut off sideways (an ellipsis hides its tail). */
async function horizontallyClipped(label: Locator): Promise<boolean> {
	return label.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
}

async function applyLargerText(page: Page): Promise<void> {
	await page.evaluate(() => {
		document.documentElement.dataset.textSize = '150';
	});
	await nextFrames(page, 3);
}

function panel(page: Page, name: string): Locator {
	return page.getByRole('complementary', { name: 'Worker details: ' + name });
}

test('Configuration keeps same-named branches tellable by path and reachable by keyboard', async ({
	page,
	request
}) => {
	await seed(request);
	await page.setViewportSize({ width: 1024, height: 640 });
	await openPage(page, '/configuration');
	const attributeEditor = await openAttributeEditor(page, 'Location');

	const editor = attributeEditor.getByTestId('attribute-answers');
	// Values lead with their leaf; full paths remain available from the value title and control names.
	for (const label of [northLeafPath, northCentralLeafPath, southLeafPath]) {
		const value = editor.getByTitle(label, { exact: true });
		await expect(value).toBeVisible();
		await expect(value).toHaveAttribute('title', label);
		await expect(value).toContainText(label.split(' / ').at(-1)!);
	}
	// The two same-named answers are separate controls, named by their paths.
	const removeNorth = attributeEditor.getByRole('button', {
		name: 'Remove ' + northLeafPath,
		exact: true
	});
	await expect(removeNorth).toHaveCount(1);
	await expect(
		attributeEditor.getByRole('button', { name: 'Remove ' + northCentralLeafPath, exact: true })
	).toHaveCount(1);
	await expect(
		attributeEditor.getByRole('button', { name: 'Edit ' + northLeafPath, exact: true })
	).toHaveCount(1);

	// Pending placement uses the same full paths as the hierarchy, so a keyboard
	// reader chooses a branch rather than a short, ambiguous leaf label.
	const newOption = attributeEditor.getByRole('textbox', { name: 'Add an option to Location' });
	await newOption.fill('Deep receiving team');
	const pendingHandle = attributeEditor.getByRole('button', {
		name: 'Place new value Deep receiving team',
		exact: true
	});
	await pendingHandle.focus();
	await page.keyboard.press('Enter');
	const parentTarget = attributeEditor.getByRole('button', {
		name: 'Place under ' + northStoreAPath,
		exact: true
	});
	await parentTarget.focus();
	await expect(parentTarget).toBeFocused();
	await page.keyboard.press('Enter');
	const addedPath = path(northStoreAPath, 'Deep receiving team');
	const addedValue = editor.getByTitle(addedPath, { exact: true });
	await expect(addedValue).toBeVisible();
	await expect(addedValue).toHaveAttribute('title', addedPath);
	await expect(addedValue).toContainText('Deep receiving team');

	// Removing a parent offers its children a destination named by the full path.
	await attributeEditor
		.getByRole('button', { name: 'Remove ' + northCentralPath, exact: true })
		.click();
	const disposition = attributeEditor.getByTestId('parent-removal-choice');
	await expect(disposition).toBeVisible();
	const destination = attributeEditor.getByRole('combobox', { name: 'Move the children under' });
	await destination.focus();
	await expect(destination).toBeFocused();
	expect(await optionLabels(destination)).toContain(southLeafPath);
	await disposition.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(disposition).toHaveCount(0);

	// Renaming a sibling into a shared leaf name asks before merging, and the
	// confirmation is dismissible from the keyboard.
	await attributeEditor.getByRole('button', { name: 'Edit ' + STORE_A, exact: true }).click();
	const rename = attributeEditor.getByRole('textbox', { name: 'Rename ' + STORE_A });
	await rename.fill(LEAF);
	await rename.press('Enter');
	const merge = page.getByRole('alertdialog');
	await expect(merge).toBeVisible();
	await expect(merge).toContainText(LEAF);
	await expect(merge).toContainText('will be merged into the existing');
	expect(await horizontallyClipped(merge)).toBe(false);
	await page.keyboard.press('Escape');
	await expect(merge).toHaveCount(0);

	// Larger text plus the long draft keeps the editor's actions on screen and the
	// page from widening. The editor closes first: its actions sit behind the dialog.
	await closeAttributeEditor(page);
	await applyLargerText(page);
	await expect(page.getByRole('button', { name: 'Discard', exact: true })).toBeVisible();
	await expectNoPageOverflow(page);
});

test('Configuration keeps full-path labels readable on a narrow larger-text outline', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await page.setViewportSize({ width: 640, height: 844 });
	await openPage(page, '/configuration');
	const editor = await openAttributeEditor(page, 'Location');
	await applyLargerText(page);

	const row = editor.locator(`[data-row-id="${seeded.answers.northLeaf}"]`);
	const edit = row.getByRole('button', { name: 'Edit ' + northLeafPath, exact: true });
	const remove = row.getByRole('button', { name: 'Remove ' + northLeafPath, exact: true });
	const leaf = row.getByTitle(northLeafPath, { exact: true });
	const geometry = await leaf.evaluate((leafElement) => {
		const style = getComputedStyle(leafElement);
		const lineHeight =
			Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
		const edit = leafElement.closest<HTMLElement>('[data-action="edit"]');
		const remove = leafElement
			.closest<HTMLElement>('[role="treeitem"]')
			?.querySelector<HTMLElement>('[data-action="remove"]');
		return {
			leafWidth: leafElement.clientWidth,
			leafHeight: leafElement.clientHeight,
			lineHeight,
			editWidth: edit?.getBoundingClientRect().width ?? 0,
			removeWidth: remove?.getBoundingClientRect().width ?? 0,
			removeHeight: remove?.getBoundingClientRect().height ?? 0
		};
	});
	expect(geometry.leafWidth, JSON.stringify(geometry)).toBeGreaterThan(100);
	expect(geometry.leafHeight, JSON.stringify(geometry)).toBeLessThanOrEqual(
		geometry.lineHeight + 1
	);
	expect(geometry.editWidth, JSON.stringify(geometry)).toBeGreaterThan(100);
	// The delete column matches the Attribute row's compact 28px button from the md width up
	// (42px at 150% text), so the floor here is the 24px WCAG 2.2 target size.
	expect(geometry.removeWidth, JSON.stringify(geometry)).toBeGreaterThanOrEqual(24);
	expect(geometry.removeHeight, JSON.stringify(geometry)).toBeGreaterThanOrEqual(24);
	await expect(edit).toBeVisible();
	await expect(remove).toBeVisible();
	await expect(leaf).toHaveAttribute('title', northLeafPath);
	await expect(leaf).toContainText(LEAF);
});

test('Configuration resolution dialogs name the affected path and resolve it by keyboard', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await page.setViewportSize({ width: 1024, height: 640 });
	await openPage(page, '/configuration');
	const attributeEditor = await openAttributeEditor(page, 'Location');

	// Remove the Southern leaf; Casey's saved Worker value holds it.
	await attributeEditor
		.getByRole('button', { name: 'Remove ' + southLeafPath, exact: true })
		.click();
	await closeAttributeEditor(page);
	await page.getByRole('button', { name: 'Save all', exact: true }).click();

	const dialog = page.getByTestId('configuration-preview-dialog');
	await expect(dialog).toBeVisible();
	// The AlertDialog moves focus into the dialog, so a keyboard reader is inside it.
	expect(
		await page.evaluate(
			() => document.activeElement?.closest('[data-testid="configuration-preview-dialog"]') !== null
		)
	).toBe(true);
	expect(await horizontallyClipped(dialog)).toBe(false);

	const resolutions = dialog.getByTestId('configuration-resolutions');
	await expect(resolutions).toBeVisible();
	// The row names the removed path, not just its repeated leaf label.
	await expect(resolutions).toContainText(southLeafPath);
	const select = resolutions.getByRole('combobox').first();
	expect(await select.getAttribute('aria-label')).toContain('Rachel Carson');
	// Replacements are named by their full paths, so the two Packing and Fulfilment
	// leaves are tellable apart in the keyboard-driven option list.
	const options = await optionLabels(select);
	expect(options).toContain('Replace with ' + northCentralLeafPath);

	await select.focus();
	await expect(select).toBeFocused();
	// The choice is made the way an organizer makes it after reaching the control from the keyboard.
	await choose(select, { label: 'Replace with ' + northCentralLeafPath });
	const confirm = dialog.getByRole('button', { name: /^Save (changes|and discard values)/ });
	await confirm.focus();
	await expect(confirm).toBeFocused();
	await confirm.press('Enter');
	await expect(dialog).toHaveCount(0);

	const after = await (await request.get('/api/dataset')).json();
	const casey = after.workers.find(
		(worker: { name: string }) => worker.name === 'Rachel Carson'
	) as { attributes: Record<string, string | string[]> };
	const stored = casey.attributes[seeded.locationId];
	const held = Array.isArray(stored) ? stored : [stored];
	expect(held).toContain(seeded.answers.northCentralLeaf);
	expect(held).not.toContain(seeded.answers.southLeaf);
});

test('Workers Attribute cells and Record panel rows name each path and wrap it at larger text', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await page.setViewportSize({ width: 1024, height: 640 });
	await openPage(page, '/workers');

	const row = page.getByRole('row', { name: /Rachel Carson/ });
	const cell = row.locator(`td[data-column-id="${seeded.locationId}"]`);
	// The ordinary cell names both configured paths, even when its chips clip.
	expect(await cell.getAttribute('aria-label')).toContain(northLeafPath);
	expect(await cell.getAttribute('aria-label')).toContain(southLeafPath);
	const chips = cell.getByTitle(northLeafPath, { exact: true });
	await expect(chips).toBeVisible();
	await expect(cell.getByTitle(southLeafPath, { exact: true })).toBeVisible();

	// Enter on the cell opens the ordinary value menu; Escape gives the cell back.
	await cell.focus();
	await cell.press('Enter');
	await expect(page.getByRole('menu')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(cell).toBeFocused();

	// The record panel reads each stored answer by its path.
	await row
		.getByRole('gridcell', { name: 'Name for Rachel Carson: Rachel Carson', exact: true })
		.click();
	const record = panel(page, 'Rachel Carson');
	await expect(record).toBeVisible();
	const attributes = record.locator('section[aria-labelledby="record-attributes"]');
	const location = attributes.locator('dl > div').filter({ hasText: 'Location' });
	for (const label of [northLeafPath, southLeafPath]) {
		const value = location.locator('.prose-value');
		await expect(value).toContainText(label);
		expect(await horizontallyClipped(value), label + ' is cut off').toBe(false);
	}

	await applyLargerText(page);
	await expectNoPageOverflow(page);
	const largeValue = location.locator('.prose-value');
	await expect(largeValue).toContainText(northLeafPath);
	await expect(largeValue).toContainText(southLeafPath);
	expect(await horizontallyClipped(largeValue), 'the reading is cut off at 150%').toBe(false);
	await expect(location.getByRole('button', { name: 'Edit Location', exact: true })).toBeVisible();
});

test('Overview names long groups by path and keeps its no-scroll surface at larger text', async ({
	page,
	request
}) => {
	await seed(request);
	await page.setViewportSize({ width: 1024, height: 640 });
	await openPage(page, '/overview');

	// Department is the fallback grouping: its long root names render as links
	// carrying the full name in their title, so nothing is lost to truncation.
	const byCard = page.getByRole('region', { name: 'By Department' });
	await expect(byCard).toBeVisible();
	const ops = byCard.getByTitle(OPS, { exact: true });
	await expect(ops).toBeVisible();
	await expect(ops).toHaveAttribute('title', OPS);

	// Keyboard activation opens the group's Workers.
	await ops.focus();
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/\/workers/);
	await appReady(page);
	await expect(page.getByTestId('worker-count')).toBeVisible();
	await page.goBack();
	await appReady(page);

	// The surface still does not scroll and nothing is hidden rather than fitted.
	await expect(byCard).toBeVisible();
	expect(await scrollableOverflow(page)).toBe(0);
	expect(await clippedContent(page)).toEqual([]);
	// The By list keeps room for at least one reading row: actions stay reachable.
	const regionEl = byCard.locator('[data-breakdown-rows]');
	const regionHeight = await regionEl.evaluate((element) => element.clientHeight);
	const firstRowHeight = await regionEl
		.locator('[data-group-row]:not([inert])')
		.first()
		.evaluate((element) => (element instanceof HTMLElement ? element.offsetHeight : 0));
	expect(regionHeight).toBeGreaterThanOrEqual(firstRowHeight);

	await applyLargerText(page);
	await expect(byCard).toBeVisible();
	expect(await scrollableOverflow(page)).toBe(0);
	expect(await clippedContent(page)).toEqual([]);
	await expectNoPageOverflow(page);
});

test('Mapping names long groups in its controls, detail and table without breaking its surface', async ({
	page,
	request
}) => {
	const seeded = await seed(request, { caseySecondLocation: false });
	await page.setViewportSize({ width: 1024, height: 640 });
	await openPage(page, '/mapping?group=' + seeded.departmentId);
	await waitForMapReady(page);

	// The Group control is keyboard operable, and the two Front of House teams are
	// told apart by their full paths in the Filter's option list.
	const groupButton = page.getByRole('button', { name: /^Group:/ });
	await groupButton.focus();
	await groupButton.press('Enter');
	await expect(page.locator('#map-group-by')).toBeVisible();

	const filterButton = page.getByRole('button', { name: 'Filter', exact: true });
	await filterButton.click();
	// An Attribute trigger carries the count of values it is showing, so its accessible
	// name is "Department 6". Scope to the panel, so the sr-only Map table's own
	// "Department" column button can never match instead of the trigger.
	const filterPanel = page.locator('#map-filter-panel');
	const departmentFilter = filterPanel.getByRole('button', { name: /^Department/ });
	await expect(departmentFilter).toHaveCount(1);
	await departmentFilter.focus();
	await departmentFilter.press('Enter');
	const items = page.getByRole('menuitemcheckbox');
	await expect(items.filter({ hasText: frontAPath })).toHaveCount(1);
	await expect(items.filter({ hasText: frontBPath })).toHaveCount(1);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');

	// Expand the Operations branch from the keyboard; its rows keep their full paths.
	if ((await groupButton.getAttribute('aria-expanded')) !== 'true') await groupButton.click();
	const expand = page.locator(
		'[data-testid="map-expansion-primary"] [data-expand-branch="' + seeded.answers.ops + '"]'
	);
	await expect(expand).toBeVisible();
	await expand.focus();
	await expand.press('Enter');
	await expect(expand).toHaveAttribute('aria-expanded', 'true');
	const childLabel = page
		.locator('[data-testid="map-expansion-primary"]')
		.getByText(frontAPath, { exact: true });
	await expect(childLabel).toBeVisible();
	expect(await horizontallyClipped(childLabel), 'mapping expansion is cut off').toBe(false);
	await page.keyboard.press('Escape');

	// The Map table is the same membership and names the same long regions.
	const drawn = await page
		.locator('svg g[role="button"][data-node-id]')
		.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-node-id')).sort());
	const rows = await page
		.locator('[data-map-table-row]')
		.evaluateAll((elements) =>
			elements.map((row) => row.getAttribute('data-map-table-row')).sort()
		);
	expect(rows).toEqual(drawn);
	await expect(page.locator('[data-map-table-row="' + seeded.workers.casey + '"]')).toContainText(
		frontAPath
	);
	await expect(page.locator('[data-map-table-row="' + seeded.workers.gray + '"]')).toContainText(
		OPS
	);

	// Selecting a Worker from the keyboard opens a record that states the full path.
	const caseyNode = page.getByRole('button', { name: /^Rachel Carson, / });
	await caseyNode.focus();
	await caseyNode.press('Enter');
	const record = page.getByRole('region', { name: 'Worker record' });
	await expect(record).toBeVisible();
	await expect(record).toContainText(frontAPath);

	expect(await scrollableOverflow(page)).toBe(0);
	expect(await clippedContent(page)).toEqual([]);
	// Popovers are positioned for the text they opened at; a reader changing Text
	// size navigates to Settings first, so this is a fresh open at the larger size.
	if ((await groupButton.getAttribute('aria-expanded')) === 'true') {
		await groupButton.click();
		await expect(groupButton).toHaveAttribute('aria-expanded', 'false');
		// A closing popover keeps its box while it fades; wait for it to leave the
		// layout so the next measurement describes the surface, not the exit.
		await expect
			.poll(async () =>
				page
					.locator('#map-group-by')
					.evaluate(
						(element) => !element.isConnected || getComputedStyle(element).display === 'none'
					)
					.catch(() => true)
			)
			.toBe(true);
	}
	await applyLargerText(page);
	// The record card is a data-driven card with its own scroll; the map surface
	// itself still neither scrolls nor clips.
	await expect(record).toHaveAttribute('data-scroll-region', '');
	expect(await record.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
		await record.evaluate((element) => element.clientHeight)
	);
	expect(await scrollableOverflow(page)).toBe(0);
	expect(await clippedContent(page)).toEqual([]);
	await expectNoPageOverflow(page);

	// The Group control opened at the larger size stays inside the viewport.
	await groupButton.click();
	await expect(page.locator('#map-group-by')).toBeVisible();
	expect(await scrollableOverflow(page)).toBe(0);
	await expectNoPageOverflow(page);
	await page.keyboard.press('Escape');
});
