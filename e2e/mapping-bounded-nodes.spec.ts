import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { waitForMapReady } from './map.ts';
import { selectOnMap } from './person.ts';
import { answerId, wireDefinitions } from './answer-wire.ts';
import { workerUpdateFrom } from './api.ts';
import { mapPanStep, mapShiftPanStep } from '../src/lib/features/mapping/map-keyboard.ts';

/**
 * Ticket 10 — the bounded map: a 499-relationship hub draws at the capped 10
 * user units instead of sizing the canvas around itself, while its exact count
 * stays in its accessible name and dossier. The canvas surface answers real
 * keyboard events, and mobile widths reserve toolbar space instead of floating
 * controls over the small drawing area.
 */
test.use({ reducedMotion: 'reduce' });

/** A hub with `total - 1` recorded Relationships, built in three calls. */
async function seedHub(request: APIRequestContext, total = 500) {
	const names = Array.from({ length: total }, (_, index) => `Map Worker ${index + 1}`);
	const created = await request.post('/api/workers', { data: names.map((name) => ({ name })) });
	expect(created.ok(), await created.text()).toBeTruthy();

	type DatasetWorker = {
		id: string;
		name: string;
		email: string;
		phone: string;
		assessment: string;
		attributes: Record<string, unknown>;
		agitations: string[];
		languages: string[];
		relationships: string[];
		notes: unknown[];
	};
	const dataset = (await (await request.get('/api/dataset')).json()) as {
		workers: DatasetWorker[];
	};
	const hub = dataset.workers.find((worker) => worker.name === 'Map Worker 1');
	if (!hub) throw new Error('the hub worker is missing from the dataset');
	const spokeIds = dataset.workers
		.filter((worker) => worker.id !== hub.id)
		.map((worker) => worker.id);
	expect(spokeIds).toHaveLength(total - 1);

	const related = await request.put(`/api/workers/${hub.id}`, {
		data: { ...workerUpdateFrom(hub), relationships: spokeIds }
	});
	expect(related.ok(), await related.text()).toBeTruthy();
}

async function openMap(page: Page) {
	await page.goto('/mapping');
	// A 500-Worker hub takes several seconds to arrange on first load, which the
	// network used to hide; the map says when it is done.
	await waitForMapReady(page, 20_000);
	await expect(page.getByTestId('relationship-map-layer')).toBeAttached();
}

const layerTransform = async (page: Page) => {
	const raw = await page.getByTestId('relationship-map-layer').getAttribute('transform');
	const parsed = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(raw ?? '');
	expect(parsed, `layer transform reads: ${raw}`).not.toBeNull();
	if (!parsed) throw new Error(`unreadable layer transform: ${raw}`);
	return { x: Number(parsed[1]), y: Number(parsed[2]), scale: Number(parsed[3]) };
};

/** Selects the hub even where hundreds of spokes cover its dot. */
async function selectHub(page: Page) {
	const hub = page.getByRole('button', { name: /Map Worker 1.*499 relationships/ });
	await expect(hub).toBeAttached();
	await hub.click();
	await expect(page.getByRole('heading', { name: 'Map Worker 1' })).toBeVisible();
}

/** Opens a worker record through the same click handler as its layered hit target. */
async function clickWorker(page: Page, name: RegExp) {
	const worker = page.getByRole('button', { name });
	await expect(worker).toBeAttached();
	await worker.click();
}

test('a 499-relationship hub draws capped with its exact count kept', async ({ page, request }) => {
	await seedHub(request);
	await openMap(page);
	// The hub's own name, spelled out: `Map Worker 1` prefixes 10, 100 and the rest.
	await expect(
		page.getByRole('button', { name: /Map Worker 1, .* 499 relationships/ })
	).toBeAttached();

	// Every node dot — focus rings excluded — fits the 4..24 bound, and exactly
	// one dot (the hub) draws at the 24 cap.
	const radii = await page
		.getByTestId('relationship-map-layer')
		.locator('circle:not(.fill-none):not([data-hit-for])')
		.evaluateAll((circles) => circles.map((circle) => Number(circle.getAttribute('r'))));
	expect(radii.length).toBe(500);
	expect(Math.max(...radii)).toBe(24);
	expect(radii.filter((radius) => radius === 24)).toHaveLength(1);

	// The cap reports nothing exact, so exactness lives in the name and dossier.
	await expect(
		page.getByRole('button', { name: /Map Worker 1.*499 relationships/ })
	).toBeAttached();
	await expect(page.getByLabel(/Dot size shows Relationships/)).toBeVisible();
	await selectHub(page);
	await expect(page.getByText('499 relationships').first()).toBeVisible();
});

test('arrow keys pan, plus and minus zoom, Escape clears, typing is unaffected', async ({
	page,
	request
}) => {
	await seedHub(request);
	await openMap(page);

	const surface = page.getByRole('application', { name: /Relationship map/ });
	// Focused rather than clicked: a press on the canvas belongs to the pan
	// gesture, which takes the pointer and leaves focus alone. Tab is how a
	// keyboard reader arrives here, and `focus()` is that same arrival.
	await surface.focus();
	const before = await layerTransform(page);

	// Polled, not read once: the transform follows the key through the app's own
	// reactive pass, so a single read can outrun it under load. The step itself
	// is still asserted exactly.
	const step = async (key: string, measure: () => Promise<number>, expected: number) => {
		await page.keyboard.press(key);
		await expect.poll(measure, { message: `${key} step` }).toBeCloseTo(expected, 3);
	};

	await step('ArrowRight', async () => (await layerTransform(page)).x - before.x, mapPanStep);
	const panned = await layerTransform(page);
	expect(panned.scale).toBe(before.scale);

	await step(
		'Shift+ArrowDown',
		async () => (await layerTransform(page)).y - panned.y,
		mapShiftPanStep
	);
	const shifted = await layerTransform(page);

	// Zoom factor 1.3 has no exported constant (see notes.md Questions); kept hardcoded.
	await step('+', async () => (await layerTransform(page)).scale / shifted.scale, 1.3);
	const zoomed = await layerTransform(page);

	await step('-', async () => (await layerTransform(page)).scale / zoomed.scale, 1 / 1.3);
	// Escape clears a selection made on the canvas.
	await selectHub(page);
	await surface.focus();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('heading', { name: 'Map Worker 1' })).toBeHidden();

	// Keys typed into the search field never reach the map: the value stands
	// and no selection appears from nowhere.
	const search = page.getByRole('searchbox', { name: 'Find a worker' });
	await search.fill('Map Worker 499');
	await expect(page.getByRole('status')).toContainText('1 match');
	// Arrow keys move the caret in the field; they never pan the map behind it.
	await search.press('ArrowLeft');
	await expect(search).toHaveValue('Map Worker 499');
	await expect(page.getByRole('heading', { name: 'Map Worker 1' })).toHaveCount(0);
});

test('mobile widths reserve toolbar space instead of overlapping the drawing', async ({
	page,
	request
}) => {
	await seedHub(request);

	for (const width of [320, 390]) {
		await page.setViewportSize({ width, height: 844 });
		await openMap(page);

		const documentOverflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth + 1
		);
		expect(documentOverflow, `document scroll at ${width}px`).toBe(false);

		// The search row stands above the drawing area, in flow rather than over it.
		const surface = page.getByRole('application', { name: /Relationship map/ });
		await expect(surface).toBeVisible();
		const searchBox = await page.getByRole('searchbox', { name: 'Find a worker' }).boundingBox();
		const surfaceBox = await surface.boundingBox();
		expect(searchBox).not.toBeNull();
		expect(surfaceBox).not.toBeNull();
		const searchBottom = searchBox!.y + searchBox!.height;
		expect(searchBottom, `search clears the drawing at ${width}px`).toBeLessThanOrEqual(
			surfaceBox!.y + 1
		);
	}
});

test('a selected worker adds no horizontal scroll at 375px', async ({ page, request }) => {
	await seedHub(request);
	await page.setViewportSize({ width: 375, height: 812 });
	await openMap(page);

	await page
		.getByRole('button', { name: /^Map Worker 1, /, includeHidden: false })
		.first()
		.click();
	await expect(page.getByRole('heading', { name: 'Map Worker 1' })).toBeVisible();

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth + 1
	);
	expect(overflow, 'document scroll at 375px with a selection').toBe(false);
});

test('desktop widths keep every control reachable without document overflow', async ({
	page,
	request
}) => {
	// Two cold loads of a 500-Worker hub exceed the 30s default on slower runners.
	test.slow();
	await seedHub(request);

	for (const width of [1024, 1440]) {
		await page.setViewportSize({ width, height: width === 1024 ? 640 : 900 });
		await openMap(page);

		const documentOverflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth + 1
		);
		expect(documentOverflow, `document scroll at ${width}px`).toBe(false);

		await expect(page.getByRole('searchbox', { name: 'Find a worker' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Reset zoom' })).toBeVisible();
		await page.getByRole('button', { name: /^Filter/ }).click();
		await expect(page.getByRole('button', { name: 'Reset all' })).toBeVisible();
		await page.getByRole('button', { name: /^Filter/ }).click();
		await expect(page.getByLabel(/Dot size shows Relationships/)).toBeVisible();
	}
});

type Box = { x: number; y: number; width: number; height: number };
const intersects = (a: Box, b: Box) =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (outer: Box, inner: Box) =>
	inner.x >= outer.x - 1 &&
	inner.y >= outer.y - 1 &&
	inner.x + inner.width <= outer.x + outer.width + 1 &&
	inner.y + inner.height <= outer.y + outer.height + 1;

async function seedCategories(request: APIRequestContext) {
	const ids = [randomUUID(), randomUUID()];
	const options = ['Alpha value', 'Beta value', 'Gamma value', 'Delta value'];
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions(
			ids.map((id, index) => ({
				id,
				name: `Category ${index + 1}`,
				kind: 'category',
				options
			}))
		)
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	const created = await request.post('/api/workers', {
		data: [{ name: 'Layout Worker' }]
	});
	expect(created.ok(), await created.text()).toBeTruthy();
	const dataset = (await (await request.get('/api/dataset')).json()) as {
		workers: { id: string; name: string }[];
	};
	const worker = dataset.workers.find((entry) => entry.name === 'Layout Worker');
	if (!worker) throw new Error('seeded worker missing');
	return { ids, options, workerId: worker.id };
}

const stripOf = (page: Page) =>
	page
		.getByRole('searchbox', { name: 'Find a worker' })
		.locator('xpath=ancestor::div[contains(@class,"flex-wrap")][1]');

test('the worker card docks below the control strip, which never reflows', async ({
	page,
	request
}) => {
	const { ids, options } = await seedCategories(request);
	const hid = ids
		.flatMap((id) => options.slice(0, 3).map((o) => `hid=${id}:${answerId(id, o)}`))
		.join('&');
	for (const width of [1024, 1060, 1100, 1440]) {
		await page.setViewportSize({ width, height: 800 });
		await page.goto(`/mapping?group=${ids[0]}&${hid}`);
		await waitForMapReady(page);
		const strip = stripOf(page);
		const before = (await strip.boundingBox())!;
		const controlsBefore = await strip
			.locator('> *')
			.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().y)));

		await clickWorker(page, /^Layout Worker, /);
		const card = page.getByRole('region', { name: 'Worker record' });
		await expect(card).toBeVisible();

		const after = (await strip.boundingBox())!;
		expect(after.height, `strip height unchanged by the card at ${width}px`).toBe(before.height);
		const controlsAfter = await strip
			.locator('> *')
			.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().y)));
		expect(controlsAfter, `strip rows unchanged by the card at ${width}px`).toEqual(controlsBefore);

		const cardBox = (await card.boundingBox())!;
		const canvas = (await page.getByTestId('relationship-map-canvas').boundingBox())!;
		const controls = strip.locator('> *');
		for (let i = 0; i < (await controls.count()); i++) {
			const box = await controls.nth(i).boundingBox();
			if (!box || box.width === 0) continue;
			expect(intersects(cardBox, box), `strip control ${i} vs card at ${width}px`).toBe(false);
		}
		expect(cardBox.y, `card starts below the strip at ${width}px`).toBeGreaterThanOrEqual(
			after.y + after.height - 1
		);
		expect(contains(canvas, cardBox), `card inside the canvas at ${width}px`).toBe(true);
	}
});

test('a tall card scrolls inside itself and stays clear of the strip', async ({
	page,
	request
}) => {
	const { workerId } = await seedCategories(request);
	await page.setViewportSize({ width: 1024, height: 560 });
	await page.goto('/mapping');
	await waitForMapReady(page);
	await selectOnMap(page, workerId);
	const card = page.getByRole('region', { name: 'Worker record' });
	await expect(card).toBeVisible();
	const strip = (await stripOf(page).boundingBox())!;
	const cardBox = (await card.boundingBox())!;
	const canvas = (await page.getByTestId('relationship-map-canvas').boundingBox())!;
	expect(cardBox.y).toBeGreaterThanOrEqual(strip.y + strip.height - 1);
	expect(contains(canvas, cardBox)).toBe(true);
});

const keyOf = (page: Page) => page.getByRole('group', { name: 'Assessment color key' });
const dotKeyOf = (page: Page) => page.getByTestId('mapping-dot-key');

test('the Assessment color key and the dot-size key share the bottom row without overlapping', async ({
	page,
	request
}) => {
	await seedCategories(request);

	for (const [width, height] of [
		[1024, 640],
		[1100, 700],
		[1440, 900]
	]) {
		await page.setViewportSize({ width, height });
		await page.goto('/mapping');
		await waitForMapReady(page);

		await expect(keyOf(page)).toBeVisible();
		await expect(dotKeyOf(page)).toBeVisible();
		const key = (await keyOf(page).boundingBox())!;
		const dotKey = (await dotKeyOf(page).boundingBox())!;
		const canvas = (await page.getByTestId('relationship-map-canvas').boundingBox())!;
		const at = `${width}×${height}`;
		expect(intersects(key, dotKey), `keys at ${at}`).toBe(false);
		expect(contains(canvas, dotKey), `dot-size key inside the canvas at ${at}`).toBe(true);
		expect(dotKey.x, `dot-size key right of the colour key at ${at}`).toBeGreaterThanOrEqual(
			key.x + key.width - 1
		);
	}

	// Below lg both keys are strips in normal flow at the foot of the canvas.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/mapping');
	await waitForMapReady(page);
	const key = (await keyOf(page).boundingBox())!;
	const dotKey = (await dotKeyOf(page).boundingBox())!;
	expect(intersects(key, dotKey), 'keys on a phone').toBe(false);
	expect(dotKey.y, 'dot-size key below the colour key on a phone').toBeGreaterThanOrEqual(
		key.y + key.height - 1
	);
});

/** Two related Workers, so one of them can be open in the card while the canvas pans. */
async function seedRelatedPair(request: APIRequestContext) {
	const created = await request.post('/api/workers', { data: [{ name: 'Ada' }, { name: 'Bo' }] });
	expect(created.ok(), await created.text()).toBeTruthy();

	const dataset = (await (await request.get('/api/dataset')).json()) as {
		workers: {
			id: string;
			name: string;
			email: string;
			phone: string;
			assessment: string;
			attributes: Record<string, unknown>;
			agitations: string[];
			languages: string[];
			relationships: string[];
			notes: unknown[];
		}[];
	};
	const ada = dataset.workers.find((worker) => worker.name === 'Ada');
	const bo = dataset.workers.find((worker) => worker.name === 'Bo');
	if (!ada || !bo) throw new Error('the seeded pair is missing from the dataset');

	const related = await request.put(`/api/workers/${ada.id}`, {
		data: { ...workerUpdateFrom(ada), relationships: [bo.id] }
	});
	expect(related.ok(), await related.text()).toBeTruthy();
}

/**
 * A point on the canvas where a click lands on the map's own painting: clear of
 * every dot — and of every dot's hit area, which selects its Worker the same way
 * the painted mark does — and clear of the floating strip, key, bar and card.
 * Found through `elementFromPoint`, which is what the pointer would actually hit.
 */
async function emptyCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
	const canvas = (await page.getByTestId('relationship-map-canvas').boundingBox())!;
	const found = await page.evaluate(
		({ x, y, width, height }) => {
			for (let fy = 0.2; fy <= 0.8; fy += 0.05) {
				for (let fx = 0.1; fx <= 0.9; fx += 0.05) {
					const px = Math.round(x + width * fx);
					const py = Math.round(y + height * fy);
					const hit = document.elementFromPoint(px, py);
					if (!hit) continue;
					if (hit.closest('g[role="button"], [data-hit-for]')) continue;
					if (hit.closest('button, input, [role="button"], [role="group"], [role="region"]'))
						continue;
					return { x: px, y: py };
				}
			}
			return undefined;
		},
		{ x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height }
	);
	expect(found, 'an empty spot on the canvas').toBeDefined();
	return found!;
}

test('a drag pans with the worker card open, while a click still closes it', async ({
	page,
	request
}) => {
	await seedRelatedPair(request);
	await openMap(page);

	const card = page.getByRole('region', { name: 'Worker record' });
	await clickWorker(page, /^Ada, /);
	await expect(card).toBeVisible();

	// Looking around keeps the record open, and the canvas really moved.
	const from = await emptyCanvasPoint(page);
	const before = await layerTransform(page);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	for (const step of [15, 45, 75, 90]) await page.mouse.move(from.x + step, from.y - step / 3);
	await page.mouse.up();

	await expect(card, 'a pan keeps the card open').toBeVisible();
	const panned = await layerTransform(page);
	expect(panned.x - before.x, 'the drag panned the map').toBeGreaterThan(60);

	// A click that drifts a few pixels — a hand that is not perfectly still — is
	// still a click, so dismissing the card needs no precision.
	const drifted = await emptyCanvasPoint(page);
	await page.mouse.move(drifted.x, drifted.y);
	await page.mouse.down();
	await page.mouse.move(drifted.x + 3, drifted.y + 2);
	await page.mouse.up();
	await expect(card, 'a 3px drift still closes the card').toBeHidden();

	// And so is a plain click on empty canvas.
	await clickWorker(page, /^Ada, /);
	await expect(card).toBeVisible();
	const still = await emptyCanvasPoint(page);
	await page.mouse.click(still.x, still.y);
	await expect(card).toBeHidden();
});

/** The box every drawn dot occupies, in client pixels: the drawn set's own extent. */
async function drawnBounds(page: Page): Promise<Box> {
	const circles = page
		.getByTestId('relationship-map-layer')
		.locator('circle:not(.fill-none):not([data-hit-for])');
	const boxes = await circles.evaluateAll((elements) =>
		elements.map((element) => {
			const rect = element.getBoundingClientRect();
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		})
	);
	expect(boxes.length).toBeGreaterThan(0);

	const left = Math.min(...boxes.map((box) => box.x));
	const top = Math.min(...boxes.map((box) => box.y));
	const right = Math.max(...boxes.map((box) => box.x + box.width));
	const bottom = Math.max(...boxes.map((box) => box.y + box.height));
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The free canvas as laid out: the map's surface minus the measured control strip,
 * and minus the card's column when one is open.
 */
async function freeCanvasBox(page: Page, options: { card?: boolean } = {}): Promise<Box> {
	const surface = (await page
		.getByRole('application', { name: /Relationship map/ })
		.boundingBox())!;
	const strip = (await stripOf(page).boundingBox())!;
	const right = options.card
		? (await page.getByRole('region', { name: 'Worker record' }).boundingBox())!.x - 1
		: surface.x + surface.width;
	const top = strip.y + strip.height - 1;
	const bottom = surface.y + surface.height;

	return { x: surface.x, y: top, width: right - surface.x, height: bottom - top };
}

test('Reset zoom recovers a panned-away map inside the free canvas', async ({ page, request }) => {
	await seedRelatedPair(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await openMap(page);

	/**
	 * Pans the whole map off the canvas, from a point that holds no dot. The free
	 * canvas is wide and the drawn set small, so one drag may not clear it: drag
	 * again until the map is lost, which is what the organizer would do.
	 */
	const dragMapAway = async () => {
		// The start-up splash is a full-screen overlay that swallows raw mouse input,
		// so a drag waits for the shell, not just the drawing.
		await appReady(page);
		for (let drag = 0; drag < 4; drag += 1) {
			const from = await emptyCanvasPoint(page);
			await page.mouse.move(from.x, from.y);
			await page.mouse.down();
			for (const step of [200, 400, 560]) await page.mouse.move(from.x + step, from.y + step * 0.5);
			await page.mouse.up();
			if (!contains(await freeCanvasBox(page), await drawnBounds(page))) return;
		}
	};

	await dragMapAway();
	expect(
		contains(await freeCanvasBox(page), await drawnBounds(page)),
		'the map is lost off the canvas'
	).toBe(false);

	await page.getByRole('button', { name: 'Reset zoom' }).click();
	await expect
		.poll(async () => contains(await freeCanvasBox(page), await drawnBounds(page)))
		.toBe(true);
	// Reset returns to the whole-map framing, which the zoom readout calls 100%.
	await expect(page.getByText('100%', { exact: true })).toBeVisible();

	// With the card open the map centres in the canvas the card leaves, rather
	// than behind it.
	await clickWorker(page, /^Ada, /);
	await expect(page.getByRole('region', { name: 'Worker record' })).toBeVisible();
	await dragMapAway();
	await page.getByRole('button', { name: 'Reset zoom' }).click();
	await expect
		.poll(async () => contains(await freeCanvasBox(page, { card: true }), await drawnBounds(page)))
		.toBe(true); // Recovering the view never throws Isolate away, and inside Isolate the reset
	// returns to the fitted view: the same neighbourhood in the same place.
	const isolate = page
		.getByTestId('relationship-map-canvas')
		.getByRole('button', { name: 'Isolate' });
	await isolate.click();
	await expect(page).toHaveURL(/iso=1/);
	// Isolate travels to its fitted view: measure it once it has settled
	// inside the free canvas.
	await expect
		.poll(async () => contains(await freeCanvasBox(page, { card: true }), await drawnBounds(page)))
		.toBe(true);
	let fitted = await drawnBounds(page);
	await expect
		.poll(async () => {
			const now = await drawnBounds(page);
			const settled = (['x', 'y', 'width', 'height'] as const).every(
				(edge) => Math.abs(now[edge] - fitted[edge]) < 0.5
			);
			fitted = now;
			return settled;
		})
		.toBe(true);

	await dragMapAway();
	await page.getByRole('button', { name: 'Reset zoom' }).click();
	await expect(page).toHaveURL(/iso=1/);
	await expect(isolate).toHaveAttribute('aria-pressed', 'true');
	await expect
		.poll(async () => contains(await freeCanvasBox(page, { card: true }), await drawnBounds(page)))
		.toBe(true);

	const recovered = await drawnBounds(page);
	for (const edge of ['x', 'y', 'width', 'height'] as const) {
		expect(Math.abs(recovered[edge] - fitted[edge]), `fitted view restored: ${edge}`).toBeLessThan(
			2
		);
	}
});

test('the Filter popover hangs from its button and stays inside the canvas', async ({
	page,
	request
}) => {
	const { workerId } = await seedCategories(request);
	for (const [width, height] of [
		[1440, 900],
		[1024, 640],
		[375, 812]
	]) {
		await page.setViewportSize({ width, height });
		await page.goto('/mapping');
		await waitForMapReady(page);
		const button = page.getByRole('button', { name: /^Filter/ });
		await button.click();
		const panel = page.locator('#map-filter-panel');
		await expect(panel).toBeVisible();
		const canvas = (await page.getByTestId('relationship-map-canvas').boundingBox())!;
		// Floating UI positions the portal on the next frame; visibility alone can
		// observe its initial off-canvas coordinates.
		await expect
			.poll(
				async () => {
					const box = await panel.boundingBox();
					return box !== null && contains(canvas, box);
				},
				{ message: `panel in canvas at ${width}px` }
			)
			.toBe(true);
		const buttonBox = (await button.boundingBox())!;
		const box = (await panel.boundingBox())!;
		const at = `${width}px: panel ${JSON.stringify(box)} button ${JSON.stringify(buttonBox)}`;
		expect(contains(canvas, box), `panel in canvas at ${at}`).toBe(true);
		// Touches the button: a few pixels of gap on the side it opens toward, and
		// horizontally overlapping the button rather than somewhere else on the canvas.
		const gap = Math.min(
			Math.abs(box.y - (buttonBox.y + buttonBox.height)),
			Math.abs(buttonBox.y - (box.y + box.height))
		);
		expect(gap, `panel touches the button at ${at}`).toBeLessThanOrEqual(8);
		expect(box.x <= buttonBox.x + buttonBox.width && box.x + box.width >= buttonBox.x).toBe(true);
		if (width === 375) {
			for (const name of [/^Category 1/, /^Category 2/, 'Clear filters', 'Reset all']) {
				await expect(panel.getByRole('button', { name })).toBeVisible();
			}
			await panel.getByRole('button', { name: /^Category 1/ }).click();
			await expect(page.getByRole('menuitemcheckbox', { name: 'Alpha value' })).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(panel).toBeVisible();
		}
		await page.keyboard.press('Escape');
		await expect(panel).toBeHidden();
	}

	// An open card does not stop the popover drawing over it.
	await page.setViewportSize({ width: 1024, height: 800 });
	await page.goto('/mapping');
	await waitForMapReady(page);
	await selectOnMap(page, workerId);
	await page.getByRole('button', { name: /^Filter/ }).click();
	const panel = page.locator('#map-filter-panel');
	await expect(panel).toBeVisible();
	const box = (await panel.boundingBox())!;
	const top = await page.evaluate(
		([x, y]) => document.elementFromPoint(x, y)?.closest('#map-filter-panel') !== null,
		[box.x + box.width / 2, box.y + 8]
	);
	expect(top, 'the popover draws above the card').toBe(true);

	// A category dropdown inside the popover does not dismiss it.
	await panel.getByRole('button', { name: /^Category 1/ }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Alpha value' }).click();
	await expect(panel).toBeVisible();
});

test.describe('the Isolate camera', () => {
	const sampleZooms = (page: Page) =>
		page.evaluate(
			() =>
				new Promise<number[]>((resolve) => {
					const zooms: number[] = [];
					const read = () => {
						const raw = document
							.querySelector('[data-testid="relationship-map-layer"]')
							?.getAttribute('transform');
						zooms.push(Number(/scale\(([-\d.]+)\)/.exec(raw ?? '')?.[1]));
					};
					const tick = () => {
						read();
						if (zooms.length < 6) requestAnimationFrame(tick);
						else resolve(zooms);
					};
					requestAnimationFrame(tick);
				})
		);

	test('eases toward 1× entering Isolate, instant under reduced motion', async ({
		page,
		request
	}) => {
		await seedRelatedPair(request);
		await page.setViewportSize({ width: 1440, height: 900 });
		await openMap(page);
		const isolate = page
			.getByTestId('relationship-map-canvas')
			.getByRole('button', { name: 'Isolate' });
		await clickWorker(page, /^Ada, /);
		const zoomIn = page.getByRole('button', { name: 'Zoom in' });

		for (const reduced of [false, true]) {
			await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
			await openMap(page);
			await clickWorker(page, /^Ada, /);
			await zoomIn.click();
			await zoomIn.click();
			const before = (await layerTransform(page)).scale;
			expect(before).toBeGreaterThan(1.2);
			await isolate.click();
			const zooms = await sampleZooms(page);
			if (reduced) {
				expect(zooms[0]).toBe(1);
			} else {
				for (let index = 1; index < zooms.length; index += 1) {
					expect(zooms[index], `frame ${index}`).toBeLessThanOrEqual(zooms[index - 1] + 1e-6);
				}
				expect(zooms[0]).toBeLessThan(before);
				expect(zooms[0]).toBeGreaterThan(1);
				await expect.poll(async () => (await layerTransform(page)).scale).toBe(1);

				// Leaving Isolate eases to the fitted camera, again without a jump.
				await isolate.click();
				const back = await sampleZooms(page);
				const sign = Math.sign(back[5] - back[0]) || 1;
				for (let index = 1; index < back.length; index += 1) {
					expect(sign * (back[index] - back[index - 1]), `leaving frame ${index}`).toBeGreaterThan(
						-1e-6
					);
				}
				expect(back[0]).not.toBe(back[5]);
			}
		}
	});
});
