import type { Page } from '@playwright/test';
import { appReady } from './page-ready.ts';
import { waitForMapReady } from './map.ts';

/**
 * Opening a page the browser suite tests. Each helper sets the viewport that page is
 * designed for and waits for the app shell, so a spec states where it goes rather than
 * repeating navigation order.
 */

export async function openConfiguration(page: Page): Promise<void> {
	await page.goto('/configuration');
	await appReady(page);
}

export async function openWorkers(page: Page, path = '/workers'): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(path);
	await appReady(page);
}

export async function openOverview(page: Page, path = '/overview'): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 1080 });
	await page.goto(path);
	await appReady(page);
}

export async function openMapping(page: Page, query = ''): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/mapping${query}`);
	await waitForMapReady(page);
}
