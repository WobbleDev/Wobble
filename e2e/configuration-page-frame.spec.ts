import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { readDataset, worksiteDataset } from './api.ts';
import { answerId, wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';
import { openConfiguration } from './pages.ts';
import { appReady } from './page-ready.ts';
import {
	addAttribute,
	addAttributeForm,
	addValue,
	addValueUnder,
	answerRow,
	attributeIds,
	attributeRowByName,
	closeAttributeEditor,
	expandAttribute,
	moveValueUnder,
	openAttributeEditor,
	saveAll,
	workerColumn,
	worksiteCard
} from './configuration-outline.ts';

/**
 * Ticket 04: Configuration is one scrolling page of four parts. The Worksite card holds
 * the name and Committee coverage target, one ordered Attributes list follows, Agitations
 * and Languages share a row beneath it, and the danger zone is last.
 * A card keeps its size and scrolls inside itself, under its own sticky header, rather than stretching its row.
 */

/** Horizontal overflow of the document itself, which the frame must never cause. */
function documentOverflow(page: import('@playwright/test').Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

test('the Worksite card, the one Attributes list and the danger zone read in order', async ({
	page,
	activeWorksite
}) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await openConfiguration(page);
	await page.evaluate(() => document.fonts.ready);

	const card = worksiteCard(page);
	// The control's accessible name carries the visible Worksite name (WCAG 2.5.3).
	await expect(
		card.getByRole('button', { name: `Edit worksite name: ${activeWorksite.name}` })
	).toBeVisible();
	await expect(card.getByLabel('Workers per Leader')).toHaveValue('5');
	await expect(card.getByRole('button', { name: 'Delete Worksite' })).toHaveCount(0);

	const column = workerColumn(page);
	await expect(column.getByRole('heading', { name: 'About each Worker' })).toBeVisible();
	await expect(column.getByTestId('add-attribute')).toContainText('Add attribute');
	await expect(page.getByTestId('assignment-column')).toHaveCount(0);
	await expect(page.getByText('About each Work Assignment')).toHaveCount(0);
	await expect(
		page.getByTestId('agitations-card').getByRole('heading', { name: 'Agitations', exact: true })
	).toBeVisible();
	await expect(
		page.getByTestId('languages-card').getByRole('heading', { name: 'Languages', exact: true })
	).toBeVisible();

	const [cardBox, columnBox, dangerBox] = await Promise.all([
		card.boundingBox(),
		column.boundingBox(),
		page.getByRole('region', { name: 'Danger zone' }).boundingBox()
	]);
	expect(cardBox).not.toBeNull();
	expect(columnBox).not.toBeNull();
	expect(dangerBox).not.toBeNull();

	// The one list fills the card's width beneath the Worksite card.
	expect(Math.abs(columnBox!.width - cardBox!.width)).toBeLessThanOrEqual(1);
	expect(columnBox!.y).toBeGreaterThanOrEqual(cardBox!.y + cardBox!.height - 1);

	// Agitations and Languages share a row beneath the list; the danger zone is last.
	const agitations = await page.getByTestId('agitations-card').boundingBox();
	const languages = await page.getByTestId('languages-card').boundingBox();
	expect(agitations).not.toBeNull();
	expect(languages).not.toBeNull();
	expect(agitations!.y).toBeGreaterThanOrEqual(columnBox!.y + columnBox!.height - 1);
	expect(Math.abs(agitations!.y - languages!.y)).toBeLessThanOrEqual(1);
	expect(agitations!.x).toBeLessThan(languages!.x);
	expect(dangerBox!.y).toBeGreaterThanOrEqual(agitations!.y + agitations!.height - 1);

	// Cards in a row share one height, so no dead space is left under the shorter one.
	expect(Math.abs(agitations!.height - languages!.height)).toBeLessThanOrEqual(1);

	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});

test('the one Attributes list fits at laptop and phone widths without horizontal overflow', async ({
	page
}) => {
	for (const width of [1100, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		await openConfiguration(page);
		await page.evaluate(() => document.fonts.ready);

		const card = await worksiteCard(page).boundingBox();
		const column = await workerColumn(page).boundingBox();
		expect(card).not.toBeNull();
		expect(column).not.toBeNull();
		expect(Math.abs(column!.width - card!.width)).toBeLessThanOrEqual(1);
		expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
	}

	await page.setViewportSize({ width: 390, height: 844 });
	await openConfiguration(page);
	await page.evaluate(() => document.fonts.ready);

	const card = await worksiteCard(page).boundingBox();
	const column = await workerColumn(page).boundingBox();
	const agitations = await page.getByTestId('agitations-card').boundingBox();
	const languages = await page.getByTestId('languages-card').boundingBox();
	const danger = await page.getByRole('region', { name: 'Danger zone' }).boundingBox();
	for (const box of [card, column, agitations, languages, danger]) expect(box).not.toBeNull();

	// On a phone the parts stack: Worksite card, the list, Agitations, Languages, danger zone.
	expect(column!.y).toBeGreaterThanOrEqual(card!.y + card!.height - 1);
	expect(agitations!.y).toBeGreaterThanOrEqual(column!.y + column!.height - 1);
	expect(languages!.y).toBeGreaterThanOrEqual(agitations!.y + agitations!.height - 1);
	expect(danger!.y).toBeGreaterThanOrEqual(languages!.y + languages!.height - 1);
	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});

test('the reorder handle keeps a 24px target on a narrow layout', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openConfiguration(page);
	await page.evaluate(() => document.fonts.ready);

	const row = attributeRowByName(page, 'Department');
	const box = await row.locator('[data-action="reorder"]').boundingBox();
	expect(box).not.toBeNull();
	expect(box!.width).toBeGreaterThanOrEqual(24);
	expect(box!.height).toBeGreaterThanOrEqual(24);
});

test('one ordered list creates both types, nests values, reorders and keeps every identity after save and reload', async ({
	page,
	request
}) => {
	page.on('console', (m) => {
		if (m.text().startsWith('[DIAG]')) console.log(m.text());
	});
	await openConfiguration(page);
	await page.evaluate(() => document.fonts.ready);
	const column = workerColumn(page);

	// Creating an Attribute asks for a name and a type only: no scope decision.
	await column.getByTestId('add-attribute').click();
	const form = addAttributeForm(column);
	await expect(form.getByLabel('Display name')).toBeVisible();
	await expect(form.getByLabel('Attribute type')).toBeVisible();
	await expect(form.getByRole('combobox', { name: /scope/i })).toHaveCount(0);
	await expect(form.getByText(/scope/i)).toHaveCount(0);
	await form.getByLabel('Display name').fill('Team');
	await form.getByRole('button', { name: 'Add attribute', exact: true }).click();
	await expect(form).toHaveCount(0);

	// The second kind is created from the same form; the list has no column to choose.
	await addAttribute(page, 'Skills', { type: 'multi' });

	const team = attributeRowByName(page, 'Team');
	await expect(team).toHaveAccessibleName('Team, Single-Select');
	const skills = attributeRowByName(page, 'Skills');
	await expect(skills).toHaveAccessibleName('Skills, Multi-Select');

	// Both kinds accept the same nested-value hierarchy.
	await addValue(page, 'Team', 'North');
	await addValueUnder(page, 'Team', 'Fulfillment', 'North');
	await addValue(page, 'Team', 'South');
	await addValue(page, 'Skills', 'Machining');
	await addValueUnder(page, 'Skills', 'Lathe', 'Machining');

	// A value moves to another parent, and its path distinguishes it.
	await moveValueUnder(page, 'Team', 'North / Fulfillment', 'South');
	await addValueUnder(page, 'Team', 'Packing', 'North');
	await expandAttribute(page, 'Team');
	await expect(
		attributeRowByName(page, 'Team').getByRole('button', { name: 'Edit Packing' })
	).toHaveCount(1);
	await expect(
		attributeRowByName(page, 'Team').getByRole('button', { name: 'Edit Fulfillment' })
	).toHaveCount(1);

	// A rename changes labels only; now the two same-named values are separated by path.
	await attributeRowByName(page, 'Team')
		.getByRole('button', { name: 'Edit Fulfillment', exact: true })
		.click();
	const rename = attributeRowByName(page, 'Team').getByRole('textbox', {
		name: 'Rename Fulfillment'
	});
	await rename.fill('Packing');
	await rename.press('Enter');
	await expect(
		attributeRowByName(page, 'Team').getByRole('button', { name: 'Edit North / Packing' })
	).toHaveCount(1);
	await expect(
		attributeRowByName(page, 'Team').getByRole('button', { name: 'Edit South / Packing' })
	).toHaveCount(1);

	await attributeRowByName(page, 'Team').getByRole('button', { name: 'Rename Team' }).click();
	const nameInput = attributeRowByName(page, 'Team').getByRole('textbox', {
		name: 'Name',
		exact: true
	});
	await nameInput.fill('Crew');
	await nameInput.press('Enter');
	await expect(attributeRowByName(page, 'Crew')).toBeVisible();

	// Attributes reorder in the one list, and Save writes that order as `position`.
	const before = await attributeIds(page);
	const crewId = await attributeRowByName(page, 'Crew').getAttribute('data-attribute-id');
	const crewHandle = attributeRowByName(page, 'Crew').getByRole('button', {
		name: /^Reorder Crew/
	});
	await crewHandle.focus();
	await crewHandle.press('ArrowUp');
	const after = await attributeIds(page);
	expect(after.indexOf(crewId!)).toBe(before.indexOf(crewId!) - 1);

	await saveAll(page);
	await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);

	const saved = await worksiteDataset(request);
	expect(saved.attributes.map((attribute: { name: string }) => attribute.name)).toEqual([
		'Department',
		'Role',
		'Crew',
		'Shifts',
		'Skills'
	]);
	const savedCrew = saved.attributes.find((attribute: { id: string }) => attribute.id === crewId)!;
	const savedSkills = saved.attributes.find(
		(attribute: { name: string }) => attribute.name === 'Skills'
	)!;
	expect(savedCrew.kind).toBe('category');
	expect(savedSkills.kind).toBe('tag');
	expect(
		savedCrew.options.map((answer: { value: string; parentId?: string }) => [
			answer.value,
			answer.parentId ?? null
		])
	).toEqual([
		['North', null],
		['Packing', savedCrew.options[2].id],
		['South', null],
		['Packing', savedCrew.options[0].id]
	]);
	expect(
		savedSkills.options.map((answer: { value: string; parentId?: string }) => [
			answer.value,
			answer.parentId ?? null
		])
	).toEqual([
		['Machining', null],
		['Lathe', savedSkills.options[0].id]
	]);

	await page.reload();
	await appReady(page);
	const reloaded = await worksiteDataset(request);
	expect(reloaded.attributes).toEqual(saved.attributes);
	expect(await attributeIds(page)).toEqual(
		saved.attributes.map((attribute: { id: string }) => attribute.id)
	);
	await expect(attributeRowByName(page, 'Crew')).toHaveAccessibleName('Crew, Single-Select');
	await expect(attributeRowByName(page, 'Skills')).toHaveAccessibleName('Skills, Multi-Select');

	const savedCrewRow = await openAttributeEditor(page, 'Crew');
	await expect(savedCrewRow.getByRole('button', { name: 'Edit North / Packing' })).toHaveCount(1);
	await expect(savedCrewRow.getByRole('button', { name: 'Edit South / Packing' })).toHaveCount(1);

	const savedSkillsRow = await openAttributeEditor(page, 'Skills');
	await expect(savedSkillsRow.getByRole('button', { name: 'Edit Lathe' })).toHaveCount(1);
	await expect(answerRow(page, 'Lathe', 'Skills')).toHaveCount(1);
});

async function seedCardinalities(request: APIRequestContext) {
	const suffix = randomUUID().slice(0, 8);
	const departmentId = `department-${suffix}`;
	const rolesId = `roles-${suffix}`;

	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: departmentId, name: 'Department', kind: 'category', options: ['Packing', 'Delivery'] },
			{ id: rolesId, name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
		])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	const workers = [
		{ name: 'Alex', department: 'Packing', roles: ['Trainer'] },
		{ name: 'Blair', department: 'Delivery', roles: ['Trainer', 'Steward'] },
		{ name: 'Casey', department: '', roles: [] }
	];
	for (const worker of workers) {
		const created = await request.post('/api/workers', {
			data: {
				name: worker.name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({
					[departmentId]: worker.department,
					[rolesId]: worker.roles
				}),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}

	return { departmentId, rolesId };
}

type SavedDataset = {
	attributes: {
		id: string;
		name: string;
		kind: 'category' | 'tag';
		options: { id: string; value: string }[];
	}[];
	workers: { name: string; attributes: Record<string, string | string[]> }[];
};

/** The saved answers and Worker memberships the save must leave exactly as they were. */
function savedShape(dataset: SavedDataset, departmentId: string, rolesId: string) {
	return {
		attributes: dataset.attributes
			.filter((attribute) => attribute.id === departmentId || attribute.id === rolesId)
			.map((attribute) => ({
				id: attribute.id,
				kind: attribute.kind,
				answers: attribute.options.map((option) => option.id)
			})),
		workers: Object.fromEntries(
			dataset.workers.map((worker) => [
				worker.name,
				{
					department: worker.attributes[departmentId],
					roles: worker.attributes[rolesId]
				}
			])
		)
	};
}

test('[folded from product-gap-02] saving a configured Worksite preserves value ids, order and Worker values', async ({
	page,
	request
}) => {
	const { departmentId, rolesId } = await seedCardinalities(request);
	const before = savedShape(await readDataset(request), departmentId, rolesId);

	// The independent oracle: the stored discriminators and answer ids are untouched.
	expect(before.attributes).toEqual([
		{
			id: departmentId,
			kind: 'category',
			answers: [answerId(departmentId, 'Packing'), answerId(departmentId, 'Delivery')]
		},
		{
			id: rolesId,
			kind: 'tag',
			answers: [answerId(rolesId, 'Trainer'), answerId(rolesId, 'Steward')]
		}
	]);
	expect(before.workers).toEqual({
		Alex: { department: answerId(departmentId, 'Packing'), roles: [answerId(rolesId, 'Trainer')] },
		Blair: {
			department: answerId(departmentId, 'Delivery'),
			roles: [answerId(rolesId, 'Trainer'), answerId(rolesId, 'Steward')]
		},
		Casey: { department: '', roles: [] }
	});

	await openConfiguration(page);
	const department = await openAttributeEditor(page, 'Department');

	// A harmless answer rename makes the Attributes section dirty, so Save all sends
	// their current ids and order through the normal save path.
	await department.getByRole('button', { name: 'Edit Packing' }).click();
	const answerInput = department.getByRole('textbox', { name: 'Rename Packing' });
	await answerInput.fill('Packing crew');
	await answerInput.press('Enter');
	await expect(department.getByRole('button', { name: 'Edit Packing crew' })).toBeVisible();
	await closeAttributeEditor(page);

	await page.getByRole('button', { name: 'Save all' }).click();
	await expect(page.getByRole('button', { name: 'Save all' })).toHaveCount(0);

	const afterDataset = await readDataset(request);
	const after = savedShape(afterDataset, departmentId, rolesId);
	expect(after.attributes).toEqual(before.attributes);
	expect(after.workers).toEqual(before.workers);

	const departmentAfter = afterDataset.attributes.find(
		(attribute) => attribute.id === departmentId
	);
	expect(departmentAfter?.options.map((option) => option.value)).toEqual([
		'Packing crew',
		'Delivery'
	]);
});
