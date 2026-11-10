import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { worksiteDataset } from './api.ts';
import { appReady } from './page-ready.ts';
import {
	addAttribute,
	closeAttributeEditor,
	openAttributeEditor
} from './configuration-outline.ts';

/**
 * Ticket 08: an organizer builds a hierarchy of answers in Configuration, and the
 * Workers table selects a direct parent or a same-named descendant by its path. Ids,
 * order and holders survive renames and reloads.
 */

type Ids = {
	location: string;
	central: string;
	other: string;
	storeA: string;
	centralPacking: string;
	otherPacking: string;
};

function ids(): Ids {
	const suffix = randomUUID().slice(0, 8);
	return {
		location: 'location-' + suffix,
		central: 'central-' + suffix,
		other: 'other-' + suffix,
		storeA: 'store-a-' + suffix,
		centralPacking: 'central-packing-' + suffix,
		otherPacking: 'other-packing-' + suffix
	};
}

/** Worker Location: Central / Store A, Central / Packing, Other / Packing. */
function locationDefinition(settings: Ids) {
	return {
		id: settings.location,
		name: 'Location',
		kind: 'category',
		options: [
			{ id: settings.central, value: 'Central' },
			{ id: settings.other, value: 'Other' },
			{ id: settings.storeA, value: 'Store A', parentId: settings.central },
			{ id: settings.centralPacking, value: 'Packing', parentId: settings.central },
			{ id: settings.otherPacking, value: 'Packing', parentId: settings.other }
		]
	};
}

async function seed(request: APIRequestContext, settings: Ids): Promise<void> {
	const configured = await request.put('/api/attributes', {
		data: [locationDefinition(settings)]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	const created = await request.post('/api/workers', {
		data: {
			name: 'Rachel Carson',
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: { [settings.location]: '' },
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		}
	});
	expect(created.status(), await created.text()).toBe(201);
}

async function chooseLocation(page: Page, label: string): Promise<void> {
	await page.getByRole('button', { name: 'Edit Location for Rachel Carson' }).click();
	await page.getByRole('menuitemradio', { name: label, exact: true }).click();
}

async function addUnder(
	editor: Locator,
	input: Locator,
	value: string,
	parent: string
): Promise<void> {
	await input.fill(value);
	await editor.getByRole('button', { name: 'Place new value ' + value, exact: true }).click();
	await editor.getByRole('button', { name: 'Place under ' + parent, exact: true }).click();
}

test('Configuration builds root and child answers, rejects sibling collisions, and keeps identity through rename and reload', async ({
	page,
	request
}) => {
	await page.goto('/configuration');
	await appReady(page);

	await addAttribute(page, 'Location');

	const editor = await openAttributeEditor(page, 'Location');
	const option = editor.getByRole('textbox', { name: 'Add an option to Location' });
	for (const value of ['Central', 'Other']) {
		await option.fill(value);
		await option.press('Enter');
	}

	// A child beneath Central, the same label beneath Other, and a deeper leaf under Store A.
	await addUnder(editor, option, 'Store A', 'Central');
	await addUnder(editor, option, 'Packing', 'Central');
	await addUnder(editor, option, 'Packing', 'Other');
	await addUnder(editor, option, 'Loading dock', 'Central / Store A');

	// Two answers with the same label under different parents are distinct paths.
	await expect(
		editor.getByRole('button', { name: 'Edit Central / Packing', exact: true })
	).toHaveCount(1);
	await expect(
		editor.getByRole('button', { name: 'Edit Other / Packing', exact: true })
	).toHaveCount(1);
	const chips = editor.getByTestId('attribute-answers');
	await expect(
		chips.getByRole('button', { name: 'Edit Central / Packing', exact: true })
	).toContainText('Packing');
	await expect(
		chips.getByRole('button', { name: 'Edit Other / Packing', exact: true })
	).toContainText('Packing');
	await expect(chips.getByTitle('Central / Store A / Loading dock', { exact: true })).toContainText(
		'Loading dock'
	);

	// A label repeated under one parent is refused, while the same label under another is not.
	await addUnder(editor, option, 'store a', 'Central');
	await expect(page.getByRole('alert')).toContainText(
		'A value with this name already exists under this parent.'
	);
	await option.fill('');

	// A parent cannot be removed without saying what happens to its children; the
	// branch itself is kept until that choice is made.
	await editor.getByRole('button', { name: 'Remove Central', exact: true }).click();
	const disposition = editor.getByTestId('parent-removal-choice');
	await expect(disposition).toBeVisible();
	await expect(disposition).toHaveAccessibleName(
		'Remove Central and choose what happens to its children'
	);
	await disposition.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(disposition).toHaveCount(0);
	await expect(editor.getByRole('button', { name: 'Edit Central', exact: true })).toBeVisible();

	await closeAttributeEditor(page);
	await page.getByRole('button', { name: 'Save all' }).click();
	await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);

	const saved = await worksiteDataset(request);
	const location = saved.attributes.find((item: { name: string }) => item.name === 'Location')!;
	const savedIds = location.options.map((answer: { id: string }) => answer.id);
	expect(
		location.options.map((answer: { value: string; parentId?: string }) => [
			answer.value,
			answer.parentId ?? null
		])
	).toEqual([
		['Central', null],
		['Other', null],
		['Store A', location.options[0].id],
		['Packing', location.options[0].id],
		['Packing', location.options[1].id],
		['Loading dock', location.options[2].id]
	]);

	// Renaming changes labels only: ids, order and parents stay.
	const renameEditor = await openAttributeEditor(page, 'Location');
	await renameEditor.getByRole('button', { name: 'Edit Central', exact: true }).click();
	const rename = renameEditor.getByRole('textbox', { name: 'Rename Central' });
	await rename.fill('Downtown');
	await rename.press('Enter');
	await expect(
		renameEditor.getByTitle('Downtown / Store A / Loading dock', { exact: true })
	).toContainText('Loading dock');
	await closeAttributeEditor(page);
	await page.getByRole('button', { name: 'Save all' }).click();
	await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);

	const renamed = await worksiteDataset(request);
	const renamedLocation = renamed.attributes.find(
		(item: { name: string }) => item.name === 'Location'
	)!;
	expect(renamedLocation.options.map((answer: { id: string }) => answer.id)).toEqual(savedIds);
	expect(
		renamedLocation.options.map((answer: { value: string; parentId?: string }) => [
			answer.value,
			answer.parentId ?? null
		])
	).toEqual([
		['Downtown', null],
		['Other', null],
		['Store A', location.options[0].id],
		['Packing', location.options[0].id],
		['Packing', location.options[1].id],
		['Loading dock', location.options[2].id]
	]);

	await page.reload();
	await appReady(page);
	const reloadedEditor = await openAttributeEditor(page, 'Location');
	await expect(reloadedEditor.getByTitle('Downtown / Store A', { exact: true })).toContainText(
		'Store A'
	);
	await expect(
		reloadedEditor.getByRole('button', { name: 'Edit Downtown / Packing', exact: true })
	).toHaveCount(1);
	await expect(
		reloadedEditor.getByRole('button', { name: 'Edit Other / Packing', exact: true })
	).toHaveCount(1);
	await closeAttributeEditor(page);

	// The request boundary refuses a cycle and a cross-Attribute parent without writing.
	const afterReload = await worksiteDataset(request);
	const cyclic = [
		{
			...renamedLocation,
			options: [
				{ id: 'cycle-a', value: 'A', parentId: 'cycle-b' },
				{ id: 'cycle-b', value: 'B', parentId: 'cycle-a' }
			]
		}
	];
	const refused = await request.put('/api/attributes', { data: cyclic });
	expect(refused.status()).toBe(400);
	// The parent exists in the payload, but in another Attribute, so it is not this
	// Attribute's to own (and the refused request writes nothing).
	const otherDefinition = {
		id: 'cross-attribute',
		name: 'Crew',
		kind: 'category',
		options: [{ id: 'crew-parent', value: 'Crew parent' }]
	};
	const crossAttribute = [
		{
			...renamedLocation,
			options: [
				...renamedLocation.options,
				{ id: 'cross-child', value: 'Child', parentId: 'crew-parent' }
			]
		},
		otherDefinition
	];
	expect((await request.put('/api/attributes', { data: crossAttribute })).status()).toBe(400);
	expect(await worksiteDataset(request)).toEqual(afterReload);
});

test('Workers selects a direct parent or a same-named child by path, and reload keeps them', async ({
	page,
	request
}) => {
	const settings = ids();
	await seed(request, settings);

	await page.goto('/workers');
	await appReady(page);
	await expect(page.locator('tbody tr[data-worker-id]')).toHaveCount(1);

	// A direct parent selection records Central, not a child.
	await chooseLocation(page, 'Central');
	await expect(
		page.getByRole('row', { name: /Rachel Carson/ }).getByText('Central', { exact: true })
	).toBeVisible();

	// Same-named children are told apart by their paths, and each can be selected.
	await chooseLocation(page, 'Central / Packing');
	await expect(
		page.getByRole('row', { name: /Rachel Carson/ }).getByText('Central / Packing', { exact: true })
	).toBeVisible();
	await chooseLocation(page, 'Other / Packing');
	await expect(
		page.getByRole('row', { name: /Rachel Carson/ }).getByText('Other / Packing', { exact: true })
	).toBeVisible();

	await page.reload();
	await appReady(page);
	await expect(
		page.getByRole('row', { name: /Rachel Carson/ }).getByText('Other / Packing', { exact: true })
	).toBeVisible();
	const afterChoice = await worksiteDataset(request);
	const casey = afterChoice.workers.find(
		(worker: { name: string }) => worker.name === 'Rachel Carson'
	)!;
	expect(casey.attributes[settings.location]).toBe(settings.otherPacking);
});
