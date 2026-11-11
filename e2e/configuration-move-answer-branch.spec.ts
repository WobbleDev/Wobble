import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { createWorkerWithIds, observeWrites, saveDraft, readDataset } from './api.ts';
import { openConfiguration } from './pages.ts';
import { appReady } from './page-ready.ts';
import {
	closeAttributeEditor,
	expandAttribute,
	openAttributeEditor
} from './configuration-outline.ts';

/**
 * Ticket 11: moving an answer branch to another parent. The synthetic fixture is seeded
 * through the API, the real preview and Save routes are exercised, and the move and
 * confirmation are driven through the UI. A preview writes nothing; a confirmed move
 * changes only parent references, so answer ids, order, saved values and drafts survive.
 */

type Ids = {
	location: string;
	central: string;
	north: string;
	storeA: string;
	dock: string;
	centralPacking: string;
	northPacking: string;
};

function ids(): Ids {
	const suffix = randomUUID().slice(0, 8);
	return {
		location: 't11-location-' + suffix,
		central: 't11-central-' + suffix,
		north: 't11-north-' + suffix,
		storeA: 't11-store-a-' + suffix,
		dock: 't11-dock-' + suffix,
		centralPacking: 't11-central-packing-' + suffix,
		northPacking: 't11-north-packing-' + suffix
	};
}

/** Location: Central / Store A / Loading dock, Central / Packing and North / Packing. */
function locationDefinition(id: Ids) {
	return {
		id: id.location,
		name: 'Location',
		kind: 'category',
		options: [
			{ id: id.central, value: 'Central' },
			{ id: id.north, value: 'North' },
			{ id: id.storeA, value: 'Store A', parentId: id.central },
			{ id: id.dock, value: 'Loading dock', parentId: id.storeA },
			{ id: id.northPacking, value: 'Packing', parentId: id.north },
			{ id: id.centralPacking, value: 'Packing', parentId: id.central }
		]
	};
}

async function configure(request: APIRequestContext, id: Ids): Promise<void> {
	const response = await request.put('/api/attributes', {
		data: [locationDefinition(id)]
	});
	expect(response.ok(), await response.text()).toBeTruthy();
}

function draftBody(
	name: string,
	updateAttributes: Record<string, unknown>,
	baseAttributes: Record<string, unknown>
) {
	const contact = {
		name,
		email: name.replace(/\s+/g, '.').toLowerCase() + '@example.com',
		phone: '',
		assessment: 'Unassessed',
		agitations: [],
		languages: [],
		relationships: [],
		notes: []
	};
	return {
		update: { ...contact, attributes: updateAttributes },
		pendingNote: { text: 'keep this note' },
		base: { ...contact, attributes: baseAttributes }
	};
}

type Dataset = {
	attributes: {
		id: string;
		name: string;
		options: { id: string; value: string; parentId?: string }[];
	}[];
	workers: {
		id: string;
		name: string;
		attributes: Record<string, string>;
	}[];
};

async function dataset(request: APIRequestContext): Promise<Dataset> {
	return readDataset<Dataset>(request);
}

function worker(view: Dataset, name: string) {
	const found = view.workers.find((candidate) => candidate.name === name);
	expect(found, name).toBeTruthy();
	return found!;
}

function locationOptions(view: Dataset, id: Ids) {
	const location = view.attributes.find((attribute) => attribute.id === id.location);
	expect(location, 'Location').toBeTruthy();
	return location!.options;
}

async function workerDraft(request: APIRequestContext, workerId: string): Promise<unknown> {
	const response = await request.get('/api/worker-drafts/' + workerId);
	expect(response.ok(), await response.text()).toBeTruthy();
	return (await response.json()).draft as unknown;
}

const saveAll = (page: Page) => page.getByRole('button', { name: 'Save all', exact: true });
const previewDialog = (page: Page) => page.getByTestId('configuration-preview-dialog');
const confirmMove = (page: Page) =>
	previewDialog(page).getByRole('button', { name: 'Save changes', exact: true });

async function move(page: Page, from: string, to: string): Promise<void> {
	await page.getByRole('button', { name: 'Place ' + from, exact: true }).click();
	await page.getByRole('button', { name: 'Place under ' + to, exact: true }).click();
}

type Fixture = {
	id: Ids;
	alex: string;
	blair: string;
	casey: string;
	dana: string;
	eli: string;
};

async function seeded(request: APIRequestContext): Promise<Fixture> {
	const id = ids();
	await configure(request, id);
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex ' + suffix;
	const blair = 'Blair ' + suffix;
	const casey = 'Casey ' + suffix;
	const dana = 'Dana ' + suffix;
	const eli = 'Eli ' + suffix;
	const alexId = await createWorkerWithIds(request, {
		name: alex,
		attributes: { [id.location]: id.storeA }
	});
	const blairId = await createWorkerWithIds(request, {
		name: blair,
		attributes: { [id.location]: id.dock }
	});
	const caseyId = await createWorkerWithIds(request, {
		name: casey,
		attributes: { [id.location]: id.central }
	});
	const danaId = await createWorkerWithIds(request, {
		name: dana,
		attributes: { [id.location]: '' }
	});
	const eliId = await createWorkerWithIds(request, {
		name: eli,
		attributes: { [id.location]: id.dock }
	});
	await saveDraft(
		request,
		danaId,
		draftBody(dana, { [id.location]: id.storeA }, { [id.location]: '' })
	);
	await saveDraft(
		request,
		eliId,
		draftBody(eli, { [id.location]: id.dock }, { [id.location]: id.dock })
	);

	return { id, alex: alexId, blair: blairId, casey: caseyId, dana: danaId, eli: eliId };
}

test('@ticket-11 previews and confirms moving a branch, preserving every holder and draft', async ({
	page,
	request
}) => {
	const fixture = await seeded(request);
	const { id } = fixture;
	const before = await dataset(request);
	const beforeIds = locationOptions(before, id).map((option) => option.id);
	const draftsBefore = {
		dana: await workerDraft(request, fixture.dana),
		eli: await workerDraft(request, fixture.eli)
	};
	await page.setViewportSize({ width: 1280, height: 900 });

	await openConfiguration(page);
	await openAttributeEditor(page, 'Location');

	// Show pointer-only feedback during a real held gesture, then release outside
	// the tree to verify cleanup without changing the draft.
	const sourceHandle = page.getByRole('button', {
		name: 'Place Central / Store A',
		exact: true
	});
	const targetLabel = page.locator(
		`[data-placement-attribute="${id.location}"][data-placement-parent="${id.north}"]`
	);
	await sourceHandle.scrollIntoViewIfNeeded();
	await sourceHandle.hover();
	await targetLabel.scrollIntoViewIfNeeded();
	const sourceBox = await sourceHandle.boundingBox();
	const targetBox = await targetLabel.boundingBox();
	expect(sourceBox).not.toBeNull();
	expect(targetBox).not.toBeNull();
	const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	expect(sourceBox!.x).toBeGreaterThanOrEqual(0);
	expect(sourceBox!.y).toBeGreaterThanOrEqual(0);
	expect(sourceBox!.y + sourceBox!.height).toBeLessThanOrEqual(viewport.height);
	expect(targetBox!.x).toBeGreaterThanOrEqual(0);
	expect(targetBox!.y).toBeGreaterThanOrEqual(0);
	expect(targetBox!.y + targetBox!.height).toBeLessThanOrEqual(viewport.height);
	await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
	await page.mouse.down();
	await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, {
		steps: 4
	});
	await expect(page.getByTestId('placement-drag-ghost')).toContainText('Store A');
	await expect(page.getByTestId('placement-drop-indicator')).toBeVisible();
	if (process.env.PLACEMENT_QA_DIR) {
		await mkdir(process.env.PLACEMENT_QA_DIR, { recursive: true });
		await page.screenshot({
			path: join(process.env.PLACEMENT_QA_DIR, 'drag-feedback-desktop.png')
		});
	}
	await page.mouse.move(0, 0);
	await page.mouse.up();
	await expect(page.getByTestId('placement-drag-ghost')).toHaveCount(0);
	await expect(page.getByTestId('placement-drop-indicator')).toHaveCount(0);
	await expect(page.getByRole('treeitem', { name: 'Store A', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		id.central
	);

	// A branch cannot be placed beneath itself or a descendant; those destinations
	// are absent while placement is active and Escape leaves the tree untouched.
	await page.getByRole('button', { name: 'Place Central / Store A', exact: true }).click();
	await expect(
		page.getByRole('button', {
			name: 'Place under Central / Store A / Loading dock',
			exact: true
		})
	).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(page.getByRole('treeitem', { name: 'Loading dock', exact: true })).toContainText(
		'Loading dock'
	);
	await expect(page.getByTitle('Central / Store A / Loading dock', { exact: true })).toContainText(
		'Loading dock'
	);

	// Moving the branch to North changes only its path in the draft.
	await page.getByRole('button', { name: 'Place Central / Store A', exact: true }).click();
	await page.getByRole('button', { name: 'Place under North', exact: true }).click();
	await expect(page.getByRole('treeitem', { name: 'Store A', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		id.north
	);
	await expect(page.getByTitle('North / Store A', { exact: true })).toContainText('Store A');
	await expect(page.getByRole('treeitem', { name: 'Loading dock', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		id.storeA
	);
	await expect(page.getByTitle('North / Store A / Loading dock', { exact: true })).toContainText(
		'Loading dock'
	);

	const writes = observeWrites(page);
	await closeAttributeEditor(page);
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByText('Move Store A under North')).toBeVisible();
	await expect(
		preview.getByText(
			'3 Workers affected; saved values and drafts keep their values. The path changes from Central / Store A to North / Store A.'
		)
	).toBeVisible();
	await expect(
		preview.getByText(
			'3 Workers affected. No values are discarded; holders keep their values and read their new paths.'
		)
	).toBeVisible();

	// The preview is an observation: nothing is written and the saved hierarchy is intact.
	expect(writes).toEqual([]);
	expect(await dataset(request)).toEqual(before);
	expect(await workerDraft(request, fixture.dana)).toEqual(draftsBefore.dana);
	expect(await workerDraft(request, fixture.eli)).toEqual(draftsBefore.eli);

	// Cancel keeps the draft and writes nothing; Save all again uses the same preview.
	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toHaveCount(0);
	expect(writes).toEqual([]);
	expect(await dataset(request)).toEqual(before);

	await closeAttributeEditor(page);
	await saveAll(page).click();
	await expect(preview).toBeVisible();
	await confirmMove(page).click();
	await expect(preview).toHaveCount(0);
	await expect
		.poll(async () => locationOptions(await dataset(request), id)[2].parentId)
		.toBe(id.north);

	const after = await dataset(request);
	// Every answer keeps its identity and configured order; only the moved parent changes.
	expect(locationOptions(after, id).map((option) => option.id)).toEqual(beforeIds);
	expect(locationOptions(after, id).map((option) => option.value)).toEqual([
		'Central',
		'North',
		'Store A',
		'Loading dock',
		'Packing',
		'Packing'
	]);
	expect(
		locationOptions(after, id).map((option) => [option.value, option.parentId ?? null])
	).toEqual([
		['Central', null],
		['North', null],
		['Store A', id.north],
		['Loading dock', id.storeA],
		['Packing', id.north],
		['Packing', id.central]
	]);
	// Every saved value keeps its answer id, including the direct Central selection that is
	// not the moved branch.
	expect(worker(after, after.workers.find((w) => w.id === fixture.alex)!.name).attributes).toEqual({
		[id.location]: id.storeA
	});
	expect(worker(after, after.workers.find((w) => w.id === fixture.casey)!.name).attributes).toEqual(
		{ [id.location]: id.central }
	);
	expect(await workerDraft(request, fixture.dana)).toEqual(draftsBefore.dana);
	expect(await workerDraft(request, fixture.eli)).toEqual(draftsBefore.eli);

	// Reload shows the confirmed new paths, and the unchanged holders still read as before.
	await page.reload();
	await appReady(page);
	await openAttributeEditor(page, 'Location');
	await expect(page.getByRole('treeitem', { name: 'Store A', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		id.north
	);
	await expect(page.getByTitle('North / Store A', { exact: true })).toContainText('Store A');
	await expect(page.getByRole('treeitem', { name: 'Loading dock', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		id.storeA
	);
	await expect(page.getByTitle('North / Store A / Loading dock', { exact: true })).toContainText(
		'Loading dock'
	);
});

test('@ticket-11 a sibling clash waits for a rename, and a stale confirmation writes nothing', async ({
	page,
	request
}) => {
	const fixture = await seeded(request);
	const { id } = fixture;
	const before = await dataset(request);
	const beforeIds = locationOptions(before, id).map((option) => option.id);

	await openConfiguration(page);
	await openAttributeEditor(page, 'Location');

	// Central / Packing under North collides with North / Packing.
	await move(page, 'Central / Packing', 'North');
	await expect(page.getByRole('alert')).toContainText(
		'Another value under that parent already uses this name.'
	);
	await expect(saveAll(page)).toBeDisabled();
	expect(await dataset(request)).toEqual(before);

	// Renaming the moved answer is the explicit valid resolution; both identities stay.
	// The refused move is still the draft's intent: both Packings sit under North, so
	// the moved one is the second of the two same-named chips.
	await page.getByRole('button', { name: 'Edit North / Packing', exact: true }).nth(1).click();
	const rename = page.getByRole('textbox', { name: 'Rename Packing' });
	await rename.fill('Packing (Central)');
	await rename.press('Enter');
	await expect(page.getByTitle('North / Packing (Central)', { exact: true })).toContainText(
		'Packing (Central)'
	);
	await expect(saveAll(page)).toBeEnabled();

	await closeAttributeEditor(page);
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByText('Move Packing (Central) under North')).toBeVisible();
	await expect(
		preview.getByText(
			'No saved Worker value or draft holds this branch. Its path changes from Central / Packing to North / Packing (Central).'
		)
	).toBeVisible();
	await confirmMove(page).click();
	await expect(preview).toHaveCount(0);
	await expect
		.poll(
			async () =>
				locationOptions(await dataset(request), id).find((o) => o.value === 'Packing (Central)')
					?.parentId
		)
		.toBe(id.north);

	const after = await dataset(request);
	expect(locationOptions(after, id).map((option) => option.id)).toEqual(beforeIds);
	expect(
		locationOptions(after, id)
			.filter((option) => option.value.startsWith('Packing'))
			.map((option) => [option.value, option.parentId])
	).toEqual([
		['Packing', id.north],
		['Packing (Central)', id.north]
	]);
});

test('@ticket-11 a stale move preview is refused and leaves the hierarchy unchanged', async ({
	page,
	request
}) => {
	const fixture = await seeded(request);
	const { id } = fixture;

	await openConfiguration(page);
	await openAttributeEditor(page, 'Location');
	await move(page, 'Central / Store A', 'North');
	await closeAttributeEditor(page);
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();

	// A Worker edit lands between the preview and the confirmation.
	const changed = await request.patch('/api/workers/' + fixture.alex, {
		data: { attributeId: id.location, value: id.central }
	});
	expect(changed.status(), await changed.text()).toBe(200);
	const before = await dataset(request);

	await confirmMove(page).click();
	await expect(preview).toHaveCount(0);
	await expect(
		page.getByText(/The Worksite changed since these effects were checked/)
	).toBeVisible();

	// The stale plan changed nothing: the branch is still under Central.
	const after = await dataset(request);
	expect(after).toEqual(before);
	expect(locationOptions(after, id)[2].parentId).toBe(id.central);
});

async function pointerPlace(page: Page, sourcePath: string, parentId: string): Promise<void> {
	const handle = page.getByRole('button', { name: 'Place ' + sourcePath, exact: true });
	await handle.scrollIntoViewIfNeeded();
	const target = page.locator(
		`[data-placement-parent="${parentId}"]:not([data-placement-promote])`
	);
	await handle.hover();
	const start = (await handle.boundingBox())!;
	const startPoint = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
	await page.mouse.down();
	await page.mouse.move(startPoint.x + 6, startPoint.y);
	await expect(handle).toHaveAttribute('aria-pressed', 'true');
	const region = page.getByTestId('worker-column').filter({ has: handle });
	const regionBox = (await region.boundingBox())!;
	// Stop edge auto-scroll before centering the intended destination beneath the
	// captured pointer. Re-measure and hit-test only after both scrolls have settled.
	await page.mouse.move(regionBox.x + regionBox.width / 2, regionBox.y + regionBox.height / 2);
	await target.evaluate((element) =>
		element.scrollIntoView({ block: 'center', inline: 'nearest' })
	);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	const targetButton = target.locator(':scope > button');
	const end = (await targetButton.boundingBox())!;
	const point = { x: end.x + end.width / 2, y: end.y + end.height / 2 };
	const expectedParentRowId =
		parentId ||
		(await target.evaluate(
			(element) => element.closest<HTMLElement>('[data-row-id]')?.dataset.rowId
		));
	const intendedHit = await page.evaluate(({ x, y }) => {
		const hit = document.elementFromPoint(x, y);
		return {
			parentId: hit?.closest<HTMLElement>('[data-placement-parent]')?.dataset.placementParent,
			rowId: hit?.closest<HTMLElement>('[data-row-id]')?.dataset.rowId
		};
	}, point);
	if (intendedHit.parentId !== parentId) {
		throw new Error(
			`Pointer did not hit requested target before release: ${JSON.stringify({
				sourcePath,
				requestedParentId: parentId,
				intendedHit,
				point,
				regionBox,
				end
			})}`
		);
	}
	await page.mouse.move(point.x, point.y);
	const sourceId = await handle.getAttribute('data-placement-handle');
	await page.mouse.up();
	const sourceRow = page.locator(`[data-row-id="${sourceId}"]`);
	const actualParentRowId = await sourceRow.getAttribute('data-parent-row-id');
	if (actualParentRowId !== expectedParentRowId) {
		throw new Error(
			`Pointer placement missed its destination: ${JSON.stringify({
				sourcePath,
				requestedParentId: parentId,
				expectedParentRowId,
				actualParentRowId
			})}`
		);
	}
}

async function beginTouchDrag(page: Page, from: { x: number; y: number }) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x: from.x, y: from.y }]
	});
	return {
		move: (point: { x: number; y: number }) =>
			cdp.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [{ x: point.x, y: point.y }]
			}),
		end: async () => {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			await cdp.detach();
		}
	};
}

async function touchTap(page: Page, at: { x: number; y: number }): Promise<void> {
	await page.touchscreen.tap(at.x, at.y);
}

async function placementHitAt(page: Page, point: { x: number; y: number }) {
	return page.evaluate(({ x, y }) => {
		const hit = document.elementFromPoint(x, y);
		const target = hit?.closest<HTMLElement>('[data-placement-parent]');
		const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
		const rect = hit?.getBoundingClientRect();
		return {
			tag: hit?.tagName,
			parentId: target?.dataset.placementParent,
			attributeId: target?.dataset.placementAttribute,
			row: hit?.closest<HTMLElement>('[data-row-id]')?.dataset.rowId,
			inViewport: Boolean(
				rect &&
				rect.bottom > viewport.top &&
				rect.top < viewport.bottom &&
				rect.right > viewport.left &&
				rect.left < viewport.right
			)
		};
	}, point);
}

async function destinationGeometry(page: Page, region: Locator, destination: Locator) {
	return page.evaluate(
		({ regionElement, destinationElement }) => {
			const region = regionElement.getBoundingClientRect();
			const destination = destinationElement.getBoundingClientRect();
			const point = {
				x: destination.left + destination.width / 2,
				y: destination.top + destination.height / 2
			};
			const hit = document.elementFromPoint(point.x, point.y);
			const parent = hit?.closest<HTMLElement>('[data-placement-parent]');
			const row = hit?.closest<HTMLElement>('[data-row-id]');
			return {
				scrollTop: (regionElement as HTMLElement).scrollTop,
				insideRegion:
					destination.bottom > region.top &&
					destination.top < region.bottom &&
					destination.right > region.left &&
					destination.left < region.right,
				comfortable: point.y > region.top + 56 && point.y < region.bottom - 56,
				visibleAtCenter: row === destinationElement,
				parentId: parent?.dataset.placementParent
			};
		},
		{
			regionElement: await region.elementHandle(),
			destinationElement: await destination.elementHandle()
		}
	);
}

async function moveTouchGradually(
	drag: Awaited<ReturnType<typeof beginTouchDrag>>,
	from: { x: number; y: number },
	to: { x: number; y: number }
): Promise<void> {
	for (let step = 1; step <= 8; step++) {
		await drag.move({
			x: from.x + ((to.x - from.x) * step) / 8,
			y: from.y + ((to.y - from.y) * step) / 8
		});
	}
}

test.describe('touch placement in long Attribute outlines', () => {
	test.use({ hasTouch: true, reducedMotion: 'reduce' });
	test('phone-sized touch taps choose a handle and destination without dragging', async ({
		page,
		request
	}) => {
		const id = ids();
		await configure(request, id);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/configuration');
		await appReady(page);
		await expandAttribute(page, 'Location');
		for (const name of ['Central', 'Store A']) {
			const row = page.getByRole('treeitem', { name, exact: true });
			if ((await row.getAttribute('aria-expanded')) === 'false') {
				await row.getByRole('button').first().click();
			}
		}
		const source = page.getByRole('button', {
			name: 'Place Central / Store A',
			exact: true
		});
		await source.scrollIntoViewIfNeeded();
		const sourceBox = (await source.boundingBox())!;
		await touchTap(page, {
			x: sourceBox.x + sourceBox.width / 2,
			y: sourceBox.y + sourceBox.height / 2
		});
		await expect(source).toHaveAttribute('aria-pressed', 'true');
		const destination = page.getByRole('button', { name: 'Place under North', exact: true });
		await expect(destination).toBeVisible();
		await destination.scrollIntoViewIfNeeded();
		const destinationBox = (await destination.boundingBox())!;
		const destinationPoint = {
			x: destinationBox.x + destinationBox.width / 2,
			y: destinationBox.y + destinationBox.height / 2
		};
		const destinationHit = await placementHitAt(page, destinationPoint);
		expect(destinationHit, JSON.stringify(destinationHit)).toMatchObject({
			parentId: id.north,
			attributeId: id.location,
			inViewport: true
		});
		await touchTap(page, destinationPoint);
		const parentId = await page
			.locator(`[data-row-id="${id.storeA}"]`)
			.getAttribute('data-parent-row-id');
		expect(parentId, JSON.stringify({ destinationHit, destinationBox, destinationPoint })).toBe(
			id.north
		);
		await expect(page.locator(`[data-row-id="${id.location}"]`)).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		await expect(page.getByRole('button', { name: 'Save all' })).toBeVisible();
	});

	test('touch drag auto-scrolls to a collapsed deep destination and saves the held branch', async ({
		page,
		request,
		browserName
	}) => {
		test.skip(
			browserName === 'webkit',
			'WebKit has no Chrome DevTools session, which this test uses to drive touch or emulate media; it stays Chromium-only.'
		);
		const id = ids();
		const destinationId = 't11-touch-destination-' + randomUUID().slice(0, 8);
		const destinationLeafId = 't11-touch-leaf-' + randomUUID().slice(0, 8);
		const extraRoots = Array.from({ length: 28 }, (_, index) => ({
			id: `t11-overflow-${String(index).padStart(2, '0')}-${randomUUID().slice(0, 4)}`,
			value: `Overflow ${String(index + 1).padStart(2, '0')}`
		}));
		const definition = locationDefinition(id);
		definition.options.push(
			...extraRoots,
			{
				id: destinationId,
				value: 'A destination with a long name that wraps across the outline column'
			},
			{ id: destinationLeafId, value: 'Receiving area', parentId: destinationId }
		);
		const configured = await request.put('/api/attributes', { data: [definition] });
		expect(configured.ok(), await configured.text()).toBeTruthy();
		const workerId = await createWorkerWithIds(request, {
			name: 'Touch branch holder',
			attributes: { [id.location]: id.dock }
		});
		await saveDraft(
			request,
			workerId,
			draftBody('Touch branch holder', { [id.location]: id.dock }, { [id.location]: id.dock })
		);
		const before = await dataset(request);

		await page.setViewportSize({ width: 1280, height: 720 });
		await page.goto('/configuration');
		await appReady(page);
		await expandAttribute(page, 'Location');
		for (const name of ['Central', 'Store A']) {
			const row = page.getByRole('treeitem', { name, exact: true });
			if ((await row.getAttribute('aria-expanded')) === 'false') {
				await row.getByRole('button').first().click();
			}
		}
		const region = page.getByTestId('worker-column');
		const handle = page.getByRole('button', {
			name: 'Place Central / Store A',
			exact: true
		});
		await expect(handle).toBeVisible();
		await handle.hover();
		const handleBox = (await handle.boundingBox())!;
		const handlePoint = {
			x: handleBox.x + handleBox.width / 2,
			y: handleBox.y + handleBox.height / 2
		};
		const handleHit = await page.evaluate(({ x, y }) => {
			const hit = document.elementFromPoint(x, y);
			const handle = hit?.closest<HTMLElement>('[data-placement-handle]');
			return {
				handleId: handle?.dataset.placementHandle,
				rowId: handle?.closest<HTMLElement>('[data-row-id]')?.dataset.rowId,
				tag: hit?.tagName
			};
		}, handlePoint);
		expect(handleHit, JSON.stringify({ handleBox, handleHit })).toMatchObject({
			handleId: id.storeA,
			rowId: id.storeA
		});
		const regionBox = (await region.boundingBox())!;
		const destination = page.getByRole('treeitem', {
			name: 'A destination with a long name that wraps across the outline column',
			exact: true
		});
		const leaf = page.getByRole('treeitem', { name: 'Receiving area', exact: true });
		await expect(leaf).toHaveCount(0);
		await expect(destination).toHaveAttribute('aria-expanded', 'false');
		const edgePoint = {
			x: regionBox.x + regionBox.width / 2,
			y: regionBox.y + regionBox.height - 18
		};
		const drag = await beginTouchDrag(page, {
			...handlePoint
		});
		await moveTouchGradually(drag, handlePoint, edgePoint);
		// Keep the finger at the scroll edge until this particular row is actually hittable.
		await expect
			.poll(() => destinationGeometry(page, region, destination), { timeout: 10_000 })
			.toMatchObject({
				insideRegion: true,
				comfortable: true,
				visibleAtCenter: true,
				parentId: destinationId
			});
		const destinationPoint = await destination.evaluate((element) => {
			const bounds = element.getBoundingClientRect();
			return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
		});
		const destinationHit = await placementHitAt(page, destinationPoint);
		expect(
			destinationHit,
			JSON.stringify({
				destinationHit,
				geometry: await destinationGeometry(page, region, destination)
			})
		).toMatchObject({ parentId: destinationId, attributeId: id.location, inViewport: true });
		const scrollStopPoint = {
			x: regionBox.x + regionBox.width / 2,
			y: regionBox.y + regionBox.height / 2
		};
		await drag.move(scrollStopPoint);
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				)
		);
		const stoppedAt = await region.evaluate((element) => (element as HTMLElement).scrollTop);
		const currentDestinationBox = (await destination.boundingBox())!;
		const currentDestinationPoint = {
			x: currentDestinationBox.x + currentDestinationBox.width / 2,
			y: currentDestinationBox.y + currentDestinationBox.height / 2
		};
		await moveTouchGradually(drag, scrollStopPoint, currentDestinationPoint);
		await expect(region).toHaveJSProperty('scrollTop', stoppedAt);
		await expect(destination).toHaveAttribute('aria-expanded', 'true');
		await expect(leaf).toBeVisible();
		const leafBox = (await leaf.boundingBox())!;
		await drag.move({ x: leafBox.x + leafBox.width / 2, y: leafBox.y + leafBox.height / 2 });
		await drag.end();
		await expect(page.getByRole('treeitem', { name: 'Store A', exact: true })).toHaveAttribute(
			'data-parent-row-id',
			destinationLeafId
		);
		await saveAll(page).click();
		await confirmMove(page).click();
		await page.reload();
		await appReady(page);
		await openAttributeEditor(page, 'Location');

		const after = await dataset(request);
		const afterOptions = locationOptions(after, id);
		expect(afterOptions.map((answer) => answer.id)).toEqual(
			locationOptions(before, id).map((answer) => answer.id)
		);
		expect(afterOptions.find((answer) => answer.id === id.storeA)?.parentId).toBe(
			destinationLeafId
		);
		expect(afterOptions.find((answer) => answer.id === id.dock)?.parentId).toBe(id.storeA);
		expect(worker(after, 'Touch branch holder').attributes).toEqual({ [id.location]: id.dock });
		expect(await workerDraft(request, workerId)).toMatchObject({
			update: { attributes: { [id.location]: id.dock } }
		});
		await expect(
			page.getByRole('treeitem', { name: 'Store A', exact: true }).getByRole('button', {
				name: 'Edit Store A',
				exact: true
			})
		).toBeVisible();
	});
});

test('pointer placement moves a leaf, returns it to the Attribute root, and saves its identity', async ({
	page,
	request
}) => {
	const id = ids();
	await configure(request, id);
	await openConfiguration(page);
	await openAttributeEditor(page, 'Location');
	const before = locationOptions(await dataset(request), id);
	await pointerPlace(page, 'Central / Store A / Loading dock', id.north);
	await expect(page.getByRole('treeitem', { name: 'Loading dock', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		id.north
	);
	await pointerPlace(page, 'North / Loading dock', '');
	await expect(page.getByRole('treeitem', { name: 'Loading dock', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		id.location
	);
	await saveAll(page).click();
	await confirmMove(page).click();
	await page.reload();
	await appReady(page);
	await openAttributeEditor(page, 'Location');
	await expect(page.getByRole('treeitem', { name: 'Loading dock', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		id.location
	);
	const after = locationOptions(await dataset(request), id);
	expect(after.map((answer) => answer.id)).toEqual(before.map((answer) => answer.id));
	expect(after.find((answer) => answer.id === id.dock)?.parentId).toBeUndefined();
});

test('keyboard placement, Escape, same-parent no-op and invalid branch destinations leave a predictable draft', async ({
	page,
	request
}) => {
	const id = ids();
	await configure(request, id);
	await openConfiguration(page);
	await openAttributeEditor(page, 'Location');
	const before = await dataset(request);
	const source = page.getByRole('button', { name: 'Place Central / Store A', exact: true });
	await source.focus();
	await source.press('Enter');
	await expect(
		page.getByRole('button', { name: 'Place under Central / Store A', exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole('button', { name: 'Place under Central / Store A / Loading dock', exact: true })
	).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(source).toBeFocused();
	await source.click();
	await page.getByRole('button', { name: 'Place under Central', exact: true }).click();
	await expect(saveAll(page)).toHaveCount(0);
	expect(await dataset(request)).toEqual(before);
	await source.focus();
	await source.press('Enter');
	// Store A, Loading dock, Central/Packing, North are consecutive visible rows.
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('treeitem', { name: 'Store A', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		id.north
	);
	await expect(page.getByRole('treeitem', { name: 'Store A', exact: true })).toBeFocused();
	await expect(
		page.getByRole('status').filter({ hasText: 'Placed Central / Store A under North' })
	).toBeVisible();
	expect(await dataset(request)).toEqual(before);
	await page.getByRole('button', { name: 'Discard', exact: true }).click();
	await expect(saveAll(page)).toHaveCount(0);
});

test('pointer release outside a target or cancellation writes nothing and keeps the saved hierarchy', async ({
	page,
	request
}) => {
	const id = ids();
	await configure(request, id);
	await openConfiguration(page);
	await openAttributeEditor(page, 'Location');
	const before = await dataset(request);
	const handle = page.getByRole('button', { name: 'Place Central / Store A', exact: true });
	await handle.scrollIntoViewIfNeeded();
	await handle.hover();
	await page.mouse.down();
	await page.mouse.move(2, 2, { steps: 5 });
	await expect(handle).toHaveAttribute('aria-pressed', 'true');
	await page.mouse.up();
	await expect(handle).toBeFocused();
	await expect(saveAll(page)).toHaveCount(0);
	expect(await dataset(request)).toEqual(before);
});

test('pending value placement creates directly under its parent and saves without an intermediate root', async ({
	page,
	request
}) => {
	const id = ids();
	await configure(request, id);
	await openConfiguration(page);
	await openAttributeEditor(page, 'Location');
	await expect(page.getByTestId('attribute-parent')).toHaveCount(0);
	await expect(page.getByTestId('attribute-move-disclosure')).toHaveCount(0);
	const before = await dataset(request);
	const input = page.getByRole('textbox', { name: 'Add an option to Location', exact: true });
	await input.fill('Central');
	await page.getByRole('button', { name: 'Place new value Central', exact: true }).click();
	await page.getByRole('button', { name: 'Place under North', exact: true }).click();
	await expect(input).toHaveValue('');
	await expect(
		page.getByRole('treeitem', { name: 'North / Central', exact: true })
	).toHaveAttribute('data-parent-row-id', id.north);
	await expect(
		page.getByRole('status').filter({ hasText: 'Placed Central under North' })
	).toBeVisible();
	expect(await dataset(request)).toEqual(before);
	await saveAll(page).click();
	await expect(saveAll(page)).toHaveCount(0);
	const after = locationOptions(await dataset(request), id);
	expect(after.slice(0, -1)).toEqual(locationOptions(before, id));
	expect(after.at(-1)).toMatchObject({ value: 'Central', parentId: id.north });
	await page.reload();
	await appReady(page);
	await openAttributeEditor(page, 'Location');
	await expect(
		page.getByRole('button', { name: 'Edit North / Central', exact: true })
	).toBeVisible();
});

test('pending placement cancellation and sibling conflicts keep the typed value and draft untouched', async ({
	page,
	request
}) => {
	const id = ids();
	await configure(request, id);
	await openConfiguration(page);
	await openAttributeEditor(page, 'Location');
	const before = await dataset(request);
	const input = page.getByRole('textbox', { name: 'Add an option to Location', exact: true });

	await input.fill('Abandoned');
	await page.getByRole('button', { name: 'Place new value Abandoned', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(input).toHaveValue('Abandoned');
	await expect(saveAll(page)).toHaveCount(0);
	expect(await dataset(request)).toEqual(before);

	await input.fill('Packing');
	await page.getByRole('button', { name: 'Place new value Packing', exact: true }).click();
	await page.getByRole('button', { name: 'Place under North', exact: true }).click();
	await expect(input).toHaveValue('Packing');
	await expect(page.getByTestId('attribute-tools').getByRole('alert')).toContainText(
		'A value with this name already exists under this parent.'
	);
	await expect(saveAll(page)).toHaveCount(0);
	expect(await dataset(request)).toEqual(before);
});

test('the add button and Enter create top-level values after a directly placed child', async ({
	page,
	request
}) => {
	const id = ids();
	await configure(request, id);
	await openConfiguration(page);
	await openAttributeEditor(page, 'Location');
	const editor = await openAttributeEditor(page, 'Location');
	const input = editor.getByRole('textbox', { name: 'Add an option to Location', exact: true });
	await input.fill('Child first');
	await editor.getByRole('button', { name: 'Place new value Child first', exact: true }).click();
	await editor.getByRole('button', { name: 'Place under North', exact: true }).click();
	await expect(input).toHaveValue('');
	await expect(editor.getByRole('treeitem', { name: 'Child first', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		id.north
	);

	await input.fill('Enter root');
	await input.press('Enter');
	await input.fill('Button root');
	await editor.getByRole('button', { name: 'Add option to Location', exact: true }).click();
	await expect(editor.getByRole('treeitem', { name: 'Enter root', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		id.location
	);
	await expect(editor.getByRole('treeitem', { name: 'Button root', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		id.location
	);
	await expect(input).toHaveValue('');
});

test('pending values use the same placement flow for Worker Attributes and Discard restores the saved hierarchy', async ({
	page,
	request
}) => {
	const id = ids();
	const teamId = 't11-team-' + randomUUID().slice(0, 8);
	const organizingId = 't11-organizing-' + randomUUID().slice(0, 8);
	const configureResponse = await request.put('/api/attributes', {
		data: [
			locationDefinition(id),
			{
				id: teamId,
				name: 'Team',
				kind: 'category',
				options: [{ id: organizingId, value: 'Organizing' }]
			}
		]
	});
	expect(configureResponse.ok(), await configureResponse.text()).toBeTruthy();
	await openConfiguration(page);
	await openAttributeEditor(page, 'Location');
	const before = await dataset(request);
	const editor = await openAttributeEditor(page, 'Team');
	const input = editor.getByRole('textbox', { name: 'Add an option to Team', exact: true });
	await input.fill('Canvass');
	await editor.getByRole('button', { name: 'Place new value Canvass', exact: true }).click();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(editor.getByRole('treeitem', { name: 'Canvass', exact: true })).toHaveAttribute(
		'data-parent-row-id',
		organizingId
	);
	expect(await dataset(request)).toEqual(before);
	await page.getByRole('button', { name: 'Discard', exact: true }).click();
	await expect(editor.getByRole('treeitem', { name: 'Canvass', exact: true })).toHaveCount(0);
});

test.describe('phone Attribute placement feedback', () => {
	test.use({ hasTouch: true });

	test('shows held-touch feedback and clears it when released outside the outline', async ({
		page,
		request,
		browserName
	}) => {
		test.skip(
			browserName === 'webkit',
			'WebKit has no Chrome DevTools session, which this test uses to drive touch or emulate media; it stays Chromium-only.'
		);
		const id = ids();
		await configure(request, id);
		await page.setViewportSize({ width: 390, height: 844 });
		await openConfiguration(page);
		await openAttributeEditor(page, 'Location');

		const sourceHandle = page.getByRole('button', {
			name: 'Place Central / Store A',
			exact: true
		});
		const targetLabel = page.locator(
			`[data-placement-attribute="${id.location}"][data-placement-parent="${id.central}"]`
		);
		// Scroll the handle into the phone viewport before measuring either end.
		await sourceHandle.hover();
		const sourceBox = await sourceHandle.boundingBox();
		const targetBox = await targetLabel.boundingBox();
		expect(sourceBox).not.toBeNull();
		expect(targetBox).not.toBeNull();
		const from = {
			x: sourceBox!.x + sourceBox!.width / 2,
			y: sourceBox!.y + sourceBox!.height / 2
		};
		const to = {
			x: targetBox!.x + targetBox!.width / 2,
			y: targetBox!.y + targetBox!.height / 2
		};
		expect(
			await page.evaluate(
				(point) =>
					document
						.elementFromPoint(point.x, point.y)
						?.closest<HTMLElement>('[data-placement-handle]')?.dataset.placementHandle,
				from
			)
		).toBe(id.storeA);
		expect(
			await page.evaluate(
				(point) =>
					document
						.elementFromPoint(point.x, point.y)
						?.closest<HTMLElement>('[data-placement-parent]')?.dataset.placementParent,
				to
			)
		).toBe(id.central);

		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
		for (let step = 1; step <= 4; step++) {
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [
					{
						x: from.x + ((to.x - from.x) * step) / 4,
						y: from.y + ((to.y - from.y) * step) / 4
					}
				]
			});
		}
		await expect(page.getByTestId('placement-drag-ghost')).toContainText('Store A');
		await expect(page.getByTestId('placement-drop-indicator')).toBeVisible();
		if (process.env.PLACEMENT_QA_DIR) {
			await mkdir(process.env.PLACEMENT_QA_DIR, { recursive: true });
			await page.screenshot({
				path: join(process.env.PLACEMENT_QA_DIR, 'drag-feedback-phone.png')
			});
		}

		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x: 0, y: 0 }]
		});
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await cdp.detach();
		await expect(page.getByTestId('placement-drag-ghost')).toHaveCount(0);
		await expect(page.getByTestId('placement-drop-indicator')).toHaveCount(0);
		await expect(page.getByRole('treeitem', { name: 'Store A', exact: true })).toHaveAttribute(
			'data-parent-row-id',
			id.central
		);
	});
});
