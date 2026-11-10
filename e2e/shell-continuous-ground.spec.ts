import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';

test('the main content region paints nothing, so the wash reads continuously past the rail', async ({
	page
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/overview');
	await appReady(page);

	const background = await page
		.locator('#main-content')
		.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(background).toBe('rgba(0, 0, 0, 0)');
});

test('the shell behaves like a native app: no elastic overscroll, chrome text is not selectable', async ({
	page
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/overview');
	await appReady(page);

	const styles = await page.evaluate(() => ({
		overscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
		userSelect: getComputedStyle(document.body).userSelect
	}));
	expect(styles).toEqual({ overscroll: 'none', userSelect: 'none' });
});
