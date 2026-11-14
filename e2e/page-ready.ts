import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';

/**
 * The app has mounted: the start-up screen (src/app.html) has faded out and been
 * removed, and the page's main landmark is showing. Wait for a specific element
 * the test reads next when it needs data; this only says the shell is up, so a
 * status or landmark query does not catch the splash on its way out.
 */
export async function appReady(page: Page): Promise<void> {
	// Local asset reads can exceed the default five-second assertion deadline.
	// Keep startup bounded while allowing those reads and the splash fade to finish.
	await expect(page.locator('#splash')).toHaveCount(0, { timeout: 15_000 });
	await expect(page.locator('main')).toBeVisible();
}

/**
 * Opens Configuration and waits for the Abbreviation suggestion it asks for once its draft has
 * settled (a 250 ms debounce). Without the wait the call happens only when the test outlives
 * it, so a recording sometimes has no answer for it and replay sometimes asks for one.
 */
export async function gotoConfiguration(page: Page): Promise<void> {
	const suggested = page.waitForResponse('**/api/configuration/abbreviations');
	await page.goto('/configuration');
	await appReady(page);
	await suggested;
}
