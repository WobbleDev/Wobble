import { type APIRequestContext, type Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { settled, waitForMapInteraction } from './map.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

// Touch capability is present before layout; toggling it mid-gesture changes input metrics.
test.use({ reducedMotion: 'reduce', hasTouch: true });

/** Three Workers, one of them related to the other two, and one Category. */
async function seedMappedWorkers(request: APIRequestContext) {
	const deptId = crypto.randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: ['Front of House'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const ids: string[] = [];
	for (const name of ['Ada', 'Grace', 'Lin']) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({ [deptId]: 'Front of House' }),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
		ids.push((await created.json()).worker.id);
	}

	const related = await request.put(`/api/workers/${ids[0]}`, {
		data: {
			name: 'Ada',
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: wireWorkerAttributes({ [deptId]: 'Front of House' }),
			agitations: [],
			languages: [],
			relationships: [ids[1], ids[2]],
			notes: []
		}
	});
	expect(related.ok()).toBeTruthy();
}

/** The layer's `translate(x y) scale(z)`, as the pan/zoom surface writes it. */
async function readLayerTransform(page: Page) {
	const transform = await page.getByTestId('relationship-map-layer').getAttribute('transform');
	const match = transform?.match(/translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)/);
	expect(match, `unexpected layer transform: ${transform}`).not.toBeNull();

	return { x: Number(match![1]), y: Number(match![2]), zoom: Number(match![3]) };
}

/**
 * Drags with a synthesized finger.
 *
 * `touch-action: none` and the 3px capture threshold mean a touch pan is entirely
 * the component's own gesture handling, and `lostpointercapture` bubbles — so a
 * regression there is invisible to a mouse drag and to any layout assertion.
 */
async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });

	const steps = 6;
	await cdp.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x: from.x, y: from.y }]
	});
	for (let step = 1; step <= steps; step++) {
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [
				{
					x: from.x + ((to.x - from.x) * step) / steps,
					y: from.y + ((to.y - from.y) * step) / steps
				}
			]
		});
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await cdp.detach();
}

/**
 * Taps with a synthesized finger: down and up, no move in between. Any
 * `touchMove` — even at the same point — can read as a drag and cost the tap its
 * synthesized click, which is not what a finger on a node does.
 */
async function touchTap(page: Page, at: { x: number; y: number }) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	await cdp.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x: at.x, y: at.y }]
	});
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await cdp.detach();
}

test('a touch drag pans the relationship map the full distance', async ({ page, request }) => {
	await seedMappedWorkers(request);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/mapping');
	await waitForMapInteraction(page);

	const canvas = page.getByTestId('relationship-map-canvas');
	await expect(page.getByTestId('relationship-map-layer')).toBeVisible();
	const bounds = await canvas.boundingBox();
	expect(bounds).not.toBeNull();

	const before = await settled(() => readLayerTransform(page));
	const from = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
	await touchDrag(page, from, { x: from.x + 100, y: from.y + 60 });
	const after = await settled(() => readLayerTransform(page));

	// A drag that stops after the first step lands around (10, 6): the whole
	// gesture has to count, not just the step that took capture.
	expect(after.x - before.x).toBeGreaterThan(90);
	expect(after.y - before.y).toBeGreaterThan(50);
	expect(after.zoom).toBe(before.zoom);
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('a touch tap still selects the Worker under the finger @flaky', async ({ page, request }) => {
	await seedMappedWorkers(request);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/mapping');
	await waitForMapInteraction(page);

	const node = page.getByRole('button', { name: /^Ada, / });
	await expect(node).toBeVisible();
	const box = await node.boundingBox();
	expect(box).not.toBeNull();
	// The SVG must be sized to the drawable surface, not the wrapper containing
	// the mobile toolbars. A visible node can otherwise be under the legend.
	const application = page.getByRole('application', { name: /Relationship map/ });
	const surfaceBox = await application.boundingBox();
	await page.evaluate(() => {
		const surface = document.querySelector<HTMLElement>('[role="application"]');
		if (!surface) throw new Error('relationship map surface is missing');
		surface.addEventListener(
			'pointerup',
			() => {
				const transform = document
					.querySelector('[data-testid="relationship-map-layer"]')
					?.getAttribute('transform');
				const match = transform?.match(/translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)/);
				document.documentElement.dataset.touchPointerUp = JSON.stringify({
					camera: match
						? { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) }
						: null,
					panning: surface.classList.contains('cursor-grabbing')
				});
			},
			{ capture: true, once: true }
		);
	});

	expect(surfaceBox).not.toBeNull();
	expect(box!.y + box!.height / 2).toBeGreaterThanOrEqual(surfaceBox!.y);
	expect(box!.y + box!.height / 2).toBeLessThanOrEqual(surfaceBox!.y + surfaceBox!.height);
	const layerBeforeTap = await readLayerTransform(page);
	await touchTap(page, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
	await expect
		.poll(() => page.locator('html').getAttribute('data-touch-pointer-up'))
		.not.toBeNull();
	const pointerUp = JSON.parse((await page.locator('html').getAttribute('data-touch-pointer-up'))!);
	await page
		.locator('html')
		.evaluate((element) => element.removeAttribute('data-touch-pointer-up'));
	// Read before the synthetic click opens the in-flow dossier and refits the camera.
	expect(pointerUp.camera).not.toBeNull();
	expect(pointerUp.camera).toEqual(layerBeforeTap);
	expect(pointerUp.panning).toBe(false);

	await expect(node).toHaveAttribute('aria-pressed', 'true');
	await expect(page).not.toHaveURL(/sel=/);
	// A finger has no hover, so the tap is the only way to reach the node's card:
	// Assessment, relationship count and Attribute values all live in it.
	const card = page.locator('.lc-tooltip-container');
	await expect(card).toBeVisible();
	await expect(card).toContainText('Ada');
	await expect(card).toContainText('Assessment');
	await expect(card).toContainText('Relationships');
});
