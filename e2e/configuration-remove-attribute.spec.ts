import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { choose } from './select.ts';
import { createWorkerWithIds, observeWrites, readDataset } from './api.ts';
import { openConfiguration } from './pages.ts';
import { appReady } from './page-ready.ts';
import { closeAttributeEditor, openAttributeEditor } from './configuration-outline.ts';

/**
 * Removing an entire ordinary Attribute only after resolving the saved Worker values and
 * drafts that depend on it. The synthetic fixture is seeded through the API, the real
 * preview and Save routes are exercised, and the confirmation is driven through the UI.
 * A preview writes nothing; the Save carries the explicit Attribute acknowledgement.
 */

type Ids = {
	location: string;
	job: string;
	shift: string;
	department: string;
	storeA: string;
	storeB: string;
	cashier: string;
	sales: string;
	stocker: string;
	day: string;
	night: string;
	front: string;
	back: string;
};

function ids(): Ids {
	const suffix = randomUUID().slice(0, 8);
	return {
		location: 't14-location-' + suffix,
		job: 't14-job-' + suffix,
		shift: 't14-shift-' + suffix,
		department: 't14-department-' + suffix,
		storeA: 't14-store-a-' + suffix,
		storeB: 't14-store-b-' + suffix,
		cashier: 't14-cashier-' + suffix,
		sales: 't14-sales-' + suffix,
		stocker: 't14-stocker-' + suffix,
		day: 't14-day-' + suffix,
		night: 't14-night-' + suffix,
		front: 't14-front-' + suffix,
		back: 't14-back-' + suffix
	};
}

function attribute(
	id: string,
	name: string,
	kind: string,
	options: { id: string; value: string }[]
) {
	return { id, name, kind, options };
}

async function configureJobs(request: APIRequestContext, id: Ids): Promise<void> {
	const response = await request.put('/api/attributes', {
		data: [
			attribute(id.location, 'Location', 'category', [
				{ id: id.storeA, value: 'Store A' },
				{ id: id.storeB, value: 'Store B' }
			]),
			attribute(id.job, 'Job', 'category', [
				{ id: id.cashier, value: 'Cashier' },
				{ id: id.sales, value: 'Sales' },
				{ id: id.stocker, value: 'Stocker' }
			])
		]
	});
	expect(response.ok(), await response.text()).toBeTruthy();
}

async function configureWorkerScope(request: APIRequestContext, id: Ids): Promise<void> {
	const response = await request.put('/api/attributes', {
		data: [
			attribute(id.shift, 'Shift', 'tag', [
				{ id: id.day, value: 'Day' },
				{ id: id.night, value: 'Night' }
			]),
			attribute(id.department, 'Department', 'category', [
				{ id: id.front, value: 'Front' },
				{ id: id.back, value: 'Back' }
			])
		]
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

async function saveWorkerDraft(
	request: APIRequestContext,
	workerId: string,
	body: Record<string, unknown>
): Promise<void> {
	const response = await request.put('/api/worker-drafts/' + workerId, { data: body });
	expect(response.status(), await response.text()).toBe(200);
}

type Dataset = {
	attributes: { id: string; name: string; options: { id: string; value: string }[] }[];
	workers: {
		id: string;
		name: string;
		attributes: Record<string, string | string[]>;
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

function attributeNames(view: Dataset): string[] {
	return view.attributes.map((attribute) => attribute.name);
}

async function workerDraft(request: APIRequestContext, workerId: string): Promise<unknown> {
	const response = await request.get('/api/worker-drafts/' + workerId);
	expect(response.ok(), await response.text()).toBeTruthy();
	return (await response.json()).draft as unknown;
}

const saveAll = (page: Page) => page.getByRole('button', { name: 'Save all', exact: true });
const previewDialog = (page: Page) => page.getByTestId('configuration-preview-dialog');
const confirmButton = (page: Page) =>
	previewDialog(page).getByRole('button', { name: 'Save and discard values' });

async function removeAttribute(page: Page, name: string): Promise<void> {
	const attributeEditor = await openAttributeEditor(page, name);
	await attributeEditor.getByRole('button', { name: 'Delete ' + name }).click();
	const confirmation = page.getByRole('alertdialog');
	await expect(confirmation).toBeVisible();
	await confirmation.getByRole('button', { name: 'Delete attribute' }).click();
	await expect(page.getByTestId('attribute-editor-dialog')).toHaveCount(0);
}

test('previews and resolves a removed Attribute before saving', async ({ page, request }) => {
	const id = ids();
	await configureJobs(request, id);
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex ' + suffix;
	const blair = 'Blair ' + suffix;
	const casey = 'Casey ' + suffix;
	const dana = 'Dana ' + suffix;
	await createWorkerWithIds(request, {
		name: alex,
		attributes: { [id.location]: '', [id.job]: id.cashier }
	});
	await createWorkerWithIds(request, {
		name: blair,
		attributes: { [id.location]: id.storeA, [id.job]: id.cashier }
	});
	const caseyId = await createWorkerWithIds(request, {
		name: casey,
		attributes: { [id.location]: '', [id.job]: '' }
	});
	const danaId = await createWorkerWithIds(request, {
		name: dana,
		attributes: { [id.location]: id.storeB, [id.job]: id.cashier }
	});
	await saveWorkerDraft(
		request,
		caseyId,
		draftBody(casey, { [id.location]: '', [id.job]: id.sales }, { [id.location]: '', [id.job]: '' })
	);
	await saveWorkerDraft(
		request,
		danaId,
		draftBody(
			dana,
			{ [id.location]: id.storeB, [id.job]: id.stocker },
			{ [id.location]: id.storeB, [id.job]: id.cashier }
		)
	);

	const before = await dataset(request);
	await openConfiguration(page);
	await removeAttribute(page, 'Job');

	const writes = observeWrites(page);
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByRole('heading', { name: 'Remove the Job Attribute' })).toBeVisible();
	await expect(preview.getByTestId('configuration-resolutions')).toBeVisible();
	await expect(preview.getByText(alex + ' — Worker value')).toBeVisible();
	await expect(preview.getByText(blair + ' — Worker value')).toBeVisible();
	await expect(preview.getByText(casey + ' — Worker draft update')).toBeVisible();
	await expect(preview.getByText(dana + ' — Worker value')).toBeVisible();

	// A preview is an observation: nothing was written, and the saved records are intact.
	expect(writes).toEqual([]);
	expect(await dataset(request)).toEqual(before);

	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toHaveCount(0);
	expect(writes).toEqual([]);
	expect(await dataset(request)).toEqual(before);

	// A whole-Attribute removal has no replacement to choose: the acknowledgement is the
	// Save, and every named Worker value and draft is pruned with it.
	await saveAll(page).click();
	await expect(preview).toBeVisible();
	await expect(confirmButton(page)).toBeEnabled();
	await confirmButton(page).click();
	await expect(preview).toHaveCount(0);
	await expect.poll(async () => attributeNames(await dataset(request))).not.toContain('Job');

	const after = await dataset(request);
	const location = after.attributes.find((candidate) => candidate.id === id.location);
	expect(location?.options.map((option) => option.id)).toEqual([id.storeA, id.storeB]);
	expect(worker(after, alex).attributes).toEqual({ [id.location]: '' });
	expect(worker(after, blair).attributes).toEqual({ [id.location]: id.storeA });
	expect(worker(after, dana).attributes).toEqual({ [id.location]: id.storeB });

	const caseyDraft = (await workerDraft(request, caseyId)) as {
		update: { name: string; attributes: Record<string, unknown> };
		pendingNote: { text: string };
		base: { attributes: Record<string, unknown> };
	};
	expect(caseyDraft.update.name).toBe(casey);
	expect(caseyDraft.pendingNote.text).toBe('keep this note');
	expect(caseyDraft.update.attributes).toEqual({ [id.location]: '' });
	expect(caseyDraft.base.attributes).toEqual({ [id.location]: '' });

	const danaDraft = (await workerDraft(request, danaId)) as {
		update: { attributes: Record<string, unknown> };
		base: { attributes: Record<string, unknown> };
	};
	expect(danaDraft.update.attributes).toEqual({ [id.location]: id.storeB });
	expect(danaDraft.base.attributes).toEqual({ [id.location]: id.storeB });

	// Reload shows the confirmed configuration; the removed question is gone from the list
	// and Location remains.
	await page.reload();
	await appReady(page);
	await expect(page.getByRole('button', { name: 'Delete Job' })).toHaveCount(0);
	const locationEditor = await openAttributeEditor(page, 'Location');
	await expect(locationEditor.getByRole('button', { name: 'Delete Location' })).toBeVisible();
	await closeAttributeEditor(page);
});

test('a removal prunes saved values and Worker drafts', async ({ page, request }) => {
	const id = ids();
	await configureWorkerScope(request, id);
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex ' + suffix;
	const alexId = await createWorkerWithIds(request, {
		name: alex,
		attributes: { [id.shift]: [id.day, id.night], [id.department]: id.front }
	});
	await createWorkerWithIds(request, {
		name: 'Blair ' + suffix,
		attributes: { [id.shift]: [id.night], [id.department]: id.back }
	});
	await saveWorkerDraft(
		request,
		alexId,
		draftBody(
			alex,
			{ [id.shift]: [id.day], [id.department]: id.front },
			{ [id.shift]: [id.day, id.night], [id.department]: id.front }
		)
	);

	await openConfiguration(page);
	await removeAttribute(page, 'Shift');
	const writes = observeWrites(page);
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByRole('heading', { name: 'Remove the Shift Attribute' })).toBeVisible();
	await expect(preview.getByText(alex + ' — Worker value')).toBeVisible();
	await expect(preview.getByText(alex + ' — Worker draft update')).toBeVisible();
	// A whole-Attribute removal needs only its acknowledgement; no holder picks a replacement.
	await expect(confirmButton(page)).toBeEnabled();
	expect(writes).toEqual([]);
	await confirmButton(page).click();
	await expect(preview).toHaveCount(0);

	await expect.poll(async () => attributeNames(await dataset(request))).not.toContain('Shift');
	const after = await dataset(request);
	expect(worker(after, alex).attributes).toEqual({ [id.department]: id.front });

	// The Worker draft keeps its contact input and pending note; only the removed question
	// disappears from its update and base maps.
	const draft = (await workerDraft(request, alexId)) as {
		update: { name: string; email: string; attributes: Record<string, unknown> };
		pendingNote: { text: string };
		base: { attributes: Record<string, unknown> };
	};
	expect(draft.update.name).toBe(alex);
	expect(draft.update.email).toBe(alex.replace(/\s+/g, '.').toLowerCase() + '@example.com');
	expect(draft.pendingNote.text).toBe('keep this note');
	expect(draft.update.attributes).toEqual({ [id.department]: id.front });
	expect(draft.base.attributes).toEqual({ [id.department]: id.front });

	await page.reload();
	await appReady(page);
	await expect(page.getByRole('button', { name: 'Delete Shift' })).toHaveCount(0);
	const departmentEditor = await openAttributeEditor(page, 'Department');
	await expect(departmentEditor.getByRole('button', { name: 'Delete Department' })).toBeVisible();
	await closeAttributeEditor(page);
});

test('a Worker value change after the preview is refused as stale', async ({ page, request }) => {
	const id = ids();
	await configureWorkerScope(request, id);
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex ' + suffix;
	const alexId = await createWorkerWithIds(request, {
		name: alex,
		attributes: { [id.shift]: [id.day], [id.department]: id.front }
	});

	await openConfiguration(page);
	await removeAttribute(page, 'Shift');
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(confirmButton(page)).toBeEnabled();

	// A Worker value edit lands between the preview and the confirmation.
	const changed = await request.patch('/api/workers/' + alexId, {
		data: { attributeId: id.shift, value: [id.night] }
	});
	expect(changed.status(), await changed.text()).toBe(200);
	const before = await dataset(request);

	await confirmButton(page).click();
	await expect(preview).toHaveCount(0);
	await expect(
		page.getByText(/The Worksite changed since these effects were checked/)
	).toBeVisible();

	// The stale plan changed nothing: the definition and every saved value stay as they were.
	expect(await dataset(request)).toEqual(before);
	expect(attributeNames(await dataset(request))).toContain('Shift');
});

type Gap12Fixture = {
	department: string;
	roles: string;
	shifts: string;
	packing: string;
	delivery: string;
	noDepartment: string;
	trainer: string;
	steward: string;
};

type Gap13Fixture = Gap12Fixture & {
	equipment: string;
	schedule: string;
	english: string;
	spanish: string;
};

type Gap13Dataset = {
	attributes: {
		id: string;
		name: string;
		kind: string;
		options: { id: string; value: string }[];
	}[];
	agitations: { id: string; text: string }[];
	languages: { id: string; name: string }[];
	workers: {
		name: string;
		attributes: Record<string, string | string[]>;
		agitations: string[];
		languages: string[];
	}[];
};

async function gap12SeedFixture(request: APIRequestContext): Promise<Gap12Fixture> {
	const suffix = randomUUID().slice(0, 8);
	const fixture: Gap12Fixture = {
		department: `pg12-dept-${suffix}`,
		roles: `pg12-roles-${suffix}`,
		shifts: `pg12-shifts-${suffix}`,
		packing: `pg12-packing-${suffix}`,
		delivery: `pg12-delivery-${suffix}`,
		noDepartment: `pg12-none-${suffix}`,
		trainer: `pg12-trainer-${suffix}`,
		steward: `pg12-steward-${suffix}`
	};

	const configured = await request.put('/api/attributes', {
		data: [
			{
				id: fixture.department,
				name: 'Department',
				kind: 'category',
				options: [
					{ id: fixture.packing, value: 'Packing' },
					{ id: fixture.delivery, value: 'Delivery' },
					{ id: fixture.noDepartment, value: 'No Department' }
				]
			},
			{
				id: fixture.roles,
				name: 'Roles',
				kind: 'tag',
				options: [
					{ id: fixture.trainer, value: 'Trainer' },
					{ id: fixture.steward, value: 'Steward' }
				]
			},
			{ id: fixture.shifts, name: 'Shifts', kind: 'tag', options: [] }
		]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	const agitations = await request.put('/api/agitations', {
		data: [
			{ id: `pg12-equipment-${suffix}`, text: 'Equipment' },
			{ id: `pg12-schedule-${suffix}`, text: 'Schedule' }
		]
	});
	expect(agitations.ok(), await agitations.text()).toBeTruthy();
	const languages = await request.put('/api/languages', {
		data: [
			{ id: `pg12-english-${suffix}`, name: 'English' },
			{ id: `pg12-spanish-${suffix}`, name: 'Spanish' }
		]
	});
	expect(languages.ok(), await languages.text()).toBeTruthy();

	const workers: { name: string; assessment: string; department: string; roles: string[] }[] = [
		{ name: 'Alex', assessment: 'Leader', department: fixture.packing, roles: [fixture.trainer] },
		{
			name: 'Blair',
			assessment: 'Supporter',
			department: fixture.delivery,
			roles: [fixture.trainer, fixture.steward]
		},
		{ name: 'Casey', assessment: 'Unassessed', department: '', roles: [] },
		{
			name: 'Drew',
			assessment: 'Activist',
			department: fixture.noDepartment,
			roles: [fixture.steward]
		}
	];
	for (const worker of workers) {
		const created = await request.post('/api/workers', {
			data: {
				name: worker.name,
				email: '',
				phone: '',
				assessment: worker.assessment,
				attributes: {
					[fixture.department]: worker.department,
					[fixture.roles]: worker.roles,
					[fixture.shifts]: []
				},
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}

	return fixture;
}

function held(dataset: Dataset, name: string, attributeId: string): string | string[] | undefined {
	return dataset.workers.find((worker) => worker.name === name)?.attributes[attributeId];
}

const gapDeleteDialog = (page: Page) => page.getByRole('alertdialog');

/** Opens an Attribute editor for folded gap tests. */
async function gapRename(page: Page, editLabel: string, renameLabel: string, text: string) {
	await page.getByRole('button', { name: editLabel }).click();
	const input = page.getByRole('textbox', { name: renameLabel });
	await input.fill(text);
	await input.press('Enter');
}

async function gapOpenEditor(page: Page, attributeName: string): Promise<Locator> {
	return openAttributeEditor(page, attributeName);
}

async function gapDeleteAttribute(page: Page, attributeName: string) {
	const dialog = await gapOpenEditor(page, attributeName);
	await dialog.getByRole('button', { name: `Delete ${attributeName}` }).click();
	await gapDeleteDialog(page).getByRole('button', { name: 'Delete attribute' }).click();
	// Confirming the delete also closes the editor it was opened from.
	await expect(page.getByTestId('attribute-editor-dialog')).toHaveCount(0);
}

async function gap13SeedFixture(request: APIRequestContext): Promise<Gap13Fixture> {
	const suffix = randomUUID().slice(0, 8);
	const fixture: Gap13Fixture = {
		department: `pg13-dept-${suffix}`,
		roles: `pg13-roles-${suffix}`,
		shifts: `pg13-shifts-${suffix}`,
		packing: `pg13-packing-${suffix}`,
		delivery: `pg13-delivery-${suffix}`,
		noDepartment: `pg13-none-${suffix}`,
		trainer: `pg13-trainer-${suffix}`,
		steward: `pg13-steward-${suffix}`,
		equipment: `pg13-equipment-${suffix}`,
		schedule: `pg13-schedule-${suffix}`,
		english: `pg13-english-${suffix}`,
		spanish: `pg13-spanish-${suffix}`
	};

	const configured = await request.put('/api/attributes', {
		data: [
			{
				id: fixture.department,
				name: 'Department',
				kind: 'category',
				options: [
					{ id: fixture.packing, value: 'Packing' },
					{ id: fixture.delivery, value: 'Delivery' },
					{ id: fixture.noDepartment, value: 'No Department' }
				]
			},
			{
				id: fixture.roles,
				name: 'Roles',
				kind: 'tag',
				options: [
					{ id: fixture.trainer, value: 'Trainer' },
					{ id: fixture.steward, value: 'Steward' }
				]
			},
			{ id: fixture.shifts, name: 'Shifts', kind: 'tag', options: [] }
		]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	const agitations = await request.put('/api/agitations', {
		data: [
			{ id: fixture.equipment, text: 'Equipment' },
			{ id: fixture.schedule, text: 'Schedule' }
		]
	});
	expect(agitations.ok(), await agitations.text()).toBeTruthy();
	const languages = await request.put('/api/languages', {
		data: [
			{ id: fixture.english, name: 'English' },
			{ id: fixture.spanish, name: 'Spanish' }
		]
	});
	expect(languages.ok(), await languages.text()).toBeTruthy();

	const workers = [
		{
			name: 'Alex',
			assessment: 'Leader',
			department: fixture.packing,
			roles: [fixture.trainer],
			languages: [fixture.english],
			agitations: [fixture.equipment]
		},
		{
			name: 'Blair',
			assessment: 'Supporter',
			department: fixture.delivery,
			roles: [fixture.trainer, fixture.steward],
			languages: [fixture.spanish],
			agitations: [fixture.schedule]
		},
		{
			name: 'Casey',
			assessment: 'Unassessed',
			department: '',
			roles: [],
			languages: [fixture.english, fixture.spanish],
			agitations: [fixture.equipment]
		},
		{
			name: 'Drew',
			assessment: 'Activist',
			department: fixture.noDepartment,
			roles: [fixture.steward],
			languages: [],
			agitations: []
		}
	];
	for (const worker of workers) {
		const created = await request.post('/api/workers', {
			data: {
				name: worker.name,
				email: '',
				phone: '',
				assessment: worker.assessment,
				attributes: {
					[fixture.department]: worker.department,
					[fixture.roles]: worker.roles,
					[fixture.shifts]: []
				},
				agitations: worker.agitations,
				languages: worker.languages,
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}

	return fixture;
}

function gap13Worker(dataset: Gap13Dataset, name: string): Gap13Dataset['workers'][number] {
	return dataset.workers.find((candidate) => candidate.name === name)!;
}

test('[folded from product-gap-12] removing Department previews 3/3/3 and saves only after confirmation', async ({
	page,
	request
}) => {
	const fixture = await gap12SeedFixture(request);
	const before = await readDataset(request);
	await openConfiguration(page);
	await gapDeleteAttribute(page, 'Department');

	const writes = observeWrites(page);
	const previewRequest = page.waitForRequest((candidate) =>
		candidate.url().endsWith('/api/configuration/preview')
	);
	await saveAll(page).click();

	// Every preview carries all three proposed sets, in their Save shapes.
	const proposed = (await previewRequest).postDataJSON() as Record<string, unknown>;
	expect(Object.keys(proposed).sort()).toEqual(['agitations', 'attributes', 'languages']);
	const attributes = proposed.attributes as { options: unknown[] }[];
	expect(attributes[0].options).toEqual([
		{ id: fixture.trainer, value: 'Trainer' },
		{ id: fixture.steward, value: 'Steward' }
	]);

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(
		preview.getByText(
			'3 Workers affected. Each saved value, draft update, and draft base needs an explicit resolution.'
		)
	).toBeVisible();
	const departmentRow = preview
		.locator('li[data-preview-change]')
		.filter({ hasText: 'Remove the Department Attribute' });
	await expect(departmentRow).toBeVisible();
	await expect(
		preview.getByText(
			'Removes every value and branch; each saved value and draft surface needs an explicit result.'
		)
	).toBeVisible();
	await expect(preview.getByRole('button', { name: 'Save and discard values' })).toBeVisible();

	// A preview is an observation: nothing was written and the saved records are intact.
	expect(writes).toEqual([]);
	expect((await readDataset(request)).attributes.map((attribute) => attribute.id)).toEqual(
		before.attributes.map((attribute) => attribute.id)
	);

	// Cancel keeps the recoverable draft and writes nothing.
	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toHaveCount(0);
	await expect(saveAll(page)).toBeEnabled();
	expect(writes).toEqual([]);
	expect((await readDataset(request)).attributes.map((attribute) => attribute.id)).toEqual(
		before.attributes.map((attribute) => attribute.id)
	);

	// Confirming does not save by itself; the existing Save all protocol does.
	await saveAll(page).click();
	await expect(previewDialog(page)).toBeVisible();
	await previewDialog(page).getByRole('button', { name: 'Save and discard values' }).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toHaveCount(0);

	const after = await readDataset(request);
	expect(after.attributes.map((attribute) => attribute.id)).not.toContain(fixture.department);
	expect(writes).toContain('PUT /api/attributes');
	expect(held(after, 'Alex', fixture.department)).toBeUndefined();
});

test('[folded from product-gap-12] a failed preview preserves the draft and blocks the save', async ({
	page,
	request
}) => {
	const fixture = await gap12SeedFixture(request);
	await openConfiguration(page);
	const dialog = await gapOpenEditor(page, 'Department');
	await dialog.getByRole('button', { name: 'Remove Packing' }).click();
	await closeAttributeEditor(page);

	await page.route('**/api/configuration/preview', async (route) => {
		await route.fulfill({ status: 500, json: { message: 'Synthetic preview failure.' } });
	});
	const writes = observeWrites(page);
	await saveAll(page).click();

	await expect(page.getByRole('alert')).toContainText(
		'Could not check these changes. Your draft is still here.'
	);
	// The core's diagnostic is not screen copy (ADR-0024).
	await expect(page.getByRole('alert')).not.toContainText('Synthetic preview failure.');
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toBeEnabled();
	expect(writes).toEqual([]);
	expect((await readDataset(request)).attributes[0].options.map((option) => option.id)).toContain(
		fixture.packing
	);

	await page.getByRole('button', { name: 'Discard' }).click();
	const reopened = await gapOpenEditor(page, 'Department');
	await expect(reopened.getByRole('button', { name: 'Remove Packing' })).toBeVisible();
	await closeAttributeEditor(page);
});

test('[folded from product-gap-12] removing an unused Attribute explains the definition removal', async ({
	page,
	request
}) => {
	const fixture = await gap12SeedFixture(request);
	await openConfiguration(page);
	await gapDeleteAttribute(page, 'Shifts');

	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(
		preview.getByText(
			'0 Workers affected. No Worker values are discarded; Workers keep their values.'
		)
	).toBeVisible();
	await expect(
		preview.getByText(
			'0 Workers affected. Each saved value, draft update, and draft base needs an explicit resolution.'
		)
	).toHaveCount(0);
	await expect(preview.getByText('Remove the Shifts Attribute')).toBeVisible();
	await expect(
		preview.getByText('Removes the definition. No Worker values are discarded.')
	).toBeVisible();
	await expect(preview.getByRole('button', { name: 'Save changes' })).toBeVisible();

	await preview.getByRole('button', { name: 'Save changes' }).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toHaveCount(0);
	expect((await readDataset(request)).attributes.map((attribute) => attribute.id)).not.toContain(
		fixture.shifts
	);
});

test('[folded from product-gap-13] removing Equipment previews 2/2/2 and saves only after confirmation', async ({
	page,
	request
}) => {
	const fixture = await gap13SeedFixture(request);
	const before = await readDataset(request);
	await openConfiguration(page);
	await page.getByRole('button', { name: 'Remove Equipment' }).click();

	const writes = observeWrites(page);
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(
		preview.getByText('2 Workers affected. 2 saved values would be discarded.')
	).toBeVisible();
	await expect(preview.getByText('Remove the Equipment Agitation')).toBeVisible();
	await expect(
		preview.getByText('Removes it from the Worksite and discards 2 values from 2 Workers.')
	).toBeVisible();
	await expect(
		preview.getByRole('button', { name: 'Save and discard saved values' })
	).toBeVisible();

	// A preview is an observation: nothing was written, and the saved data is intact.
	expect(writes).toEqual([]);
	expect((await readDataset(request)).agitations).toEqual(before.agitations);

	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toHaveCount(0);
	await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
	expect(writes).toEqual([]);

	await saveAll(page).click();
	await expect(previewDialog(page)).toBeVisible();
	await previewDialog(page).getByRole('button', { name: 'Save and discard saved values' }).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toHaveCount(0);

	const after = await readDataset(request);
	expect(after.agitations.map((agitation) => agitation.id)).not.toContain(fixture.equipment);
	expect(gap13Worker(after, 'Alex').agitations).not.toContain(fixture.equipment);
	expect(gap13Worker(after, 'Casey').agitations).not.toContain(fixture.equipment);
	expect(gap13Worker(after, 'Blair').agitations).toEqual([fixture.schedule]);
	expect(writes).toContain('PUT /api/agitations');
});

test('[folded from product-gap-13] a mixed Attribute and shared draft previews and saves both', async ({
	page,
	request
}) => {
	const fixture = await gap13SeedFixture(request);
	await openConfiguration(page);
	const dialog = await gapOpenEditor(page, 'Department');
	await dialog.getByRole('button', { name: 'Remove Packing' }).click();
	await closeAttributeEditor(page);

	const agitationInput = page.getByRole('textbox', { name: 'Add an agitation' });
	await agitationInput.fill('Extra shift');
	await agitationInput.press('Enter');

	const writes = observeWrites(page);
	await saveAll(page).click();

	// The added Agitation is harmless, and the removal is previewed rather than bypassed.
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByText('Remove the Packing value')).toBeVisible();
	await expect(
		preview.getByText(
			'1 Worker affected. Each saved value, draft update, and draft base needs an explicit resolution.'
		)
	).toBeVisible();
	expect(writes).toEqual([]);

	for (const resolution of await preview.getByRole('combobox', { name: /Resolution for/ }).all()) {
		await choose(resolution, { label: 'No value' });
	}

	await preview.getByRole('button', { name: 'Save and discard values' }).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toHaveCount(0);

	const after = await readDataset(request);
	const department = after.attributes.find((attribute) => attribute.id === fixture.department)!;
	expect(department.options.map((option) => option.id)).not.toContain(fixture.packing);
	expect(after.agitations.map((agitation) => agitation.text)).toContain('Extra shift');
	expect(gap13Worker(after, 'Alex').attributes[fixture.department]).toBe('');
});

test('[folded from product-gap-13] a failed shared preview keeps the draft and blocks the save', async ({
	page,
	request
}) => {
	const fixture = await gap13SeedFixture(request);
	await openConfiguration(page);
	await page.getByRole('button', { name: 'Remove Equipment' }).click();

	await page.route('**/api/configuration/preview', async (route) => {
		await route.fulfill({ status: 500, json: { message: 'Synthetic preview failure.' } });
	});
	const writes = observeWrites(page);
	await saveAll(page).click();

	await expect(page.getByRole('alert')).toContainText(
		'Could not check these changes. Your draft is still here.'
	);
	// The core's diagnostic is not screen copy (ADR-0024).
	await expect(page.getByRole('alert')).not.toContainText('Synthetic preview failure.');
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toBeEnabled();
	expect(writes).toEqual([]);
	expect((await readDataset(request)).agitations.map((agitation) => agitation.id)).toContain(
		fixture.equipment
	);

	await page.getByRole('button', { name: 'Discard' }).click();
	await expect(page.getByRole('button', { name: 'Remove Equipment' })).toBeVisible();
});

test('[folded from product-gap-13] a changed draft discards a stale shared preview', async ({
	page,
	request
}) => {
	const fixture = await gap13SeedFixture(request);
	await openConfiguration(page);
	await page.getByRole('button', { name: 'Remove Equipment' }).click();

	let releasePreview: () => void = () => {};
	const previewHeld = new Promise<void>((resolve) => {
		releasePreview = resolve;
	});
	await page.route('**/api/configuration/preview', async (route) => {
		await previewHeld;
		await route.continue();
	});

	await saveAll(page).click();
	await expect(page.getByText('Checking changes…')).toBeVisible();

	// Change the draft while the shared preview is in flight.
	await gapRename(page, 'Edit Schedule', 'Rename Schedule', 'Rota');
	releasePreview();

	// The late reply describes the previous draft, so it is dropped rather than shown.
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toBeEnabled();
	await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

	// The next Save all previews the actual draft, with the removal and the rename.
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByText('Remove the Equipment Agitation')).toBeVisible();
	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toHaveCount(0);

	expect((await readDataset(request)).agitations.map((agitation) => agitation.id)).toContain(
		fixture.equipment
	);
});
