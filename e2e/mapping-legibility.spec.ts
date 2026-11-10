import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { waitForMapInteraction } from './map.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

/**
 * Ticket 1 — the map's marks hold their reading at every camera scale: names
 * stay 12px, ties keep a 1pt stroke, and a pointer that only comes close to a
 * dot still lands on that Worker rather than on nobody.
 */
test.use({ reducedMotion: 'reduce' });

/** A hub with two spokes and the requested number of Workers in one department. */
async function seedLegibleWorksite(request: APIRequestContext, workerCount = 6) {
	const deptId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: ['Front of House'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const names = [
		'Ada',
		'Bo',
		'Cy',
		'Fio',
		'Gus',
		'Hana',
		...Array.from({ length: Math.max(0, workerCount - 6) }, (_, index) => `Extra ${index + 1}`)
	].slice(0, workerCount);
	const attributes = wireWorkerAttributes({ [deptId]: 'Front of House' });
	const workerIds: string[] = [];

	for (const name of names) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes,
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
		workerIds.push((await created.json()).worker.id);
	}

	// Ada is the only hub: two of her own ties, and nobody else is related. The
	// three Workers with no tie draw at the smallest radius the map has.
	const related = await request.put(`/api/workers/${workerIds[0]}`, {
		data: {
			name: names[0],
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes,
			agitations: [],
			languages: [],
			relationships: [workerIds[1], workerIds[2]],
			notes: []
		}
	});
	expect(related.ok(), await related.text()).toBeTruthy();

	return { deptId, workerIds };
}

async function openMap(page: Page, drawn: number) {
	await page.goto('/mapping');
	await waitForMapInteraction(page);
	await expect(page.locator('svg g[role="button"][data-node-id]')).toHaveCount(drawn);
}

/** A drawn Worker as the pointer meets it, in the browser's own CSS pixels. */
type DrawnDot = {
	/** The Worker's id, which its hit circle carries as `data-hit-for`. */
	id: string;
	name: string;
	/** The painted dot's centre. */
	cx: number;
	cy: number;
	/** The painted dot's radius, as drawn. */
	radius: number;
	/** The radius of the transparent circle that catches the pointer. */
	hitRadius: number;
};

/**
 * Every drawn Worker's painted centre, painted radius and hit radius — all in
 * CSS pixels, so the camera's zoom and the page's layout are already in them.
 * The radii are read as attributes and scaled by the layer's own zoom, which is
 * the same transform that draws them.
 */
async function drawnDots(page: Page): Promise<DrawnDot[]> {
	return page.evaluate(() => {
		const layer = document.querySelector('g[data-testid="relationship-map-layer"]');
		const zoom = Number(/scale\(([\d.]+)\)/.exec(layer?.getAttribute('transform') ?? '')?.[1]);

		return [...document.querySelectorAll('svg g[role="button"][data-node-id]')].map((group) => {
			const id = group.getAttribute('data-node-id') ?? '';
			const painted = group.querySelector(
				'circle:not([data-hit-for]):not([data-focus-ring]):not([data-selected-ring])'
			)!;
			const hit = document.querySelector(`[data-hit-for="${id}"]`);
			const rect = painted.getBoundingClientRect();

			return {
				id,
				name: (group.getAttribute('aria-label') ?? '').split(',')[0],
				cx: rect.x + rect.width / 2,
				cy: rect.y + rect.height / 2,
				radius: Number(painted.getAttribute('r')) * zoom,
				hitRadius: Number(hit?.getAttribute('r') ?? 0) * zoom
			};
		});
	});
}

/** The camera's current scale, read off the layer's own transform. */
async function readZoom(page: Page): Promise<number> {
	return page.evaluate(() => {
		const layer = document.querySelector('g[data-testid="relationship-map-layer"]');
		return Number(/scale\(([\d.]+)\)/.exec(layer?.getAttribute('transform') ?? '')?.[1]);
	});
}

/** The rendered height of every name drawn on the map, in CSS pixels. */
async function labelHeights(page: Page): Promise<number[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll('svg text[data-node-label]')].map(
			(text) => text.getBoundingClientRect().height
		)
	);
}

async function expectLabelsDoNotOverlap(page: Page) {
	await expect.poll(() => page.locator('svg text[data-node-label]').count()).toBeGreaterThan(0);
	const boxes = await page.locator('svg text[data-node-label]').evaluateAll((labels) =>
		labels.map((label) => {
			const { x, y, width, height } = label.getBoundingClientRect();
			return {
				text: label.textContent,
				anchor: label.getAttribute('text-anchor'),
				cx: label.getAttribute('x'),
				cy: label.getAttribute('y'),
				left: x,
				top: y,
				right: x + width,
				bottom: y + height
			};
		})
	);
	for (let first = 0; first < boxes.length; first += 1) {
		for (let second = first + 1; second < boxes.length; second += 1) {
			const a = boxes[first];
			const b = boxes[second];
			expect(
				a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
				`labels overlap: ${JSON.stringify([a, b])}`
			).toBe(true);
		}
	}
}

test('labels never overlap each other in ungrouped and grouped layouts', async ({
	page,
	request
}) => {
	const { deptId } = await seedLegibleWorksite(request);
	await openMap(page, 6);
	await expectLabelsDoNotOverlap(page);

	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapInteraction(page);
	await expect(page.locator('svg g[role="button"][data-node-id]')).toHaveCount(6);
	await expectLabelsDoNotOverlap(page);
});

/** What the pointer would actually hit at a point, as the hit layer names it. */
async function hitAt(page: Page, x: number, y: number): Promise<string | undefined> {
	return page.evaluate(
		([px, py]) =>
			document.elementFromPoint(px, py)?.closest('[data-hit-for]')?.getAttribute('data-hit-for') ??
			undefined,
		[x, y]
	);
}

/** The record card's heading, which names the Worker the map has selected. */
function cardName(page: Page) {
	return page.getByRole('region', { name: 'Worker record' }).getByRole('heading');
}

async function selectWorker(page: Page, name: string) {
	const worker = page.getByRole('button', { name: new RegExp(`^${name}, `) });
	await expect(worker).toBeAttached();
	await worker.click();
}

test('selection emphasizes ego ties, draws a ring and states both Isolate degrees', async ({
	page,
	request
}) => {
	await seedLegibleWorksite(request);
	await openMap(page, 6);
	const map = page.getByTestId('relationship-map-layer');
	const accessible = await map.ariaSnapshot();
	expect(accessible.split('\n').filter((line) => /- button /.test(line))).toHaveLength(6);
	for (const [name, count] of [
		['Ada', 2],
		['Bo', 1],
		['Cy', 1],
		['Fio', 0],
		['Gus', 0],
		['Hana', 0]
	] as const) {
		await expect(
			map.getByRole('button', {
				name: `${name}, Unassessed, ${count} relationship${count === 1 ? '' : 's'}`,
				exact: true
			})
		).toHaveCount(1);
	}
	expect(
		await map
			.locator('[data-hit-for]')
			.evaluateAll((hits) =>
				hits.every(
					(hit) =>
						hit.parentElement?.getAttribute('data-node-id') === hit.getAttribute('data-hit-for')
				)
			)
	).toBe(true);

	await selectWorker(page, 'Ada');
	await expect(cardName(page)).toHaveText('Ada');
	await expect(page.locator('[data-selected-ring]')).toHaveCount(1);
	await expect
		.poll(() =>
			page
				.locator('svg path[data-tie]')
				.first()
				.evaluate((path) => Number(getComputedStyle(path).strokeOpacity))
		)
		.toBeGreaterThan(0.85);

	await page.getByRole('button', { name: 'Isolate' }).click();
	await expect(page.getByText('2 direct · 0 through them')).toBeVisible();
});

test('card lists neighbours alphabetically with relationship counts', async ({ page, request }) => {
	await seedLegibleWorksite(request);
	await openMap(page, 6);
	await selectWorker(page, 'Ada');
	const rows = page.getByRole('region', { name: 'Worker record' }).locator('ul li button');
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toContainText('Bo');
	await expect(rows.nth(0)).toContainText('1');
	await expect(rows.nth(1)).toContainText('Cy');
	await expect(rows.nth(1)).toContainText('1');
});

test('size and Isolate readings fit in two reserved key rows', async ({ page, request }) => {
	await seedLegibleWorksite(request);
	await openMap(page, 6);
	await selectWorker(page, 'Ada');
	await page.getByRole('button', { name: 'Isolate' }).click();
	const list = page.getByRole('group', { name: 'Assessment color key' }).getByRole('list');

	for (const width of [1024, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		const tops = await list
			.locator(':scope > li')
			.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
		const layout = await list.locator(':scope > li').evaluateAll((items) =>
			items.map((item) => ({
				text: item.textContent?.trim(),
				x: Math.round(item.getBoundingClientRect().x),
				width: Math.round(item.getBoundingClientRect().width),
				y: Math.round(item.getBoundingClientRect().y)
			}))
		);
		const rows: number[] = [];
		for (const top of tops.sort((a, b) => a - b)) {
			if (rows.every((rowTop) => Math.abs(top - rowTop) > 10)) rows.push(top);
		}
		expect(rows.length, `key rows at ${width}px: ${JSON.stringify(layout)}`).toBeLessThanOrEqual(2);
	}
});

test('name labels stay 12px at fit and after two zoom-ins', async ({ page, request }) => {
	await seedLegibleWorksite(request);
	await openMap(page, 6);

	await page.getByRole('application', { name: /Relationship map/ }).focus();

	const atFit = await labelHeights(page);
	expect(atFit.length, 'the map drew names to measure').toBeGreaterThan(0);
	for (const height of atFit) {
		expect(height, 'a name at the fit').toBeGreaterThanOrEqual(11);
		expect(height, 'a name at the fit').toBeLessThanOrEqual(17);
	}

	const zoomedOut = await readZoom(page);
	await page.keyboard.press('+');
	await page.keyboard.press('+');
	await expect.poll(() => readZoom(page)).toBeGreaterThan(zoomedOut);

	// The zoom eases in over several frames; read the names once it has settled.
	await expect
		.poll(async () => (await labelHeights(page)).every((height) => height >= 11 && height <= 17))
		.toBe(true);
	const afterZoom = await labelHeights(page);
	expect(afterZoom).toHaveLength(atFit.length);
	for (const height of afterZoom) {
		expect(height, 'a name two zoom-ins in').toBeGreaterThanOrEqual(11);
		expect(height, 'a name two zoom-ins in').toBeLessThanOrEqual(17);
	}
});

test('ties keep a non-scaling stroke', async ({ page, request }) => {
	await seedLegibleWorksite(request);
	await openMap(page, 6);

	const ties = page.locator('svg path[data-tie]');
	await expect(ties).toHaveCount(2);
	await expect(ties.first()).toHaveAttribute('data-tie', 'within');

	// Every tie is drawn through the camera's own scale, so the stroke has to be
	// held outside it: a 1pt rule stays 1pt at 71% and at 4×.
	const effects = await ties.evaluateAll((paths) =>
		paths.map((path) => path.getAttribute('vector-effect'))
	);
	expect(effects).toEqual(['non-scaling-stroke', 'non-scaling-stroke']);
});

test('a near miss selects the smallest worker', async ({ page, request }) => {
	await seedLegibleWorksite(request);
	await openMap(page, 6);

	// 9px from the centre is well outside a lone Worker's 6px mark and inside the
	// 24px target the hit layer gives it. The smallest dot first: its painted mark
	// is the one a pointer is most likely to miss.
	// The first frame is placed a beat after the dots mount, so the dots are read
	// once every one of them sits inside the viewport the pointer can reach.
	const viewport = page.viewportSize()!;
	await expect
		.poll(async () =>
			(await drawnDots(page)).every(
				(dot) => dot.cx > 0 && dot.cx < viewport.width && dot.cy > 0 && dot.cy < viewport.height
			)
		)
		.toBe(true);
	const dots = await drawnDots(page);
	const miss = [];
	for (const dot of [...dots].sort((a, b) => a.radius - b.radius)) {
		const x = dot.cx + 9;
		if ((await hitAt(page, x, dot.cy)) === dot.id) miss.push({ dot, x });
	}
	expect(miss.length, 'a Worker with room for a near miss').toBeGreaterThan(0);

	const { dot, x } = miss[0];
	await page.mouse.click(x, dot.cy);
	await expect(cardName(page)).toHaveText(dot.name);
});

/**
 * The closest pair of drawn dots whose 24px targets overlap while their painted
 * marks leave each other's centres clear — the case the hit layer's order exists
 * for. A dot sitting over another dot's centre is a different reading (the mark
 * the reader can see is the one on top), so those pairs are not it.
 * Actual clicks below verify pointer resolution even when a later halo is on top.
 */
async function touchingPair(page: Page): Promise<{ first: DrawnDot; second: DrawnDot } | null> {
	return page.evaluate(() => {
		const layer = document.querySelector('g[data-testid="relationship-map-layer"]');
		const zoom = Number(/scale\(([\d.]+)\)/.exec(layer?.getAttribute('transform') ?? '')?.[1]);
		// Selecting a Worker opens the 320px record card, 12px in from the surface's right
		// edge (worker-dossier.svelte), over whatever dots lie there. Only dots left of that
		// footprint can still be clicked after the first selection.
		const dockLeft =
			document.querySelector('[data-testid="relationship-map-surface"]')!.getBoundingClientRect()
				.right -
			12 -
			320;
		const dots = [...document.querySelectorAll('svg g[role="button"][data-node-id]')].map(
			(group) => {
				const id = group.getAttribute('data-node-id') ?? '';
				const painted = group.querySelector(
					'circle:not([data-hit-for]):not([data-focus-ring]):not([data-selected-ring])'
				)!;
				const hit = document.querySelector(`[data-hit-for="${id}"]`);
				const rect = painted.getBoundingClientRect();

				return {
					id,
					name: (group.getAttribute('aria-label') ?? '').split(',')[0],
					cx: rect.x + rect.width / 2,
					cy: rect.y + rect.height / 2,
					radius: Number(painted.getAttribute('r')) * zoom,
					hitRadius: Number(hit?.getAttribute('r') ?? 0) * zoom
				};
			}
		);

		const pairs = [];
		for (let a = 0; a < dots.length; a += 1) {
			for (let b = a + 1; b < dots.length; b += 1) {
				if (dots[a].cx >= dockLeft || dots[b].cx >= dockLeft) continue;
				const distance = Math.hypot(dots[a].cx - dots[b].cx, dots[a].cy - dots[b].cy);
				if (distance < dots[a].radius + dots[b].radius) continue;
				if (distance >= dots[a].hitRadius + dots[b].hitRadius) continue;
				pairs.push({ distance, first: dots[a], second: dots[b] });
			}
		}

		pairs.sort((left, right) => left.distance - right.distance);
		return pairs[0] ?? null;
	});
}

test('touching dots each select themselves', async ({ page, request }) => {
	// Enough Workers that framing the group needs less than the 40% hand-zoom
	// floor, so zooming out can reach the scale where neighbouring targets meet.
	const workerCount = 80;
	const { deptId } = await seedLegibleWorksite(request, workerCount);

	// A dense group packs neighbours close enough that one Worker's 24px target
	// covers a neighbour's dot when zoomed out.
	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapInteraction(page);
	await expect(page.locator('svg g[role="button"][data-node-id]')).toHaveCount(workerCount);

	await page.getByRole('application', { name: /Relationship map/ }).focus();

	// Zooming out grows every Worker's target in map units — a 24px reach at a
	// smaller scale — until neighbouring dots' targets overlap.
	let overlap = await touchingPair(page);
	for (let step = 0; step < 5 && !overlap; step += 1) {
		const before = await readZoom(page);
		await page.keyboard.press('-');
		await expect.poll(() => readZoom(page)).toBeLessThan(before);
		overlap = await touchingPair(page);
	}

	expect(overlap, 'two drawn dots whose targets overlap').not.toBeNull();
	const { first, second } = overlap!;

	// Each painted centre is that Worker's own: the dot that is drawn sits above
	// every hit circle, including its neighbour's.
	await page.mouse.click(first.cx, first.cy);
	await expect(cardName(page)).toHaveText(first.name);

	await page.mouse.click(second.cx, second.cy);
	await expect(cardName(page)).toHaveText(second.name);
});
