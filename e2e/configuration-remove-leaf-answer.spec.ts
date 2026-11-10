import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { choose } from './select.ts';
import { createWorkerWithIds, observeWrites, saveDraft, readDataset } from './api.ts';
import { openConfiguration } from './pages.ts';
import { appReady } from './page-ready.ts';
import {
	closeAttributeEditor,
	expandAttribute,
	openAttributeEditor
} from './configuration-outline.ts';

/**
 * Removing a leaf answer only after resolving its effect on saved Worker values and
 * drafts. The synthetic fixture is seeded through the API, the real preview and Save
 * routes are exercised, and the confirmation is driven through the UI. A preview writes
 * nothing; a Save carries one explicit resolution per holder.
 */

type Ids = {
	location: string;
	job: string;
	storeA: string;
	storeB: string;
	cashier: string;
	sales: string;
};

function ids(): Ids {
	const suffix = randomUUID().slice(0, 8);
	return {
		location: 't09-location-' + suffix,
		job: 't09-job-' + suffix,
		storeA: 't09-store-a-' + suffix,
		storeB: 't09-store-b-' + suffix,
		cashier: 't09-cashier-' + suffix,
		sales: 't09-sales-' + suffix
	};
}

async function configure(request: APIRequestContext, id: Ids): Promise<void> {
	const response = await request.put('/api/attributes', {
		data: [
			{
				id: id.location,
				name: 'Location',
				kind: 'category',
				options: [
					{ id: id.storeA, value: 'Store A' },
					{ id: id.storeB, value: 'Store B' }
				]
			},
			{
				id: id.job,
				name: 'Job',
				kind: 'category',
				options: [
					{ id: id.cashier, value: 'Cashier' },
					{ id: id.sales, value: 'Sales' }
				]
			}
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

type Dataset = {
	attributes: { id: string; name: string; options: { id: string; value: string }[] }[];
	workers: {
		id: string;
		name: string;
		attributes: Record<string, unknown>;
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

function jobOptions(view: Dataset, id: Ids): string[] {
	const job = view.attributes.find((attribute) => attribute.id === id.job);
	expect(job).toBeTruthy();
	return job!.options.map((option) => option.id);
}

async function draft(request: APIRequestContext, workerId: string): Promise<unknown> {
	const response = await request.get('/api/worker-drafts/' + workerId);
	expect(response.ok(), await response.text()).toBeTruthy();
	return (await response.json()).draft as unknown;
}

const saveAll = (page: Page) => page.getByRole('button', { name: 'Save all', exact: true });
const previewDialog = (page: Page) => page.getByTestId('configuration-preview-dialog');
const confirmButton = (page: Page) =>
	previewDialog(page).getByRole('button', { name: 'Save and discard values' });

async function removeCashier(page: Page): Promise<void> {
	const job = await openAttributeEditor(page, 'Job');
	await job.getByRole('button', { name: 'Remove Cashier' }).click();
	await closeAttributeEditor(page);
}

test('previews and resolves a removed leaf answer before saving', async ({ page, request }) => {
	const id = ids();
	await configure(request, id);
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex ' + suffix;
	const blair = 'Blair ' + suffix;
	const casey = 'Casey ' + suffix;
	const dana = 'Dana ' + suffix;
	const alexId = await createWorkerWithIds(request, {
		name: alex,
		attributes: { [id.location]: id.storeB, [id.job]: id.cashier }
	});
	await createWorkerWithIds(request, {
		name: blair,
		attributes: { [id.location]: '', [id.job]: id.cashier }
	});
	await createWorkerWithIds(request, {
		name: casey,
		attributes: { [id.location]: id.storeA, [id.job]: id.cashier }
	});
	const danaId = await createWorkerWithIds(request, {
		name: dana,
		attributes: { [id.location]: '', [id.job]: '' }
	});
	// A draft-only holder, and a saved value with both draft surfaces.
	await saveDraft(
		request,
		danaId,
		draftBody(
			dana,
			{ [id.location]: id.storeA, [id.job]: id.cashier },
			{ [id.location]: '', [id.job]: '' }
		)
	);
	await saveDraft(
		request,
		alexId,
		draftBody(
			alex,
			{ [id.location]: id.storeB, [id.job]: id.cashier },
			{ [id.location]: id.storeB, [id.job]: id.cashier }
		)
	);

	const before = await dataset(request);
	await openConfiguration(page);
	await removeCashier(page);

	const writes = observeWrites(page);
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByText('Remove the Cashier value')).toBeVisible();
	await expect(preview.getByTestId('configuration-resolutions')).toBeVisible();

	// A preview is an observation: nothing was written, and the saved records are intact.
	expect(writes).toEqual([]);
	const afterPreview = await dataset(request);
	expect(jobOptions(afterPreview, id)).toContain(id.cashier);
	expect(afterPreview).toEqual(before);

	// Every holder has its own explicit choice, so confirmation waits until they are made.
	await expect(confirmButton(page)).toBeDisabled();
	for (const label of [
		`Resolution for ${alex} Worker value`,
		`Resolution for ${alex} Worker draft update`,
		`Resolution for ${alex} Worker draft base`,
		`Resolution for ${blair} Worker value`,
		`Resolution for ${casey} Worker value`,
		`Resolution for ${dana} Worker draft update`
	]) {
		await expect(preview.getByLabel(label)).toBeVisible();
	}

	// Cancel keeps the recoverable draft and writes nothing.
	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toHaveCount(0);
	expect(writes).toEqual([]);
	expect(await dataset(request)).toEqual(before);

	// Save all again, then resolve each affected holder explicitly.
	await saveAll(page).click();
	await expect(preview).toBeVisible();
	for (const label of [
		`Resolution for ${alex} Worker value`,
		`Resolution for ${alex} Worker draft update`,
		`Resolution for ${alex} Worker draft base`,
		`Resolution for ${casey} Worker value`,
		`Resolution for ${dana} Worker draft update`
	]) {
		await choose(preview.getByLabel(label), { label: 'Replace with Sales' });
	}
	await choose(preview.getByLabel(`Resolution for ${blair} Worker value`), {
		label: 'No value'
	});
	await expect(confirmButton(page)).toBeEnabled();

	await confirmButton(page).click();
	await expect(preview).toHaveCount(0);
	await expect
		.poll(async () => (await jobOptions(await dataset(request), id)).includes(id.cashier))
		.toBe(false);

	const after = await dataset(request);
	expect(worker(after, alex).attributes).toEqual({
		[id.location]: id.storeB,
		[id.job]: id.sales
	});
	expect(worker(after, blair).attributes).toEqual({ [id.location]: '', [id.job]: '' });
	expect(worker(after, casey).attributes).toEqual({
		[id.location]: id.storeA,
		[id.job]: id.sales
	});

	// Drafts keep their unfinished input and resolve only the removed answer.
	const danaDraft = (await draft(request, danaId)) as {
		update: { attributes: Record<string, unknown> };
		pendingNote: { text: string };
		base: { attributes: Record<string, unknown> };
	};
	expect(danaDraft.update.attributes).toEqual({ [id.location]: id.storeA, [id.job]: id.sales });
	expect(danaDraft.base.attributes).toEqual({ [id.location]: '', [id.job]: '' });
	expect(danaDraft.pendingNote.text).toBe('keep this note');
	const alexDraft = (await draft(request, alexId)) as {
		update: { attributes: Record<string, unknown> };
		base: { attributes: Record<string, unknown> };
	};
	expect(alexDraft.update.attributes).toEqual({
		[id.location]: id.storeB,
		[id.job]: id.sales
	});
	expect(alexDraft.base.attributes).toEqual({
		[id.location]: id.storeB,
		[id.job]: id.sales
	});

	// Reload shows the confirmed configuration; the removed answer is gone.
	await page.reload();
	await appReady(page);
	await expandAttribute(page, 'Job');
	await expect(page.getByText('Cashier', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Sales', { exact: true }).first()).toBeVisible();
});

test('a stale preview is refused and writes nothing', async ({ page, request }) => {
	const id = ids();
	await configure(request, id);
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex ' + suffix;
	const alexId = await createWorkerWithIds(request, {
		name: alex,
		attributes: { [id.location]: id.storeB, [id.job]: id.cashier }
	});

	await openConfiguration(page);
	await removeCashier(page);
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await choose(preview.getByLabel(`Resolution for ${alex} Worker value`), {
		label: 'Replace with Sales'
	});

	// A Worker edit lands between the preview and the confirmation.
	const changed = await request.patch('/api/workers/' + alexId, {
		data: { attributeId: id.job, value: id.sales }
	});
	expect(changed.status(), await changed.text()).toBe(200);
	const before = await dataset(request);

	await confirmButton(page).click();
	await expect(preview).toHaveCount(0);
	await expect(
		page.getByText(/The Worksite changed since these effects were checked/)
	).toBeVisible();

	// The stale plan changed nothing: the definition and the saved answers stay as they were.
	const after = await dataset(request);
	expect(after).toEqual(before);
	expect(jobOptions(after, id)).toContain(id.cashier);
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

/** Opens an Attribute editor for folded gap tests. */
async function gapOpenEditor(page: Page, attributeName: string): Promise<Locator> {
	return openAttributeEditor(page, attributeName);
}

test('[folded from product-gap-12] removing Packing previews one lost value and cancelling keeps the draft', async ({
	page,
	request
}) => {
	const fixture = await gap12SeedFixture(request);
	await openConfiguration(page);
	const dialog = await gapOpenEditor(page, 'Department');
	await dialog.getByRole('button', { name: 'Remove Packing' }).click();
	await closeAttributeEditor(page);

	const writes = observeWrites(page);
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(
		preview.getByText(
			'1 Worker affected. Each saved value, draft update, and draft base needs an explicit resolution.'
		)
	).toBeVisible();
	await expect(preview.getByText('Remove the Packing value')).toBeVisible();
	await expect(
		preview.getByText('1 Worker affected; each saved value and draft surface needs a resolution.')
	).toBeVisible();
	await expect(preview.getByRole('button', { name: 'Save and discard values' })).toBeVisible();
	expect(writes).toEqual([]);

	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toHaveCount(0);
	await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
	const unchanged = await readDataset(request);
	expect(unchanged.attributes[0].options.map((option) => option.id)).toEqual([
		fixture.packing,
		fixture.delivery,
		fixture.noDepartment
	]);

	// Discard restores the saved answer to the draft.
	await page.getByRole('button', { name: 'Discard' }).click();
	const reopened = await gapOpenEditor(page, 'Department');
	await expect(reopened.getByRole('button', { name: 'Remove Packing' })).toBeVisible();
	await closeAttributeEditor(page);
});

test('[folded from product-gap-12] a changed draft discards the late preview instead of confirming it', async ({
	page,
	request
}) => {
	const fixture = await gap12SeedFixture(request);
	await openConfiguration(page);
	const dialog = await gapOpenEditor(page, 'Department');
	await dialog.getByRole('button', { name: 'Remove Packing' }).click();
	await closeAttributeEditor(page);

	// Hold the preview reply so the draft can change while it is in flight.
	let releasePreview: () => void = () => {};
	const previewHeld = new Promise<void>((resolve) => {
		releasePreview = resolve;
	});
	await page.route('**/api/configuration/preview', async (route) => {
		await previewHeld;
		await route.continue();
	});

	await saveAll(page).click();
	await expect(page.getByText('Checking changes…', { exact: true })).toBeVisible();

	// Change the draft while the request is in flight.
	const reopened = await gapOpenEditor(page, 'Department');
	await reopened.getByRole('button', { name: 'Rename Department' }).click();
	const name = reopened.getByRole('textbox', { name: 'Name' });
	await name.fill('Team');
	await name.press('Enter');
	await closeAttributeEditor(page);
	releasePreview();

	// The late reply describes the previous draft, so it is dropped rather than shown.
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toBeEnabled();
	await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

	// The next Save all previews the actual draft, with the rename and the removal.
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByText('Remove the Packing value')).toBeVisible();
	await expect(
		preview.getByText(
			'1 Worker affected. Each saved value, draft update, and draft base needs an explicit resolution.'
		)
	).toBeVisible();
	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toHaveCount(0);

	// Nothing was written by either preview.
	expect((await readDataset(request)).attributes[0].options.map((option) => option.id)).toContain(
		fixture.packing
	);
});

test('[folded from product-gap-13] removing Spanish discards Blair and Casey once each', async ({
	page,
	request
}) => {
	const fixture = await gap13SeedFixture(request);
	await openConfiguration(page);
	await page.getByRole('button', { name: 'Remove Spanish' }).click();

	const writes = observeWrites(page);
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(
		preview.getByText('2 Workers affected. 2 saved values would be discarded.')
	).toBeVisible();
	await expect(preview.getByText('Remove the Spanish Language')).toBeVisible();
	await expect(
		preview.getByText('Removes it from the Worksite and discards 2 values from 2 Workers.')
	).toBeVisible();
	expect(writes).toEqual([]);

	await preview.getByRole('button', { name: 'Save and discard saved values' }).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toHaveCount(0);

	const after = await readDataset(request);
	expect(after.languages).toEqual([{ id: fixture.english, name: 'English' }]);
	expect(gap13Worker(after, 'Alex').languages).toEqual([fixture.english]);
	expect(gap13Worker(after, 'Blair').languages).toEqual([]);
	expect(gap13Worker(after, 'Casey').languages).toEqual([fixture.english]);
	expect(gap13Worker(after, 'Drew').languages).toEqual([]);
});
