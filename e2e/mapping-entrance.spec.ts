import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';
import { openWorkersTable } from './workers-table-page.ts';
import { waitForMapReady } from './map.ts';

/** Records, every frame, the canvas's opacity and where its first dot is drawn. */
async function watchCanvas(page: Page) {
	await page.evaluate(() => {
		const frames: { opacity: number; x: number; y: number }[] = [];
		(window as unknown as { __frames: typeof frames }).__frames = frames;
		const tick = () => {
			const chart = document.querySelector('[data-slot="chart"]');
			const dot = document.querySelector('[data-node-id] circle:not([data-focus-ring])');
			if (chart && dot) {
				const box = dot.getBoundingClientRect();
				frames.push({ opacity: Number(getComputedStyle(chart).opacity), x: box.x, y: box.y });
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
}

async function frames(page: Page) {
	return page.evaluate(
		() => (window as unknown as { __frames: { opacity: number; x: number; y: number }[] }).__frames
	);
}

test('the map fades in already in place and never slides after it appears', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request);
	await watchCanvas(page);
	await page.getByRole('link', { name: 'Mapping', exact: true }).first().click();
	await waitForMapReady(page);
	await page.waitForTimeout(300);

	const seen = (await frames(page)).filter((frame) => frame.opacity > 0.01);
	expect(seen.length).toBeGreaterThan(0);
	// From its first visible frame to the last, the first dot never moves.
	const xs = seen.map((frame) => frame.x);
	const ys = seen.map((frame) => frame.y);
	expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1);
	expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(1);
	// It comes up through partial opacity rather than cutting in.
	expect(seen[0]!.opacity).toBeLessThan(0.9);
	expect(seen.at(-1)!.opacity).toBe(1);
});

test('the map shows at once when motion is reduced', async ({ page, request }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await openWorkersTable(page, request);
	await watchCanvas(page);
	await page.getByRole('link', { name: 'Mapping', exact: true }).first().click();
	await waitForMapReady(page);

	const seen = (await frames(page)).filter((frame) => frame.opacity > 0.01);
	expect(seen.length).toBeGreaterThan(0);
	expect(seen[0]!.opacity).toBe(1);
});
