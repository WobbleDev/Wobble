import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

test('the Languages column carries an assignment and filters the Workers table', async ({
	page,
	request
}) => {
	const created = await request.post('/api/languages', { data: { name: 'Spanish' } });
	expect(created.ok()).toBeTruthy();
	const { language }: { language: { id: string } } = await created.json();

	// A worker answers every configured Attribute, so clear the seeded vocabulary first.
	const cleared = await request.put('/api/attributes', { data: wireDefinitions([]) });
	expect(cleared.ok()).toBeTruthy();

	const worker = await request.post('/api/workers', {
		data: {
			name: 'Ada Lovelace',
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: wireWorkerAttributes({}),
			agitations: [],
			languages: [language.id],
			relationships: [],
			notes: []
		}
	});
	expect(worker.status()).toBe(201);

	await page.goto('/workers');
	await appReady(page);

	await expect(page.getByRole('columnheader', { name: 'Languages' })).toBeVisible();
	await expect(
		page.getByRole('row').filter({ hasText: 'Ada Lovelace' }).getByText('Spanish')
	).toBeVisible();

	await page.goto('/workers?f=languages:Spanish');
	await appReady(page);
	await expect(page.getByRole('row').filter({ hasText: 'Ada Lovelace' })).toBeVisible();

	await page.goto('/workers?f=languages:Polish');
	await appReady(page);
	await expect(page.getByText('No workers match Languages.')).toBeVisible();
});
