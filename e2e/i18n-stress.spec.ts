import { appReady } from './page-ready.ts';
import { expect, test } from './fixtures.ts';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';

/**
 * The development-only expanded pseudo-locale stress pass.
 *
 * Run with VITE_WOBBLE_PSEUDO_LOCALE=1 so the build applies en-XA; every message then
 * carries visible markers and extra padding. The test is skipped in ordinary builds so
 * the regular suite stays honest about which locale it is exercising.
 */
const stress = process.env.VITE_WOBBLE_PSEUDO_LOCALE === '1';

test.skip(!stress, 'run with VITE_WOBBLE_PSEUDO_LOCALE=1 to exercise the pseudo-locale');

const EXPANDED = /⟦/;

const documentOverflow = (page: import('@playwright/test').Page) =>
	page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('expanded messages stay readable at the viewport floor and larger text', async ({
	page,
	request
}) => {
	expect((await request.put('/api/attributes', { data: wireDefinitions([]) })).ok()).toBeTruthy();
	await createWorker(request, {
		name: 'إيليا Грейс العربية\u202eLTR',
		notes: [
			{
				id: 'stress-note',
				text: 'Nota con mezcla: العربية עברית and a long unbroken value ' + 'N'.repeat(400),
				timestamp: '2024-01-01T00:00:00.000Z'
			}
		]
	});

	await page.setViewportSize({ width: 1024, height: 640 });
	await page.goto('/workers');
	await appReady(page);

	const rail = page.getByRole('navigation', { name: EXPANDED });
	await expect(rail.getByRole('link', { name: EXPANDED }).first()).toBeVisible();
	await expect(page.getByRole('heading', { level: 1, name: EXPANDED })).toBeVisible();
	await expect(page.getByRole('button', { name: /New Worker/ })).toBeVisible();

	// A normal record with a mixed-direction name and Note.
	const row = page.getByRole('row', { name: /إيليا/ });
	await expect(row).toBeVisible();
	await row.getByRole('gridcell').nth(1).click();
	await expect(page.getByRole('complementary', { name: /Worker details:/ })).toBeVisible();
	await expect(page.getByText(/Nota con mezcla/)).toBeVisible();

	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);

	// The existing larger-text accommodation, on top of the expanded prose.
	await page.evaluate(() => {
		document.documentElement.dataset.textSize = '150';
	});
	await expect(page.getByRole('button', { name: /New Worker/ })).toBeVisible();
	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});
