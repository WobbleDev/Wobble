import { randomUUID } from 'node:crypto';
import { appReady } from './page-ready.ts';
import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { answerId, wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

/** The Worksite's vocabulary, in the order the Workers table and the filter bar read it. */
const attributeDefs = [
	{
		name: 'Department',
		kind: 'category' as const,
		options: ['Front of House', 'Back of House']
	},
	{ name: 'Role', kind: 'category' as const, options: ['Server', 'Cook'] },
	{ name: 'Shifts', kind: 'tag' as const, options: ['Dinner', 'Brunch'] }
];

async function seedVocabulary(request: APIRequestContext) {
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions(attributeDefs.map((attribute) => ({ ...attribute, id: randomUUID() })))
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	const { attributes }: { attributes: { id: string; name: string }[] } = await configured.json();

	const languages: string[] = [];
	for (const name of ['Polish', 'Spanish']) {
		// Creating a Language is idempotent: an existing name comes back with it.
		const created = await request.post('/api/languages', { data: { name } });
		expect(created.ok(), await created.text()).toBeTruthy();
		const { language }: { language: { id: string } } = await created.json();
		languages.push(language.id);
	}

	for (const [index, name] of ['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson'].entries()) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment: 'Supporter',
				attributes: wireWorkerAttributes({
					[attributes[0].id]: attributeDefs[0].options[0],
					[attributes[1].id]: attributeDefs[1].options[index % 2],
					[attributes[2].id]: [attributeDefs[2].options[0]]
				}),
				agitations: [],
				languages: languages.slice(0, (index % 2) + 1),
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}

	return { attributes, languages };
}

test('the Workers table reads Name, Assessment, Languages, Attributes', async ({
	page,
	request
}) => {
	await seedVocabulary(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	const headers = (await page.getByRole('columnheader').allTextContents()).map((text) =>
		text.trim()
	);
	// The pinned selection checkbox leads and carries no text, then Name, then
	// the rest.
	expect(headers).toEqual(['', 'Name', 'Assessment', 'Languages', 'Department', 'Role', 'Shifts']);
});

/** The Name of each rendered Worker row, top to bottom. */
const namesInOrder = async (page: Page) => {
	const rows = page.locator('tbody tr[data-worker-id]');
	const names: string[] = [];
	for (let index = 0; index < (await rows.count()); index += 1) {
		names.push((await rows.nth(index).locator('td').nth(1).innerText()).trim());
	}
	return names;
};

test('Name, Assessment, Languages and Attributes sort; the selection column does not', async ({
	page,
	request
}) => {
	await seedVocabulary(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	const nameHeader = page.getByRole('columnheader', { name: 'Name' });
	const assessmentHeader = page.getByRole('columnheader', { name: 'Assessment' });
	const languagesHeader = page.getByRole('columnheader', { name: 'Languages' });
	const roleHeader = page.getByRole('columnheader', { name: 'Role' });

	await expect(nameHeader.getByRole('button')).toHaveCount(1);
	for (const [header, title] of [
		[assessmentHeader, 'Assessment'],
		[languagesHeader, 'Languages'],
		[roleHeader, 'Role']
	] as const) {
		await expect(header.getByRole('button', { name: title, exact: true })).toHaveCount(1);
		await expect(header).toHaveAttribute('aria-sort', 'none');
	}
	// The pinned selection column has no sort control.
	await expect(page.getByRole('columnheader').first()).not.toHaveAttribute('aria-sort', /.+/);

	// Name A→Z is the default order.
	expect(await namesInOrder(page)).toEqual(['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson']);
	await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
	const sortControl = nameHeader.getByRole('button');
	await sortControl.click();
	await expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
	expect(await namesInOrder(page)).toEqual(['Katherine Johnson', 'Grace Hopper', 'Ada Lovelace']);
	await sortControl.click();
	await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');

	// Languages: Grace holds two, which sorts after the single "Polish" holders in both directions.
	await languagesHeader.getByRole('button', { name: 'Languages', exact: true }).click();
	await expect(languagesHeader).toHaveAttribute('aria-sort', 'ascending');
	expect((await namesInOrder(page)).at(-1)).toBe('Grace Hopper');
	await languagesHeader.getByRole('button', { name: 'Languages', exact: true }).click();
	await expect(languagesHeader).toHaveAttribute('aria-sort', 'descending');
	expect((await namesInOrder(page))[0]).toBe('Grace Hopper');

	// A Category Attribute sorts by its answer label: Cook (Grace) before Server.
	await roleHeader.getByRole('button', { name: 'Role', exact: true }).click();
	await expect(roleHeader).toHaveAttribute('aria-sort', 'ascending');
	expect((await namesInOrder(page))[0]).toBe('Grace Hopper');

	// A filter still works from the same column that no longer sorts. Grace
	// Hopper is the worker the seed gives both Languages to.
	await page.goto('/workers?f=languages:Spanish');
	await appReady(page);
	await expect(page.getByRole('row').filter({ hasText: 'Grace Hopper' })).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: 'Ada Lovelace' })).toHaveCount(0);
});

test('Assessment sorts in scale order with Unassessed last both ways, and the open panel keeps its Worker', async ({
	page,
	request
}) => {
	const assessments = [
		['Ada Lovelace', 'Hostile'],
		['Grace Hopper', 'Unassessed'],
		['Katherine Johnson', 'Leader'],
		['Mary Jackson', 'Activist']
	] as const;
	// The database keeps the worksite's attributes between tests, and a Worker must
	// carry a value for each: blank for a Category, empty for Tags.
	const { attributes } = (await (await request.get('/api/dataset')).json()) as {
		attributes: { id: string; kind: string }[];
	};
	// Every configured Attribute is an ordinary Worker field, so every Worker carries
	// one value for each: blank for a Category, empty for a Tag.
	const blank = Object.fromEntries(
		attributes.map((attribute) => [attribute.id, attribute.kind === 'tag' ? [] : ''])
	);
	for (const [name, assessment] of assessments) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment,
				attributes: blank,
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	const assessmentHeader = page.getByRole('columnheader', { name: 'Assessment' });
	const sortControl = assessmentHeader.getByRole('button', { name: 'Assessment', exact: true });
	await expect(assessmentHeader).toHaveAttribute('aria-sort', 'none');

	// Open Mary's record panel before sorting: the panel must keep following her.
	await page
		.getByRole('gridcell', { name: 'Name for Mary Jackson: Mary Jackson', exact: true })
		.click();
	await expect(
		page.getByRole('complementary', { name: 'Worker details: Mary Jackson' })
	).toBeVisible();

	// First press: ascending in scale order, Unassessed last.
	await sortControl.click();
	await expect(assessmentHeader).toHaveAttribute('aria-sort', 'ascending');
	expect(await namesInOrder(page)).toEqual([
		'Katherine Johnson',
		'Mary Jackson',
		'Ada Lovelace',
		'Grace Hopper'
	]);
	await expect(
		page.getByRole('complementary', { name: 'Worker details: Mary Jackson' })
	).toBeVisible();

	// Second press: descending, and Unassessed still last.
	await sortControl.click();
	await expect(assessmentHeader).toHaveAttribute('aria-sort', 'descending');
	expect(await namesInOrder(page)).toEqual([
		'Ada Lovelace',
		'Mary Jackson',
		'Katherine Johnson',
		'Grace Hopper'
	]);
	await expect(
		page.getByRole('complementary', { name: 'Worker details: Mary Jackson' })
	).toBeVisible();
});

test('a sortable header is set in the same type as a fixed one', async ({ page, request }) => {
	await seedVocabulary(request);

	const typography = (locator: ReturnType<typeof page.getByRole>) =>
		locator.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				family: style.fontFamily,
				size: style.fontSize,
				weight: style.fontWeight,
				transform: style.textTransform,
				spacing: style.letterSpacing
			};
		});

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	const sortable = await typography(
		page.getByRole('columnheader', { name: 'Name' }).getByRole('button')
	);
	const fixed = await typography(page.getByRole('columnheader', { name: 'Assessment' }));

	// Both headers are compared to each other, so this holds at any density; the
	// pass that drives all three densities lives in the layout spec, which owns
	// that installation-wide setting.
	expect(sortable).toEqual(fixed);
	expect(sortable.transform).toBe('uppercase');
	expect(sortable.family).toContain('Roboto Mono');

	// The label leads, so the arrow stays under the body step the control would
	// otherwise take from the button.
	const icon = await page
		.getByRole('columnheader', { name: 'Name' })
		.locator('svg')
		.evaluate((element) => Math.round(element.getBoundingClientRect().width));
	expect(icon).toBeLessThan(14);
});

test('each filterable column header carries its own Filter button, and Columns is its own button, in Workers table order', async ({
	page,
	request
}) => {
	await seedVocabulary(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	// Every filterable column header has a funnel button; Name and the selection column do not.
	for (const name of ['Languages', 'Assessment', 'Department', 'Role', 'Shifts']) {
		await expect(
			page
				.getByRole('columnheader', { name })
				.getByRole('button', { name: `Filter ${name}`, exact: true })
		).toHaveCount(1);
	}
	await expect(
		page.getByRole('columnheader', { name: 'Name' }).getByRole('button', { name: /^Filter/ })
	).toHaveCount(0);

	// The toolbar carries one Filters menu on desktop; each column keeps its own funnel.
	await expect(page.getByRole('button', { name: /^Filters/ })).toHaveCount(1);
	await expect(page.getByTestId('worker-count')).toBeVisible();

	await page.getByRole('button', { name: 'Columns', exact: true }).click();
	const items = await page
		.getByRole('group', { name: 'Columns' })
		.getByRole('menuitemcheckbox')
		.evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
	expect(items).toEqual(['Assessment', 'Languages', 'Department', 'Role', 'Shifts']);
});

test('Assessment can be hidden and shown again from the Columns button', async ({
	page,
	request
}) => {
	await seedVocabulary(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	const assessmentHeader = page.getByRole('columnheader', { name: 'Assessment' });
	await expect(assessmentHeader).toBeVisible();

	await page.getByRole('button', { name: 'Columns', exact: true }).click();
	const assessment = page
		.getByRole('group', { name: 'Columns' })
		.getByRole('menuitemcheckbox', { name: 'Assessment' });
	await expect(assessment).toBeChecked();

	await assessment.click();
	await expect(assessment).not.toBeChecked();
	await expect(assessmentHeader).toHaveCount(0);

	await assessment.click();
	await expect(assessment).toBeChecked();
	await expect(assessmentHeader).toBeVisible();
});

test('the Columns list never offers the record-panel fields', async ({ page, request }) => {
	await seedVocabulary(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	await page.getByRole('button', { name: 'Columns', exact: true }).click();
	const columns = page.getByRole('group', { name: 'Columns' });
	for (const name of ['Email', 'Phone', 'Agitations', 'Relationships', 'Notes']) {
		await expect(columns.getByRole('menuitemcheckbox', { name })).toHaveCount(0);
		await expect(page.getByRole('columnheader', { name })).toHaveCount(0);
	}
});

test('an Attribute added in Configuration becomes a column', async ({ page, request }) => {
	const { attributes } = await seedVocabulary(request);
	const updated = await request.put('/api/attributes', {
		data: wireDefinitions([
			...attributes.map((attribute, index) => ({ ...attributeDefs[index], id: attribute.id })),
			{ id: randomUUID(), name: 'Zone', kind: 'category', options: ['North', 'South'] }
		])
	});
	expect(updated.ok(), await updated.text()).toBeTruthy();

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);
	await expect(page.getByRole('columnheader', { name: 'Zone' })).toBeVisible();
});

test('an Attribute filter in the URL carries the answer id, and an old text link opens unfiltered', async ({
	page,
	request
}) => {
	const { attributes } = await seedVocabulary(request);
	const role = attributes[1].id;
	await page.setViewportSize({ width: 1440, height: 900 });

	// Only Ada and Katherine are Servers; Grace is the Cook.
	await page.goto(`/workers?f=${role}:${encodeURIComponent(answerId(role, 'Server'))}`);
	await appReady(page);
	await expect(page.getByRole('row').filter({ hasText: 'Ada Lovelace' })).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: 'Grace Hopper' })).toHaveCount(0);

	// A link that carries the answer's text reopens the Workers table unfiltered, without an error.
	await page.goto(`/workers?f=${role}:Server`);
	await appReady(page);
	await expect(page.getByRole('row').filter({ hasText: 'Grace Hopper' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
});

test('an empty search offers Clear search, which leaves the other filters set', async ({
	page,
	request
}) => {
	await seedVocabulary(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers?f=languages:Spanish');
	await appReady(page);

	// Grace Hopper is the only Spanish speaker, so searching for Ada leaves nothing.
	const search = page.getByRole('searchbox', { name: 'Search Name' });
	await search.fill('Ada');
	await expect(page.getByRole('row').filter({ hasText: 'Grace Hopper' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Clear search' }).click();

	await expect(search).toHaveValue('');
	await expect(page.getByRole('button', { name: 'Clear search' })).toHaveCount(0);
	await expect(page.getByRole('row').filter({ hasText: 'Grace Hopper' })).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: 'Ada Lovelace' })).toHaveCount(0);
});

test('an empty Worksite says how to bring workers in', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	await expect(page.getByText('No workers in this worksite yet.')).toBeVisible();
	await expect(page.getByText('or use Import contacts to bring in a list.')).toBeVisible();
});

/** The header labels the grid shows left to right, the selection checkbox first. */
const headerOrder = async (page: Page) =>
	(await page.getByRole('columnheader').allTextContents()).map((text) => text.trim());

/** The column order the seed and the table start from, before anything is moved. */
const DEFAULT_HEADERS = ['', 'Name', 'Assessment', 'Languages', 'Department', 'Role', 'Shifts'];

/** The column ids the header row and the first Worker row carry, left to right. */
async function columnIdsByRow(page: Page) {
	const ids = (locator: Locator) =>
		locator.evaluateAll((nodes) =>
			nodes
				.map((node) => node.getAttribute('data-column-id'))
				.filter((id): id is string => id !== null)
		);
	return {
		headers: await ids(page.locator('thead th')),
		cells: await ids(page.locator('tbody tr[data-worker-id]').first().locator('td'))
	};
}

test('dragging a header moves its column and its cells, and Name stays first', async ({
	page,
	request
}) => {
	const { attributes } = await seedVocabulary(request);
	const role = attributes[1].id;
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	await page
		.getByRole('columnheader', { name: 'Role' })
		.dragTo(page.getByRole('columnheader', { name: 'Assessment' }));

	expect(await headerOrder(page)).toEqual([
		'',
		'Name',
		'Role',
		'Assessment',
		'Languages',
		'Department',
		'Shifts'
	]);
	// The cells follow their headers: the first row's cells sit under the same column ids, in the same order.
	const { headers, cells } = await columnIdsByRow(page);
	// The checkbox column is pinned and left out of the comparison.
	const dataColumns = (ids: string[]) => ids.filter((id) => id !== 'selection');
	expect(headers.indexOf(role)).toBe(2);
	expect(dataColumns(cells)).toEqual(dataColumns(headers));
	await expect(page.locator('tbody tr[data-worker-id]').first().locator('td').nth(1)).toHaveText(
		/Ada Lovelace/
	);
});

test('dragging a header never sorts, and clicking it still does', async ({ page, request }) => {
	await seedVocabulary(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	const nameHeader = page.getByRole('columnheader', { name: 'Name' });
	const languagesHeader = page.getByRole('columnheader', { name: 'Languages' });
	await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');

	await languagesHeader.dragTo(page.getByRole('columnheader', { name: 'Role' }));
	await expect(languagesHeader).toHaveAttribute('aria-sort', 'none');
	await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
	expect(await namesInOrder(page)).toEqual(['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson']);

	await languagesHeader.getByRole('button', { name: 'Languages', exact: true }).click();
	await expect(languagesHeader).toHaveAttribute('aria-sort', 'ascending');
});

test('Name and the selection checkbox cannot be dragged, and nothing drops onto them', async ({
	page,
	request
}) => {
	await seedVocabulary(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	const nameHeader = page.getByRole('columnheader', { name: 'Name' });
	const selectionHeader = page.getByRole('columnheader').first();
	await expect(nameHeader).not.toHaveAttribute('draggable', 'true');
	await expect(selectionHeader).not.toHaveAttribute('draggable', 'true');

	await page.getByRole('columnheader', { name: 'Assessment' }).dragTo(nameHeader);
	await page.getByRole('columnheader', { name: 'Languages' }).dragTo(selectionHeader);
	expect(await headerOrder(page)).toEqual(DEFAULT_HEADERS);
});

test('Alt+Arrow moves the focused header one place, keeps focus on it, and announces the move', async ({
	page,
	request
}) => {
	await seedVocabulary(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	const roleSort = () =>
		page
			.getByRole('columnheader', { name: 'Role' })
			.getByRole('button', { name: 'Role', exact: true });
	await roleSort().focus();

	await page.keyboard.press('Alt+ArrowLeft');
	expect(await headerOrder(page)).toEqual([
		'',
		'Name',
		'Assessment',
		'Languages',
		'Role',
		'Department',
		'Shifts'
	]);
	await expect(roleSort()).toBeFocused();
	await expect(page.getByTestId('workers-column-notice')).toHaveText('Role moved to position 4');

	await page.keyboard.press('Alt+ArrowRight');
	expect(await headerOrder(page)).toEqual(DEFAULT_HEADERS);
	await expect(roleSort()).toBeFocused();
});

test('Alt+Arrow leaves the order alone next to a pinned column and on Name', async ({
	page,
	request
}) => {
	await seedVocabulary(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	// Assessment's left neighbour is Name, which is pinned.
	await page
		.getByRole('columnheader', { name: 'Assessment' })
		.getByRole('button', { name: 'Assessment', exact: true })
		.focus();
	await page.keyboard.press('Alt+ArrowLeft');
	expect(await headerOrder(page)).toEqual(DEFAULT_HEADERS);

	await page.getByRole('columnheader', { name: 'Name' }).getByRole('button').focus();
	await page.keyboard.press('Alt+ArrowRight');
	expect(await headerOrder(page)).toEqual(DEFAULT_HEADERS);
});

test('a moved order holds through a sort, and a hidden column returns to its place', async ({
	page,
	request
}) => {
	await seedVocabulary(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/workers');
	await appReady(page);

	await page
		.getByRole('columnheader', { name: 'Role' })
		.dragTo(page.getByRole('columnheader', { name: 'Assessment' }));
	const moved = ['', 'Name', 'Role', 'Assessment', 'Languages', 'Department', 'Shifts'];
	expect(await headerOrder(page)).toEqual(moved);

	await page
		.getByRole('columnheader', { name: 'Name' })
		.getByRole('button', { name: 'Name', exact: true })
		.click();
	expect(await headerOrder(page)).toEqual(moved);

	await page.getByRole('button', { name: 'Columns', exact: true }).click();
	const role = page
		.getByRole('group', { name: 'Columns' })
		.getByRole('menuitemcheckbox', { name: 'Role' });
	await role.click();
	await expect(page.getByRole('columnheader', { name: 'Role' })).toHaveCount(0);
	await role.click();
	expect(await headerOrder(page)).toEqual(moved);
});
