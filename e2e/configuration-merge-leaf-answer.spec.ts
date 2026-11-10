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
 * Merging two leaf answers. The organizer chooses the source and the surviving answer in
 * the UI; the authoritative preview names every saved holder, the surviving identity and
 * the draft dispositions, and the confirmed plan moves the holders through the real Save
 * route. A preview writes nothing.
 */

type Ids = {
	location: string;
	job: string;
	storeA: string;
	storeB: string;
	cashier: string;
	sales: string;
	stocker: string;
};

function ids(): Ids {
	const suffix = randomUUID().slice(0, 8);
	return {
		location: 't10-location-' + suffix,
		job: 't10-job-' + suffix,
		storeA: 't10-store-a-' + suffix,
		storeB: 't10-store-b-' + suffix,
		cashier: 't10-cashier-' + suffix,
		sales: 't10-sales-' + suffix,
		stocker: 't10-stocker-' + suffix
	};
}

const attributes = (id: Ids) => [
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
			{ id: id.sales, value: 'Sales' },
			{ id: id.stocker, value: 'Stocker' }
		]
	}
];

async function configure(request: APIRequestContext, id: Ids): Promise<void> {
	const response = await request.put('/api/attributes', { data: attributes(id) });
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

/** Renames Cashier to the existing Sales label, which opens the explicit merge dialog. */
async function mergeCashierIntoSales(page: Page): Promise<void> {
	const editor = await openAttributeEditor(page, 'Job');
	await editor.getByRole('button', { name: 'Edit Cashier' }).click();
	const input = editor.getByRole('textbox', { name: 'Rename Cashier' });
	await input.fill('Sales');
	await input.press('Enter');
	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await closeAttributeEditor(page);
}

test('merges a leaf answer, moves every saved holder, and confirms the merge', async ({
	page,
	request
}) => {
	const id = ids();
	await configure(request, id);
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex ' + suffix;
	const casey = 'Casey ' + suffix;
	const dana = 'Dana ' + suffix;
	const alexId = await createWorkerWithIds(request, {
		name: alex,
		attributes: { [id.location]: id.storeB, [id.job]: id.cashier }
	});
	await createWorkerWithIds(request, {
		name: casey,
		attributes: { [id.location]: id.storeA, [id.job]: id.cashier }
	});
	const danaId = await createWorkerWithIds(request, {
		name: dana,
		attributes: { [id.location]: '', [id.job]: '' }
	});
	// A saved value with both draft surfaces, and a draft-only holder.
	await saveDraft(
		request,
		alexId,
		draftBody(
			alex,
			{ [id.location]: id.storeB, [id.job]: id.cashier },
			{ [id.location]: id.storeB, [id.job]: id.cashier }
		)
	);
	await saveDraft(
		request,
		danaId,
		draftBody(
			dana,
			{ [id.location]: id.storeA, [id.job]: id.cashier },
			{ [id.location]: '', [id.job]: '' }
		)
	);

	const before = await dataset(request);
	await openConfiguration(page);
	await mergeCashierIntoSales(page);
	expect(jobOptions(await dataset(request), id)).toContain(id.cashier);

	const writes = observeWrites(page);
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByRole('heading', { name: 'Merge Cashier into Sales' })).toBeVisible();
	await expect(preview.getByTestId('configuration-resolutions')).toBeVisible();

	// The preview is an observation: nothing was written, and the saved records are intact.
	expect(writes).toEqual([]);
	expect(await dataset(request)).toEqual(before);
	expect(jobOptions(await dataset(request), id)).toContain(id.cashier);

	// A merge has one outcome: every holder already follows the survivor, so Save changes
	// needs no extra choice.
	const confirm = preview.getByRole('button', { name: 'Save changes' });
	await expect(confirm).toBeEnabled();

	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toHaveCount(0);
	expect(writes).toEqual([]);
	expect(await dataset(request)).toEqual(before);

	await saveAll(page).click();
	await expect(preview).toBeVisible();
	await confirm.click();
	await expect(preview).toHaveCount(0);
	await expect
		.poll(async () => (await jobOptions(await dataset(request), id)).includes(id.cashier))
		.toBe(false);

	const after = await dataset(request);
	// Cashier's holders now reference the surviving answer; unrelated Location stays.
	expect(worker(after, alex).attributes).toEqual({
		[id.location]: id.storeB,
		[id.job]: id.sales
	});
	expect(worker(after, casey).attributes).toEqual({
		[id.location]: id.storeA,
		[id.job]: id.sales
	});
	expect(jobOptions(after, id)).toEqual([id.sales, id.stocker]);

	// Both draft surfaces follow the merge; the draft-only holder keeps its input.
	const alexDraft = (await draft(request, alexId)) as {
		update: { attributes: Record<string, unknown> };
		pendingNote: { text: string };
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
	expect(alexDraft.pendingNote.text).toBe('keep this note');
	const danaDraft = (await draft(request, danaId)) as {
		update: { attributes: Record<string, unknown> };
		base: { attributes: Record<string, unknown> };
	};
	expect(danaDraft.update.attributes).toEqual({ [id.location]: id.storeA, [id.job]: id.sales });
	expect(danaDraft.base.attributes).toEqual({ [id.location]: '', [id.job]: '' });

	// Reload shows the merged configuration.
	await page.reload();
	await appReady(page);
	await expandAttribute(page, 'Job');
	await expect(page.getByText('Cashier', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Sales', { exact: true }).first()).toBeVisible();
});

test('a stale merge preview is refused and writes nothing', async ({ page, request }) => {
	const id = ids();
	await configure(request, id);
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex ' + suffix;
	const alexId = await createWorkerWithIds(request, {
		name: alex,
		attributes: { [id.location]: id.storeB, [id.job]: id.cashier }
	});

	await openConfiguration(page);
	await mergeCashierIntoSales(page);
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();

	// A Worker edit lands between the preview and the confirmation.
	const changed = await request.patch('/api/workers/' + alexId, {
		data: { attributeId: id.job, value: id.sales }
	});
	expect(changed.status(), await changed.text()).toBe(200);
	const before = await dataset(request);

	await preview.getByRole('button', { name: 'Save changes' }).click();
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

function held(dataset: Dataset, name: string, attributeId: string): string | string[] | undefined {
	return dataset.workers.find((worker) => worker.name === name)?.attributes[attributeId];
}

const gapDeleteDialog = (page: Page) => page.getByRole('alertdialog');

/** Opens an Attribute editor for folded gap tests. */
async function gapOpenEditor(page: Page, attributeName: string): Promise<Locator> {
	return openAttributeEditor(page, attributeName);
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

async function gapMergeInto(
	page: Page,
	editLabel: string,
	renameLabel: string,
	survivor: string,
	scope: Page | Locator = page
) {
	await scope.getByRole('button', { name: editLabel }).click();
	const input = scope.getByRole('textbox', { name: renameLabel });
	await input.fill(survivor);
	await input.press('Enter');
	await gapDeleteDialog(page).getByRole('button', { name: 'Merge', exact: true }).click();
}

test('[folded from product-gap-12] merging Trainer into Steward explains preservation without a destructive confirmation', async ({
	page,
	request
}) => {
	const fixture = await gap12SeedFixture(request);
	await openConfiguration(page);
	const dialog = await gapOpenEditor(page, 'Roles');

	await dialog.getByRole('button', { name: 'Edit Trainer' }).click();
	const input = dialog.getByRole('textbox', { name: 'Rename Trainer' });
	await input.fill('Steward');
	await input.press('Enter');
	await gapDeleteDialog(page).getByRole('button', { name: 'Merge', exact: true }).click();

	await closeAttributeEditor(page);
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	const mergeRow = preview
		.locator('li[data-preview-change]')
		.filter({ hasText: 'Merge Trainer into Steward' });
	await expect(mergeRow).toBeVisible();
	await expect(mergeRow).toContainText('Values are preserved; nothing is discarded.');
	await expect(preview.getByRole('button', { name: 'Save changes' })).toBeVisible();
	await expect(preview.getByRole('button', { name: 'Save and discard values' })).toHaveCount(0);
	await expect(preview.getByText('This cannot be undone.')).toHaveCount(0);

	await preview.getByRole('button', { name: 'Save changes' }).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toHaveCount(0);

	const after = await readDataset(request);
	const blair = held(after, 'Blair', fixture.roles);
	expect(blair).toEqual([fixture.steward]);
});

test('[folded from product-gap-13] merging English into Spanish preserves holders and deduplicates Casey', async ({
	page,
	request
}) => {
	const fixture = await gap13SeedFixture(request);
	await openConfiguration(page);
	await gapMergeInto(page, 'Edit English', 'Rename English', 'Spanish');

	const writes = observeWrites(page);
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(
		preview.getByText(
			'2 Workers affected. No saved values are discarded; holders keep their values.'
		)
	).toBeVisible();
	await expect(preview.getByText('Merge English into Spanish')).toBeVisible();
	await expect(
		preview.getByText('Holders keep the surviving value; nothing is discarded. 2 Workers affected.')
	).toBeVisible();
	await expect(preview.getByRole('button', { name: 'Save changes' })).toBeVisible();
	await expect(preview.getByRole('button', { name: 'Save and discard saved values' })).toHaveCount(
		0
	);
	expect(writes).toEqual([]);

	await preview.getByRole('button', { name: 'Save changes' }).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toHaveCount(0);

	const after = await readDataset(request);
	expect(after.languages).toEqual([{ id: fixture.spanish, name: 'Spanish' }]);
	// Casey held both Languages and now holds the survivor once; every holder is preserved.
	expect(gap13Worker(after, 'Alex').languages).toEqual([fixture.spanish]);
	expect(gap13Worker(after, 'Blair').languages).toEqual([fixture.spanish]);
	expect(gap13Worker(after, 'Casey').languages).toEqual([fixture.spanish]);
	expect(gap13Worker(after, 'Drew').languages).toEqual([]);
});

test('[folded from product-gap-13] merging Trainer then removing Steward reports 3/3/4', async ({
	page,
	request
}) => {
	await gap13SeedFixture(request);
	await openConfiguration(page);
	const dialog = await gapOpenEditor(page, 'Roles');
	await gapMergeInto(page, 'Edit Trainer', 'Rename Trainer', 'Steward', dialog);
	await dialog.getByRole('button', { name: 'Remove Steward' }).click();
	await closeAttributeEditor(page);

	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByText('Remove the Trainer value')).toBeVisible();
	await expect(preview.getByText('Remove the Steward value')).toBeVisible();
	await expect(preview.getByText('Merge Trainer into Steward', { exact: true })).toHaveCount(0);
	await expect(
		preview.getByText(
			'3 Workers affected. Each saved value, draft update, and draft base needs an explicit resolution.'
		)
	).toBeVisible();
	await expect(preview.getByRole('button', { name: 'Save and discard values' })).toBeVisible();

	for (const resolution of await preview.getByRole('combobox', { name: /Resolution for/ }).all()) {
		await choose(resolution, { label: 'No value' });
	}

	await preview.getByRole('button', { name: 'Save and discard values' }).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toHaveCount(0);

	const after = await readDataset(request);
	const roles = after.attributes.find((attribute) => attribute.name === 'Roles')!;
	expect(roles.options).toEqual([]);
	for (const name of ['Alex', 'Blair', 'Casey', 'Drew']) {
		expect(gap13Worker(after, name).attributes[roles.id]).toEqual([]);
	}
});

test('[folded from product-gap-13] merging English then removing Spanish follows the same final effect', async ({
	page,
	request
}) => {
	await gap13SeedFixture(request);
	await openConfiguration(page);
	await gapMergeInto(page, 'Edit English', 'Rename English', 'Spanish');
	await page.getByRole('button', { name: 'Remove Spanish' }).click();

	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByText('Remove the English Language')).toBeVisible();
	await expect(preview.getByText('Remove the Spanish Language')).toBeVisible();
	await expect(preview.getByText('Merge English into Spanish', { exact: true })).toHaveCount(0);
	await expect(
		preview.getByText('3 Workers affected. 4 saved values would be discarded.')
	).toBeVisible();
	await expect(
		preview.getByRole('button', { name: 'Save and discard saved values' })
	).toBeVisible();

	await preview.getByRole('button', { name: 'Save and discard saved values' }).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toHaveCount(0);

	const after = await readDataset(request);
	expect(after.languages).toEqual([]);
	for (const name of ['Alex', 'Blair', 'Casey', 'Drew']) {
		expect(gap13Worker(after, name).languages).toEqual([]);
	}
});
