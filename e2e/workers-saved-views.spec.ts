import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { openWorkers } from './pages.ts';
import { answerId } from './answer-wire.ts';
import { addAttributes, addWorkers } from './worksite-builder.ts';

/**
 * Ticket 19: saved Workers views. A view opens as an editable copy; only Save as, Update,
 * Rename and Delete change what is stored; a view naming something that is gone opens as
 * Needs review and never broadens silently.
 */

const rows = (page: Page) => page.locator('tbody tr[data-worker-id]');
const views = (page: Page) => page.getByTestId('views-panel');

type StoredView = {
	id: string;
	name: string;
	snapshot: { workers: { filters: { population: { answers: Record<string, string[]> } } } };
};

async function stored(request: APIRequestContext): Promise<StoredView[]> {
	const reply = await request.get('/api/views');
	expect(reply.ok()).toBeTruthy();
	return ((await reply.json()) as { views: StoredView[] }).views;
}

async function seed(request: APIRequestContext) {
	const [role] = await addAttributes(request, [
		{ name: 'Role', kind: 'category', options: ['Steward', 'Member'] }
	]);
	await addWorkers(request, [
		{ name: 'Ada Lovelace', attributes: { [role]: 'Steward' } },
		{ name: 'Grace Hopper', attributes: { [role]: 'Member' } },
		{ name: 'Alan Turing', attributes: { [role]: 'Steward' } }
	]);
	return { role, steward: answerId(role, 'Steward') };
}

async function openMenu(page: Page) {
	await page.getByTestId('views-trigger').click();
	await expect(views(page)).toBeVisible();
}

function workersSnapshot(answers: Record<string, string[]>) {
	return {
		version: 1,
		kind: 'workers',
		workers: {
			filters: {
				population: { answers, exactAnswers: {}, missing: [] },
				agitations: [],
				languages: [],
				assessments: []
			},
			sort: [{ column: 'name', descending: false }],
			hiddenColumns: [],
			order: []
		}
	};
}

test('Save as, open as a copy, explicit Update, Rename and Delete', async ({ page, request }) => {
	const { role, steward } = await seed(request);
	await openWorkers(page, `/workers?f=${role}:${steward}`);
	await expect(rows(page)).toHaveCount(2);

	await openMenu(page);
	await page.getByTestId('view-name').fill('Stewards');
	await page.getByTestId('view-save-as').click();
	await expect(views(page).getByTestId('view-row')).toHaveCount(1);
	expect((await stored(request))[0].snapshot.workers.filters.population.answers).toEqual({
		[role]: [steward]
	});
	await page.keyboard.press('Escape');

	// Opening applies the question without writing anything back.
	await page.getByRole('button', { name: 'Clear filters' }).click();
	await expect(rows(page)).toHaveCount(3);
	await openMenu(page);
	await views(page).getByRole('button', { name: 'Open Stewards' }).click();
	await expect(rows(page)).toHaveCount(2);
	await expect(page).toHaveURL(new RegExp(`f=${role}`));
	expect((await stored(request))[0].snapshot.workers.filters.population.answers).toEqual({
		[role]: [steward]
	});

	// Update is the only thing that overwrites.
	await page.getByRole('button', { name: 'Clear filters' }).click();
	await expect(rows(page)).toHaveCount(3);
	expect((await stored(request))[0].snapshot.workers.filters.population.answers).toEqual({
		[role]: [steward]
	});
	await openMenu(page);
	await page.getByTestId('view-update').click();
	await expect
		.poll(async () => (await stored(request))[0].snapshot.workers.filters.population.answers)
		.toEqual({});

	await views(page).getByRole('button', { name: 'Rename Stewards' }).click();
	await views(page).getByRole('textbox', { name: 'Rename Stewards' }).fill('Everyone');
	await views(page).getByRole('button', { name: 'Save', exact: true }).click();
	await expect(views(page).getByTestId('view-row')).toHaveAttribute('data-view-name', 'Everyone');

	await views(page).getByRole('button', { name: 'Delete Everyone' }).click();
	await views(page).getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(views(page).getByTestId('view-row')).toHaveCount(0);
	expect(await stored(request)).toEqual([]);
});

test('a view naming something gone opens as Needs review, dropping one reference at a time', async ({
	page,
	request
}) => {
	const { role, steward } = await seed(request);
	const created = await request.post('/api/views', {
		data: {
			name: 'Old view',
			snapshot: workersSnapshot({ [role]: [steward], 'attribute-gone': ['answer-gone'] })
		}
	});
	expect(created.status()).toBe(201);

	await openWorkers(page);
	await expect(rows(page)).toHaveCount(3);
	await openMenu(page);
	await views(page).getByRole('button', { name: 'Open Old view' }).click();

	const review = page.getByTestId('view-review');
	await expect(review).toBeVisible();
	await expect(review.getByTestId('view-problem')).toHaveCount(1);
	await expect(review.getByTestId('view-review-open')).toBeDisabled();
	// Nothing was applied while it waits.
	await expect(rows(page)).toHaveCount(3);

	await review.getByRole('button', { name: 'Cancel' }).click();
	await expect(review).toHaveCount(0);
	await expect(rows(page)).toHaveCount(3);

	await openMenu(page);
	await views(page).getByRole('button', { name: 'Open Old view' }).click();
	await review.getByTestId('view-problem-drop').click();
	await review.getByTestId('view-review-open').click();
	await expect(review).toHaveCount(0);
	// What still reads is applied; nothing else was broadened.
	await expect(rows(page)).toHaveCount(2);

	// The stored view keeps the broken reference until the organizer updates it.
	expect((await stored(request))[0].snapshot.workers.filters.population.answers).toHaveProperty(
		'attribute-gone'
	);
});

test('reload keeps filters from the address and resets sort, columns and order to defaults', async ({
	page,
	request
}) => {
	const { role, steward } = await seed(request);
	const created = await request.post('/api/views', {
		data: {
			name: 'Reverse names',
			snapshot: {
				...workersSnapshot({ [role]: [steward] }),
				workers: {
					...workersSnapshot({ [role]: [steward] }).workers,
					sort: [{ column: 'name', descending: true }]
				}
			}
		}
	});
	expect(created.status()).toBe(201);

	await openWorkers(page);
	await openMenu(page);
	await views(page).getByRole('button', { name: 'Open Reverse names' }).click();
	await expect(rows(page).first()).toContainText('Alan Turing');

	await page.reload();
	await expect(rows(page)).toHaveCount(2);
	await expect(rows(page).first()).toContainText('Ada Lovelace');
});
