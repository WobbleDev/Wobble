import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';

test('Configuration stays in the navigation rail footer on desktop and mobile', async ({
	page
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/overview');
	await appReady(page);

	const configurationLink = page.getByRole('link', { name: 'Configuration', exact: true });
	await expect(page.getByText('Views', { exact: true })).toBeVisible();
	await expect(page.getByText('Worksite', { exact: true })).toHaveCount(0);
	await expect(configurationLink).toHaveAttribute('href', '/configuration');
	await expect(configurationLink).toBeVisible();

	const footerBounds = await page
		.locator('footer')
		.filter({ has: configurationLink })
		.boundingBox();
	const viewport = page.viewportSize();
	if (!footerBounds || !viewport) throw new Error('Configuration footer is not visible');
	// The rail card is inset 0.875rem (14px) from every window edge, so its footer
	// sits that far above the viewport bottom rather than flush with it.
	expect(footerBounds.y + footerBounds.height).toBeGreaterThanOrEqual(viewport.height - 16);

	// The Configuration page asks for Short form suggestions as it opens. Waiting for that
	// call makes it happen, and be recorded, in every run rather than only when the page
	// outlives the test.
	const suggested = page.waitForResponse('**/api/configuration/short-forms');
	await configurationLink.click();
	await expect(page).toHaveURL('/configuration');
	await suggested;

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/overview');
	await appReady(page);
	await page.keyboard.press('Control+b');

	const mobileConfigurationLink = page
		.locator('footer')
		.getByRole('link', { name: 'Configuration', exact: true });
	await expect(mobileConfigurationLink).toBeVisible();
	const suggestedOnMobile = page.waitForResponse('**/api/configuration/short-forms');
	await mobileConfigurationLink.click();
	await expect(page).toHaveURL('/configuration');
	await suggestedOnMobile;
});
