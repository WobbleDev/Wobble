import { expect, test } from './fixtures.ts';

test('opens Overview at the application root', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/overview$/);
});
