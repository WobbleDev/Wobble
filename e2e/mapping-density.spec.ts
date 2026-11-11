import { replayMappingSettings } from './mapping-fixture.ts';
import { expect, test } from './fixtures.ts';
import { settled, waitForMapInteraction, waitForSceneReady } from './map.ts';
import { clippedNames, readNames } from './mapping-name-framing.ts';
import { densityCases } from './workers-table-grid.ts';
import captured from './fixtures/mapping-density-clipping.json' with { type: 'json' };

// Exact original dataset and 3 densities × 3 viewports × 2 schemes in the original order.
// Replay settings too: no writes to the application's shared appearance settings.
test('captured Sub-grouping names fit through the original density and viewport sequence', async ({
	page
}) => {
	// Eighteen map loads over three densities; the macOS runner needs more than a minute.
	test.setTimeout(120_000);
	let density = 'standard';
	const settings = () => ({ ...captured.dataset.settings, density });
	await replayMappingSettings(page, settings);
	await page.route('**/api/dataset', (route) =>
		route.fulfill({ json: { ...captured.dataset, settings: settings() } })
	);
	for (const appearance of densityCases) {
		density = appearance.value;
		for (const size of [
			{ width: 1600, height: 1000 },
			{ width: 1000, height: 1400 },
			{ width: 1024, height: 640 }
		]) {
			for (const colorScheme of ['light', 'dark'] as const) {
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
				const tag = `${density} ${size.width}x${size.height} ${colorScheme}`;
				expect(initial.names.length, tag).toBeGreaterThan(0);
				expect(clippedNames(initial), tag + ' initial').toEqual([]);
				await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
				await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
				await waitForSceneReady(page);
				await page.evaluate(() => document.fonts.ready.then(() => undefined));
				const reset = await settled(() => readNames(page));
				expect(clippedNames(reset), tag + ' reset').toEqual([]);
				expect(reset.names.map((n) => n.id).sort()).toEqual(initial.names.map((n) => n.id).sort());
			}
		}
	}
});
