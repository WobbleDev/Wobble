import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';

test(
	'Cmd/Ctrl+1/2/3 switch views and Cmd/Ctrl+F focuses the page search',
	{ tag: '@smoke' },
	async ({ page }) => {
		await page.goto('/overview');
		await appReady(page);

		await page.keyboard.press('ControlOrMeta+2');
		await expect(page).toHaveURL('/workers');
		await page.keyboard.press('ControlOrMeta+f');
		await expect(page.getByLabel('Search Name')).toBeFocused();

		// Shortcuts stand down while a field has focus.
		await page.keyboard.press('ControlOrMeta+3');
		await expect(page).toHaveURL('/workers');
		await page.getByLabel('Search Name').blur();
		await page.keyboard.press('ControlOrMeta+3');
		await expect(page).toHaveURL('/mapping');
		await page.keyboard.press('ControlOrMeta+f');
		await expect(page.getByLabel('Find a worker')).toBeFocused();

		await page.getByLabel('Find a worker').blur();
		await page.keyboard.press('ControlOrMeta+1');
		await expect(page).toHaveURL('/overview');
	}
);
