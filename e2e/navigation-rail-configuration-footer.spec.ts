import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';

/** The switcher's border must paint the strong control rule, resolved to a real colour. */
async function switcherBorderColour(page: Page) {
	return page.getByRole('button', { name: /^Active Worksite:/ }).evaluate((switcher) => {
		// The button transitions `all`, so a theme flip would otherwise be read mid-flight.
		const transition = switcher.style.transition;
		switcher.style.transition = 'none';
		const root = getComputedStyle(document.documentElement);
		const probe = document.createElement('span');
		probe.style.color = root.getPropertyValue('--rule-strong').trim();
		document.body.append(probe);
		const ruleStrong = getComputedStyle(probe).color;
		probe.remove();
		const border = getComputedStyle(switcher).borderTopColor;
		switcher.style.transition = transition;
		return { border, ruleStrong };
	});
}

test('Configuration stays in the navigation rail footer on desktop and mobile', async ({
	page
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/overview');
	await appReady(page);

	// The Worksite selector inherits the outline variant's --rule-strong (>= 3:1 in both
	// themes) rather than the rail's faint hairline.
	await page.evaluate(() => document.documentElement.classList.remove('dark'));
	const lightBorder = await switcherBorderColour(page);
	expect(lightBorder.border).toBe(lightBorder.ruleStrong);
	await page.evaluate(() => document.documentElement.classList.add('dark'));
	const darkBorder = await switcherBorderColour(page);
	expect(darkBorder.border).toBe(darkBorder.ruleStrong);
	await page.evaluate(() => document.documentElement.classList.remove('dark'));

	const railFooter = page
		.locator('footer')
		.filter({ has: page.getByRole('link', { name: 'Configuration', exact: true }) });
	const groups = railFooter.locator('[data-slot="sidebar-group"]');
	const configurationLink = railFooter.getByRole('link', { name: 'Configuration', exact: true });
	const settingsLink = railFooter.getByRole('link', { name: 'Settings', exact: true });

	await expect(page.getByText('Views', { exact: true })).toBeVisible();
	await expect(groups).toHaveCount(2);
	await expect(groups.nth(0).locator('[data-slot="sidebar-group-label"]')).toHaveText('Worksite');
	await expect(groups.nth(1).locator('[data-slot="sidebar-group-label"]')).toHaveText(
		'This computer'
	);
	await expect(configurationLink).toHaveAttribute('href', '/configuration');
	await expect(configurationLink).toBeVisible();
	await expect(settingsLink).toHaveAttribute('href', '/settings');
	await expect(settingsLink).toBeVisible();

	// The footer groups align with Views rather than nesting a second padding box.
	const mappingBox = await page
		.getByRole('navigation', { name: 'Worksite' })
		.getByRole('link', { name: 'Mapping', exact: true })
		.boundingBox();
	const configurationBox = await configurationLink.boundingBox();
	const settingsBox = await settingsLink.boundingBox();
	const ruleBox = await railFooter.locator('[data-slot="separator"]').boundingBox();
	if (!mappingBox || !configurationBox || !settingsBox || !ruleBox) {
		throw new Error('Navigation rail elements are not visible');
	}
	expect({ x: configurationBox.x, width: configurationBox.width }).toEqual({
		x: mappingBox.x,
		width: mappingBox.width
	});
	expect({ x: settingsBox.x, width: settingsBox.width }).toEqual({
		x: mappingBox.x,
		width: mappingBox.width
	});
	// The footer paints its rule inside its own padding, so it is inset like the links.
	expect({ x: ruleBox.x, width: ruleBox.width }).toEqual({
		x: mappingBox.x,
		width: mappingBox.width
	});

	const footerBounds = await railFooter.boundingBox();
	const viewport = page.viewportSize();
	if (!footerBounds || !viewport) throw new Error('Configuration footer is not visible');
	// The rail card is inset 0.875rem (14px) from every window edge, so its footer
	// sits that far above the viewport bottom rather than flush with it.
	expect(footerBounds.y + footerBounds.height).toBeGreaterThanOrEqual(viewport.height - 16);
	// The footer keeps its own bottom padding below the last link.
	expect(footerBounds.y + footerBounds.height - (settingsBox.y + settingsBox.height)).toBeCloseTo(
		8
	);

	// The Configuration page asks for Abbreviation suggestions as it opens. Waiting for that
	// call makes it happen, and be recorded, in every run rather than only when the page
	// outlives the test.
	const suggested = page.waitForResponse('**/api/configuration/abbreviations');
	await configurationLink.click();
	await expect(page).toHaveURL('/configuration');
	await suggested;

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/overview');
	await appReady(page);
	await page.keyboard.press('Control+b');

	const mobileFooter = page
		.locator('footer')
		.filter({ has: page.getByRole('link', { name: 'Configuration', exact: true }) });
	const mobileGroups = mobileFooter.locator('[data-slot="sidebar-group"]');
	const mobileConfigurationLink = mobileFooter.getByRole('link', {
		name: 'Configuration',
		exact: true
	});
	await expect(mobileGroups).toHaveCount(2);
	await expect(mobileGroups.nth(0).locator('[data-slot="sidebar-group-label"]')).toHaveText(
		'Worksite'
	);
	await expect(mobileGroups.nth(1).locator('[data-slot="sidebar-group-label"]')).toHaveText(
		'This computer'
	);
	await expect(
		mobileGroups.nth(1).getByRole('link', { name: 'Settings', exact: true })
	).toBeVisible();
	await expect(mobileConfigurationLink).toBeVisible();
	const suggestedOnMobile = page.waitForResponse('**/api/configuration/abbreviations');
	await mobileConfigurationLink.click();
	await expect(page).toHaveURL('/configuration');
	await suggestedOnMobile;
});
