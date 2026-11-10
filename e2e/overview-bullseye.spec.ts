import type { APIRequestContext, Page } from '@playwright/test';
import { appReady } from './page-ready.ts';
import { clippedContent, expect, scrollableOverflow, test } from './fixtures.ts';
import { nextFrames } from './frames.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

/**
 * The Assessment bullseye as the reader drives it: a real pointer that drags the
 * ground, a wheel over a point in it, and whatever is under the pointer at the
 * end. The chart is moved one for one, so a drag is both how a Worker is brought
 * into view and how the bound is probed.
 */

const WORKERS: [string, string][] = [
	['Ari', 'Leader'],
	...Array.from(
		{ length: 10 },
		(_unused, index) => [`Activist ${index}`, 'Activist'] as [string, string]
	),
	...Array.from(
		{ length: 16 },
		(_unused, index) => [`Supporter ${index}`, 'Supporter'] as [string, string]
	),
	...Array.from(
		{ length: 12 },
		(_unused, index) => [`Disengaged ${index}`, 'Disengaged'] as [string, string]
	),
	// A count divisible by four puts one dot on each of the four extremes of the
	// Hostile track, which is where reachability fails first.
	...Array.from(
		{ length: 8 },
		(_unused, index) => [`Hostile ${index}`, 'Hostile'] as [string, string]
	),
	...Array.from(
		{ length: 3 },
		(_unused, index) => [`Unassessed ${index}`, 'Unassessed'] as [string, string]
	)
];

function workerPayload(name: string, assessment: string, relationships: string[] = []) {
	return {
		name,
		email: '',
		phone: '',
		assessment,
		attributes: wireWorkerAttributes({}),
		agitations: [],
		languages: [],
		relationships,
		notes: []
	};
}

/** A dense Workers table of fifty: every standing, and enough of them to fill the rings. */
async function seedWorkers(request: APIRequestContext) {
	// A new worksite ships with default attributes, and every configured one must be
	// present on a worker. The chart reads no Category, so clear them.
	const cleared = await request.put('/api/attributes', { data: wireDefinitions([]) });
	expect(cleared.ok()).toBeTruthy();

	const leader = await request.post('/api/workers', { data: workerPayload('Ari', 'Leader') });
	expect(leader.status(), await leader.text()).toBe(201);
	const leaderId = (await leader.json()).worker.id as string;

	for (const [name, assessment] of WORKERS) {
		if (name === 'Ari') continue;
		const created = await request.post('/api/workers', {
			data: workerPayload(name, assessment, [leaderId])
		});
		expect(created.status(), await created.text()).toBe(201);
	}
}

const layer = (page: Page) => page.locator('[data-bullseye-layer]');
const callout = (page: Page) => page.locator('[data-bullseye-callout]');

/** Worker ids are UUIDs, so they need no escaping in an attribute selector. */
const dot = (page: Page, id: string) => page.locator(`circle[data-worker-id="${id}"]`);

const dotIds = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('circle[data-worker-id]')].map(
			(dot) => dot.getAttribute('data-worker-id') as string
		)
	);

async function layerWidth(page: Page) {
	return (await layer(page).boundingBox())!.width;
}

test('leaves the chart alone when the wheel is over an open dialog', async ({ page, request }) => {
	await seedWorkers(request);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/overview?setup=1');
	await appReady(page);

	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	const before = await layerWidth(page);

	const box = (await dialog.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await wheelDelivered(page, () => page.mouse.wheel(0, -600));

	expect(await layerWidth(page)).toBeCloseTo(before, 0);
});

async function expectFittedCardsContained(page: Page) {
	const layout = await page.evaluate(() => {
		const chart = document.querySelector('.no-scroll-chart')!.getBoundingClientRect();
		return [...document.querySelectorAll('[data-dashboard] > section')].map((card) => {
			const box = card.getBoundingClientRect();
			const content = document.createRange();
			content.selectNodeContents(card);
			const text = content.getBoundingClientRect();
			return {
				height: box.height,
				contained: text.top >= box.top && text.bottom <= box.bottom,
				beforeChart: box.bottom <= chart.top + 1
			};
		});
	});
	for (const card of layout) {
		expect(card.height).toBeGreaterThan(64);
		expect(card.contained, 'card content remains inside its panel').toBe(true);
		expect(card.beforeChart, 'fitted chart follows the dashboard without overlap').toBe(true);
	}
}

test('falls back to the fitted chart when motion is reduced', async ({ page, request }) => {
	await seedWorkers(request);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/overview');
	await expect(page.locator('[data-bullseye-base]')).toBeVisible();
	await expect(page.locator('[data-bullseye-base-surface]')).toHaveCount(1);

	await page.emulateMedia({ reducedMotion: 'reduce' });

	for (const size of [
		{ width: 1280, height: 900 },
		{ width: 1024, height: 640 }
	]) {
		await page.setViewportSize(size);
		await page.goto('/overview');
		await appReady(page);

		// Nothing is clipped, so nothing has to be dragged to: every dot is in the page.
		await expect(page.locator('[data-bullseye-base]')).toHaveCount(0);
		await expect(page.locator('[data-bullseye-base-surface]')).toHaveCount(0);
		await expect(page.locator('.no-scroll-chart')).toHaveCount(1);

		const outside = await page.evaluate(
			() =>
				[...document.querySelectorAll('circle[data-worker-id]')]
					.map((dot) => dot.getBoundingClientRect())
					.filter(
						(box) => box.x < 0 || box.y < 0 || box.right > innerWidth || box.bottom > innerHeight
					).length
		);
		expect(outside, `${size.width}x${size.height}`).toBe(0);

		// The fitted chart still holds the no-scroll promise at the floor.
		expect(await scrollableOverflow(page)).toBe(0);
		expect(await clippedContent(page)).toEqual([]);
		await expectFittedCardsContained(page);
		await page.screenshot({
			path: test.info().outputPath(`fitted-${size.width}x${size.height}.png`)
		});
	}

	await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test.describe('a coarse pointer', () => {
	test.use({ hasTouch: true });

	test('draws the fitted chart in the page, not the dragged ground', async ({ page, request }) => {
		await seedWorkers(request);

		for (const size of [
			{ width: 1280, height: 900 },
			{ width: 1024, height: 640 }
		]) {
			await page.setViewportSize(size);
			await page.goto('/overview');
			await appReady(page);

			await expect(page.locator('[data-bullseye-base]')).toHaveCount(0);
			await expect(page.locator('.no-scroll-chart')).toHaveCount(1);
			expect(await scrollableOverflow(page)).toBe(0);
			expect(await clippedContent(page)).toEqual([]);
			await expectFittedCardsContained(page);
			await page.screenshot({
				path: test.info().outputPath(`fitted-${size.width}x${size.height}.png`)
			});
		}
	});

	test('taps the nearest mark, sized for a finger', async ({ page, request }) => {
		// One Worker keeps the nearest-mark answer unambiguous: every other mark
		// would only repeat the same Worker.
		const cleared = await request.put('/api/attributes', { data: wireDefinitions([]) });
		expect(cleared.ok()).toBeTruthy();
		const created = await request.post('/api/workers', {
			data: workerPayload('Ari', 'Leader')
		});
		expect(created.status(), await created.text()).toBe(201);

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/overview');
		await appReady(page);

		const cell = page.locator('.no-scroll-chart');
		await cell.scrollIntoViewIfNeeded();
		const chart = chartBox(page);
		const frame = (await chart.boundingBox())!;
		const mark = page.locator('circle[data-worker-id]').first();
		const box = (await mark.boundingBox())!;
		const cx = box.x + box.width / 2;
		const cy = box.y + box.height / 2;
		const dx = cx - (frame.x + frame.width / 2);
		const dy = cy - (frame.y + frame.height / 2);
		const length = Math.hypot(dx, dy) || 1;

		// ~12 screen pixels from the centre of a mark only a few pixels wide: this
		// is a finger tap beside the painted circle, answered by the nearest mark.
		await page.touchscreen.tap(cx + (dx / length) * 12, cy + (dy / length) * 12);
		await expect(callout(page)).toHaveCount(1);
		const name = ((await mark.getAttribute('aria-label')) ?? '').split(' — ')[0];
		await expect(callout(page)).toContainText(name);
		await expect(mark).toHaveAttribute('aria-pressed', 'true');
	});
});

/** The fitted chart's own box, which the wheel is measured against. */
function chartBox(page: Page) {
	return page.getByRole('group', { name: /Organizing Committee's reach/ });
}

/**
 * Runs a wheel action and resolves once the wheel has reached the page and two frames
 * have painted after it, so a zoom the wheel causes has landed before the chart is read.
 * A wheel that never reaches the page fails the wait instead of passing a no-op check.
 */
async function wheelDelivered(page: Page, act: () => Promise<void>): Promise<void> {
	await page.evaluate(() => {
		(window as unknown as { wheelLanded: Promise<void> }).wheelLanded = new Promise<void>(
			(resolve) => {
				window.addEventListener(
					'wheel',
					() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					{ once: true, capture: true, passive: true }
				);
			}
		);
	});
	await act();
	await page.evaluate(() => (window as unknown as { wheelLanded: Promise<void> }).wheelLanded);
}

/** Turn the wheel over a point inside the fitted chart's cell. */
async function wheelOverChart(page: Page, deltaY: number) {
	const box = (await page.locator('.no-scroll-chart').boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + Math.min(40, box.height / 2));
	await page.mouse.wheel(0, deltaY);
}

test('the fitted chart re-fits after crossing the viewport floor at zoom one', async ({
	page,
	request
}) => {
	await seedWorkers(request);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const mobile = { width: 390, height: 780 };
	const floor = { width: 1024, height: 640 };
	for (const [from, to] of [
		[mobile, floor],
		[floor, mobile]
	]) {
		await page.setViewportSize(from);
		await page.goto('/overview');
		await appReady(page);
		await page.evaluate(() => document.fonts.ready.then(() => undefined));
		await nextFrames(page);
		await expect(chartBox(page)).toHaveAccessibleDescription(/Scale: 1×/);

		await page.setViewportSize(to);
		await nextFrames(page, 3);
		const resized = (await chartBox(page).boundingBox())!;

		await page.reload();
		await appReady(page);
		await nextFrames(page);
		const fresh = (await chartBox(page).boundingBox())!;
		await test.info().attach(`resize-${from.width}-${to.width}.json`, {
			body: JSON.stringify({ from, to, resized, fresh }),
			contentType: 'application/json'
		});
		expect.soft(resized.width, 'resize agrees with a fresh fit').toBeCloseTo(fresh.width, 0);
		expect.soft(resized.height, 'resize agrees with a fresh fit').toBeCloseTo(fresh.height, 0);
	}
});

test('scales the fitted chart with the wheel, and forgets the scale on the next visit', async ({
	page,
	request
}) => {
	await seedWorkers(request);
	// Reduced motion draws the fitted chart at a no-scroll viewport, so the wheel
	// has to answer there while the surface itself may not scroll.
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/overview');
	await appReady(page);

	await expect(page.locator('[data-bullseye-base]')).toHaveCount(0);
	await expect(page.locator('.no-scroll-chart')).toHaveCount(1);
	const chart = chartBox(page);
	const base = (await chart.boundingBox())!.width;

	await wheelOverChart(page, -600);
	await expect.poll(async () => (await chart.boundingBox())!.width).toBeGreaterThan(base + 10);

	// The scale belongs to the visit: arriving again draws the chart as it was.
	await page.goto('/workers');
	await page.goto('/overview');
	await appReady(page);
	await expect.poll(async () => (await chart.boundingBox())!.width).toBeCloseTo(base, 0);

	await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('leaves the wheel to the page below the no-scroll floor', async ({ page, request }) => {
	await seedWorkers(request);
	// 900px wide is below the 1024×640 no-scroll floor: the surface scrolls again,
	// so the wheel belongs to the page and the chart must not claim it there.
	await page.setViewportSize({ width: 900, height: 900 });
	await page.goto('/overview');
	await appReady(page);

	await expect(page.locator('[data-bullseye-base]')).toHaveCount(0);
	await expect(page.locator('.no-scroll-chart')).toHaveCount(1);
	const chart = chartBox(page);
	await page.locator('.no-scroll-chart').scrollIntoViewIfNeeded();
	const base = (await chart.boundingBox())!.width;

	await wheelDelivered(page, () => wheelOverChart(page, -600));
	expect((await chart.boundingBox())!.width).toBeCloseTo(base, 0);
});

test('scales the fitted chart under reduced motion without clipping or scrolling', async ({
	page,
	request
}) => {
	await seedWorkers(request);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/overview');
	await appReady(page);

	// No ground is drawn under reduced motion, so the chart is fitted in the page.
	await expect(page.locator('[data-bullseye-base]')).toHaveCount(0);
	await expect(page.locator('.no-scroll-chart')).toHaveCount(1);
	const chart = chartBox(page);
	const base = (await chart.boundingBox())!.width;

	await wheelOverChart(page, 600);
	await expect.poll(async () => (await chart.boundingBox())!.width).toBeLessThan(base - 10);

	// Shrinking is the one direction with room here, and it must stay a fitted
	// chart: nothing clipped, nothing to scroll.
	expect(await scrollableOverflow(page)).toBe(0);
	expect(await clippedContent(page)).toEqual([]);

	await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('announces the keyboard scale in the chart description', async ({ page, request }) => {
	await seedWorkers(request);
	await page.setViewportSize({ width: 900, height: 900 });
	await page.goto('/overview');
	await appReady(page);

	await expect(page.locator('.no-scroll-chart')).toHaveCount(1);
	const chart = chartBox(page);
	const base = (await chart.boundingBox())!.width;

	const [id] = await dotIds(page);
	await dot(page, id).focus();
	await page.keyboard.press('Equal');

	await expect.poll(async () => (await chart.boundingBox())!.width).toBeGreaterThan(base + 10);
	// One Equal from the default puts the scale at 1.25×, so the text must carry it.
	await expect(chart).toHaveAccessibleDescription(/Scale: 1\.25×/);
	// The keyboard change is also announced through the chart's polite status.
	await expect(page.locator('[data-chart-status]')).toHaveText(/1\.25/);
});
