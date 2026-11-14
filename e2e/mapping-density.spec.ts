import { replayMappingSettings } from './mapping-fixture.ts';
import { expect, test } from './fixtures.ts';
import { settled, waitForMapInteraction, waitForSceneReady } from './map.ts';
import { clippedNames, readNames } from './mapping-name-framing.ts';
import { densityCases } from './workers-table-grid.ts';
import captured from './fixtures/mapping-density-clipping.json' with { type: 'json' };

// Exact original dataset: 3 densities × 3 viewports × 2 schemes, one test each, so a slow
// runner spends its time per case instead of against one budget for all eighteen map loads.
// Replay settings too: no writes to the application's shared appearance settings.
const sizes = [
	{ width: 1600, height: 1000 },
	{ width: 1000, height: 1400 },
	{ width: 1024, height: 640 }
];

for (const appearance of densityCases) {
	for (const size of sizes) {
		for (const colorScheme of ['light', 'dark'] as const) {
			const tag = `${appearance.value} ${size.width}x${size.height} ${colorScheme}`;
			test(`captured Sub-grouping names fit at ${tag}`, async ({ page }) => {
				// Two map loads (open, then Reset zoom); the macOS runner needs more than the default.
				test.setTimeout(30_000);
				const settings = () => ({ ...captured.dataset.settings, density: appearance.value });
				await replayMappingSettings(page, settings);
				await page.route('**/api/dataset', (route) =>
					route.fulfill({ json: { ...captured.dataset, settings: settings() } })
				);
				await page.setViewportSize(size);
				await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
				await page.goto(captured.url);
				await waitForMapInteraction(page);
				await waitForSceneReady(page);
				await expect(page.locator('html')).toHaveCSS('font-size', appearance.rootFont);
				// Names are measured text: read them only once the document's fonts are
				// ready, as the Mapping composition specs do, so a fallback font's
				// wider boxes never read as clipped.
				await page.evaluate(() => document.fonts.ready.then(() => undefined));
				const initial = await settled(() => readNames(page));
				expect(initial.names.length, tag).toBeGreaterThan(0);
				expect(clippedNames(initial), tag + ' initial').toEqual([]);
				await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
				await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
				await waitForSceneReady(page);
				await page.evaluate(() => document.fonts.ready.then(() => undefined));
				const reset = await settled(() => readNames(page));
				expect(clippedNames(reset), tag + ' reset').toEqual([]);
				expect(reset.names.map((n) => n.id).sort()).toEqual(initial.names.map((n) => n.id).sort());
			});
		}
	}
}
