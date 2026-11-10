import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { choose } from './select.ts';
import { observeWrites, readDataset, worksiteDataset } from './api.ts';
import { openConfiguration } from './pages.ts';
import { appReady } from './page-ready.ts';
import {
	closeAttributeEditor,
	expandAttribute,
	openAttributeEditor
} from './configuration-outline.ts';

const previewDialog = (page: import('@playwright/test').Page) =>
	page.getByTestId('configuration-preview-dialog');
const saveAll = (page: import('@playwright/test').Page) =>
	page.getByRole('button', { name: 'Save all', exact: true });

async function fixture(request: import('@playwright/test').APIRequestContext) {
	const suffix = randomUUID().slice(0, 8);
	const ids = {
		location: `t12-location-${suffix}`,
		job: `t12-job-${suffix}`,
		central: `t12-central-${suffix}`,
		storeA: `t12-store-a-${suffix}`,
		dock: `t12-dock-${suffix}`,
		storeB: `t12-store-b-${suffix}`,
		north: `t12-north-${suffix}`,
		neutral: `t12-neutral-${suffix}`
	};
	const configured = await request.put('/api/attributes', {
		data: [
			{
				id: ids.location,
				name: 'Location',
				kind: 'category',
				options: [{ id: ids.neutral, value: 'Worksite' }]
			},
			{
				id: ids.job,
				name: 'Job',
				kind: 'category',
				options: [
					{ id: ids.central, value: 'Central' },
					{ id: ids.storeA, value: 'Store A', parentId: ids.central },
					{ id: ids.dock, value: 'Loading dock', parentId: ids.storeA },
					{ id: ids.storeB, value: 'Store B', parentId: ids.central },
					{ id: ids.north, value: 'North' }
				]
			}
		]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	return ids;
}

async function worker(
	request: import('@playwright/test').APIRequestContext,
	name: string,
	attributes: Record<string, unknown>
) {
	const response = await request.post('/api/workers', {
		data: {
			name,
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes,
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		}
	});
	expect(response.status(), await response.text()).toBe(201);
	return (await response.json()).worker.id as string;
}

test('relocation preserves child identities and resolves a direct parent holder', async ({
	page,
	request
}) => {
	const ids = await fixture(request);
	const alexName = 'Alex ' + randomUUID().slice(0, 5);
	const alex = await worker(request, alexName, {
		[ids.location]: ids.neutral,
		[ids.job]: ids.central
	});
	const before = await worksiteDataset(request);
	await openConfiguration(page);
	const jobEditor = await openAttributeEditor(page, 'Job');
	await jobEditor.getByRole('button', { name: 'Remove Central' }).click();
	const choice = jobEditor.getByTestId('parent-removal-choice');
	await expect(choice).toBeVisible();
	await expect(choice.getByRole('button', { name: 'Remove the entire branch' })).toBeVisible();
	await choose(choice.getByRole('combobox'), ids.north);
	await choice.getByRole('button', { name: 'Relocate children and remove parent' }).click();
	await closeAttributeEditor(page);

	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByText('Move Store A under North')).toBeVisible();
	await expect(preview.getByText('Move Store B under North')).toBeVisible();
	await expect(preview.getByText('Remove the Central value')).toBeVisible();
	await expect(preview.getByLabel(`Resolution for ${alexName} Worker value`)).toBeVisible();
	const afterPreview = await worksiteDataset(request);
	expect(afterPreview.attributes).toEqual(before.attributes);
	await preview.getByRole('button', { name: 'Cancel' }).click();
	expect(await worksiteDataset(request)).toEqual(before);

	await saveAll(page).click();
	await expect(preview).toBeVisible();
	await choose(preview.getByLabel(`Resolution for ${alexName} Worker value`), ids.storeA);
	await preview.getByRole('button', { name: 'Save and discard values' }).click();

	const after = await worksiteDataset(request);
	const job = after.attributes.find((attribute: { id: string }) => attribute.id === ids.job)!;
	// Each value also carries its generated Short form (ADR 0046), which this check ignores.
	const withoutShortForms = job.options.map(
		({ id, value, parentId }: { id: string; value: string; parentId?: string }) => ({
			id,
			value,
			...(parentId ? { parentId } : {})
		})
	);
	expect(withoutShortForms).toEqual([
		{ id: ids.storeA, value: 'Store A', parentId: ids.north },
		{ id: ids.dock, value: 'Loading dock', parentId: ids.storeA },
		{ id: ids.storeB, value: 'Store B', parentId: ids.north },
		{ id: ids.north, value: 'North' }
	]);
	const savedAlex = after.workers.find((candidate: { id: string }) => candidate.id === alex)!;
	expect(savedAlex.attributes[ids.job]).toBe(ids.storeA);
	await page.reload();
	await appReady(page);
	await expandAttribute(page, 'Job');
	await expect(page.getByText('Central', { exact: true })).toHaveCount(0);
	const storeEditor = await openAttributeEditor(page, 'Job');
	await expect(
		storeEditor.getByRole('button', { name: 'Edit Store A', exact: true })
	).toBeVisible();
	await closeAttributeEditor(page);
});

test('whole-branch removal is a separate choice and resolves every removed holder', async ({
	page,
	request
}) => {
	const ids = await fixture(request);
	const suffix = randomUUID().slice(0, 5);
	const alexName = 'Alex ' + suffix;
	const blairName = 'Blair ' + suffix;
	const alex = await worker(request, alexName, {
		[ids.location]: ids.neutral,
		[ids.job]: ids.central
	});
	const blair = await worker(request, blairName, {
		[ids.location]: ids.neutral,
		[ids.job]: ids.storeA
	});

	await openConfiguration(page);
	const jobEditor = await openAttributeEditor(page, 'Job');
	await jobEditor.getByRole('button', { name: 'Remove Central' }).click();
	const choice = jobEditor.getByTestId('parent-removal-choice');
	await choice.getByRole('button', { name: 'Remove the entire branch' }).click();
	await closeAttributeEditor(page);
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByLabel(`Resolution for ${alexName} Worker value`)).toBeVisible();
	await expect(preview.getByLabel(`Resolution for ${blairName} Worker value`)).toBeVisible();
	await choose(preview.getByLabel(`Resolution for ${alexName} Worker value`), '__none__');
	await choose(preview.getByLabel(`Resolution for ${blairName} Worker value`), '__none__');
	await preview.getByRole('button', { name: 'Save and discard values' }).click();

	const after = await worksiteDataset(request);
	const job = after.attributes.find((attribute: { id: string }) => attribute.id === ids.job)!;
	expect(job.options.map((option: { id: string }) => option.id)).toEqual([ids.north]);
	expect(
		after.workers.find((candidate: { id: string }) => candidate.id === alex)!.attributes[ids.job]
	).toBe('');
	expect(
		after.workers.find((candidate: { id: string }) => candidate.id === blair)!.attributes[ids.job]
	).toBe('');
});

test('a stale parent-removal plan leaves the current hierarchy and answers intact', async ({
	page,
	request
}) => {
	const ids = await fixture(request);
	const name = 'Alex ' + randomUUID().slice(0, 5);
	const alex = await worker(request, name, {
		[ids.location]: ids.neutral,
		[ids.job]: ids.central
	});

	await openConfiguration(page);
	const jobEditor = await openAttributeEditor(page, 'Job');
	await jobEditor.getByRole('button', { name: 'Remove Central' }).click();
	const choice = jobEditor.getByTestId('parent-removal-choice');
	await choose(choice.getByRole('combobox'), ids.north);
	await choice.getByRole('button', { name: 'Relocate children and remove parent' }).click();
	await closeAttributeEditor(page);
	await saveAll(page).click();
	const preview = previewDialog(page);
	await choose(preview.getByLabel(`Resolution for ${name} Worker value`), ids.north);
	const changed = await request.patch(`/api/workers/${alex}`, {
		data: { attributeId: ids.job, value: ids.storeA }
	});
	expect(changed.status(), await changed.text()).toBe(200);
	const beforeConfirmation = await worksiteDataset(request);

	await preview.getByRole('button', { name: 'Save and discard values' }).click();
	await expect(preview).toHaveCount(0);
	await expect(
		page.getByText(/The Worksite changed since these effects were checked/)
	).toBeVisible();
	const after = await worksiteDataset(request);
	expect(after).toEqual(beforeConfirmation);
	const job = after.attributes.find((attribute: { id: string }) => attribute.id === ids.job)!;
	expect(job.options.map((option: { id: string }) => option.id)).toContain(ids.central);
});

/** A Worker-scoped Role hierarchy: Central with Store A, and North. */
async function workerRoleFixture(request: import('@playwright/test').APIRequestContext) {
	const suffix = randomUUID().slice(0, 8);
	const ids = {
		role: `t12-role-${suffix}`,
		central: `t12-role-central-${suffix}`,
		storeA: `t12-role-store-a-${suffix}`,
		north: `t12-role-north-${suffix}`
	};
	const response = await request.put('/api/attributes', {
		data: [
			{
				id: ids.role,
				name: 'Role',
				kind: 'category',
				options: [
					{ id: ids.central, value: 'Central' },
					{ id: ids.storeA, value: 'Store A', parentId: ids.central },
					{ id: ids.north, value: 'North' }
				]
			}
		]
	});
	expect(response.ok(), await response.text()).toBeTruthy();
	return ids;
}

async function workerWithRole(
	request: import('@playwright/test').APIRequestContext,
	name: string,
	roleId: string,
	attributeId: string
) {
	const response = await request.post('/api/workers', {
		data: {
			name,
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: { [attributeId]: roleId },
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		}
	});
	expect(response.status(), await response.text()).toBe(201);
	return (await response.json()).worker.id as string;
}

async function saveWorkerDraft(
	request: import('@playwright/test').APIRequestContext,
	workerId: string,
	name: string,
	attributeId: string,
	updateRole: string,
	baseRole: string
) {
	const update = {
		name,
		email: `${name.replace(/\s+/g, '.').toLowerCase()}@example.com`,
		phone: '',
		assessment: 'Unassessed',
		agitations: [],
		languages: [],
		relationships: [],
		notes: []
	};
	const response = await request.put(`/api/worker-drafts/${workerId}`, {
		data: {
			update: { ...update, attributes: { [attributeId]: updateRole } },
			pendingNote: { text: 'keep this note' },
			base: { ...update, attributes: { [attributeId]: baseRole } }
		}
	});
	expect(response.status(), await response.text()).toBe(200);
}

test('@ticket-12 a Worker-scoped parent removal resolves the saved value and both draft surfaces', async ({
	page,
	request
}) => {
	const ids = await workerRoleFixture(request);
	const suffix = randomUUID().slice(0, 5);
	const alexName = 'Alex ' + suffix;
	const danaName = 'Dana ' + suffix;
	const alex = await workerWithRole(request, alexName, ids.central, ids.role);
	const dana = await workerWithRole(request, danaName, ids.central, ids.role);
	await saveWorkerDraft(request, dana, danaName, ids.role, ids.central, ids.central);
	const draftBefore = (await (await request.get(`/api/worker-drafts/${dana}`)).json()).draft;
	const before = await worksiteDataset(request);

	await page.goto('/configuration');
	await appReady(page);
	const roleEditor = await openAttributeEditor(page, 'Role');
	await roleEditor.getByRole('button', { name: 'Remove Central', exact: true }).click();
	const choice = roleEditor.getByTestId('parent-removal-choice');
	await expect(choice).toBeVisible();
	await choice.getByRole('combobox').click();
	const destinations = await page
		.getByRole('option')
		.evaluateAll((options) => options.map((option) => option.getAttribute('data-value')));
	await page.keyboard.press('Escape');
	expect(destinations).not.toContain(ids.central);
	expect(destinations).toContain(ids.north);
	await choose(choice.getByRole('combobox'), ids.north);
	await choice.getByRole('button', { name: 'Relocate children and remove parent' }).click();
	await closeAttributeEditor(page);

	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByText('Remove the Central value')).toBeVisible();
	await expect(preview.getByLabel(`Resolution for ${alexName} Worker value`)).toBeVisible();
	await expect(preview.getByLabel(`Resolution for ${danaName} Worker value`)).toBeVisible();
	await expect(preview.getByLabel(`Resolution for ${danaName} Worker draft update`)).toBeVisible();
	await expect(preview.getByLabel(`Resolution for ${danaName} Worker draft base`)).toBeVisible();
	expect(await worksiteDataset(request)).toEqual(before);
	expect((await (await request.get(`/api/worker-drafts/${dana}`)).json()).draft).toEqual(
		draftBefore
	);

	await choose(preview.getByLabel(`Resolution for ${alexName} Worker value`), ids.storeA);
	await choose(preview.getByLabel(`Resolution for ${danaName} Worker value`), ids.north);
	await choose(preview.getByLabel(`Resolution for ${danaName} Worker draft update`), ids.north);
	await choose(preview.getByLabel(`Resolution for ${danaName} Worker draft base`), '__none__');
	await preview.getByRole('button', { name: 'Save and discard values' }).click();
	await expect(preview).toHaveCount(0);

	const after = await worksiteDataset(request);
	const role = after.attributes.find((attribute: { id: string }) => attribute.id === ids.role)!;
	expect(role.options.map((option: { id: string }) => option.id)).toEqual([ids.storeA, ids.north]);
	expect(
		after.workers.find((candidate: { id: string }) => candidate.id === alex)!.attributes[ids.role]
	).toBe(ids.storeA);
	expect(
		after.workers.find((candidate: { id: string }) => candidate.id === dana)!.attributes[ids.role]
	).toBe(ids.north);
	const draftAfter = (await (await request.get(`/api/worker-drafts/${dana}`)).json()).draft;
	expect(draftAfter.update.attributes[ids.role]).toBe(ids.north);
	expect(draftAfter.base.attributes[ids.role]).toBe('');
	expect(draftAfter.pendingNote.text).toBe('keep this note');
	expect(draftAfter.updatedAt).toBe(draftBefore.updatedAt);
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

test('[folded from product-gap-13] mixed removals count a shared Worker once and each lost value once', async ({
	page,
	request
}) => {
	const fixture = await gap13SeedFixture(request);
	await openConfiguration(page);
	const dialog = await gapOpenEditor(page, 'Department');
	await dialog.getByRole('button', { name: 'Remove Packing' }).click();
	await closeAttributeEditor(page);
	await page.getByRole('button', { name: 'Remove Equipment' }).click();

	const writes = observeWrites(page);
	await saveAll(page).click();

	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	// Alex is affected by both removals but counts once; the three lost values count.
	await expect(
		preview.getByText(
			'2 Workers affected. Each saved value, draft update, and draft base needs an explicit resolution.'
		)
	).toBeVisible();
	await expect(preview.getByText('Remove the Equipment Agitation')).toBeVisible();
	await expect(preview.getByText('Remove the Packing value')).toBeVisible();
	await expect(
		preview.getByText('Removes it from the Worksite and discards 2 values from 2 Workers.')
	).toBeVisible();
	await expect(
		preview.getByText('1 Worker affected; each saved value and draft surface needs a resolution.')
	).toBeVisible();
	expect(writes).toEqual([]);

	for (const resolution of await preview.getByRole('combobox', { name: /Resolution for/ }).all()) {
		await choose(resolution, { label: 'No value' });
	}

	await preview.getByRole('button', { name: 'Save and discard saved values' }).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(saveAll(page)).toHaveCount(0);

	const after = await readDataset(request);
	const department = after.attributes.find((attribute) => attribute.id === fixture.department)!;
	expect(department.options.map((option) => option.id)).toEqual([
		fixture.delivery,
		fixture.noDepartment
	]);
	expect(after.agitations.map((agitation) => agitation.id)).toEqual([fixture.schedule]);
	expect(gap13Worker(after, 'Alex').attributes[fixture.department]).toBe('');
	expect(gap13Worker(after, 'Alex').agitations).toEqual([]);
});
