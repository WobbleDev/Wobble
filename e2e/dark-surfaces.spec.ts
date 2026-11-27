import { appReady } from './page-ready.ts';
import { expect, test } from './fixtures.ts';

/**
 * Issue #267: the Dark Mode open surface ladder. This is a regular-suite test —
 * it needs the real backend and seeds nothing, so the Settings pad renders from
 * the empty Worksite. The `ui` suite cannot answer a new title: it has no
 * recording for one.
 */
test('Dark Mode paints the tonal ladder and the top-edge highlight', async ({ page }) => {
	// Pin the system appearance and motion; forced colors and increased contrast
	// would replace the palette this test reads. Reduced transparency is not a
	// Playwright option, so the rail fill accepts either its solid fallback or
	// the 80% glass over the page — both resolve to the same #1c1d1f tone.
	await page.emulateMedia({
		colorScheme: 'dark',
		reducedMotion: 'reduce',
		forcedColors: 'none',
		contrast: 'no-preference'
	});
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/settings');
	await appReady(page);
	await expect(page.locator('html')).toHaveClass(/\bdark\b/);

	const surfaces = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 1;
		const context = canvas.getContext('2d', { willReadFrequently: true })!;
		const resolve = (selector: string) => {
			const element = document.querySelector(selector);
			if (!element) throw new Error(`no ${selector}`);
			const css = getComputedStyle(element).backgroundColor;
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = css;
			context.fillRect(0, 0, 1, 1);
			return [...context.getImageData(0, 0, 1, 1).data];
		};
		return {
			page: resolve('body'),
			panel: resolve('[data-well]'),
			inset: resolve('[data-well] [data-selectable]'),
			rail: resolve("[data-slot='sidebar-inner']"),
			elevatedShadow: getComputedStyle(document.querySelector('[data-well]')!).boxShadow
		};
	});

	expect(surfaces.page, 'page ground').toEqual([14, 15, 16, 255]);
	expect(surfaces.panel, 'panel').toEqual([28, 29, 31, 255]);
	expect(surfaces.inset, 'inset field').toEqual([20, 21, 23, 255]);
	expect(surfaces.rail.slice(0, 3), 'navigation rail tone').toEqual([28, 29, 31]);
	expect(surfaces.rail[3], 'rail is solid or 80% glass').toBeGreaterThanOrEqual(204);
	expect(surfaces.elevatedShadow, 'elevated surface highlight').toContain('inset');
	expect(surfaces.elevatedShadow).toMatch(/rgba\(255, 255, 255, 0\.055\)/);
});
