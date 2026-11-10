import { expect, test } from './fixtures.ts';
import {
	recordMark,
	seedRelationshipHub,
	startResponsivenessProbe,
	stopResponsivenessProbe
} from './mapping-responsiveness.ts';

test.setTimeout(90_000);

test('navigation rail to Mapping stays responsive with 50 related Workers', async ({
	page,
	request
}) => {
	await seedRelationshipHub(request);
	await page.goto('/overview');
	const mappingTab = page.getByRole('link', { name: 'Mapping', exact: true });
	await expect(mappingTab).toBeVisible();
	await startResponsivenessProbe(page);

	let probe: Awaited<ReturnType<typeof stopResponsivenessProbe>> | undefined;
	try {
		await recordMark(page, 'before rail click');
		await mappingTab.click();
		await recordMark(page, 'rail click completed');
		await expect(page).toHaveURL(/\/mapping$/);
		await recordMark(page, 'mapping URL settled');
		await expect(page.getByTestId('relationship-map-layer')).toBeAttached({ timeout: 30_000 });
		await recordMark(page, 'canvas layer attached');

		const search = page.getByRole('searchbox', { name: 'Find a worker' });
		await expect(search).toBeVisible({ timeout: 30_000 });
		await recordMark(page, 'search visible');
		await search.fill('Map Worker 50');
		await expect(page.getByTestId('relationship-map-canvas').getByRole('status')).toContainText(
			'1 match',
			{ timeout: 10_000 }
		);
		await recordMark(page, 'search result available');
	} finally {
		probe = await stopResponsivenessProbe(page);
		console.log(
			`Mapping interaction measurement: ${JSON.stringify({
				elapsedMs: Math.round(probe.elapsedMs),
				maxGapMs: Math.round(probe.maxGapMs),
				maxGapAtMs: Math.round(probe.maxGapAtMs),
				longTasks: probe.longTasks.map(({ startTime, duration }) => ({
					startMs: Math.round(startTime - probe!.startedAt),
					durationMs: Math.round(duration)
				})),
				marks: probe.marks.map(({ name, elapsedMs }) => ({
					name,
					elapsedMs: Math.round(elapsedMs)
				})),
				ticks: probe.ticks
			})}`
		);
	}

	if (!probe) throw new Error('Mapping responsiveness probe produced no result');
	expect(probe.maxGapMs, 'browser event loop stall while opening Mapping').toBeLessThan(1_000);
	expect(probe.elapsedMs, 'time from rail click through successful search').toBeLessThan(3_000);
});
