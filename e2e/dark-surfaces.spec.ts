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

	const readSurfaces = () =>
		page.evaluate(() => {
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

	// Every surface carries `transition: all`, so a colour read in the frame after the
	// theme flips can still be the light one. Wait for the ladder to settle first.
	await expect
		.poll(async () => (await readSurfaces()).page, { message: 'page ground settles' })
		.toEqual([14, 15, 16, 255]);
	await expect
		.poll(async () => (await readSurfaces()).panel, { message: 'panel settles' })
		.toEqual([28, 29, 31, 255]);
	await expect
		.poll(async () => (await readSurfaces()).inset, { message: 'inset field settles' })
		.toEqual([20, 21, 23, 255]);
	const surfaces = await readSurfaces();

	expect(surfaces.page, 'page ground').toEqual([14, 15, 16, 255]);
	expect(surfaces.panel, 'panel').toEqual([28, 29, 31, 255]);
	expect(surfaces.inset, 'inset field').toEqual([20, 21, 23, 255]);
	// The rail is the panel tone through 80% glass, and the canvas rounds a
	// translucent fill by a channel. Compare it to the panel it mirrors with one
	// step of slack; the opaque surfaces above stay exact.
	const railTone = surfaces.rail.slice(0, 3);
	const panelTone = surfaces.panel.slice(0, 3);
	expect(
		railTone.every((channel, index) => Math.abs(channel - panelTone[index]) <= 1),
		`navigation rail tone ${railTone.join(',')} matches panel ${panelTone.join(',')} within 1`
	).toBe(true);
	expect(surfaces.rail[3], 'rail is solid or 80% glass').toBeGreaterThanOrEqual(204);
	expect(surfaces.elevatedShadow, 'elevated surface highlight').toContain('inset');
	expect(surfaces.elevatedShadow).toMatch(/rgba\(255, 255, 255, 0\.055\)/);
});
