import captured from './fixtures/mapping-subgrouping-small-canvas.json' with { type: 'json' };
import type { Page } from '@playwright/test';
import { appReady } from './page-ready.ts';
import { populateWorksite, ringWorksite } from './mapping-composition-worksite.ts';
import { settled, waitForMapInteraction, waitForMapReady } from './map.ts';
import { clippedNames, readNames } from './mapping-name-framing.ts';
import { clippedContent, expect, scrollableOverflow, test } from './fixtures.ts';
import {
	densityCases,
	gridReport,
	workersMinFloorRem,
	workersNameRem,
	seedManyCategories,
	seedWorkers,
	seedWideWorkers,
	wideWorkersMinFloorRem,
	wideWorkerName,
	widthOf
} from './workers-table-grid.ts';

// Both tests write the shared density setting to the same database, so they
// must not run against it in parallel.
test.describe.configure({ mode: 'serial' });
test.use({ splash: 'hold' });

const sizes = [
	{ width: 1024, height: 640 },
	{ width: 1280, height: 800 },
	{ width: 1920, height: 1080 }
] as const;

const densities = [
	{ name: 'Compact', value: 'compact', rootFont: '15px' },
	{ name: 'Comfortable', value: 'comfortable', rootFont: '17px' }
] as const;

// Standard density is covered by the regular no-scroll spec; this suite
// covers the two settings that rescale the rem base.
for (const density of densities) {
	test(`the no-scroll guarantee holds in ${density.name} density`, async ({ page, request }) => {
		// Overview plus both Mapping schemes over three viewports no longer fit
		// the default budget once the dashboard renders: allow a full minute.
		test.setTimeout(60_000);
		const saved = await request.put('/api/settings', { data: { density: density.value } });
		expect(saved.ok()).toBeTruthy();

		// The 40 Category values double as the Mapping dataset; a second
		// attribute seed would replace this one wholesale.
		await seedManyCategories(request);

		for (const size of sizes) {
			await page.setViewportSize(size);
			await page.goto('/overview');
			await appReady(page);
			await expect(page.locator('html')).toHaveCSS('font-size', density.rootFont);
			await expect(page.getByRole('region', { name: 'Overall support' })).toBeVisible();
			await expect(page.getByRole('region', { name: 'Agitations' })).toBeVisible();
			await expect(page.getByRole('region', { name: /^By / })).toBeVisible();
			expect(await scrollableOverflow(page)).toBe(0);
			expect(await clippedContent(page)).toEqual([]);

			// The paged By reading must hold a complete visible row and keep a
			// stable height as the viewport changes. Off-page rows are inert.
			if (size.width === 1024 || size.width === 1280) {
				const region = page.locator('[data-breakdown-rows]');
				const firstRow = region.locator('[data-group-row]:not([inert])').first();
				const regionHeight = await region.evaluate((el) => el.clientHeight);
				const rowHeight = await firstRow.evaluate((el) =>
					el instanceof HTMLElement ? el.offsetHeight : 0
				);
				expect(
					regionHeight,
					'page holds a whole reading row in ' + density.name + ' at ' + size.width + 'px'
				).toBeGreaterThanOrEqual(rowHeight);

				const samples: number[] = [];
				for (let sample = 0; sample < 5; sample += 1) {
					samples.push(await region.evaluate((el) => el.clientHeight));
					// Deliberate: sample over time to prove the height holds still.
					if (sample < 4) await page.waitForTimeout(200);
				}
				expect(
					new Set(samples).size,
					'reading page height is stable in ' + density.name + ' at ' + size.width + 'px'
				).toBe(1);
			}

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme });
				await page.goto('/mapping');
				await appReady(page);
				await expect(page.getByTestId('relationship-map-surface')).toHaveAttribute(
					'data-map-settled',
					'true'
				);
				expect(await scrollableOverflow(page)).toBe(0);
				expect(await clippedContent(page)).toEqual([]);
				const reading = await readNames(page);
				expect(reading.names.length, `${density.name} ${colorScheme} names`).toBeGreaterThan(0);
				expect(clippedNames(reading), `${density.name} ${colorScheme} names`).toEqual([]);
			}
		}
	});
}

// The Workers table's own layout at each density. It lives here rather than in the
// regular suite because density is an installation-wide setting and this suite
// is the one that owns writing it: a second writer running beside the regular
// specs moves the root font under whatever they are measuring.
test('the Workers table keeps its allocation, its row floor and its header type in every density', async ({
	page,
	request
}) => {
	await seedWorkers(request);

	const typography = (locator: ReturnType<typeof page.getByRole>) =>
		locator.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				family: style.fontFamily,
				size: style.fontSize,
				weight: style.fontWeight,
				transform: style.textTransform,
				spacing: style.letterSpacing
			};
		});

	for (const density of densityCases) {
		const saved = await request.put('/api/settings', { data: { density: density.value } });
		expect(saved.ok(), await saved.text()).toBeTruthy();

		for (const width of [1024, 1280, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto('/workers');
			await appReady(page);
			await expect(page.locator('html')).toHaveCSS('font-size', density.rootFont);

			const report = await gridReport(page);
			expect(await clippedContent(page), `hidden content in ${density.name} at ${width}px`).toEqual(
				[]
			);

			// Whether the grid scrolls sideways depends on the 20rem record rail beside it; what must hold is that only the scrollport scrolls, never the document.
			expect(report.documentOverflowX, `document scroll in ${density.name} at ${width}px`).toBe(
				false
			);
			expect(
				report.tableScrollWidth,
				`column floor in ${density.name} at ${width}px`
			).toBeGreaterThanOrEqual(workersMinFloorRem() * report.rootFont - 1);

			// A row is never shorter than its density's one-line metric. Above it a
			// value has wrapped rather than been cut — the approved policy, which
			// replaced the older promise that every seeded row stayed on one line.
			expect(
				Math.min(...report.rowHeights),
				`row floor in ${density.name} at ${width}px`
			).toBeGreaterThanOrEqual(density.line);
			// Name is pinned to its longest name (--workers-table-name-w), at every width and density here.
			expect(widthOf(report, 'Name'), `Name holds in ${density.name} at ${width}px`).toBe(
				workersNameRem() * report.rootFont
			);

			// A sortable header and a fixed one stay the same type at this density.
			const sortable = await typography(
				page.getByRole('columnheader', { name: 'Name' }).getByRole('button')
			);
			const fixed = await typography(page.getByRole('columnheader', { name: 'Assessment' }));
			expect(sortable, `header type in ${density.name} at ${width}px`).toEqual(fixed);
		}
	}

	// Hand the installation-wide setting back for the rest of the suite.
	const restored = await request.put('/api/settings', { data: { density: 'standard' } });
	expect(restored.ok(), await restored.text()).toBeTruthy();
});

// The same scroll floor under a twelve-Attribute Workers table (wideWorkersMinFloorRem in workers-table-grid.ts). It outgrows every frame here, so the scrollport always scrolls sideways and the document never does.
test('the wide floor holds per density with a twelve-attribute Workers table', async ({
	page,
	request
}) => {
	await seedWideWorkers(request);
	await page.goto('/workers');
	await appReady(page);
	// The wide fixture repeats first and last names, so the row is named by its
	// whole unique Name cell rather than by a two-word prefix.
	await expect(
		page.getByRole('row').filter({
			has: page.getByRole('gridcell', {
				name: `Name for ${wideWorkerName(0)}: ${wideWorkerName(0)}`,
				exact: true
			})
		})
	).toBeVisible();

	for (const density of densityCases) {
		const saved = await request.put('/api/settings', { data: { density: density.value } });
		expect(saved.ok(), await saved.text()).toBeTruthy();

		for (const width of [1024, 1280, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto('/workers');
			await appReady(page);
			await expect(page.locator('html')).toHaveCSS('font-size', density.rootFont);

			const report = await gridReport(page);
			expect(
				report.tableScrollWidth,
				`wide floor in ${density.name} at ${width}px`
			).toBeGreaterThanOrEqual(wideWorkersMinFloorRem() * report.rootFont - 1);
			expect(report.overflowX, `sideways scroll in ${density.name} at ${width}px`).toBe(true);
			expect(report.documentOverflowX, `document scroll in ${density.name} at ${width}px`).toBe(
				false
			);
		}
	}

	// Hand the installation-wide setting back for the rest of the suite.
	const restored = await request.put('/api/settings', { data: { density: 'standard' } });
	expect(restored.ok(), await restored.text()).toBeTruthy();
});

type Edges = { count: number; left: number; top: number; right: number; bottom: number } | null;

/** How far each kind of drawing extends past the map surface, in screen pixels. */
async function overflow(page: Page) {
	return page.evaluate(() => {
		const s = document
			.querySelector('[data-testid="relationship-map-surface"]')!
			.getBoundingClientRect();
		const past = (selector: string, keep: (element: Element) => boolean = () => true): Edges => {
			const boxes = [...document.querySelectorAll(selector)]
				.filter(keep)
				.map((element) => element.getBoundingClientRect())
				.filter((box) => box.width || box.height);
			if (!boxes.length) return null;
			return {
				count: boxes.length,
				left: Math.max(0, s.left - Math.min(...boxes.map((b) => b.left))),
				top: Math.max(0, s.top - Math.min(...boxes.map((b) => b.top))),
				right: Math.max(0, Math.max(...boxes.map((b) => b.right)) - s.right),
				bottom: Math.max(0, Math.max(...boxes.map((b) => b.bottom)) - s.bottom)
			};
		};
		return {
			regions: past('[data-group-hull] path, [data-sub-hull] path'),
			headings: past('[data-region-label]'),
			dots: past(
				'[data-node-id] circle',
				(c) => c.getAttribute('fill') !== 'transparent' && !c.hasAttribute('data-focus-ring')
			)
		};
	});
}

function expectInside(reading: Awaited<ReturnType<typeof overflow>>, tag: string) {
	for (const [kind, edges] of Object.entries(reading)) {
		expect.soft(edges, `${tag} ${kind} drawn`).not.toBeNull();
		if (!edges) continue;
		for (const side of ['left', 'top', 'right', 'bottom'] as const)
			expect.soft(edges[side], `${tag} ${kind} past the surface ${side}`).toBeLessThanOrEqual(1);
	}
}

// Replayed from a captured dataset so the arrangement is fixed; the density is the global
// setting, written like the tests above and restored after each case.
for (const density of densityCases) {
	test(`Mapping Sub-grouping fits a 1024x640 canvas whole at ${density.name} density, and Reset returns to that frame`, async ({
		page,
		request
	}) => {
		const { dataset, urls } = captured;
		await page.route('**/api/dataset', (route) =>
			route.fulfill({
				json: { ...dataset, settings: { ...dataset.settings, density: density.value } }
			})
		);
		// The first paint of a returning organizer already has the saved density (the app
		// caches it, src/app.html), so the map is measured once at its final root size.
		await page.addInitScript((value) => {
			localStorage.setItem('wobble.appearance', JSON.stringify({ density: value }));
		}, density.value);
		await page.setViewportSize({ width: 1024, height: 640 });
		await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
		try {
			const saved = await request.put('/api/settings', { data: { density: density.value } });
			expect(saved.ok(), await saved.text()).toBeTruthy();
			await page.goto(urls['Sub-grouping']);
			await waitForMapInteraction(page);
			await page.evaluate(() => document.fonts.ready.then(() => undefined));
			await expect(page.getByTestId('relationship-map-surface')).toHaveAttribute(
				'data-map-settled',
				'true'
			);
			await expect(page.locator('html')).toHaveCSS('font-size', density.rootFont);

			const initial = await settled(() => readNames(page));
			const tag = `${density.name} initial`;
			expect(initial.names.length, `${tag} names`).toBeGreaterThan(0);
			expect(clippedNames(initial), `${tag} names clipped`).toEqual([]);
			expectInside(await overflow(page), tag);

			await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
			await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
			const reset = await settled(() => readNames(page));
			expect(Math.abs(reset.scale / initial.scale - 1), `${density.name} reset scale`).toBeLessThan(
				0.005
			);
			expect(clippedNames(reset), `${density.name} reset names clipped`).toEqual([]);
			expectInside(await overflow(page), `${density.name} reset`);
		} finally {
			const restored = await request.put('/api/settings', { data: { density: 'standard' } });
			expect(restored.ok(), await restored.text()).toBeTruthy();
		}
	});
}

// The first layout is captured once, so a fresh load (no cached appearance) must capture it
// at the saved density, and the floating keys must keep their size at every zoom: every
// resting name must stand clear of the keys as they are drawn.
for (const density of densityCases) {
	test(`Mapping keeps resting names clear of a fixed dot-size key on a fresh load at ${density.name} density`, async ({
		page,
		request
	}) => {
		test.setTimeout(300_000);
		const populated = await populateWorksite(request, ringWorksite());
		const group = populated.attributeIds.get('Department');
		const sub = populated.attributeIds.get('Role');
		const urls = {
			Free: '/mapping',
			Grouped: `/mapping?group=${group}`,
			'Sub-grouping': `/mapping?group=${group}&sub=${sub}`
		};
		await page.addInitScript(() => localStorage.removeItem('wobble.appearance'));
		await page.setViewportSize({ width: 1024, height: 640 });
		await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
		const surface = page.getByTestId('relationship-map-surface');
		const dotKey = page.getByTestId('mapping-dot-key');
		try {
			const saved = await request.put('/api/settings', { data: { density: density.value } });
			expect(saved.ok(), await saved.text()).toBeTruthy();
			for (const [reading, url] of Object.entries(urls)) {
				for (let load = 0; load < 3; load += 1) {
					await page.goto(url);
					await waitForMapReady(page);
					await page.evaluate(() => document.fonts.ready.then(() => undefined));
					await expect(surface).toHaveAttribute('data-map-settled', 'true');
					await expect(page.locator('html')).toHaveCSS('font-size', density.rootFont);
					const tag = `${reading} ${density.value} load ${load}`;
					const size = await surface.evaluate(
						(element) => `${element.clientWidth}x${element.clientHeight}`
					);
					expect(await surface.getAttribute('data-layout-canvas'), `${tag} layout canvas`).toBe(
						size
					);
					const initial = await settled(() => readNames(page));
					expect(initial.names.length, `${tag} names`).toBeGreaterThan(0);
					expect(
						clippedNames(initial),
						`${tag} initial ${JSON.stringify({ chrome: initial.chrome, usable: initial.usable, layoutCanvas: initial.layoutCanvas, names: initial.names.filter((n) => clippedNames({ ...initial, names: [n] }).length) })}`
					).toEqual([]);
					const keyAtRest = (await dotKey.boundingBox())!;
					await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
					await settled(() => readNames(page));
					const keyZoomed = (await dotKey.boundingBox())!;
					for (const side of ['x', 'y', 'width', 'height'] as const)
						expect(
							Math.abs(keyZoomed[side] - keyAtRest[side]),
							`${tag} dot-size key ${side} ${JSON.stringify({ keyAtRest, keyZoomed })}`
						).toBeLessThanOrEqual(1);
					await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
					const reset = await settled(() => readNames(page));
					expect(
						clippedNames(reset),
						`${tag} reset ${JSON.stringify({ chrome: reset.chrome, usable: reset.usable })}`
					).toEqual([]);
				}
			}
		} finally {
			const restored = await request.put('/api/settings', { data: { density: 'standard' } });
			expect(restored.ok(), await restored.text()).toBeTruthy();
		}
	});
}
