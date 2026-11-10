import { type APIRequestContext } from '@playwright/test';
import { expect, test, testId } from './fixtures.ts';
import { waitForMapInteraction } from './map.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

test.use({ reducedMotion: 'reduce' });

async function seed(request: APIRequestContext) {
	const deptId = testId();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: ['Kitchen', 'Floor'] }
		])
	});
	expect(configured.ok()).toBeTruthy();
	const ids: Record<string, string> = {};
	for (const [name, assessment, dept] of [
		['Worker 07', 'Unassessed', 'Kitchen'],
		['Worker 07', 'Unassessed', 'Floor'],
		['Worker 08', 'Activist', 'Kitchen']
	] as const) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment,
				attributes: wireWorkerAttributes({ [deptId]: dept }),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status()).toBe(201);
		ids[`${name}/${dept}`] = (await created.json()).worker.id;
	}
	return ids;
}

test('search results tell same-named Workers apart and name their visibility', async ({
	page,
	request
}) => {
	const ids = await seed(request);
	await page.goto('/mapping');
	await waitForMapInteraction(page);

	await page.getByRole('button', { name: /^Activist, \d+ workers?, shown/ }).click();
	await page.getByRole('searchbox', { name: 'Find a worker' }).fill('worker 0');

	const list = page.getByTestId('map-search-results');
	await expect(list.getByRole('button')).toHaveCount(3);
	await expect(
		list.getByRole('button', { name: 'Worker 07, Unassessed, Kitchen, drawn' })
	).toBeVisible();
	await expect(
		list.getByRole('button', { name: 'Worker 07, Unassessed, Floor, drawn' })
	).toBeVisible();
	await expect(
		list.getByRole('button', { name: 'Worker 08, Activist, Kitchen, hidden by current view' })
	).toBeVisible();

	// Keyboard: ArrowDown enters the list, Enter on a drawn result selects it and focuses its dot.
	await page.getByRole('searchbox', { name: 'Find a worker' }).press('ArrowDown');
	await expect(list.getByRole('button').first()).toBeFocused();
	await page.keyboard.press('Enter');
	const id = ids['Worker 07/Kitchen'];
	await expect(page.locator(`[data-node-id="${id}"]`)).toBeFocused();
	await expect(page.locator(`[data-node-id="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
	expect(page.url()).not.toMatch(/[?&](sel|q|worker)=/);
});

test('a hidden result opens in Workers without changing the map conditions', async ({
	page,
	request
}) => {
	await seed(request);
	await page.goto('/mapping');
	await waitForMapInteraction(page);

	await page.getByRole('button', { name: /^Activist, \d+ workers?, shown/ }).click();
	await expect(page).toHaveURL(/no=Activist/);
	await page.getByRole('searchbox', { name: 'Find a worker' }).fill('worker 08');
	await page.getByRole('button', { name: /Worker 08.*hidden by current view/ }).click();

	await expect(page).toHaveURL(/\/workers/);
	expect(page.url()).not.toMatch(/[?&](sel|q|worker)=/);
});

test('Back from Open in Workers restores the legend the address names', async ({
	page,
	request
}) => {
	await seed(request);
	await page.goto('/mapping');
	await waitForMapInteraction(page);

	await page.getByRole('button', { name: /^Activist, \d+ workers?, shown/ }).click();
	await expect(page).toHaveURL(/no=Activist/);
	await page.getByRole('searchbox', { name: 'Find a worker' }).fill('worker 08');
	await page.getByRole('button', { name: /Worker 08.*hidden by current view/ }).click();
	await expect(page).toHaveURL(/\/workers/);

	await page.goBack();
	await expect(page).toHaveURL(/no=Activist/);
	await waitForMapInteraction(page);
	await expect(page.getByRole('button', { name: /^Activist, \d+ workers?, hidden/ })).toBeVisible();
});
