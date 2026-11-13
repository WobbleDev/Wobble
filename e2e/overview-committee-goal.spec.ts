import { appReady } from './page-ready.ts';
import { expect, test } from './fixtures.ts';

test('sets the committee coverage goal in Configuration and persists it', async ({
	page,
	request
}) => {
	await page.goto('/configuration');
	await appReady(page);

	const input = page.getByLabel('Workers per Leader');
	await expect(input).toHaveValue('5');

	await input.fill('0');
	await expect(page.getByRole('alert')).toContainText('Enter a whole number from 1 to 100.');
	await expect(page.getByRole('button', { name: 'Save all' })).toBeDisabled();

	await input.fill('3');
	await page.getByRole('button', { name: 'Save all' }).click();

	await expect
		.poll(async () => {
			const response = await request.get('/api/worksite');
			return (await response.json()).worksite.committeeGoal;
		})
		.toBe(3);

	await page.reload();
	await appReady(page);
	await expect(page.getByLabel('Workers per Leader')).toHaveValue('3');
});
