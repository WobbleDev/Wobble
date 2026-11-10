import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { choose } from './select.ts';
import { createWorkerWithIds, observeWrites, readDataset } from './api.ts';
import { openConfiguration } from './pages.ts';
import { appReady } from './page-ready.ts';
import { closeAttributeEditor, openAttributeEditor } from './configuration-outline.ts';

/**
 * Ticket 04 (Configuration's part of AC9): a Multi-Select to Single-Select change needs an
 * explicit choice for every saved Worker value, draft update, and draft base that holds
 * several answers. The fixture is seeded through the API, the real preview and Save routes
 * are exercised, and the confirmation is driven through the UI. A preview writes nothing;
 * the Save applies the chosen answers, the draft representation and the definition change
 * atomically. An unresolved attempt leaves every stored selection unchanged.
 */

type Ids = {
	shift: string;
	department: string;
	location: string;
	trainer: string;
	steward: string;
	lead: string;
	front: string;
	back: string;
	storeA: string;
};

function ids(): Ids {
	const suffix = randomUUID().slice(0, 8);
	return {
		shift: 't15-shift-' + suffix,
		department: 't15-department-' + suffix,
		location: 't15-location-' + suffix,
		trainer: 't15-trainer-' + suffix,
		steward: 't15-steward-' + suffix,
		lead: 't15-lead-' + suffix,
		front: 't15-front-' + suffix,
		back: 't15-back-' + suffix,
		storeA: 't15-store-a-' + suffix
	};
}

function workerAttribute(
	id: string,
	name: string,
	kind: string,
	options: { id: string; value: string }[]
) {
	return { id, name, kind, options };
}

function taggedConfiguration(id: Ids) {
	return [
		workerAttribute(id.shift, 'Shift', 'tag', [
			{ id: id.trainer, value: 'Trainer' },
			{ id: id.steward, value: 'Steward' },
			{ id: id.lead, value: 'Lead' }
		]),
		workerAttribute(id.department, 'Department', 'category', [
			{ id: id.front, value: 'Front' },
			{ id: id.back, value: 'Back' }
		]),
		workerAttribute(id.location, 'Location', 'category', [{ id: id.storeA, value: 'Store A' }])
	];
}

function singleSelectConfiguration(id: Ids) {
	return taggedConfiguration(id).map((attribute) =>
		attribute.id === id.shift ? { ...attribute, kind: 'category' } : attribute
	);
}

async function configure(request: APIRequestContext, attributes: unknown[]) {
	const response = await request.put('/api/attributes', { data: attributes });
	expect(response.ok(), await response.text()).toBeTruthy();
}

async function saveWorkerDraft(
	request: APIRequestContext,
	workerId: string,
	body: Record<string, unknown>
) {
	const response = await request.put('/api/worker-drafts/' + workerId, { data: body });
	expect(response.status(), await response.text()).toBe(200);
}

async function workerDraft(request: APIRequestContext, workerId: string) {
	const response = await request.get('/api/worker-drafts/' + workerId);
	expect(response.ok(), await response.text()).toBeTruthy();
	return (await response.json()).draft;
}

type Dataset = {
	attributes: {
		id: string;
		name: string;
		kind: string;
		options: { id: string; value: string }[];
	}[];
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

function draftBody(
	id: Ids,
	name: string,
	department: string,
	shiftUpdate: string | string[],
	shiftBase: string | string[]
) {
	const attributes = (shift: string | string[]) => ({
		[id.shift]: shift,
		[id.department]: department,
		[id.location]: ''
	});
	const update = {
		name,
		email: 'alex@example.com',
		phone: '',
		assessment: 'Unassessed',
		attributes: attributes(shiftUpdate),
		agitations: [],
		languages: [],
		relationships: [],
		notes: []
	};
	return {
		update,
		pendingNote: { text: 'keep this note' },
		base: { ...update, attributes: attributes(shiftBase) }
	};
}

const saveAll = (page: Page) => page.getByRole('button', { name: 'Save all', exact: true });
const previewDialog = (page: Page) => page.getByTestId('configuration-preview-dialog');
const confirmButton = (page: Page) =>
	previewDialog(page).getByRole('button', { name: 'Save and discard values' });

async function chooseSingleSelect(page: Page): Promise<void> {
	const shiftMulti = await openAttributeEditor(page, 'Shift');
	await shiftMulti
		.getByRole('button', { name: 'Switch from Multi-Select to Single-Select' })
		.click();
	await closeAttributeEditor(page);
}

async function chooseMultiSelect(page: Page): Promise<void> {
	const shiftSingle = await openAttributeEditor(page, 'Shift');
	await shiftSingle
		.getByRole('button', { name: 'Switch from Single-Select to Multi-Select' })
		.click();
	await closeAttributeEditor(page);
}

test('@ticket-15 previews and resolves saved value, draft update, and draft base before saving', async ({
	page,
	request
}) => {
	const id = ids();
	await configure(request, taggedConfiguration(id));
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex ' + suffix;
	const blair = 'Blair ' + suffix;
	const casey = 'Casey ' + suffix;
	const alexId = await createWorkerWithIds(request, {
		name: alex,
		attributes: {
			[id.shift]: [id.trainer, id.steward],
			[id.department]: id.front,
			[id.location]: ''
		}
	});
	await saveWorkerDraft(
		request,
		alexId,
		draftBody(id, alex, id.front, [id.trainer, id.lead], [id.steward, id.lead])
	);
	await createWorkerWithIds(request, {
		name: blair,
		attributes: { [id.shift]: [id.steward], [id.department]: id.back, [id.location]: '' }
	});
	await createWorkerWithIds(request, {
		name: casey,
		attributes: { [id.shift]: [], [id.department]: '', [id.location]: '' }
	});

	const before = await dataset(request);
	const beforeDraft = await workerDraft(request, alexId);
	await openConfiguration(page);
	await chooseSingleSelect(page);
	const writes = observeWrites(page);
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(
		preview.getByRole('heading', { name: 'Save changes and discard values?' })
	).toBeVisible();
	// The conversion names the saved value, draft update and draft base independently.
	await expect(preview.getByText('Change Shift to Single-Select')).toBeVisible();
	await expect(preview.getByText(alex + ' — Worker value')).toBeVisible();
	await expect(preview.getByText(alex + ' — Worker draft update')).toBeVisible();
	await expect(preview.getByText(alex + ' — Worker draft base')).toBeVisible();
	await expect(
		preview.getByTestId('configuration-resolutions').getByText('Shift: Trainer, Steward')
	).toBeVisible();
	await expect(
		preview.getByTestId('configuration-resolutions').getByText('Shift: Trainer, Lead')
	).toBeVisible();
	await expect(
		preview.getByTestId('configuration-resolutions').getByText('Shift: Steward, Lead')
	).toBeVisible();
	await expect(preview.getByTestId('configuration-resolutions')).toBeVisible();

	// A preview is an observation: nothing was written, and all three surfaces are unchanged.
	expect(writes).toEqual([]);
	expect(await dataset(request)).toEqual(before);
	expect(await workerDraft(request, alexId)).toEqual(beforeDraft);

	// The confirm stays disabled until every lossy surface has its own retained answer.
	await expect(confirmButton(page)).toBeDisabled();
	await choose(preview.getByLabel('Retained value for ' + alex + ' value'), {
		label: 'Keep Steward'
	});
	await expect(confirmButton(page)).toBeDisabled();
	await choose(preview.getByLabel('Retained value for ' + alex + ' draft update'), {
		label: 'Keep Trainer'
	});
	await expect(confirmButton(page)).toBeDisabled();
	await choose(preview.getByLabel('Retained value for ' + alex + ' draft base'), {
		label: 'Keep Lead'
	});
	await expect(confirmButton(page)).toBeEnabled();
	await confirmButton(page).click();
	await expect(preview).toHaveCount(0);

	await expect
		.poll(async () => {
			const view = await dataset(request);
			return view.attributes.find((attribute) => attribute.id === id.shift)?.kind;
		})
		.toBe('category');

	const after = await dataset(request);
	// The chosen answers replace the first-survivor shortcut.
	expect(worker(after, alex).attributes).toEqual({
		[id.shift]: id.steward,
		[id.department]: id.front,
		[id.location]: ''
	});
	expect(worker(after, blair).attributes).toEqual({
		[id.shift]: id.steward,
		[id.department]: id.back,
		[id.location]: ''
	});
	expect(worker(after, casey).attributes).toEqual({
		[id.shift]: '',
		[id.department]: '',
		[id.location]: ''
	});
	// The Attribute keeps every answer id, label and order; only its cardinality changed.
	const shift = after.attributes.find((attribute) => attribute.id === id.shift)!;
	expect(shift.options.map((option) => option.id)).toEqual([id.trainer, id.steward, id.lead]);
	expect(shift.options.map((option) => option.value)).toEqual(['Trainer', 'Steward', 'Lead']);

	// The draft keeps its contact input and pending note; update and base follow their choices.
	const draft = await workerDraft(request, alexId);
	expect(draft.update.name).toBe(alex);
	expect(draft.update.email).toBe('alex@example.com');
	expect(draft.pendingNote.text).toBe('keep this note');
	expect(draft.update.attributes).toEqual({
		[id.shift]: id.trainer,
		[id.department]: id.front,
		[id.location]: ''
	});
	expect(draft.base.attributes).toEqual({
		[id.shift]: id.lead,
		[id.department]: id.front,
		[id.location]: ''
	});

	// Reload: Configuration names the new cardinality, and the Workers row reads one answer.
	await page.reload();
	await appReady(page);
	const shiftEditor = await openAttributeEditor(page, 'Shift');
	await expect(
		shiftEditor.getByRole('button', { name: 'Switch from Single-Select to Multi-Select' })
	).toBeVisible();
	await closeAttributeEditor(page);
	await page.goto('/workers');
	await appReady(page);
	const alexRow = page.getByRole('row', { name: new RegExp(alex) });
	await expect(alexRow.getByText('Steward', { exact: true })).toBeVisible();
});

test('an unsafe conversion shows validation feedback and leaves every stored selection unchanged', async ({
	page,
	request
}) => {
	const id = ids();
	await configure(request, taggedConfiguration(id));
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex unresolved ' + suffix;
	const alexId = await createWorkerWithIds(request, {
		name: alex,
		attributes: {
			[id.shift]: [id.trainer, id.steward],
			[id.department]: id.front,
			[id.location]: ''
		}
	});
	await saveWorkerDraft(
		request,
		alexId,
		draftBody(id, alex, id.front, [id.trainer, id.lead], [id.steward, id.lead])
	);
	const before = await dataset(request);
	const beforeDraft = await workerDraft(request, alexId);

	await openConfiguration(page);
	await chooseSingleSelect(page);
	await saveAll(page).click();

	// The core's preview names the loss and the Save action stays blocked until every
	// affected Worker value, draft update and draft base has an explicit retained value.
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(
		preview.getByRole('heading', { name: 'Save changes and discard values?' })
	).toBeVisible();
	await expect(preview.getByText('Change Shift to Single-Select')).toBeVisible();
	await expect(preview.getByTestId('configuration-resolutions')).toBeVisible();
	await expect(preview.getByText(alex + ' — Worker value')).toBeVisible();
	await expect(preview.getByText(alex + ' — Worker draft update')).toBeVisible();
	await expect(preview.getByText(alex + ' — Worker draft base')).toBeVisible();
	await expect(confirmButton(page)).toBeDisabled();

	await preview.getByRole('button', { name: 'Cancel' }).click();
	await expect(preview).toHaveCount(0);

	// Nothing was persisted: the Attribute stays Multi-Select and both stored selection
	// surfaces still hold several values.
	expect(await dataset(request)).toEqual(before);
	expect(await workerDraft(request, alexId)).toEqual(beforeDraft);
	await page.reload();
	await appReady(page);
	const shift = await openAttributeEditor(page, 'Shift');
	await expect(
		shift.getByRole('button', { name: 'Switch from Multi-Select to Single-Select' })
	).toBeVisible();
	await closeAttributeEditor(page);
	expect(worker(await dataset(request), alex).attributes).toEqual({
		[id.shift]: [id.trainer, id.steward],
		[id.department]: id.front,
		[id.location]: ''
	});
});

test('@ticket-15 keeps an explicit no-value choice on all lossy surfaces', async ({
	page,
	request
}) => {
	const id = ids();
	await configure(request, taggedConfiguration(id));
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex empty ' + suffix;
	const alexId = await createWorkerWithIds(request, {
		name: alex,
		attributes: {
			[id.shift]: [id.trainer, id.steward],
			[id.department]: id.front,
			[id.location]: ''
		}
	});
	await saveWorkerDraft(
		request,
		alexId,
		draftBody(id, alex, id.front, [id.trainer, id.lead], [id.steward, id.lead])
	);
	await openConfiguration(page);
	await chooseSingleSelect(page);
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(confirmButton(page)).toBeDisabled();
	for (const surface of ['value', 'draft update', 'draft base']) {
		await choose(preview.getByLabel('Retained value for ' + alex + ' ' + surface), {
			label: 'No value'
		});
	}
	await expect(confirmButton(page)).toBeEnabled();
	await confirmButton(page).click();
	await expect(preview).toHaveCount(0);

	const after = await dataset(request);
	expect(worker(after, alex).attributes).toEqual({
		[id.shift]: '',
		[id.department]: id.front,
		[id.location]: ''
	});
	const draft = await workerDraft(request, alexId);
	expect(draft.update.attributes).toEqual({
		[id.shift]: '',
		[id.department]: id.front,
		[id.location]: ''
	});
	expect(draft.base.attributes).toEqual({
		[id.shift]: '',
		[id.department]: id.front,
		[id.location]: ''
	});
});

test('@ticket-15 single-select to multi-select stays lossless and needs no choice', async ({
	page,
	request
}) => {
	const id = ids();
	await configure(request, singleSelectConfiguration(id));
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex ' + suffix;
	const alexId = await createWorkerWithIds(request, {
		name: alex,
		attributes: { [id.shift]: id.trainer, [id.department]: id.front, [id.location]: '' }
	});
	await saveWorkerDraft(request, alexId, draftBody(id, alex, id.front, id.lead, id.trainer));

	await openConfiguration(page);
	await chooseMultiSelect(page);
	const writes = observeWrites(page);
	await saveAll(page).click();

	// The preview is informational: no lossy surface needs a choice.
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByTestId('configuration-resolutions')).toHaveCount(0);
	await expect(preview.getByText('Each Worker keeps the value they recorded.')).toBeVisible();
	expect(writes).toEqual([]);
	await preview.getByRole('button', { name: 'Save changes' }).click();
	await expect(preview).toHaveCount(0);

	await expect
		.poll(async () => {
			const view = await dataset(request);
			return view.attributes.find((attribute) => attribute.id === id.shift)?.kind;
		})
		.toBe('tag');

	const after = await dataset(request);
	expect(worker(after, alex).attributes).toEqual({
		[id.shift]: [id.trainer],
		[id.department]: id.front,
		[id.location]: ''
	});
	const draft = await workerDraft(request, alexId);
	expect(draft.update.attributes).toEqual({
		[id.shift]: [id.lead],
		[id.department]: id.front,
		[id.location]: ''
	});
	expect(draft.base.attributes).toEqual({
		[id.shift]: [id.trainer],
		[id.department]: id.front,
		[id.location]: ''
	});
});

test('@ticket-15 a Worker value change after the preview is refused as stale', async ({
	page,
	request
}) => {
	const id = ids();
	await configure(request, taggedConfiguration(id));
	const suffix = randomUUID().slice(0, 6);
	const alex = 'Alex ' + suffix;
	const alexId = await createWorkerWithIds(request, {
		name: alex,
		attributes: {
			[id.shift]: [id.trainer, id.steward],
			[id.department]: id.front,
			[id.location]: ''
		}
	});
	await saveWorkerDraft(
		request,
		alexId,
		draftBody(id, alex, id.front, [id.trainer, id.lead], [id.steward, id.lead])
	);

	await openConfiguration(page);
	await chooseSingleSelect(page);
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	for (const [surface, keep] of [
		['value', 'Keep Steward'],
		['draft update', 'Keep Trainer'],
		['draft base', 'Keep Lead']
	]) {
		await choose(preview.getByLabel('Retained value for ' + alex + ' ' + surface), {
			label: keep
		});
	}
	await expect(confirmButton(page)).toBeEnabled();

	// A Worker value edit lands between the preview and the confirmation.
	const changed = await request.patch('/api/workers/' + alexId, {
		data: { attributeId: id.shift, value: [id.trainer] }
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
	expect(
		(await dataset(request)).attributes.find((attribute) => attribute.id === id.shift)?.kind
	).toBe('tag');
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

/** Opens an Attribute editor for folded gap tests. */
async function gapOpenEditor(page: Page, attributeName: string): Promise<Locator> {
	return openAttributeEditor(page, attributeName);
}

test('[folded from product-gap-12] converting Roles to Single-Select explains retention and keeps the recorded-first value', async ({
	page,
	request
}) => {
	const fixture = await gap12SeedFixture(request);
	await openConfiguration(page);
	const dialog = await gapOpenEditor(page, 'Roles');

	await dialog.getByRole('button', { name: 'Switch from Multi-Select to Single-Select' }).click();
	await closeAttributeEditor(page);

	const writes = observeWrites(page);
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByText('3 Workers affected. 1 value would be discarded')).toBeVisible();
	await expect(preview.getByText('Change Roles to Single-Select')).toBeVisible();
	await expect(
		preview.getByText(
			'3 Workers affected; 1 value discarded. Every affected Worker value, draft update, and draft base keeps the value chosen here; the others are discarded.'
		)
	).toBeVisible();
	expect(writes).toEqual([]);

	// The cardinality change needs one retained answer per affected surface before confirming.
	for (const retained of await preview.getByRole('combobox', { name: /Retained value/ }).all()) {
		await choose(retained, { label: 'Keep Trainer' });
	}

	await preview.getByRole('button', { name: 'Save and discard values' }).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toHaveCount(0);

	const after = await readDataset(request);
	// Blair recorded Trainer first, so Trainer survives even though Steward is configured second.
	expect(held(after, 'Alex', fixture.roles)).toBe(fixture.trainer);
	expect(held(after, 'Blair', fixture.roles)).toBe(fixture.trainer);
	expect(held(after, 'Drew', fixture.roles)).toBe(fixture.steward);
	expect(held(after, 'Casey', fixture.roles)).toBe('');
});
