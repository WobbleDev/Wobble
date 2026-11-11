import { randomUUID } from 'node:crypto';
import { appReady } from './page-ready.ts';
import type { APIRequestContext, Page } from '@playwright/test';
import { clippedContent, expect, scrollableOverflow, test } from './fixtures.ts';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';
import { nextFrames } from './frames.ts';
import { settled } from './map.ts';
import {
	MIN_VISIBLE_SHARE,
	REST_SCALE
} from '../src/lib/features/overview/bullseye/pan-mappings.ts';

/**
 * The Overview's focus control (ticket 02): the edge tab slides the dashboard
 * aside and wakes the bullseye ground where it lies. Focused, the dashboard is
 * inert beneath the chart and the rail; at rest the ground is inert instead.
 * Gestures — drag, wheel, zoom keys, Reset — answer only while focused.
 */

type DashboardSeed = { deptId: string; roleId: string };

async function seedDashboard(request: APIRequestContext): Promise<DashboardSeed> {
	const deptId = randomUUID();
	const roleId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: deptId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House']
			},
			{ id: roleId, name: 'Role', kind: 'category', options: ['Cook', 'Server'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const pay = await request.post('/api/agitations', { data: { text: 'Pay' } });
	expect(pay.ok()).toBeTruthy();
	const payId = (await pay.json()).agitation.id as string;
	const hours = await request.post('/api/agitations', { data: { text: 'Hours' } });
	expect(hours.ok()).toBeTruthy();
	const hoursId = (await hours.json()).agitation.id as string;
	const snacks = await request.post('/api/agitations', { data: { text: 'Snacks' } });
	expect(snacks.ok()).toBeTruthy();
	const snacksId = (await snacks.json()).agitation.id as string;

	const crew: {
		name: string;
		assessment: string;
		dept: string;
		role: string;
		agitations: string[];
	}[] = [
		{
			name: 'Ana',
			assessment: 'Leader',
			dept: 'Front of House',
			role: 'Cook',
			agitations: [payId]
		},
		{
			name: 'Beto',
			assessment: 'Supporter',
			dept: 'Front of House',
			role: 'Cook',
			agitations: [payId, hoursId, snacksId]
		},
		{
			name: 'Carla',
			assessment: 'Activist',
			dept: 'Front of House',
			role: 'Server',
			agitations: [hoursId]
		},
		{
			name: 'Diego',
			assessment: 'Disengaged',
			dept: 'Back of House',
			role: 'Cook',
			agitations: []
		},
		{
			name: 'Elena',
			assessment: 'Hostile',
			dept: 'Back of House',
			role: 'Cook',
			agitations: [payId]
		},
		{
			name: 'Felipe',
			assessment: 'Supporter',
			dept: 'Back of House',
			role: 'Server',
			agitations: []
		},
		{
			name: 'Gloria',
			assessment: 'Unassessed',
			dept: 'Back of House',
			role: 'Server',
			agitations: []
		},
		{
			name: 'Hugo',
			assessment: 'Supporter',
			dept: 'Back of House',
			role: 'Server',
			agitations: [payId]
		}
	];
	for (const worker of crew) {
		await createWorker(request, {
			name: worker.name,
			assessment: worker.assessment,
			attributes: { [deptId]: worker.dept, [roleId]: worker.role },
			agitations: worker.agitations
		});
	}
	return { deptId, roleId };
}

const ground = (page: Page) => page.locator('[data-bullseye-base]');
const layer = (page: Page) => page.locator('[data-bullseye-layer]');
const dots = (page: Page) => page.locator('[data-bullseye-base] circle[data-worker-id]');
const dot = (page: Page, id: string) => page.locator('circle[data-worker-id="' + id + '"]');
const dashboard = (page: Page) => page.locator('[data-dashboard]');
const edge = (page: Page) => page.locator('[data-focus-edge]');
const resetZoom = (page: Page) => page.getByRole('button', { name: 'Reset zoom' });

async function dotIds(page: Page): Promise<string[]> {
	return dots(page).evaluateAll((elements) =>
		elements.map((el) => el.getAttribute('data-worker-id') as string)
	);
}

/** Bring the bullseye into focus and wait for the 650ms slide to land via page state. */
async function focusBullseye(page: Page) {
	await edge(page).click();
	await expect(edge(page)).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('[data-dashboard-root]')).toHaveAttribute('data-focused', 'true');
	await expect(dashboard(page)).toHaveCSS('opacity', '0.3');
}

/** The layer's screen width: zoom times rest size times the focus growth. */
async function layerWidth(page: Page) {
	return (await layer(page).boundingBox())!.width;
}

/** The pan the drag has written, read from the transform rather than from state. */
async function panOffset(page: Page) {
	return page.evaluate(() => {
		const layer = document.querySelector('[data-bullseye-layer]');
		const transform = layer instanceof HTMLElement ? layer.style.transform : '';
		const match = transform.match(/translate3d\((-?[\d.]+)px, (-?[\d.]+)px/);
		return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
	});
}

/** Drag the chart from one screen point to another, and let the frame land. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
	await nextFrames(page);
}

/**
 * A press that arms the drag: on the pan surface right of the slid strip, which
 * never moves, rather than the frame's middle, which the strip can cover.
 */
async function chartPoint(page: Page) {
	const frame = (await ground(page).boundingBox())!;
	const strip = await stripRight(page);
	return { x: frame.x + strip + 60, y: frame.y + frame.height / 2 };
}

/** The middle of the frame, which is always inside the chart region at these widths. */
async function frameCentre(page: Page) {
	const frame = (await ground(page).boundingBox())!;
	return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}
test('toggles the bullseye focus from the edge control, and Escape returns', async ({
	page,
	request,
	browserName
}) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	// At rest the tab reads Focus bullseye and the dashboard holds the frame.
	await expect(edge(page)).toHaveAttribute('aria-pressed', 'false');
	await expect(edge(page)).toHaveAccessibleName('Focus bullseye');
	await expect(page.locator('[data-dashboard-root]')).toHaveAttribute('data-focused', 'false');

	await edge(page).click();
	await expect(edge(page)).toHaveAttribute('aria-pressed', 'true');
	await expect(edge(page)).toHaveAccessibleName('Show dashboard');
	await expect(page.locator('[data-dashboard-root]')).toHaveAttribute('data-focused', 'true');
	await expect(dashboard(page)).toHaveCSS('opacity', '0.3');
	// Toggling keeps keyboard focus on the control itself. WebKit never focuses a button on a
	// mouse click (macOS convention), so there is no focus to keep after a click there.
	if (browserName !== 'webkit') await expect(edge(page)).toBeFocused();

	// Escape returns to the dashboard.
	await page.keyboard.press('Escape');
	await expect(edge(page)).toHaveAttribute('aria-pressed', 'false');
	await expect(edge(page)).toHaveAccessibleName('Focus bullseye');
	await expect(page.locator('[data-dashboard-root]')).toHaveAttribute('data-focused', 'false');
});

test('holds the dashboard inert while focused', async ({ page, request }) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);
	await focusBullseye(page);

	await expect(dashboard(page)).toHaveAttribute('inert', '');

	// A full tab cycle from the edge control never lands inside the dashboard:
	// its links and its Attribute select are unreachable while focused.
	await edge(page).focus();
	const landed: string[] = [];
	for (let press = 0; press < 30; press += 1) {
		await page.keyboard.press('Tab');
		landed.push(
			await page.evaluate(() => {
				const active = document.activeElement as Element | null;
				if (!active) return 'none';
				const where = active.closest('[data-dashboard]') ? 'dashboard:' : 'outside:';
				return where + (active.getAttribute('aria-label') || active.tagName);
			})
		);
	}
	expect(landed.filter((entry) => entry.startsWith('dashboard:'))).toEqual([]);

	// Let any glide a focused dot started land before clicking under it.
	await expect(dots(page).first()).toBeVisible();

	// A click over the dashboard reaches the bullseye instead: the dot under it selects.
	const ids = await dotIds(page);
	expect(ids.length).toBeGreaterThan(0);
	await settled(() =>
		dot(page, ids[0]).evaluate((element) => {
			const box = element.getBoundingClientRect();
			return { x: box.x, y: box.y, width: box.width, height: box.height };
		})
	);
	const centre = await dot(page, ids[0]).evaluate((element) => {
		const box = element.getBoundingClientRect();
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	});
	await page.mouse.click(centre.x, centre.y);
	await expect(page.locator('circle[data-worker-id][data-selected]')).toHaveAttribute(
		'data-worker-id',
		ids[0]
	);

	// The focused bullseye takes keyboard focus on its roving dot.
	await dot(page, ids[0]).focus();
	await expect(dot(page, ids[0])).toBeFocused();
});
test('moves the chart one for one with the pointer while focused', async ({ page, request }) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/overview');
	await appReady(page);
	await expect(ground(page)).toBeVisible();
	await focusBullseye(page);

	const before = (await layer(page).boundingBox())!;
	const from = await chartPoint(page);
	const delta = { x: 120, y: 70 };

	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + 20, from.y, { steps: 3 });
	// The surface says it is being moved while the drag is in flight.
	await expect(ground(page)).toHaveCSS('cursor', 'grabbing');
	await page.mouse.move(from.x + delta.x, from.y + delta.y, { steps: 6 });
	await page.mouse.up();
	await nextFrames(page);

	const after = await layer(page).boundingBox();
	expect(Math.abs(after!.x - before.x - delta.x)).toBeLessThanOrEqual(1);
	expect(Math.abs(after!.y - before.y - delta.y)).toBeLessThanOrEqual(1);
	await expect(ground(page)).toHaveCSS('cursor', 'grab');

	// A dot is as good a handle as the empty chart is.
	const ids = await dotIds(page);
	const handle = await dot(page, ids[0]).evaluate((element) => {
		const box = element.getBoundingClientRect();
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	});
	const held = (await layer(page).boundingBox())!;
	await drag(page, handle, { x: handle.x + 60, y: handle.y + 30 });

	const pulled = (await layer(page).boundingBox())!;
	expect(Math.abs(pulled!.x - held.x - 60)).toBeLessThanOrEqual(1);
	expect(Math.abs(pulled!.y - held.y - 30)).toBeLessThanOrEqual(1);
});

/**
 * Drag the chart hard in one direction, past whatever the bound allows. The
 * press stays on the pan surface and the travel stays inside the viewport.
 */
async function shove(page: Page, direction: -1 | 1) {
	const viewport = page.viewportSize() ?? { width: 1280, height: 900 };
	const from = await chartPoint(page);
	for (let step = 0; step < 6; step += 1) {
		const to = Math.max(8, Math.min(viewport.width - 8, from.x + direction * 350));
		await drag(page, from, { x: to, y: from.y });
	}
}

/** The slid dashboard's remaining strip and its right edge, in frame coordinates. */
async function stripRight(page: Page) {
	return page.evaluate(() => {
		const strip = document.querySelector('[data-dashboard]')!.getBoundingClientRect();
		const frame = document.querySelector('[data-bullseye-base]')!.getBoundingClientRect();
		return strip.right - frame.left;
	});
}

test('never lets the chart be dragged out of the chart region while focused', async ({
	page,
	request
}) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/overview');
	await appReady(page);
	await expect(ground(page)).toBeVisible();
	await focusBullseye(page);

	// The bound the drag is held inside: the travel model's own quarter-share of
	// the frame's width, past the strip's right edge on the left and inside the
	// frame on every other side.
	const boxes = async () => {
		const frame = (await ground(page).boundingBox())!;
		const chart = (await layer(page).boundingBox())!;
		return { frame, chart };
	};
	const visibleShare = async () => {
		const { frame } = await boxes();
		return MIN_VISIBLE_SHARE * REST_SCALE * frame.width;
	};

	await shove(page, -1);
	let { frame, chart } = await boxes();
	expect(chart.x + chart.width - frame.x).toBeGreaterThanOrEqual(
		(await stripRight(page)) + (await visibleShare()) - 1
	);

	await shove(page, 1);
	({ frame, chart } = await boxes());
	expect(chart.x - frame.x).toBeLessThanOrEqual(frame.width - (await visibleShare()) + 1);

	const up = await chartPoint(page);
	await drag(page, up, { x: up.x, y: up.y - 400 });
	await drag(page, up, { x: up.x, y: up.y - 400 });
	({ frame, chart } = await boxes());
	expect(chart.y + chart.height - frame.y).toBeGreaterThanOrEqual((await visibleShare()) - 1);

	await drag(page, up, { x: up.x, y: up.y + 400 });
	await drag(page, up, { x: up.x, y: up.y + 400 });
	await drag(page, up, { x: up.x, y: up.y + 400 });
	({ frame, chart } = await boxes());
	expect(chart.y - frame.y).toBeLessThanOrEqual(frame.height - (await visibleShare()) + 1);
});

const clampStep = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/** How far one drag may travel from the frame's middle and still end on screen. */
async function stepLimit(page: Page, target: { x: number; y: number }) {
	const viewport = page.viewportSize() ?? { width: 1280, height: 900 };
	const margin = 24;
	return {
		x: Math.max(0, Math.min(400, target.x - margin, viewport.width - margin - target.x)),
		y: Math.max(0, Math.min(400, target.y - margin, viewport.height - margin - target.y))
	};
}

/**
 * Bring a Worker's dot under the pointer. A dot already on screen is named where
 * it stands; one that is not is dragged towards the frame's middle first, because
 * a drag moves the chart one for one. The loop re-measures every pass.
 */
async function acquire(page: Page, id: string): Promise<boolean> {
	const target = await frameCentre(page);
	const press = await chartPoint(page);
	const limit = await stepLimit(page, target);
	const viewport = page.viewportSize() ?? { width: 1280, height: 900 };
	const margin = 4;

	for (let attempt = 0; attempt < 12; attempt += 1) {
		const centre = await dot(page, id).evaluate((element) => {
			const box = element.getBoundingClientRect();
			return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		});

		const onScreen =
			centre.x > margin &&
			centre.y > margin &&
			centre.x < viewport.width - margin &&
			centre.y < viewport.height - margin;
		if (onScreen) {
			await page.mouse.move(2, 2);
			await page.mouse.move(centre.x, centre.y);
			const under = await page.evaluate(
				([x, y]) =>
					document
						.elementFromPoint(x, y)
						?.closest('circle[data-worker-id]')
						?.getAttribute('data-worker-id') ?? null,
				[centre.x, centre.y]
			);
			if (under === id) return true;
		}

		const step = {
			x: clampStep(target.x - centre.x, limit.x),
			y: clampStep(target.y - centre.y, limit.y)
		};
		if (step.x === 0 && step.y === 0) return false;
		await drag(page, press, { x: press.x + step.x, y: press.y + step.y });
	}
	return false;
}

test('brings every dot on screen while focused', async ({ page, request }) => {
	test.setTimeout(300_000);
	await seedDashboard(request);

	for (const size of [
		{ width: 1024, height: 640 },
		{ width: 1280, height: 900 }
	]) {
		await page.setViewportSize(size);
		await page.goto('/overview');
		await appReady(page);
		await focusBullseye(page);

		const ids = await dotIds(page);
		expect(ids.length).toBeGreaterThan(0);

		const unreachable: string[] = [];
		for (const id of ids) {
			if (!(await acquire(page, id))) unreachable.push(id);
		}
		expect(unreachable, `${size.width}x${size.height}`).toEqual([]);
	}
});

test('zooms about the cursor within range while focused, and Reset returns to 1', async ({
	page,
	request
}) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/overview');
	await appReady(page);
	await focusBullseye(page);

	const ids = await dotIds(page);
	const at = await dot(page, ids[0]).evaluate((element) => {
		const box = element.getBoundingClientRect();
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	});
	const base = await layerWidth(page);

	// The wheel grows the chart about the point under the cursor.
	await page.mouse.move(at.x, at.y);
	await page.mouse.wheel(0, -300);
	await expect.poll(() => layerWidth(page)).toBeGreaterThan(base + 5);
	const grown = await layerWidth(page);
	expect(grown / base).toBeLessThan(2);

	// The dot that was under the cursor is still under it, however large it grew.
	const after = await dot(page, ids[0]).evaluate((element) => {
		const box = element.getBoundingClientRect();
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	});
	expect(Math.abs(after.x - at.x)).toBeLessThanOrEqual(2);
	expect(Math.abs(after.y - at.y)).toBeLessThanOrEqual(2);

	// The keyboard steps the same scale inside its range from a focused dot.
	await dot(page, ids[0]).focus();
	for (let press = 0; press < 10; press += 1) await page.keyboard.press('Equal');
	await expect.poll(() => layerWidth(page)).toBeLessThanOrEqual(base * 2 + 2);
	for (let press = 0; press < 20; press += 1) await page.keyboard.press('Minus');
	await expect.poll(() => layerWidth(page)).toBeGreaterThanOrEqual(base * 0.5 - 2);

	// Reset zoom is offered only while focused, and returns the chart to 1.
	await expect(resetZoom(page)).toBeVisible();
	await resetZoom(page).click();
	await expect.poll(() => layerWidth(page)).toBeCloseTo(base, 0);
});

test('leaves drag, wheel and Reset alone at rest', async ({ page, request }) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/overview');
	await appReady(page);

	const width = await layerWidth(page);
	const from = await frameCentre(page);
	await drag(page, from, { x: from.x + 200, y: from.y + 120 });
	expect(await layerWidth(page)).toBeCloseTo(width, 0);
	expect(await panOffset(page)).toEqual({ x: 0, y: 0 });

	await page.mouse.move(from.x, from.y);
	await page.mouse.wheel(0, -300);
	await expect.poll(() => layerWidth(page)).toBeCloseTo(width, 0);

	await expect(resetZoom(page)).toHaveCount(0);
});
test('hides the edge control below the floor and draws the fitted chart', async ({
	page,
	request
}) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 900, height: 600 });
	await page.goto('/overview');
	await appReady(page);

	await expect(edge(page)).toHaveCount(0);
	await expect(ground(page)).toHaveCount(0);
	await expect(page.locator('.no-scroll-chart')).toHaveCount(1);
	// The fitted chart keeps its own reset: the fallback is unchanged.
	await expect(resetZoom(page)).toBeVisible();
});

test('settles the focus change within one frame under reduced motion', async ({
	page,
	request
}) => {
	await seedDashboard(request);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	// Under reduced motion the ground never runs: no edge, fitted chart instead.
	await expect(edge(page)).toHaveCount(0);
	await expect(ground(page)).toHaveCount(0);

	// The dashboard's focus travel is instant: its transition collapses from 650ms
	// to about a millisecond (this Chromium serializes that duration as 1e-05s).
	const durations = await page.evaluate(
		() => getComputedStyle(document.querySelector('[data-dashboard]')!).transitionDuration
	);
	for (const duration of durations.split(',').map((entry) => entry.trim())) {
		expect(Number.parseFloat(duration)).toBeLessThan(0.01);
	}
});

test('never scrolls the focused page at the floor sizes', async ({ page, request }) => {
	await seedDashboard(request);
	for (const size of [
		{ width: 1024, height: 640 },
		{ width: 1440, height: 874 }
	]) {
		await page.setViewportSize(size);
		await page.goto('/overview');
		await appReady(page);
		await focusBullseye(page);

		expect(await scrollableOverflow(page)).toBe(0);
		expect(await clippedContent(page)).toEqual([]);
	}
});

test.describe('in Spanish', () => {
	test.use({ locale: 'es-MX' });

	test('names the edge control in Spanish', async ({ page, request }) => {
		await seedDashboard(request);
		await page.setViewportSize({ width: 1440, height: 874 });
		await page.goto('/overview');
		await appReady(page);

		await expect(edge(page)).toHaveAccessibleName('Enfocar la diana');
		await edge(page).click();
		await expect(edge(page)).toHaveAccessibleName('Mostrar el panel');
	});
});

test('matches the reference focused state at 1440x874', async ({ page, request }) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	// The dashboard slides left by its width less a 34rem strip, unresized.
	const rest = await page.evaluate(() => {
		const box = document.querySelector('[data-dashboard]')!.getBoundingClientRect();
		return { width: box.width, right: box.right };
	});
	await focusBullseye(page);
	const root = await page.evaluate(() =>
		Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
	);
	const slid = await page.evaluate(() => {
		const box = document.querySelector('[data-dashboard]')!.getBoundingClientRect();
		return { width: box.width, right: box.right };
	});
	expect(slid.width).toBeCloseTo(rest.width, 0);
	expect(rest.right - slid.right).toBeCloseTo(rest.width - 34 * root, 4);
	expect(slid.right).toBeGreaterThan(0);

	// The chart grows 1.12x about its bottom-right corner: the origin computes to
	// the layer's own far corner in pixels, and the drawing renders 1.12x it.
	const scale = await page.evaluate(() => {
		const origin = getComputedStyle(document.querySelector('.focus-scale')!)
			.transformOrigin.split(' ')
			.map((entry) => Number.parseFloat(entry));
		const layer = document.querySelector('[data-bullseye-layer]')!.getBoundingClientRect();
		const art = document.querySelector('.focus-scale')!.getBoundingClientRect();
		return { origin, layer: layer.width, art: art.width };
	});
	expect(scale.origin[0]).toBeCloseTo(scale.layer, 0);
	expect(scale.origin[1]).toBeCloseTo(scale.layer, 0);
	expect(scale.art / scale.layer).toBeCloseTo(1.12, 2);

	// The edge tab rides the right edge, above both layers.
	const tab = (await edge(page).boundingBox())!;
	expect(tab.width).toBeCloseTo(24, 1);
	expect(tab.height).toBeCloseTo(80, 1);

	await page.screenshot({ path: 'test-results/overview-focus-1440x874.png' });
});

test('leaves the bullseye inert at rest', async ({ page, request }) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	await expect(ground(page)).toHaveAttribute('inert', '');
	await expect(ground(page)).toHaveAttribute('aria-hidden', 'true');

	// A dot cannot take focus while the ground is inert.
	const ids = await dotIds(page);
	const focusable = await dot(page, ids[0]).evaluate((element) => {
		(element as SVGCircleElement).focus();
		return document.activeElement === element;
	});
	expect(focusable).toBe(false);
});
