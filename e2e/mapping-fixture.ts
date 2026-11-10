import type { Page } from '@playwright/test';

/** Replays saved appearance reads without writing installation-wide settings. */
export async function replayMappingSettings(page: Page, read: () => unknown): Promise<void> {
	await page.route('**/api/settings', (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ json: { settings: read() } })
			: route.fallback()
	);
}
