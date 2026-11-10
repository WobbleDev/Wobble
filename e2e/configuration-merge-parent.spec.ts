import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { createWorkerWithIds, observeWrites, saveDraft, readDataset } from './api.ts';
import { openConfiguration } from './pages.ts';
import { appReady } from './page-ready.ts';
import { closeAttributeEditor, openAttributeEditor } from './configuration-outline.ts';

/**
 * Ticket 13: merge parent branches after explicitly resolving their children. The fixture
 * is seeded through the API, while the Configuration edits and confirmation use the UI.
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

function locationOptions(view: Dataset, id: Ids) {
	const location = view.attributes.find((attribute) => attribute.id === id.location);
	expect(location, 'Location').toBeTruthy();
	return location!.options;
}

const saveAll = (page: Page) => page.getByRole('button', { name: 'Save all', exact: true });
const previewDialog = (page: Page) => page.getByTestId('configuration-preview-dialog');
/** Opens Location's attribute editor; every edit below is scoped to the returned row. */
async function move(editor: Locator, from: string, to: string): Promise<void> {
	await editor.getByRole('button', { name: 'Place ' + from, exact: true }).click();
	await editor.getByRole('button', { name: 'Place under ' + to, exact: true }).click();
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

test('explicitly resolves children before merging a parent branch', async ({ page, request }) => {
	const fixture = await seeded(request);
	const { id } = fixture;
	const before = await dataset(request);
	const originalIds = locationOptions(before, id).map((answer) => answer.id);

	await openConfiguration(page);
	const editor = await openAttributeEditor(page, 'Location');

	// Move both child branches explicitly. The child whose label conflicts is relabelled
	// before the parent merge; no identity is folded based on text.
	await move(editor, 'Central / Store A', 'North');
	await move(editor, 'Central / Packing', 'North');
	await expect(page.getByRole('alert')).toContainText(
		'Another value under that parent already uses this name.'
	);
	// The refused move is still the draft's intent: both Packings sit under North, so
	// the moved one is the second of the two same-named chips.
	await editor.getByRole('button', { name: 'Edit North / Packing', exact: true }).nth(1).click();
	const packingName = editor.getByRole('textbox', { name: 'Rename Packing' });
	await packingName.fill('Packing (Central)');
	await packingName.press('Enter');
	await expect(editor.getByTitle('North / Packing (Central)', { exact: true })).toContainText(
		'Packing (Central)'
	);

	// The parent merge is a separate explicit choice after every child is resolved.
	await editor.getByRole('button', { name: 'Edit Central' }).click();
	const parentName = editor.getByRole('textbox', { name: 'Rename Central' });
	await parentName.fill('North');
	await parentName.press('Enter');
	const parentMerge = page.getByRole('alertdialog');
	await expect(parentMerge).toBeVisible();
	await parentMerge.getByRole('button', { name: 'Merge', exact: true }).click();
	await expect(parentMerge).toHaveCount(0);

	await closeAttributeEditor(page);
	const writes = observeWrites(page);
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByRole('heading', { name: 'Merge Central into North' })).toBeVisible();
	await expect(preview.getByText('Move Packing (Central) under North')).toBeVisible();
	await expect(
		preview.locator('[data-holder-kind="worker"]').filter({ hasText: 'Casey' }).first()
	).toBeVisible();
	// Preview remains read-only, including the child move/fold and direct parent holder.
	expect(writes).toEqual([]);
	expect(await dataset(request)).toEqual(before);
	await preview.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect(preview).toHaveCount(0);

	const after = await dataset(request);
	const options = locationOptions(after, id);
	expect(options.map((answer) => answer.id)).toContain(id.north);
	expect(options.map((answer) => answer.id)).not.toContain(id.central);
	expect(options.map((answer) => answer.id)).toContain(id.centralPacking);
	expect(options.map((answer) => answer.id)).toContain(id.northPacking);
	expect(options.map((answer) => answer.id)).toContain(id.storeA);
	expect(options.map((answer) => answer.id)).toEqual(
		originalIds.filter((answer) => answer !== id.central)
	);
});

type WorkerRoleIds = {
	role: string;
	central: string;
	north: string;
	packing: string;
	shipping: string;
};

/** Role: Central / Packing, and North / Shipping. */
async function workerRoleFixture(request: APIRequestContext): Promise<WorkerRoleIds> {
	const suffix = randomUUID().slice(0, 8);
	const ids: WorkerRoleIds = {
		role: `t13-role-${suffix}`,
		central: `t13-role-central-${suffix}`,
		north: `t13-role-north-${suffix}`,
		packing: `t13-role-packing-${suffix}`,
		shipping: `t13-role-shipping-${suffix}`
	};
	const response = await request.put('/api/attributes', {
		data: [
			{
				id: ids.role,
				name: 'Role',
				kind: 'category',
				options: [
					{ id: ids.central, value: 'Central' },
					{ id: ids.north, value: 'North' },
					{ id: ids.packing, value: 'Packing', parentId: ids.central },
					{ id: ids.shipping, value: 'Shipping', parentId: ids.north }
				]
			}
		]
	});
	expect(response.ok(), await response.text()).toBeTruthy();
	return ids;
}

async function workerWithRole(
	request: APIRequestContext,
	name: string,
	attributeId: string,
	roleId: string
): Promise<string> {
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
	request: APIRequestContext,
	workerId: string,
	name: string,
	attributeId: string,
	roleId: string
): Promise<void> {
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
			update: { ...update, attributes: { [attributeId]: roleId } },
			pendingNote: { text: 'keep this note' },
			base: { ...update, attributes: { [attributeId]: roleId } }
		}
	});
	expect(response.status(), await response.text()).toBe(200);
}

test('a parent merge names and remaps the saved value and both draft surfaces', async ({
	page,
	request
}) => {
	const ids = await workerRoleFixture(request);
	const suffix = randomUUID().slice(0, 5);
	const alexName = 'Alex ' + suffix;
	const danaName = 'Dana ' + suffix;
	const alex = await workerWithRole(request, alexName, ids.role, ids.central);
	const dana = await workerWithRole(request, danaName, ids.role, ids.central);
	await saveWorkerDraft(request, dana, danaName, ids.role, ids.central);
	const draftBefore = (await (await request.get(`/api/worker-drafts/${dana}`)).json()).draft;

	await page.goto('/configuration');
	await appReady(page);
	const editor = await openAttributeEditor(page, 'Role');
	await move(editor, 'Central / Packing', 'North');
	await editor.getByRole('button', { name: 'Edit Central' }).click();
	const parentName = editor.getByRole('textbox', { name: 'Rename Central' });
	await parentName.fill('North');
	await parentName.press('Enter');
	const parentMerge = page.getByRole('alertdialog');
	await expect(parentMerge).toBeVisible();
	await parentMerge.getByRole('button', { name: 'Merge', exact: true }).click();
	await expect(parentMerge).toHaveCount(0);

	await closeAttributeEditor(page);
	await saveAll(page).click();
	const preview = previewDialog(page);
	await expect(preview).toBeVisible();
	await expect(preview.getByRole('heading', { name: 'Merge Central into North' })).toBeVisible();
	await expect(preview.getByLabel(`Resolution for ${alexName} Worker value`)).toBeVisible();
	await expect(preview.getByLabel(`Resolution for ${danaName} Worker value`)).toBeVisible();
	await expect(preview.getByLabel(`Resolution for ${danaName} Worker draft update`)).toBeVisible();
	await expect(preview.getByLabel(`Resolution for ${danaName} Worker draft base`)).toBeVisible();
	await preview.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect(preview).toHaveCount(0);

	const after = await dataset(request);
	const role = after.attributes.find((attribute) => attribute.id === ids.role);
	expect(role!.options.map((option) => option.id)).toEqual([ids.north, ids.packing, ids.shipping]);
	expect(after.workers.find((worker) => worker.id === alex)!.attributes[ids.role]).toBe(ids.north);
	expect(after.workers.find((worker) => worker.id === dana)!.attributes[ids.role]).toBe(ids.north);
	const draftAfter = (await (await request.get(`/api/worker-drafts/${dana}`)).json()).draft;
	expect(draftAfter.update.attributes[ids.role]).toBe(ids.north);
	expect(draftAfter.base.attributes[ids.role]).toBe(ids.north);
	expect(draftAfter.pendingNote.text).toBe('keep this note');
	expect(draftAfter.updatedAt).toBe(draftBefore.updatedAt);
});
