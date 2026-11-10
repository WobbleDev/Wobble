import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { openMapping } from './pages.ts';
import { answerId } from './answer-wire.ts';
import { addAttributes, addWorkers } from './worksite-builder.ts';

/**
 * Ticket 19: saved Mapping views keep the map's question (grouping, population, visibility,
 * Highlight) and never the toolbar search, the selection, Isolate or the camera.
 */

const views = (page: Page) => page.getByTestId('views-panel');

test('a Mapping view reopens its grouping and leaves person state out', async ({
	page,
	request
}) => {
	const [role] = await addAttributes(request, [
		{ name: 'Role', kind: 'category', options: ['Steward', 'Member'] }
	]);
	await addWorkers(request, [
		{ name: 'Ada Lovelace', attributes: { [role]: 'Steward' } },
		{ name: 'Grace Hopper', attributes: { [role]: 'Member' } }
	]);
	const steward = answerId(role, 'Steward');

	await openMapping(page, `?group=${role}&f=${role}:${steward}`);
	await page.getByTestId('views-trigger').click();
	await page.getByTestId('view-name').fill('Stewards by role');
	await page.getByTestId('view-save-as').click();
	await expect(views(page).getByTestId('view-row')).toHaveCount(1);

	const reply = await request.get('/api/views');
	const [stored] = (
		(await reply.json()) as {
			views: { snapshot: { mapping: Record<string, unknown> } & Record<string, unknown> }[];
		}
	).views;
	expect(JSON.stringify(stored.snapshot)).toContain(steward);
	// Person state has no place in a view: only the question's own parts are stored.
	expect(Object.keys(stored.snapshot).sort()).toEqual(['kind', 'mapping', 'version']);
	expect(Object.keys(stored.snapshot.mapping).sort()).toEqual([
		'detail',
		'grouping',
		'highlight',
		'layout',
		'population',
		'visibility'
	]);

	await openMapping(page);
	await expect(page).not.toHaveURL(/group=/);
	await page.getByTestId('views-trigger').click();
	await views(page).getByRole('button', { name: 'Open Stewards by role' }).click();
	await expect(page).toHaveURL(new RegExp(`group=${role}`));
	await expect(page).toHaveURL(new RegExp(`f=${role}`));
});
