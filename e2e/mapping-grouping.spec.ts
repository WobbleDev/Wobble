import { type APIRequestContext, type Page } from '@playwright/test';
import { expect, test, testId } from './fixtures.ts';
import { settled, waitForMapInteraction, waitForMapReady } from './map.ts';
import { selectOnMap } from './person.ts';
import { appReady } from './page-ready.ts';
import { answerId, wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';
import { workerUpdateFrom } from './api.ts';

/** Opens the Group popover unless it is already open. */
async function openGroupMenu(page: Page) {
	const trigger = page.getByRole('button', { name: /^Group(:|$)/ });
	if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
	await expect(page.locator('#map-group-by')).toBeVisible();
}

test.use({ reducedMotion: 'reduce' });

async function seedWorksite(request: APIRequestContext) {
	const deptId = testId();
	const roleId = testId();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: deptId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House']
			},
			{ id: roleId, name: 'Role', kind: 'category', options: ['Server', 'Cook'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const workers = [
		{ name: 'Ada', dept: 'Front of House', role: 'Server' },
		{ name: 'Grace', dept: 'Front of House', role: 'Cook' },
		{ name: 'Lin', dept: 'Back of House', role: 'Server' }
	];
	const ids: string[] = [];

	for (const worker of workers) {
		const created = await request.post('/api/workers', {
			data: {
				name: worker.name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({ [deptId]: worker.dept, [roleId]: worker.role }),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status()).toBe(201);
		ids.push((await created.json()).worker.id);
	}

	// Two stored relationships, so the ungrouped map has lines to draw.
	const related = await request.put(`/api/workers/${ids[0]}`, {
		data: {
			name: workers[0].name,
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: wireWorkerAttributes({ [deptId]: workers[0].dept, [roleId]: workers[0].role }),
			agitations: [],
			languages: [],
			relationships: [ids[1], ids[2]],
			notes: []
		}
	});
	expect(related.ok()).toBeTruthy();

	return { deptId, roleId, workerIds: ids };
}

/** One Category with two options, two Workers each, and no Relationships. */
async function seedWorkersWithoutRelationships(request: APIRequestContext) {
	const deptId = testId();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: deptId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House']
			}
		])
	});
	expect(configured.ok()).toBeTruthy();

	for (const [name, dept] of [
		['Ada', 'Front of House'],
		['Grace', 'Front of House'],
		['Lin', 'Back of House'],
		['Noor', 'Back of House']
	] as const) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({ [deptId]: dept }),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status()).toBe(201);
	}

	return { deptId };
}

/** One Category with many answers and enough Workers to spread its clusters wide. */
async function seedWideCategory(request: APIRequestContext) {
	const deptId = testId();
	const options = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([{ id: deptId, name: 'Team', kind: 'category', options }])
	});
	expect(configured.ok()).toBeTruthy();

	for (let index = 0; index < 36; index += 1) {
		const created = await request.post('/api/workers', {
			data: {
				name: `W${String(index).padStart(2, '0')}`,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({ [deptId]: options[index % options.length] }),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status()).toBe(201);
	}

	return { deptId };
}

/** Two Categories and a Tag, so the Group by control's exclusions are observable. */
async function seedWorksiteWithATag(request: APIRequestContext) {
	const deptId = testId();
	const roleId = testId();
	const tagId = testId();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: deptId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House']
			},
			{ id: roleId, name: 'Role', kind: 'category', options: ['Server', 'Cook'] },
			{ id: tagId, name: 'Certifications', kind: 'tag', options: ['First Aid'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const created = await request.post('/api/workers', {
		data: {
			name: 'Ada',
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: wireWorkerAttributes({
				[deptId]: 'Front of House',
				[roleId]: 'Server',
				[tagId]: ['First Aid']
			}),
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		}
	});
	expect(created.status()).toBe(201);

	return { deptId, roleId, tagId };
} /** A four-Worker relationship chain — Ada—Bo—Cy—Di — for reading the Isolate neighbourhood. */
async function seedRelationshipChain(request: APIRequestContext) {
	const names = ['Ada', 'Bo', 'Cy', 'Di'];
	const deptId = testId();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: ['Front of House'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

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
		expect(created.status()).toBe(201);
		workerIds.push((await created.json()).worker.id);
	}

	// One update per Worker that gains relationships, so each write does not
	// clobber a pair another write already stored: the service replaces the
	// Worker's whole relationship set.
	const chain: [number, string[]][] = [
		[0, [workerIds[1]]],
		[2, [workerIds[1], workerIds[3]]]
	];

	for (const [index, relationships] of chain) {
		const updated = await request.put(`/api/workers/${workerIds[index]}`, {
			data: {
				name: names[index],
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes,
				agitations: [],
				languages: [],
				relationships,
				notes: []
			}
		});
		expect(updated.ok()).toBeTruthy();
	}

	return { workerIds };
}

/** Region outlines are the only paths the map draws with a round line join. */
const regionOutlines = 'svg path[stroke-linejoin="round"]';

type Point = { x: number; y: number };

/**
 * Where each drawn Worker sits relative to the selected Worker, in CSS pixels.
 * Measuring from the selected Worker makes an Isolate neighbourhood and a Force
 * blob comparable regardless of where the canvas happens to be panned or zoomed.
 */
async function workerOffsetsFromSelection(page: Page): Promise<Point[]> {
	const markers = page.locator(
		'svg g[role="button"] > circle:not([data-hit-for]):not([data-focus-ring]):not([data-selected-ring])'
	);

	await expect.poll(() => markers.count()).toBeGreaterThan(1);

	return markers.evaluateAll((circles) => {
		const points = circles.map((circle) => {
			const { x, y } = (circle as SVGCircleElement).getBoundingClientRect();
			const selected = circle.closest('g[role="button"]')?.getAttribute('aria-pressed') === 'true';
			return { x, y, selected };
		});

		const anchor = points.find((point) => point.selected);
		if (!anchor) throw new Error('No Worker is selected');

		return points.map(({ x, y }) => ({ x: x - anchor.x, y: y - anchor.y }));
	});
}

/** The furthest any Worker moved between two measurements, in CSS pixels. */
function maxDrift(before: readonly Point[], after: readonly Point[]): number {
	expect(after).toHaveLength(before.length);

	return Math.max(
		...before.map((point, index) => Math.hypot(point.x - after[index].x, point.y - after[index].y))
	);
}

/** How far geometry may move and still count as the same layout, relative to its own radius. */
const shapeTolerance = 0.25;

/** A hub with two spokes, and enough unconnected Workers to fill the canvas. */
async function seedSmallNeighbourhood(request: APIRequestContext) {
	const created = await request.post('/api/workers', {
		data: Array.from({ length: 18 }, (_, index) => ({
			name: `W${String(index + 1).padStart(2, '0')}`
		}))
	});
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
	const workerNamed = (name: string) => {
		const worker = dataset.workers.find((entry) => entry.name === name);
		if (!worker) throw new Error(`${name} is missing from the dataset`);
		return worker;
	};

	const hub = workerNamed('W01');
	const related = await request.put(`/api/workers/${hub.id}`, {
		data: {
			...workerUpdateFrom(hub),
			relationships: [workerNamed('W02').id, workerNamed('W03').id]
		}
	});
	expect(related.ok(), await related.text()).toBeTruthy();

	return { hubId: hub.id };
}

/**
 * A drawn Worker's focus ring radius in map units. Isolate scales the dot with the fit
 * The radius arithmetic is unit-tested in map-view-model.spec.ts.
 */
async function radiusOf(page: Page, name: string): Promise<number> {
	return Number(
		await page
			.getByRole('button', { name: new RegExp(`^${name}, `) })
			.locator('circle')
			.nth(1)
			.getAttribute('r')
	);
}

/** The furthest a Worker sits from the selected one, in CSS pixels. */
const reachOf = (points: readonly Point[]) =>
	Math.max(...points.map((point) => Math.hypot(point.x, point.y)));

/**
 * The same offsets with their scale divided out. The camera and Isolate's fit both
 * scale the whole set, so comparing these compares the arrangement's shape alone.
 */
const unit = (points: readonly Point[]) =>
	points.map((point) => ({ x: point.x / reachOf(points), y: point.y / reachOf(points) }));

test('a fresh Mapping opens ungrouped with no region outlines', async ({ page, request }) => {
	await seedWorksite(request);
	await page.goto('/mapping');
	await waitForMapInteraction(page);

	// Group by offers None first, then the worksite's Categories.
	await openGroupMenu(page);
	await expect(page.getByLabel('Group by', { exact: true })).toHaveText('None');
	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await expect(page.getByRole('option')).toHaveText(['None', 'Department', 'Role']);
	await page.keyboard.press('Escape');

	// None is the default, so it is absent from the URL.
	await expect(page).not.toHaveURL(/group=/);

	// No group regions are drawn — neither outlines nor group labels — but the
	// workers and their relationships stay drawn.
	await expect(page.locator(regionOutlines)).toHaveCount(0);
	await expect(page.locator('svg text:text-is("Front of House")')).toHaveCount(0);
	await expect(page.getByRole('button', { name: /, Unassessed, / })).toHaveCount(3);
	await expect(page.locator('svg path[data-tie]')).toHaveCount(2);
});

test('choosing a Category restores region outlines, and None survives a reload', async ({
	page,
	request
}) => {
	const { deptId } = await seedWorksite(request);
	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapInteraction(page);

	await expect.poll(() => page.locator(regionOutlines).count()).toBeGreaterThan(0);

	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await page.getByRole('option').filter({ hasText: 'None' }).click();

	await expect(page).not.toHaveURL(/group=/);
	await openGroupMenu(page);
	await expect(page.getByLabel('Group by', { exact: true })).toHaveText('None');

	await page.reload();
	await waitForMapInteraction(page);

	await expect(page).not.toHaveURL(/group=/);
	await openGroupMenu(page);
	await expect(page.getByLabel('Group by', { exact: true })).toHaveText('None');
	await expect(page.locator(regionOutlines)).toHaveCount(0);

	// Picking a Category again writes its id back and restores the regions.
	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await page.getByRole('option', { name: 'Department' }).click();

	await expect(page).toHaveURL(new RegExp(`group=${deptId}`));
	await expect.poll(() => page.locator(regionOutlines).count()).toBeGreaterThan(0);
});

test('grouped map draws each cross-group tie heavier, at the width its flag sets', async ({
	page,
	request
}) => {
	const { deptId } = await seedWorksite(request);
	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapInteraction(page);
	await expect(page.locator('path[data-tie="cross"]')).toHaveCount(1);
	// Which ties are cross is unit-tested (graph-cross-ties.spec.ts); this checks the drawn widths follow it.
	const ties = await page.locator('path[data-tie]').evaluateAll((paths) =>
		paths.map((path) => ({
			kind: path.getAttribute('data-tie'),
			width: path.getAttribute('stroke-width')
		}))
	);
	expect(ties.length).toBeGreaterThan(1);
	for (const tie of ties)
		expect(tie.width, tie.kind ?? 'tie').toBe(tie.kind === 'cross' ? '2' : '1');
});

for (const nested of [false, true]) {
	test(`a settled ${nested ? 'nested ' : ''}bridge faces its actual partner and selection keeps that placement`, async ({
		page,
		request
	}) => {
		const { deptId, roleId, workerIds } = await seedWorksite(request);
		await page.goto(`/mapping?group=${deptId}${nested ? `&sub=${roleId}` : ''}`);
		await waitForMapInteraction(page);
		const centres = async () =>
			Promise.all(
				workerIds.map(async (id) => {
					const box = (await page.locator(`circle[data-hit-for="${id}"]`).boundingBox())!;
					return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
				})
			);
		await expect(page.locator('svg g[role="button"][data-node-id]')).toHaveCount(3);
		const before = await centres();
		const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
			Math.hypot(a.x - b.x, a.y - b.y);
		expect(distance(before[0], before[2])).toBeLessThan(distance(before[1], before[2]));
		await page.getByRole('button', { name: /^Ada, / }).click();
		await expect(page.locator('path[data-tie="cross"]')).toHaveCount(1);
		expect(await centres()).toEqual(before);
	});
}

test('dragging a sub-group label preserves all nested offsets and moves its parent', async ({
	page,
	request
}) => {
	const { deptId, roleId, workerIds } = await seedWorksite(request);
	await page.setViewportSize({ width: 1400, height: 800 });
	await page.goto(`/mapping?group=${deptId}&sub=${roleId}`);
	await waitForMapInteraction(page);
	const centre = async (id: string) => {
		const box = (await page.locator(`circle[data-hit-for="${id}"]`).boundingBox())!;
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	};
	await expect(page.locator('svg g[role="button"][data-node-id]')).toHaveCount(3);
	const before = await Promise.all(workerIds.map(centre));
	const grab = await page
		.locator(
			`[data-region-label="${answerId(deptId, 'Front of House')}::${answerId(roleId, 'Server')}"]`
		)
		.first()
		.evaluate((el) => {
			const box = el.getBoundingClientRect();
			return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		});
	await page.mouse.move(grab.x, grab.y);
	await page.mouse.down();
	await page.mouse.move(grab.x + 50, grab.y + 20, { steps: 8 });
	await page.mouse.up();
	const after = await settled(() => Promise.all(workerIds.map(centre)));
	expect(after[0].x - before[0].x).toBeGreaterThan(20);
	expect(after[0].x - after[1].x).toBeCloseTo(before[0].x - before[1].x, 1);
	expect(after[0].y - after[1].y).toBeCloseTo(before[0].y - before[1].y, 1);
});

test('the stored layout choice survives None and a re-picked Category', async ({
	page,
	request
}) => {
	const { deptId } = await seedWorksite(request);
	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapInteraction(page);

	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await page.getByRole('option').filter({ hasText: 'None' }).click();

	await expect(page).not.toHaveURL(/group=/);

	// None takes away the grouping controls only: the Assessment color key and
	// the map's search and filter controls stay available.
	await expect(page.getByRole('group', { name: 'Assessment color key' })).toBeVisible();
	await expect(page.getByLabel('Find a worker')).toBeVisible();
	// The filter controls sit behind the control strip's Filter button, closed
	// until an organizer asks for it. Opening it is what this assertion means.
	await page.getByRole('button', { name: /^Filter/ }).click();
	await expect(page.getByRole('button', { name: 'Reset all' })).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Reset all' })).toBeHidden();
	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await page.getByRole('option', { name: 'Department' }).click();

	// A legacy Force link still opens. Force is retired, so it renders as the one
	// remaining grouping layout — grouped — while the stored choice stays in the
	// address untouched until the organizer changes something.
	await page.goto(`/mapping?group=${deptId}&layout=free`);
	await waitForMapInteraction(page);
	await expect(page).toHaveURL(/layout=free/);

	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await page.getByRole('option').filter({ hasText: 'None' }).click();

	await expect(page).toHaveURL(/layout=free/);

	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await page.getByRole('option', { name: 'Department' }).click();

	await expect(page).toHaveURL(/layout=free/);
});

test('None drops the Grouping regions and frames the map as one ungrouped body', async ({
	page,
	request
}) => {
	const { deptId } = await seedWorkersWithoutRelationships(request);

	// Two Categories give the grouped map a region per Category.
	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapInteraction(page);
	await expect.poll(() => page.locator(regionOutlines).count()).toBeGreaterThan(0);

	// Choose None: the same Workers stay drawn, but nothing is grouped, so no
	// region is outlined and the map is one stress-laid body.
	await page.goto('/mapping');
	await page.reload();
	await waitForMapInteraction(page);

	await expect(page.locator('svg g[role="button"]')).toHaveCount(4);
	await expect(page.locator(regionOutlines)).toHaveCount(0);

	// That body is framed inside the canvas instead of running onto the
	// per-Category anchors a grouped map would spread it across.
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const layer = document.querySelector('g[data-testid="relationship-map-layer"]');
					if (!(layer instanceof SVGGraphicsElement)) return undefined;
					const surface = layer.ownerSVGElement;
					if (!surface) return undefined;

					const map = layer.getBoundingClientRect();
					const canvas = surface.getBoundingClientRect();

					return (
						map.left >= canvas.left - 1 &&
						map.top >= canvas.top - 1 &&
						map.right <= canvas.right + 1 &&
						map.bottom <= canvas.bottom + 1
					);
				}),
			{ timeout: 10_000 }
		)
		.toBe(true);
});

test('the grouped Category view frames everything on the first screen', async ({
	page,
	request
}) => {
	const { deptId } = await seedWideCategory(request);

	// The floor viewport leaves the smallest canvas the surface must fit, so a
	// grouped map that reaches past it is at its most visible here.
	await page.setViewportSize({ width: 1024, height: 640 });
	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapInteraction(page);

	await expect.poll(() => page.locator('g[role="button"]').count()).toBe(36);
	await expect.poll(() => page.locator(regionOutlines).count()).toBeGreaterThan(0);

	// First-frame framing is asynchronous, so poll until the fit has settled rather
	// than reading the bounds once and racing the animation.
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const layer = document.querySelector('g[data-testid="relationship-map-layer"]');
					if (!(layer instanceof SVGGraphicsElement)) return undefined;
					const surface = layer.ownerSVGElement;
					if (!surface) return undefined;

					const map = layer.getBoundingClientRect();
					const canvas = surface.getBoundingClientRect();

					return {
						inside:
							map.left >= canvas.left - 1 &&
							map.top >= canvas.top - 1 &&
							map.right <= canvas.right + 1 &&
							map.bottom <= canvas.bottom + 1,
						map: {
							l: Math.round(map.left),
							t: Math.round(map.top),
							r: Math.round(map.right),
							b: Math.round(map.bottom)
						},
						canvas: {
							l: Math.round(canvas.left),
							t: Math.round(canvas.top),
							r: Math.round(canvas.right),
							b: Math.round(canvas.bottom)
						}
					};
				}),
			{ timeout: 10_000 }
		)
		.toMatchObject({ inside: true });
});

test('grouped region labels carry no assessment bar and keep their worker count', async ({
	page,
	request
}) => {
	const { deptId } = await seedWorksite(request);
	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapInteraction(page);
	await expect.poll(() => page.locator('text[data-region-label]').count()).toBeGreaterThan(0);
	await expect(page.locator('[data-region-mix]')).toHaveCount(0);
	await expect(page.locator('text[data-region-label]').first()).toContainText('·');
});

test('grouped labels clear the chrome and the regions fill the free canvas', async ({
	page,
	request
}) => {
	const { deptId } = await seedWideCategory(request);
	await page.setViewportSize({ width: 1024, height: 640 });
	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapInteraction(page);
	await expect.poll(() => page.locator('text[data-region-label]').count()).toBeGreaterThan(0);
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const surface = document.querySelector('[role="application"]')?.getBoundingClientRect();
					const strip = document
						.querySelector('[data-testid="mapping-control-strip"]')
						?.getBoundingClientRect();
					const bar = document
						.querySelector('[data-testid="mapping-bottom-bar"]')
						?.getBoundingClientRect();
					const layer = document.querySelector('g[data-testid="relationship-map-layer"]');
					if (!surface || !strip || !bar || !(layer instanceof SVGGraphicsElement))
						return undefined;
					const map = layer.getBoundingClientRect();
					const labels = [...document.querySelectorAll('text[data-region-label]')].map((label) =>
						label.getBoundingClientRect()
					);
					const freeHeight = bar.top - strip.bottom;
					return {
						labelsClear: labels.every(
							(label) =>
								label.top >= strip.bottom &&
								// The key floats over the bottom-left corner only: a label clears it
								// by not touching its box, wherever else on the canvas it sits.
								(label.bottom <= bar.top || label.right <= bar.left || label.left >= bar.right)
						),
						fills: map.width >= surface.width * 0.85 || map.height >= freeHeight * 0.85,
						count: labels.length
					};
				}),
			{ timeout: 10_000 }
		)
		.toMatchObject({ labelsClear: true, fills: true });
});

test('Isolate keeps the neighbourhood shape, and survives choosing None', async ({
	page,
	request
}) => {
	const { deptId, workerIds } = await seedWorksite(request);

	// Ada is the selected Worker, with Grace and Lin related to her.
	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapInteraction(page);
	await selectOnMap(page, workerIds[0]);

	const isolate = page.getByTestId('relationship-map-canvas').getByRole('button', {
		name: 'Isolate'
	});
	await expect(isolate).toHaveAttribute('aria-pressed', 'false');
	const before = await workerOffsetsFromSelection(page);
	expect(before).toHaveLength(3);

	await isolate.click();
	await expect(isolate).toHaveAttribute('aria-pressed', 'true');
	await expect(page).toHaveURL(/iso=1/);
	await expect(page).not.toHaveURL(/layout=/);

	// Isolate spreads the neighbourhood and the camera rescales, but the shape it
	// had on the whole map is the shape it keeps: compare the offsets with their
	// scale divided out.
	const isolated = await workerOffsetsFromSelection(page);
	expect(isolated).toHaveLength(3);
	expect(maxDrift(unit(before), unit(isolated))).toBeLessThan(shapeTolerance);

	// Choosing None drops the grouping; Isolate is a focus, not a layout, so it stays.
	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await page.getByRole('option').filter({ hasText: 'None' }).click();

	await expect(page).not.toHaveURL(/group=/);
	await expect(page).toHaveURL(/iso=1/);
	await expect(isolate).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('svg g[role="button"]')).toHaveCount(3);
});

test('Isolate spreads a small neighbourhood, and gives the whole map back', async ({
	page,
	request
}) => {
	const { hubId } = await seedSmallNeighbourhood(request);

	// A hub with two spokes in a worksite of eighteen: the neighbourhood is a tiny
	// part of a map that fills the canvas.
	await page.goto('/mapping');
	await waitForMapInteraction(page);
	await selectOnMap(page, hubId);
	await expect(page.locator('svg g[role="button"]')).toHaveCount(18);

	// Measured at 1×, so a change in size is Isolate's fit and not the camera's.
	await page.getByRole('button', { name: 'Reset zoom' }).click();
	const before = await workerOffsetsFromSelection(page);
	const radiusBefore = await radiusOf(page, 'W01');

	const isolate = page
		.getByTestId('relationship-map-canvas')
		.getByRole('button', { name: 'Isolate' });
	await isolate.click();
	await expect(page.locator('svg g[role="button"]')).toHaveCount(3);

	// The neighbourhood is spread to fill the free canvas, and its dot is drawn larger.
	// The growth and the spread are unit-tested in map-view-model.spec.ts.
	await expect
		.poll(() => radiusOf(page, 'W01'), { message: 'Isolate draws the dot larger' })
		.toBeGreaterThan(radiusBefore);

	// Leaving Isolate gives the whole map back, with the arrangement it had and the
	// base dot radius.
	await isolate.click();
	await expect(page.locator('svg g[role="button"]')).toHaveCount(18);
	await expect
		.poll(() => radiusOf(page, 'W01'), { message: 'the dot returns to its base radius' })
		.toBeCloseTo(radiusBefore, 3);
	const restored = await workerOffsetsFromSelection(page);
	expect(maxDrift(unit(before), unit(restored))).toBeLessThan(shapeTolerance);
});

test('None clears and disables Sub-group by, and a Category re-enables it', async ({
	page,
	request
}) => {
	const { deptId, roleId } = await seedWorksite(request);
	await page.goto(`/mapping?group=${deptId}&sub=${roleId}`);
	await waitForMapInteraction(page);

	await openGroupMenu(page);
	const subGroup = page.locator('#map-sub-group-by');
	await expect(subGroup).toHaveText('Role');

	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await page.getByRole('option').filter({ hasText: 'None' }).click();

	// Choosing None is clear-and-forget: the sub-grouping and its URL parameter go.
	await expect(page).not.toHaveURL(/sub=/);
	await expect(page).not.toHaveURL(/group=/);

	// A second, nested partition needs a primary group, so the control stays
	// visible but is disabled — the native `disabled` state that assistive
	// technology announces.
	await expect(subGroup).toBeVisible();
	await expect(subGroup).toHaveText('None');
	await expect(subGroup).toBeDisabled();

	// Picking a Category again re-enables it, offering the remaining Category.
	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await page.getByRole('option', { name: 'Department' }).click();

	await expect(subGroup).toBeEnabled();

	await subGroup.click();
	await expect(page.getByRole('option')).toHaveText(['None', 'Role']);
});

test('no Sub-group by control is shown with fewer than two Categories', async ({
	page,
	request
}) => {
	const { deptId } = await seedWorkersWithoutRelationships(request);
	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapInteraction(page);

	await openGroupMenu(page);
	await expect(page.getByLabel('Group by', { exact: true })).toHaveText('Department');
	await expect(page.locator('#map-sub-group-by')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: /^Group(:|$)/ })).toHaveText('Group: Department');
});

test('"Reset all" returns a grouped Mapping to ungrouped', async ({ page, request }) => {
	const { deptId, roleId } = await seedWorksite(request);
	await page.goto(`/mapping?group=${deptId}&sub=${roleId}`);
	await waitForMapInteraction(page);

	await openGroupMenu(page);
	await expect(page.getByLabel('Group by', { exact: true })).toHaveText('Department');

	await page.getByRole('button', { name: /^Filter/ }).click();
	await page.getByRole('button', { name: 'Reset all' }).click();

	await expect(page).not.toHaveURL(/group=/);
	await expect(page).not.toHaveURL(/sub=/);
	await openGroupMenu(page);
	await expect(page.getByLabel('Group by', { exact: true })).toHaveText('None');
	await expect(page.locator(regionOutlines)).toHaveCount(0);
});

test('Group by offers None and every Attribute, including a Multi-Select Tag', async ({
	page,
	request
}) => {
	await seedWorksiteWithATag(request);
	await page.goto('/mapping');
	await waitForMapInteraction(page);

	await openGroupMenu(page);
	await page.getByLabel('Group by', { exact: true }).click();

	// None first, then every Attribute: a Multi-Select Tag may group whenever its
	// selections resolve to one displayed region per Worker, so it is offered too.
	await expect(page.getByRole('option')).toHaveText([
		'None',
		'Department',
		'Role',
		'Certifications'
	]);
});

test('the Isolate focus ghosts the second degree and removes the rest', async ({
	page,
	request
}) => {
	const { workerIds } = await seedRelationshipChain(request);

	// Ada is the focus: Bo is one hop out, Cy two, and Di three — off the map.
	await page.goto('/mapping?layout=isolated');
	await waitForMapInteraction(page);
	await selectOnMap(page, workerIds[0]);
	await page
		.getByTestId('relationship-map-canvas')
		.getByRole('button', { name: 'Isolate' })
		.click();

	await expect(
		page.getByTestId('relationship-map-canvas').getByRole('button', { name: 'Isolate' })
	).toHaveAttribute('aria-pressed', 'true');

	// The Fade/Remove control is gone: neither of its toggle items remains.
	await expect(page.getByRole('radio', { name: /outside the Isolated view/ })).toHaveCount(0);

	const ada = page.getByRole('button', { name: /^Ada, / });
	const bo = page.getByRole('button', { name: /^Bo, / });
	const cy = page.getByRole('button', { name: /^Cy, / });

	// The focus, its neighbour, and the ghosted second degree are drawn; the third
	// hop is off the map.
	await expect(page.locator('svg g[role="button"]')).toHaveCount(3);
	await expect(page.getByRole('button', { name: /^Di, / })).toHaveCount(0);

	// The neighbourhood's own Relationships are drawn with it: Ada—Bo, and the
	// faded Bo—Cy that says how Cy is reached. Cy's tie to Di is off the map with
	// Di, and two second-degree workers are never wired to each other.
	const drawnTies = page.locator('svg path[data-tie]');
	await expect(drawnTies).toHaveCount(2);
	// The drawn stop is read as the browser resolves it, not as an attribute: the
	// tie's styling is free to move between the two without the reading changing.
	const tieOpacity = await drawnTies.evaluateAll((paths) =>
		paths.map((path) => Number(getComputedStyle(path).strokeOpacity))
	);
	expect(Math.max(...tieOpacity)).toBeGreaterThan(Math.min(...tieOpacity));

	// Rank, not exact stops: the selected Worker outranks its neighbour, and the
	// second degree sits below both.
	const restingGhost = Number(await cy.getAttribute('opacity'));
	expect(restingGhost).toBeLessThan(Number(await bo.getAttribute('opacity')));
	expect(restingGhost).toBeLessThan(Number(await ada.getAttribute('opacity')));

	// Pointing at the ghosted Worker lifts it above its resting stop.
	await cy.hover();
	await expect
		.poll(async () => Number(await cy.getAttribute('opacity')))
		.toBeGreaterThan(restingGhost);

	// A link carrying the removed mode still opens the fixed reading, and the
	// stale parameter survives load — the address is not rewritten on load.
	await page.goto('/mapping?layout=isolated&fm=hide');
	await waitForMapInteraction(page);
	await selectOnMap(page, workerIds[0]);
	await expect(page).toHaveURL(/fm=hide/);
	await page
		.getByTestId('relationship-map-canvas')
		.getByRole('button', { name: 'Isolate' })
		.click();
	await expect(page.locator('svg g[role="button"]')).toHaveCount(3);

	// Escape clears the selection, which ends Isolate and draws everyone again.
	await page.getByRole('button', { name: /^Ada, / }).focus();
	await page.keyboard.press('Escape');
	await expect(page.locator('svg g[role="button"]')).toHaveCount(4);
	await expect(page).not.toHaveURL(/iso=|sel=/);

	// Isolating again from the selection works from the toggle.
	await page.goto('/mapping');
	await waitForMapInteraction(page);
	await selectOnMap(page, workerIds[0]);
	await expect(page.locator('svg g[role="button"]')).toHaveCount(4);
	await page
		.getByTestId('relationship-map-canvas')
		.getByRole('button', { name: 'Isolate' })
		.click();
	await expect(page.locator('svg g[role="button"]')).toHaveCount(3);
	await page.goto('/mapping?layout=isolated&fm=hide');
	await waitForMapInteraction(page);
	await selectOnMap(page, workerIds[0]);
	await page
		.getByTestId('relationship-map-canvas')
		.getByRole('button', { name: 'Isolate' })
		.click();

	// The next write drops the stale parameter from the address.
	await page
		.getByTestId('relationship-map-canvas')
		.getByRole('button', { name: 'Isolate' })
		.click();
	await expect(page).not.toHaveURL(/fm=/);
});

/** Ada—Bo, with Bo tied to Cy and Di, and a Cy—Di tie joining the two-second-degree pair. */
async function seedSecondDegreeTie(request: APIRequestContext) {
	const deptId = testId();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: ['Front of House'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const names = ['Ada', 'Bo', 'Cy', 'Di'];
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

	// One update per Worker that gains relationships, so each write does not
	// clobber a pair another write already stored.
	const wiring: [number, string[]][] = [
		[0, [workerIds[1]]],
		[1, [workerIds[0], workerIds[2], workerIds[3]]],
		[2, [workerIds[1], workerIds[3]]],
		[3, [workerIds[1], workerIds[2]]]
	];

	for (const [index, relationships] of wiring) {
		const updated = await request.put(`/api/workers/${workerIds[index]}`, {
			data: {
				name: names[index],
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes,
				agitations: [],
				languages: [],
				relationships,
				notes: []
			}
		});
		expect(updated.ok()).toBeTruthy();
	}

	return { workerIds };
}

test('Isolate leaves two second-degree workers unwired', async ({ page, request }) => {
	const { workerIds } = await seedSecondDegreeTie(request);

	// Ada is the focus: Bo is one Relationship out, and Cy and Di are two — as
	// well as being related to each other.
	await page.goto('/mapping');
	await waitForMapInteraction(page);
	await selectOnMap(page, workerIds[0]);
	await expect(page.locator('svg g[role="button"]')).toHaveCount(4);
	await expect(page.locator('svg path[data-tie]')).toHaveCount(4);

	await page
		.getByTestId('relationship-map-canvas')
		.getByRole('button', { name: 'Isolate' })
		.click();

	// Everyone is still in the neighbourhood, but the Cy—Di tie lies at the rim of
	// it rather than a way through it, so the map draws three ties and not four.
	await expect(page.locator('svg g[role="button"]')).toHaveCount(4);
	await expect(page.locator('svg path[data-tie]')).toHaveCount(3);
});

async function seedAssessed(request: APIRequestContext) {
	const deptId = testId();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: ['Front of House'] }
		])
	});
	expect(configured.ok()).toBeTruthy();
	const ids: Record<string, string> = {};
	for (const [name, assessment] of [
		['Hank', 'Hostile'],
		['Sue', 'Supporter']
	]) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment,
				attributes: wireWorkerAttributes({ [deptId]: 'Front of House' }),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
		ids[name] = (await created.json()).worker.id;
	}
	return ids;
}

test('the Hostile key button hides and restores Hostile workers', async ({ page, request }) => {
	await seedAssessed(request);
	await page.goto('/mapping');
	await waitForMapInteraction(page);

	const hank = page.getByRole('button', { name: /^Hank, Hostile/ });
	await expect(hank).toBeAttached();

	const key = page
		.getByRole('group', { name: 'Assessment color key' })
		.getByRole('button', { name: /^Hostile,/ });
	await key.click();
	await expect(key).toHaveAttribute('aria-pressed', 'false');
	await expect(hank).toHaveCount(0);

	await key.click();
	await expect(key).toHaveAttribute('aria-pressed', 'true');
	await expect(hank).toBeAttached();
});

test('Clear filters in the Filter panel offers Undo, and Undo restores the filter', async ({
	page,
	request
}) => {
	await seedAssessed(request);
	await page.goto('/mapping');
	await waitForMapInteraction(page);

	const hank = page.getByRole('button', { name: /^Hank, Hostile/ });
	const key = page
		.getByRole('group', { name: 'Assessment color key' })
		.getByRole('button', { name: /^Hostile,/ });
	await key.click();
	await expect(hank).toHaveCount(0);

	await page.getByRole('button', { name: /^Filter/ }).click();
	await page.getByRole('button', { name: 'Clear filters' }).click();
	await expect(hank).toBeAttached();

	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(hank).toHaveCount(0);
	await expect(key).toHaveAttribute('aria-pressed', 'false');
});

test("the empty map's Clear filters button is reachable above the drawing", async ({
	page,
	request
}) => {
	await seedAssessed(request);
	await page.goto('/mapping');
	await waitForMapInteraction(page);

	const hank = page.getByRole('button', { name: /^Hank, Hostile/ });
	const keys = page.getByRole('group', { name: 'Assessment color key' });
	for (const assessment of [
		'Leader',
		'Activist',
		'Supporter',
		'Disengaged',
		'Hostile',
		'Unassessed'
	]) {
		await keys.getByRole('button', { name: new RegExp(`^${assessment},`) }).click();
	}
	await expect(page.getByText('No workers match the current filters.')).toBeVisible();

	const clear = page.getByRole('button', { name: 'Clear filters' });
	await expect(clear).toBeVisible();
	const hitTarget = await clear.evaluate((button) => {
		const { x, y, width, height } = button.getBoundingClientRect();
		const hit = document.elementFromPoint(x + width / 2, y + height / 2);
		return hit === button || button.contains(hit);
	});
	expect(hitTarget).toBe(true);

	await clear.click();
	await expect(page.getByText('No workers match the current filters.')).toHaveCount(0);
	await expect(hank).toBeAttached();
});

test('Open in Workers carries the selected worker to the inspector', async ({ page, request }) => {
	const ids = await seedAssessed(request);
	await page.goto('/mapping');
	await waitForMapInteraction(page);
	await selectOnMap(page, ids.Sue);

	await page.getByRole('link', { name: 'Open in Workers' }).click();
	await expect(page).toHaveURL(/\/workers$/);
	await expect(page.getByRole('complementary', { name: 'Worker details: Sue' })).toBeVisible();
});
test.describe('E6 folds product-gap-03 mapping reading', () => {
	type Seeded = {
		departmentId: string;
		rolesId: string;
		workerIds: Record<string, string>;
	};

	async function seedFixture(request: APIRequestContext): Promise<Seeded> {
		const suffix = testId().slice(0, 8);
		const departmentId = `department-${suffix}`;
		const rolesId = `roles-${suffix}`;

		const configured = await request.put('/api/attributes', {
			data: wireDefinitions([
				{
					id: departmentId,
					name: 'Department',
					kind: 'category',
					options: ['Packing', 'Delivery', 'No Department']
				},
				{ id: rolesId, name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
			])
		});
		expect(configured.ok(), await configured.text()).toBeTruthy();

		const people = [
			{ name: 'Alex', assessment: 'Leader', department: 'Packing', roles: ['Trainer'] },
			{
				name: 'Blair',
				assessment: 'Supporter',
				department: 'Delivery',
				roles: ['Trainer', 'Steward']
			},
			{ name: 'Casey', assessment: 'Unassessed', department: '', roles: [] },
			{ name: 'Drew', assessment: 'Activist', department: 'No Department', roles: [] }
		] as const;

		const workerIds: Record<string, string> = {};
		for (const person of people) {
			const created = await request.post('/api/workers', {
				data: {
					name: person.name,
					email: '',
					phone: '',
					assessment: person.assessment,
					attributes: wireWorkerAttributes({
						[departmentId]: person.department,
						[rolesId]: person.roles
					}),
					agitations: [],
					languages: [],
					relationships: [],
					notes: []
				}
			});
			expect(created.status(), await created.text()).toBe(201);
			workerIds[person.name] = ((await created.json()) as { worker: { id: string } }).worker.id;
		}

		// The fixture's two Relationships, written after every Worker exists.
		await putWorker(request, workerIds.Alex, {
			name: 'Alex',
			assessment: 'Leader',
			attributes: wireWorkerAttributes({ [departmentId]: 'Packing', [rolesId]: ['Trainer'] }),
			relationships: [workerIds.Blair]
		});
		await putWorker(request, workerIds.Blair, {
			name: 'Blair',
			assessment: 'Supporter',
			attributes: wireWorkerAttributes({
				[departmentId]: 'Delivery',
				[rolesId]: ['Trainer', 'Steward']
			}),
			relationships: [workerIds.Alex, workerIds.Casey]
		});

		return { departmentId, rolesId, workerIds };
	}

	/** Replaces one Worker's record; the fixture only needs Relationships to change. */
	async function putWorker(
		request: APIRequestContext,
		id: string,
		worker: {
			name: string;
			assessment: string;
			attributes: Record<string, string | string[]>;
			relationships: string[];
		}
	): Promise<void> {
		const updated = await request.put(`/api/workers/${id}`, {
			data: {
				name: worker.name,
				email: '',
				phone: '',
				assessment: worker.assessment,
				attributes: worker.attributes,
				agitations: [],
				languages: [],
				relationships: worker.relationships,
				notes: []
			}
		});
		expect(updated.ok(), await updated.text()).toBeTruthy();
	}

	/** Renames the Attribute while keeping every answer id, then reloads the view. */
	async function renameDepartmentToTeam(
		request: APIRequestContext,
		page: Page,
		seeded: Seeded,
		path: string
	): Promise<void> {
		const renamed = await request.put('/api/attributes', {
			data: wireDefinitions([
				{
					id: seeded.departmentId,
					name: 'Team',
					kind: 'category',
					options: ['Packing', 'Delivery', 'No Department']
				},
				{ id: seeded.rolesId, name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
			])
		});
		expect(renamed.ok(), await renamed.text()).toBeTruthy();
		await page.goto(path);
		await appReady(page);
	}

	/** The text or accessible name a map region label carries at full length. */
	function regionReading(page: Page, key: string): Promise<string> {
		return page
			.locator(`[data-region-label="${key}"]`)
			.evaluate((label) => label.getAttribute('aria-label') ?? label.textContent ?? '');
	}
	test('@product-gap-03 Mapping labels the system region and its table row by the same rule', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		const grouping = `/mapping?group=${seeded.departmentId}`;
		await page.goto(grouping);
		await waitForMapReady(page);

		// The visual region for no answer reads No Department and, because a real answer
		// collides with it, carries the secondary description; the real answer does not.
		expect(await regionReading(page, '__unassigned')).toContain('No Department (No selection)');
		expect(await regionReading(page, answerId(seeded.departmentId, 'No Department'))).toContain(
			'No Department'
		);

		// The assistive table names the same region, and only the system reading carries
		// the collision's secondary description.
		const caseyRow = page.locator('[data-map-table-row]').filter({ hasText: 'Casey' });
		await expect(caseyRow).toBeAttached();
		await expect(caseyRow.getByRole('cell', { name: /No Department/ })).toContainText(
			'No selection'
		);
		const drewRow = page.locator('[data-map-table-row]').filter({ hasText: 'Drew' });
		await expect(drewRow.getByRole('cell', { name: 'No Department', exact: true })).toBeAttached();
		await expect(drewRow).not.toContainText('No selection');

		// A rename moves both fallbacks together.
		await renameDepartmentToTeam(request, page, seeded, grouping);
		await waitForMapReady(page);
		expect(await regionReading(page, '__unassigned')).toContain('No Team');
		expect(await regionReading(page, answerId(seeded.departmentId, 'No Department'))).toContain(
			'No Department'
		);
		const renamedCasey = page.locator('[data-map-table-row]').filter({ hasText: 'Casey' });
		await expect(renamedCasey.getByRole('cell', { name: /No Team/ })).toBeAttached();
		await expect(renamedCasey).not.toContainText('No selection');
	});
});
