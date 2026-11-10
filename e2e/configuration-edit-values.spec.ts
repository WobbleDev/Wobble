import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { readDataset } from './api.ts';
import { openConfiguration } from './pages.ts';
import { closeAttributeEditor, openAttributeEditor } from './configuration-outline.ts';
import { appReady } from './page-ready.ts';

/**
 * Editing Agitations and Languages in place: rename, cancel, blank, merge (cancel and
 * confirm), Discard, and the unsaved-changes warning. Each test runs on a fresh Worksite.
 */

type ValueKind = {
	label: string;
	heading: string;
	addLabel: string;
	workerField: 'agitations' | 'languages';
	create: (request: APIRequestContext, text: string) => Promise<string>;
};

const kinds: ValueKind[] = [
	{
		label: 'Agitations',
		heading: 'Agitations',
		addLabel: 'Add an agitation',
		workerField: 'agitations',
		create: async (request, text) => {
			const response = await request.post('/api/agitations', { data: { text } });
			expect(response.ok(), await response.text()).toBeTruthy();
			return ((await response.json()) as { agitation: { id: string } }).agitation.id;
		}
	},
	{
		label: 'Languages',
		heading: 'Languages',
		addLabel: 'Add a language',
		workerField: 'languages',
		create: async (request, name) => {
			const response = await request.post('/api/languages', { data: { name } });
			expect(response.ok(), await response.text()).toBeTruthy();
			return ((await response.json()) as { language: { id: string } }).language.id;
		}
	}
];

/** Clears the seeded Attributes so a worker can be created with no answers. */
async function clearAttributes(request: APIRequestContext) {
	const cleared = await request.put('/api/attributes', { data: [] });
	expect(cleared.ok()).toBeTruthy();
}

/** Creates a Worker holding the given value ids, in the list this kind edits. */
async function createWorker(
	request: APIRequestContext,
	kind: ValueKind,
	name: string,
	ids: string[]
) {
	const created = await request.post('/api/workers', {
		data: {
			name,
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: {},
			agitations: kind.workerField === 'agitations' ? ids : [],
			languages: kind.workerField === 'languages' ? ids : [],
			relationships: [],
			notes: []
		}
	});
	expect(created.status(), await created.text()).toBe(201);
}

/**
 * Asserts how many times a Worker holds a value. Agitations show in the Worker's record
 * (the Workers grid has no Agitations column); Languages show in the grid's Languages column.
 */
async function expectHolds(
	page: Page,
	kind: ValueKind,
	workerName: string,
	text: string,
	count: number
) {
	if (kind.workerField === 'agitations') {
		await page
			.getByRole('row')
			.filter({ hasText: workerName })
			.getByRole('gridcell', { name: `Name for ${workerName}: ${workerName}`, exact: true })
			.or(
				page
					.getByRole('row')
					.filter({ hasText: workerName })
					.getByRole('cell', { name: `Show details for ${workerName}`, exact: true })
			)
			.click();
		const record = page.getByRole('complementary', { name: `Worker details: ${workerName}` });
		await expect(record.getByRole('button', { name: `Remove agitation ${text}` })).toHaveCount(
			count
		);
		return;
	}
	const row = page.getByRole('row').filter({ hasText: workerName });
	await expect(row.getByText(text, { exact: true })).toHaveCount(count);
}

/** The chip keeps its resting shape while editing: input and remove button share one row. */
async function expectChipOnOneRow(page: Page, text: string) {
	const inputBox = await page.getByRole('textbox', { name: `Rename ${text}` }).boundingBox();
	const removeBox = await page.getByRole('button', { name: `Remove ${text}` }).boundingBox();
	expect(inputBox).not.toBeNull();
	expect(removeBox).not.toBeNull();
	if (!inputBox || !removeBox) return;
	expect(removeBox.y).toBeLessThan(inputBox.y + inputBox.height);
	expect(removeBox.y + removeBox.height).toBeGreaterThan(inputBox.y);
}

/** The section that holds this kind's chips. */
function section(page: Page, kind: ValueKind) {
	return page.locator('section').filter({
		has: page.getByRole('heading', { name: kind.heading, exact: true })
	});
}

async function saveAll(page: Page) {
	await page.getByRole('button', { name: 'Save all' }).click();
	await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);
}

for (const kind of kinds) {
	test.describe(kind.label, () => {
		test('a rename keeps the Worker value and shows the new text after Save', async ({
			page,
			request
		}) => {
			const suffix = Date.now().toString();
			const oldText = `Night shift ${suffix}`;
			const newText = `Overnight ${suffix}`;
			const id = await kind.create(request, oldText);
			await clearAttributes(request);
			await createWorker(request, kind, 'Ada Lovelace', [id]);

			await openConfiguration(page);
			await page.getByRole('button', { name: `Edit ${oldText}` }).click();
			const input = page.getByRole('textbox', { name: `Rename ${oldText}` });
			await input.fill(newText);
			await input.press('Enter');

			await expect(page.getByRole('button', { name: `Edit ${newText}` })).toBeVisible();
			await expect(page.getByText(oldText, { exact: true })).toHaveCount(0);
			await saveAll(page);

			await page.goto('/workers');
			await appReady(page);
			await expectHolds(page, kind, 'Ada Lovelace', newText, 1);
			await expect(page.getByText(oldText, { exact: true })).toHaveCount(0);
		});

		test('Escape cancels an edit and leaves the draft clean', async ({ page, request }) => {
			const suffix = Date.now().toString();
			const text = `Kept ${suffix}`;
			await kind.create(request, text);

			await openConfiguration(page);
			await page.getByRole('button', { name: `Edit ${text}` }).click();
			const input = page.getByRole('textbox', { name: `Rename ${text}` });
			await input.fill('Abandoned edit');
			await input.press('Escape');

			await expect(input).toHaveCount(0);
			await expect(page.getByRole('button', { name: `Edit ${text}` })).toBeVisible();
			await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);
		});

		test('a blank edit is rejected inline and keeps the field open', async ({ page, request }) => {
			const suffix = Date.now().toString();
			const text = `Blank test ${suffix}`;
			await kind.create(request, text);

			await openConfiguration(page);
			await page.getByRole('button', { name: `Edit ${text}` }).click();
			const input = page.getByRole('textbox', { name: `Rename ${text}` });
			await expectChipOnOneRow(page, text);

			await input.fill('   ');
			await input.press('Enter');

			await expect(page.getByRole('alert').filter({ hasText: 'Enter a value.' })).toBeVisible();
			await expect(input).toBeVisible();
			await expectChipOnOneRow(page, text);
			await input.press('Escape');
			await expect(page.getByRole('button', { name: `Edit ${text}` })).toBeVisible();
			await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);
		});

		test('editing at a narrow width keeps the remove button beside the input', async ({
			page,
			request
		}) => {
			const suffix = Date.now().toString();
			const text = `Narrow ${suffix}`;
			await kind.create(request, text);

			await page.setViewportSize({ width: 375, height: 800 });
			await openConfiguration(page);
			await page.getByRole('button', { name: `Edit ${text}` }).click();
			const input = page.getByRole('textbox', { name: `Rename ${text}` });
			await expectChipOnOneRow(page, text);

			// A rejection message drops below the row without pushing the remove button down.
			await input.fill('   ');
			await input.press('Enter');
			await expect(page.getByRole('alert').filter({ hasText: 'Enter a value.' })).toBeVisible();
			await expectChipOnOneRow(page, text);
		});

		test('a matching edit asks before merging, and Cancel restores the chip', async ({
			page,
			request
		}) => {
			const suffix = Date.now().toString();
			const first = `First ${suffix}`;
			const survivor = `Overnight ${suffix}`;
			const third = `Weekend ${suffix}`;
			await kind.create(request, first);
			await kind.create(request, survivor);
			await kind.create(request, third);

			await openConfiguration(page);
			await page.getByRole('button', { name: `Edit ${first}` }).click();
			const input = page.getByRole('textbox', { name: `Rename ${first}` });
			await input.fill(`overnight ${suffix}`);
			await input.press('Enter');

			const dialog = page.getByRole('alertdialog');
			await expect(dialog).toBeVisible();
			await expect(dialog).toContainText(
				`overnight ${suffix} will be merged into the existing ${survivor}.`
			);
			await dialog.getByRole('button', { name: 'Cancel' }).click();

			await expect(dialog).toHaveCount(0);
			await expect(page.getByRole('button', { name: `Edit ${first}` })).toBeVisible();
			await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);
		});

		test('a confirmed merge keeps the survivor in place and holds it once per Worker', async ({
			page,
			request
		}) => {
			const suffix = Date.now().toString();
			const first = `First ${suffix}`;
			const survivor = `Overnight ${suffix}`;
			const third = `Weekend ${suffix}`;
			const firstId = await kind.create(request, first);
			const survivorId = await kind.create(request, survivor);
			const thirdId = await kind.create(request, third);
			await clearAttributes(request);
			await createWorker(request, kind, 'Ada Lovelace', [firstId, survivorId]);
			await createWorker(request, kind, 'Grace Hopper', [firstId]);
			await createWorker(request, kind, 'Katherine Johnson', [thirdId]);

			await openConfiguration(page);
			await page.getByRole('button', { name: `Edit ${first}` }).click();
			const input = page.getByRole('textbox', { name: `Rename ${first}` });
			await input.fill(`overnight ${suffix}`);
			await input.press('Enter');

			const dialog = page.getByRole('alertdialog');
			await expect(dialog).toBeVisible();
			await dialog.getByRole('button', { name: 'Merge', exact: true }).click();

			await expect(dialog).toHaveCount(0);
			await expect(page.getByRole('button', { name: `Edit ${first}` })).toHaveCount(0);
			await expect(section(page, kind).getByRole('button', { name: /^Edit / })).toHaveText([
				survivor,
				third
			]);

			// A shared merge states preservation in the authoritative preview before writing.
			await page.getByRole('button', { name: 'Save all' }).click();
			const preview = page.getByTestId('configuration-preview-dialog');
			await expect(preview).toBeVisible();
			await expect(preview.getByText(`Merge ${first} into ${survivor}`)).toBeVisible();
			await expect(preview.getByRole('button', { name: 'Save changes' })).toBeVisible();
			await preview.getByRole('button', { name: 'Save changes' }).click();
			await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);

			await page.goto('/workers');
			await appReady(page);
			await expectHolds(page, kind, 'Ada Lovelace', survivor, 1);
			await expectHolds(page, kind, 'Grace Hopper', survivor, 1);
			await expect(page.getByText(first, { exact: true })).toHaveCount(0);
		});

		test('Discard undoes a rename and a merge', async ({ page, request }) => {
			const suffix = Date.now().toString();
			const renamed = `Renamed ${suffix}`;
			const survivor = `Survivor ${suffix}`;
			const folded = `Folded ${suffix}`;
			await kind.create(request, renamed);
			await kind.create(request, survivor);
			await kind.create(request, folded);

			await openConfiguration(page);
			await page.getByRole('button', { name: `Edit ${renamed}` }).click();
			const rename = page.getByRole('textbox', { name: `Rename ${renamed}` });
			await rename.fill(`Changed ${suffix}`);
			await rename.press('Enter');
			await expect(page.getByRole('button', { name: `Edit Changed ${suffix}` })).toBeVisible();
			await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

			await page.getByRole('button', { name: `Edit ${folded}` }).click();
			const merge = page.getByRole('textbox', { name: `Rename ${folded}` });
			await merge.fill(survivor);
			await merge.press('Enter');
			await page
				.getByRole('alertdialog')
				.getByRole('button', { name: 'Merge', exact: true })
				.click();
			await expect(page.getByRole('button', { name: `Edit ${folded}` })).toHaveCount(0);

			await page.getByRole('button', { name: 'Discard' }).click();
			await expect(page.getByRole('button', { name: `Edit ${renamed}` })).toBeVisible();
			await expect(page.getByRole('button', { name: `Edit ${folded}` })).toBeVisible();
			await expect(page.getByRole('button', { name: `Edit Changed ${suffix}` })).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);
		});

		test('an edit makes the navigation rail warn before switching Worksite', async ({
			page,
			request,
			activeWorksite
		}) => {
			const suffix = Date.now().toString();
			const text = `Warned ${suffix}`;
			await kind.create(request, text);

			await openConfiguration(page);
			const target = await page.evaluate(async () => {
				const response = await fetch('/api/worksite', { method: 'POST' });
				return (await response.json()).worksite as { id: string; name: string };
			});
			await page.evaluate(async (id) => {
				await fetch('/api/worksite/active', {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ id })
				});
			}, activeWorksite.id);
			await openConfiguration(page);

			await page.getByRole('button', { name: `Edit ${text}` }).click();
			const input = page.getByRole('textbox', { name: `Rename ${text}` });
			await input.fill(`Edited ${suffix}`);
			await input.press('Enter');
			await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

			await page.getByRole('button', { name: `Active Worksite: ${activeWorksite.name}` }).click();
			await page.getByRole('menuitem', { name: target.name, exact: true }).click();
			const dialog = page.getByRole('alertdialog');
			await expect(dialog).toContainText(target.name);
			await dialog.getByRole('button', { name: 'Keep editing' }).click();
			await expect(page.getByRole('button', { name: `Edit Edited ${suffix}` })).toBeVisible();
		});
	});
}

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

type Dataset = {
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

const gapSaveAll = (page: Page) => page.getByRole('button', { name: 'Save all', exact: true });
const previewDialog = (page: Page) => page.getByTestId('configuration-preview-dialog');

/** Opens an Attribute's editor dialog; its controls are scoped to the returned dialog. */
async function openEditor(page: Page, attributeName: string): Promise<Locator> {
	return openAttributeEditor(page, attributeName);
}

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

function gap13Worker(dataset: Dataset, name: string): Dataset['workers'][number] {
	return dataset.workers.find((candidate) => candidate.name === name)!;
}

async function gapRename(page: Page, editLabel: string, renameLabel: string, text: string) {
	await page.getByRole('button', { name: editLabel }).click();
	const input = page.getByRole('textbox', { name: renameLabel });
	await input.fill(text);
	await input.press('Enter');
}

test('[folded from product-gap-12] a harmless rename saves without a preview or confirmation', async ({
	page,
	request
}) => {
	const fixture = await gap12SeedFixture(request);
	const before = await readDataset(request);
	await openConfiguration(page);
	const dialog = await openEditor(page, 'Department');
	await dialog.getByRole('button', { name: 'Rename Department' }).click();
	const name = dialog.getByRole('textbox', { name: 'Name' });
	await name.fill('Team');
	await name.press('Enter');
	await closeAttributeEditor(page);

	let previewRequests = 0;
	page.on('request', (candidate) => {
		if (candidate.url().endsWith('/api/configuration/preview')) previewRequests += 1;
	});

	await gapSaveAll(page).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(gapSaveAll(page)).toHaveCount(0);
	expect(previewRequests).toBe(0);
	await expect(previewDialog(page)).toHaveCount(0);

	const after = await readDataset(request);
	expect(after.attributes.find((attribute) => attribute.id === fixture.department)?.name).toBe(
		'Team'
	);
	expect(after.workers).toEqual(before.workers);
});

test('[folded from product-gap-13] a shared rename saves without a preview and keeps ids and holders', async ({
	page,
	request
}) => {
	const fixture = await gap13SeedFixture(request);
	const before = await readDataset(request);
	await openConfiguration(page);
	await gapRename(page, 'Edit Equipment', 'Rename Equipment', 'Kit');

	let previewRequests = 0;
	page.on('request', (candidate) => {
		if (candidate.url().endsWith('/api/configuration/preview')) previewRequests += 1;
	});

	await gapSaveAll(page).click();
	await expect(previewDialog(page)).toHaveCount(0);
	await expect(gapSaveAll(page)).toHaveCount(0);
	expect(previewRequests).toBe(0);
	await expect(previewDialog(page)).toHaveCount(0);

	const after = await readDataset(request);
	expect(after.agitations).toEqual([
		{ id: fixture.equipment, text: 'Kit' },
		{ id: fixture.schedule, text: 'Schedule' }
	]);
	for (const name of ['Alex', 'Blair', 'Casey', 'Drew']) {
		expect(gap13Worker(after, name).agitations).toEqual(gap13Worker(before, name).agitations);
	}
});
