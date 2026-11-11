/**
 * The Mapping drawing contract, on captured datasets so every identity is fixed.
 *
 * An automatic arrangement is made once per scene (data, filters, grouping, hierarchy).
 * Afterwards the camera moves the view, a drag moves exactly what it grabs, and nothing
 * is searched again. Readiness is the surface's scene and manual revisions, never two
 * equal samples.
 */
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { waitForMapInteraction, waitForSceneReady } from './map.ts';
import { selectOnMap } from './person.ts';
import { clippedNames, readNames } from './mapping-name-framing.ts';
import free from './fixtures/mapping-reset-zoom-free.json' with { type: 'json' };
import subgrouped from './fixtures/mapping-reset-zoom-subgrouped.json' with { type: 'json' };
import { randomUUID } from 'node:crypto';
import { settled, waitForMapReady } from './map.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

test.use({ reducedMotion: 'reduce' });

/** A captured scene: the structure `open` reads, shared by every fixture file. */
type Fixture = {
	url: string;
	viewport: { width: number; height: number };
	dataset: unknown;
};
type Xy = { x: number; y: number };
type Reading = {
	scene: string;
	manual: string;
	solves: number;
	camera: number;
	report: string | null;
	frozen: boolean;
	scale: number;
	dots: Record<string, Xy>;
	names: Record<string, Xy & { anchor: string }>;
	ties: Record<string, string>;
	headings: Record<string, Xy>;
};

const surface = (page: Page) => page.getByTestId('relationship-map-surface');
const zoomIn = (page: Page) => page.getByRole('button', { name: 'Zoom in', exact: true });
const reset = (page: Page) => page.getByRole('button', { name: 'Reset zoom', exact: true });

async function open(
	page: Page,
	fixture: Fixture,
	url = fixture.url,
	viewport = fixture.viewport,
	motion: 'reduce' | 'no-preference' = 'reduce'
) {
	await page.route('**/api/dataset', (route) => route.fulfill({ json: fixture.dataset }));
	await page.setViewportSize(viewport);
	await page.emulateMedia({ colorScheme: 'light', reducedMotion: motion });
	await page.goto(url);
	await waitForMapInteraction(page);
	await waitForSceneReady(page);
}

/** Everything drawn, in map units, plus the revisions that say which arrangement it is. */
function read(page: Page): Promise<Reading> {
	return page.evaluate(async () => {
		// A camera written this task can still read back stale from the screen matrix.
		await new Promise<void>((done) =>
			requestAnimationFrame(() => requestAnimationFrame(() => done()))
		);
		const root = document.querySelector<HTMLElement>('[data-testid="relationship-map-surface"]')!;
		const layer = root.querySelector<SVGGElement>('[data-testid="relationship-map-layer"]')!;
		const at = (x: string | null, y: string | null) => ({ x: Number(x), y: Number(y) });
		return {
			scene: root.dataset.sceneRevision ?? '',
			manual: root.dataset.manualRevision ?? '',
			solves: Number(root.dataset.layoutSolves),
			camera: Number(root.dataset.cameraRevision),
			report: root.getAttribute('data-composition-report'),
			frozen: root.dataset.namesFrozen === 'true',
			scale: layer.getScreenCTM()!.a,
			dots: Object.fromEntries(
				[...root.querySelectorAll('circle[data-hit-for]')].map((c) => [
					c.getAttribute('data-hit-for')!,
					at(c.getAttribute('cx'), c.getAttribute('cy'))
				])
			),
			names: Object.fromEntries(
				[...root.querySelectorAll('text[data-node-label]')].map((t) => [
					t.getAttribute('data-node-label')!,
					{
						...at(t.getAttribute('x'), t.getAttribute('y')),
						anchor: t.getAttribute('text-anchor')!
					}
				])
			),
			ties: Object.fromEntries(
				[...root.querySelectorAll('path[data-tie-id]')].map((p) => [
					p.getAttribute('data-tie-id')!,
					p.getAttribute('d')!
				])
			),
			headings: Object.fromEntries(
				[...root.querySelectorAll('text[data-region-label]')].map((t) => [
					t.getAttribute('data-region-label')!,
					at(t.getAttribute('x'), t.getAttribute('y'))
				])
			)
		};
	});
}

const screenCentre = async (page: Page, selector: string) => {
	const box = (await page.locator(selector).first().boundingBox())!;
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

async function dragFrom(page: Page, from: Xy, by: Xy) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 8 });
	await page.mouse.up();
}

/** Moves the pointer off the map, so a hover (and its spotlight on the neighbourhood) ends. */
async function pointerAway(page: Page) {
	await page.mouse.move(1, 1);
}

/** Which side of its dot a name stands, and how it is anchored: what a zoom must not change. */
const side = (r: Reading, id: string) => ({
	x: Math.sign(r.names[id].x - r.dots[id].x),
	y: Math.sign(r.names[id].y - r.dots[id].y),
	anchor: r.names[id].anchor
});

function expectSameDots(after: Reading, before: Reading, except: ReadonlySet<string> = new Set()) {
	for (const [id, point] of Object.entries(before.dots)) {
		if (except.has(id)) continue;
		expect(after.dots[id], `dot ${id}`).toEqual(point);
	}
}

test('Free: the first drawing is frozen, clear of the edges, and hover or selection moves nothing', async ({
	page
}) => {
	await open(page, free);
	const before = await read(page);
	expect(clippedNames(await readNames(page))).toEqual([]);
	expect(Object.keys(before.names).length).toBeGreaterThan(0);

	const unnamed = Object.keys(before.dots).find((id) => !(id in before.names))!;
	expect(unnamed, 'a Worker without a standing name').toBeDefined();
	await page.locator(`circle[data-hit-for="${unnamed}"]`).hover();
	await expect(page.locator(`text[data-node-label="${unnamed}"]`)).toHaveCount(1);
	// Hover spotlights the neighbourhood, so names outside it leave; those that stay do not move.
	const hovered = await read(page);
	expect(hovered.names[unnamed]).toBeDefined();
	for (const [id, name] of Object.entries(hovered.names)) {
		if (id !== unnamed) expect(name, `name ${id}`).toEqual(before.names[id]);
	}
	expectSameDots(hovered, before);
	await pointerAway(page);
	await expect(page.locator(`text[data-node-label="${unnamed}"]`)).toHaveCount(0);
	expect((await read(page)).names).toEqual(before.names);

	await page.locator(`circle[data-hit-for="${unnamed}"]`).click();
	await expect(page.locator(`g[data-node-id="${unnamed}"]`)).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	const selected = await read(page);
	// Opening the card refits the camera, so a name keeps its side rather than its map offset.
	for (const id of Object.keys(selected.names)) {
		if (id !== unnamed) expect(side(selected, id), `name ${id}`).toEqual(side(before, id));
	}
	expectSameDots(selected, before);
	expect(selected.scene).toBe(before.scene);
	expect(selected.manual).toBe(before.manual);
});

test('Free: zoom, pan and Reset change the camera only', async ({ page }) => {
	await open(page, free);
	const before = await read(page);
	await zoomIn(page).click();
	await zoomIn(page).click();
	await expect.poll(async () => (await read(page)).scale).toBeGreaterThan(before.scale * 1.2);
	await surface(page).focus();
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowDown');

	const moved = await read(page);
	expect(moved.dots).toEqual(before.dots);
	expect(moved.ties).toEqual(before.ties);
	expect(moved.scene).toBe(before.scene);
	expect(moved.solves).toBe(before.solves);
	expect(moved.manual).toBe(before.manual);
	expect(Object.keys(moved.names).sort()).toEqual(Object.keys(before.names).sort());
	for (const id of Object.keys(before.names)) expect(side(moved, id)).toEqual(side(before, id));

	// A ordinary click reaches Reset, which returns to the first framing without a new search.
	await reset(page).click({ timeout: 1500 });
	await expect.poll(async () => (await read(page)).scale).toBeCloseTo(before.scale, 6);
	const back = await read(page);
	expect(back.dots).toEqual(before.dots);
	expect(back.scene).toBe(before.scene);
	expect(clippedNames(await readNames(page))).toEqual([]);
});

test('Free: a dot drag moves that Worker, its name and its tie ends, and Reset or resize keep it there', async ({
	page
}) => {
	await open(page, free);
	const before = await read(page);
	const at = (r: Reading, w: string) => `${r.dots[w].x} ${r.dots[w].y}`;
	const id = Object.keys(before.names).find((worker) =>
		Object.values(before.ties).some((d) => d.includes(at(before, worker)))
	)!;
	const start = await screenCentre(page, `circle[data-hit-for="${id}"]`);
	await dragFrom(page, start, { x: 90, y: 60 });
	await expect(surface(page)).toHaveAttribute('data-manual-revision', '1');

	await pointerAway(page);
	await expect(page.locator('text[data-node-label]')).toHaveCount(Object.keys(before.names).length);
	const after = await read(page);
	expect(after.scene).toBe(before.scene);
	expect(after.solves).toBe(before.solves);
	expect(after.dots[id].x - before.dots[id].x).toBeCloseTo(90 / before.scale, 1);
	expect(after.dots[id].y - before.dots[id].y).toBeCloseTo(60 / before.scale, 1);
	expectSameDots(after, before, new Set([id]));
	expect(after.names[id].x - before.names[id].x).toBeCloseTo(
		after.dots[id].x - before.dots[id].x,
		6
	);
	for (const [other, name] of Object.entries(before.names)) {
		if (other !== id) expect(after.names[other], `name ${other}`).toEqual(name);
	}
	const incident = (tie: string) => tie.includes(at(after, id));
	let attached = 0;
	for (const [tieId, d] of Object.entries(after.ties)) {
		if (incident(d)) attached += 1;
		else expect(d, `tie ${tieId}`).toBe(before.ties[tieId]);
	}
	expect(attached).toBeGreaterThan(0);

	await zoomIn(page).click();
	await page.setViewportSize({ width: 900, height: 1200 });
	// Reset animates the camera home. Read only once that camera has finished, or a slower
	// engine (WebKit) reads the names mid-flight at an in-between scale.
	const cameraBefore = await surface(page).getAttribute('data-camera-revision');
	await reset(page).click({ timeout: 1500 });
	await expect(surface(page)).not.toHaveAttribute('data-camera-revision', cameraBefore ?? '');
	await expect(surface(page)).toHaveAttribute('data-camera-idle', 'true');
	await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
	const resting = await read(page);
	expect(resting.dots).toEqual(after.dots);
	expect(resting.names[id].x - resting.dots[id].x).toBeCloseTo(
		after.names[id].x - after.dots[id].x,
		6
	);
	expect(resting.scene).toBe(before.scene);
	expect(resting.manual).toBe('1');
});

test('Grouped: a group drag translates exactly that group, and nothing else moves', async ({
	page
}) => {
	const groupUrl = subgrouped.url.split('&sub=')[0];
	await open(page, subgrouped, groupUrl);
	const before = await read(page);
	const heading = Object.keys(before.headings)[0];
	const start = await page
		.locator(`text[data-region-label="${heading}"]`)
		.first()
		.evaluate((el) => {
			const r = el.getBoundingClientRect();
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		});
	await dragFrom(page, start, { x: 70, y: 40 });
	await expect(surface(page)).toHaveAttribute('data-manual-revision', '1');

	const after = await read(page);
	expect(after.scene).toBe(before.scene);
	expect(after.solves).toBe(before.solves);
	const dx = 70 / before.scale;
	const dy = 40 / before.scale;
	const moved = Object.keys(before.dots).filter(
		(id) =>
			Math.abs(after.dots[id].x - before.dots[id].x) > 1e-6 ||
			Math.abs(after.dots[id].y - before.dots[id].y) > 1e-6
	);
	expect(moved.length).toBeGreaterThan(0);
	expect(moved.length).toBeLessThan(Object.keys(before.dots).length);
	for (const id of moved) {
		expect(after.dots[id].x - before.dots[id].x).toBeCloseTo(dx, 1);
		expect(after.dots[id].y - before.dots[id].y).toBeCloseTo(dy, 1);
		if (before.names[id]) {
			expect(after.names[id].x - before.names[id].x).toBeCloseTo(
				after.dots[id].x - before.dots[id].x,
				6
			);
		}
	}
	// A group dropped on its neighbour displaces no one: every unmoved dot is exactly where it was.
	expectSameDots(after, before, new Set(moved));
	for (const [id, name] of Object.entries(before.names))
		if (!moved.includes(id)) expect(after.names[id]).toEqual(name);

	await zoomIn(page).click();
	await reset(page).click({ timeout: 1500 });
	await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
	const resting = await read(page);
	expect(resting.dots).toEqual(after.dots);
	expect(resting.manual).toBe('1');
	expect(resting.scene).toBe(before.scene);
});

test('a grouping change makes a new arrangement and drops manual moves; the same data makes the same one', async ({
	page
}) => {
	await open(page, free);
	const before = await read(page);
	const id = Object.keys(before.names)[0];
	await dragFrom(page, await screenCentre(page, `circle[data-hit-for="${id}"]`), { x: 60, y: 40 });
	await expect(surface(page)).toHaveAttribute('data-manual-moves', '1');

	await page.getByRole('button', { name: /^Group(:|$)/ }).click();
	await page.locator('#map-group-by').click();
	await page.getByRole('option', { name: 'Department' }).click();
	await waitForSceneReady(page);
	await expect(surface(page)).toHaveAttribute('data-manual-moves', '0');
	const grouped = await read(page);
	expect(Number(grouped.scene)).toBeGreaterThan(Number(before.scene));
	expect(Object.keys(grouped.headings).length).toBeGreaterThan(0);
	expect(clippedNames(await readNames(page))).toEqual([]);

	await page.locator('#map-group-by').click();
	await page.getByRole('option', { name: 'None' }).click();
	await waitForSceneReady(page);
	const again = await read(page);
	// The same data and facts are the same arrangement again, without the old move.
	expect(again.scene).toBe(before.scene);
	await expect(surface(page)).toHaveAttribute('data-manual-moves', '0');
	expect(again.dots).toEqual(before.dots);
});

test('Space+drag pans without moving anything, and the keyboard selects and clears a Worker', async ({
	page
}) => {
	await open(page, free);
	const before = await read(page);
	const id = Object.keys(before.dots)[0];
	const start = await screenCentre(page, `circle[data-hit-for="${id}"]`);
	await page.mouse.move(start.x, start.y);
	await page.keyboard.down('Space');
	await page.mouse.down();
	await page.mouse.move(start.x + 50, start.y + 30, { steps: 6 });
	await page.mouse.up();
	await page.keyboard.up('Space');
	const end = await screenCentre(page, `circle[data-hit-for="${id}"]`);
	expect(end.x - start.x).toBeCloseTo(50, 0);
	expect(end.y - start.y).toBeCloseTo(30, 0);
	const after = await read(page);
	expect(after.dots).toEqual(before.dots);
	expect(after.manual).toBe(before.manual);

	const dot = page.locator('g[data-node-id]').first();
	await dot.focus();
	await page.keyboard.press('Enter');
	await expect(dot).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
	await expect(dot).toHaveAttribute('aria-pressed', 'false');
});

test('Grouped and nested headings stay attached through zoom, pan, and resize', async ({
	page
}) => {
	await open(page, subgrouped);
	// The report is first published once the drawing is read back; read it only then.
	await expect(surface(page)).toHaveAttribute('data-composition-published', 'true');
	const before = await read(page);
	expect(Object.keys(before.headings).length).toBeGreaterThan(0);
	await zoomIn(page).click();
	await surface(page).focus();
	await page.keyboard.press('ArrowRight');
	await page.setViewportSize({ width: 900, height: 1200 });
	await waitForSceneReady(page, { cameraAfter: before.camera });
	const after = await read(page);
	expect(after.headings).toEqual(before.headings);
	expect(after.report).toBe(before.report);
	expect(after.dots).toEqual(before.dots);
	expect(after.solves).toBe(before.solves);
});

test('hierarchy detail invalidates manual moves while worker and Attribute IDs stay the same', async ({
	page
}) => {
	const fixture = structuredClone(subgrouped);
	const department = fixture.dataset.attributes.find((a) => a.name === 'Department')!;
	const root = department.id + '~all';
	department.options = [
		...department.options.map((option) => ({ ...option, parentId: root })),
		{ id: root, value: 'All departments' }
	];
	Object.assign(fixture.dataset.workers[0].attributes, { [department.id]: root });
	await open(page, fixture, fixture.url.split('&sub=')[0]);
	const before = await read(page);
	const heading = Object.keys(before.headings)[0];
	// The label can still be moving into place while the camera settles; press only once it
	// has stopped, or the press lands where the label used to be.
	await expect(surface(page)).toHaveAttribute('data-camera-idle', 'true');
	await page.evaluate(
		() =>
			new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null))))
	);
	const labelStart = await screenCentre(page, `[data-region-label="${heading}"]`);
	await dragFrom(page, labelStart, {
		x: 40,
		y: 30
	});
	console.log('[DIAG] manual after drag', await surface(page).getAttribute('data-manual-revision'));
	await waitForSceneReady(page, { manual: 1 });
	await page.getByRole('button', { name: /^Group(:|$)/ }).click();
	await page
		.locator(`[data-testid="map-expansion-primary"] [data-expand-branch="${root}"]`)
		.click();
	await expect(surface(page)).not.toHaveAttribute('data-scene-revision', before.scene);
	await waitForSceneReady(page);
	await expect(surface(page)).toHaveAttribute('data-manual-moves', '0');
	const after = await read(page);
	expect(Object.keys(after.dots).sort()).toEqual(Object.keys(before.dots).sort());
	expect(after.solves).toBeGreaterThan(before.solves);
});

test('normal motion reports a completed camera after a grouping change', async ({ page }) => {
	await open(page, free, free.url, free.viewport, 'no-preference');
	const before = await read(page);
	await page.getByRole('button', { name: /^Group(:|$)/ }).click();
	await page.locator('#map-group-by').click();
	await page.getByRole('option', { name: 'Department' }).click();
	await expect(surface(page)).not.toHaveAttribute('data-scene-revision', before.scene);
	await waitForSceneReady(page, { cameraAfter: before.camera });
	const ready = await read(page);
	expect(ready.frozen).toBe(true);
	await expect(surface(page)).toHaveAttribute('data-camera-idle', 'true');
	await expect(surface(page)).not.toHaveAttribute('data-scene-error', /.+/);
});

test('a selected isolated Worker completes readiness without a second navigation', async ({
	page
}) => {
	const id = free.dataset.workers[0].id;
	await open(page, free, '/mapping');
	await selectOnMap(page, id);
	await page.getByRole('button', { name: 'Isolate' }).click();
	await expect(page.locator(`g[data-node-id="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
	await expect(surface(page)).toHaveAttribute('data-scene-ready', 'true');
});
test.describe('E6 folds product-gap-11 Highlight queries', () => {
	type Seeded = {
		languages: Record<string, string>;
		workerIds: Record<string, string>;
		departmentId: string;
	};

	const workerNames = ['Alex', 'Blair', 'Casey', 'Drew'] as const;
	const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];

	async function createLanguages(request: APIRequestContext): Promise<Record<string, string>> {
		const languages: Record<string, string> = {};
		for (const name of ['English', 'Spanish']) {
			const created = await request.post('/api/languages', { data: { name } });
			expect(created.ok(), await created.text()).toBeTruthy();
			languages[name] = ((await created.json()) as { language: { id: string } }).language.id;
		}
		return languages;
	}

	/**
	 * The acceptance fixture: Alex English (Packing), Blair Spanish (Delivery), Casey English
	 * and Spanish (no Department), Drew none (Delivery). Alex-Blair and Blair-Casey are related.
	 */
	async function seedFixture(request: APIRequestContext): Promise<Seeded> {
		const languages = await createLanguages(request);
		const departmentId = randomUUID();
		const configured = await request.put('/api/attributes', {
			data: wireDefinitions([
				{ id: departmentId, name: 'Department', kind: 'category', options: ['Packing', 'Delivery'] }
			])
		});
		expect(configured.ok(), await configured.text()).toBeTruthy();

		const fixtures = [
			{ name: 'Alex', assessment: 'Leader', languages: ['English'], department: 'Packing' },
			{ name: 'Blair', assessment: 'Supporter', languages: ['Spanish'], department: 'Delivery' },
			{
				name: 'Casey',
				assessment: 'Unassessed',
				languages: ['English', 'Spanish'],
				department: ''
			},
			{ name: 'Drew', assessment: 'Activist', languages: [], department: 'Delivery' }
		] as const;
		const workerIds: Record<string, string> = {};

		for (const worker of fixtures) {
			const created = await request.post('/api/workers', {
				data: {
					name: worker.name,
					email: '',
					phone: '',
					assessment: worker.assessment,
					attributes: wireWorkerAttributes({ [departmentId]: worker.department }),
					agitations: [],
					languages: worker.languages.map((name) => languages[name]),
					relationships: [],
					notes: []
				}
			});
			expect(created.status(), await created.text()).toBe(201);
			workerIds[worker.name] = ((await created.json()) as { worker: { id: string } }).worker.id;
		}

		// Each related Worker's whole set is listed, so no write clobbers a pair.
		for (const [name, relationships] of [
			['Alex', ['Blair']],
			['Blair', ['Alex', 'Casey']],
			['Casey', ['Blair']]
		] as const) {
			const fixture = fixtures.find((worker) => worker.name === name)!;
			const updated = await request.put(`/api/workers/${workerIds[name]}`, {
				data: {
					name,
					email: '',
					phone: '',
					assessment: fixture.assessment,
					attributes: wireWorkerAttributes({ [departmentId]: fixture.department }),
					agitations: [],
					languages: fixture.languages.map((language) => languages[language]),
					relationships: relationships.map((other) => workerIds[other]),
					notes: []
				}
			});
			expect(updated.ok(), await updated.text()).toBeTruthy();
		}

		return { languages, workerIds, departmentId };
	}

	async function openMapping(page: Page, search = ''): Promise<void> {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`/mapping${search}`);
		await waitForMapReady(page, 15000);
		await expect(page.getByRole('region', { name: 'Map table' })).toBeAttached();
	}

	/** A `hq` search parameter for one clause, as the map writes it (the root group matches all). */
	function hqParam(field: string, operator: 'any' | 'all' | 'none', values: string[]): string {
		const query = { v: 1, m: 'all', r: [{ f: field, o: operator, v: values }] };
		return `hq=${encodeURIComponent(JSON.stringify(query))}`;
	}

	/** The field key of the Languages field in `hq`. */
	const LANGUAGES = 'l';

	function spanishHq(seeded: Seeded): string {
		return hqParam(LANGUAGES, 'any', [seeded.languages.Spanish]);
	}

	const highlightRule = (page: Page, index: number) =>
		page.getByTestId('highlight-rule').nth(index);
	const highlightGroup = (page: Page, index = 0) => page.getByTestId('highlight-group').nth(index);
	const highlightKey = (page: Page) => page.getByTestId('highlight-key');
	const nodeFor = (page: Page, workerId: string) => page.locator(`g[data-node-id="${workerId}"]`);
	const drawnNodes = (page: Page) => page.locator('svg g[role="button"][data-node-id]');

	async function openHighlight(page: Page): Promise<void> {
		await page.getByTestId('highlight-trigger').click();
		await expect(page.getByTestId('highlight-group').first()).toBeVisible();
	}

	/** Escape closes the popover. The map has already faded by then. */
	async function closeHighlight(page: Page): Promise<void> {
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('highlight-group')).toHaveCount(0);
	}

	/** Opens a Select trigger and picks the option with this exact name. */
	async function pickOption(page: Page, trigger: Locator, name: string): Promise<void> {
		await trigger.click();
		await page.getByRole('option', { name, exact: true }).click();
	}

	/**
	 * Sets one clause row by its position in the builder: a field, an operator, and values
	 * ticked in the Values dropdown. Each part is optional.
	 */
	async function setRule(
		page: Page,
		index: number,
		{ field, operator, values = [] }: { field?: string; operator?: string; values?: string[] }
	): Promise<void> {
		const rule = highlightRule(page, index);
		if (field) await pickOption(page, rule.getByTestId('highlight-field'), field);
		if (operator) await pickOption(page, rule.getByTestId('highlight-operator'), operator);
		if (values.length === 0) return;
		await rule.getByRole('button', { name: /^Values/ }).click();
		for (const value of values) {
			await page.getByRole('menuitemcheckbox', { name: value, exact: true }).click();
		}
		await page.keyboard.press('Escape');
		await expect(page.getByRole('menu')).toHaveCount(0);
	}

	/** Sets the all/any switch of a group's sentence (0 is the top group). */
	async function setMatch(page: Page, groupIndex: number, match: string): Promise<void> {
		await pickOption(
			page,
			highlightGroup(page, groupIndex).getByTestId('highlight-match').first(),
			match
		);
	}

	/**
	 * Adds a rule or a group to a group's own footer. A group's footer is the last of its
	 * subtree's matching buttons, so `last()` picks the group's own control.
	 */
	async function addRule(page: Page, groupIndex = 0): Promise<void> {
		await highlightGroup(page, groupIndex).getByTestId('highlight-add-rule').last().click();
	}

	async function addGroup(page: Page, groupIndex = 0): Promise<void> {
		await highlightGroup(page, groupIndex).getByTestId('highlight-add-group').last().click();
	}

	async function isFaded(page: Page, workerId: string): Promise<boolean> {
		return (await nodeFor(page, workerId).getAttribute('data-faded')) === 'true';
	}

	/** Every drawn Worker is faded except the named ones, which stay unfaded. */
	async function expectUnfaded(page: Page, seeded: Seeded, unfaded: string[]): Promise<void> {
		for (const name of workerNames) {
			const id = seeded.workerIds[name];
			await expect(nodeFor(page, id)).toHaveCount(1);
			await expect
				.poll(() => isFaded(page, id), { message: `${name} faded state` })
				.toBe(!unfaded.includes(name));
		}
	}

	async function expectNothingFaded(page: Page): Promise<void> {
		await expect(page.locator('[data-faded]')).toHaveCount(0);
	}

	/** The settled drawing: every drawn dot's centre and the camera. Ties and their opacity are left out. */
	async function mapGeometry(page: Page) {
		return page.evaluate(() => {
			const centre = (element: Element) => {
				const box = element.getBoundingClientRect();
				return {
					x: Math.round((box.x + box.width / 2) * 100) / 100,
					y: Math.round((box.y + box.height / 2) * 100) / 100
				};
			};
			const nodes = [...document.querySelectorAll('circle[data-hit-for]')]
				.map((element) => ({
					id: element.getAttribute('data-hit-for'),
					...centre(element)
				}))
				.sort((left, right) => String(left.id).localeCompare(String(right.id)));
			const camera = document
				.querySelector('[data-testid="relationship-map-layer"]')
				?.getAttribute('transform');
			return { nodes, camera };
		});
	}

	test.use({ reducedMotion: 'reduce' });
	test('@product-gap-11 Department is one of Packing fades all but Alex and changes no drawing, selection or data', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		const writes: string[] = [];
		page.on('request', (call) => {
			if (writeMethods.includes(call.method())) writes.push(`${call.method()} ${call.url()}`);
		});

		await openMapping(page);
		await selectOnMap(page, seeded.workerIds.Alex);
		const before = await settled(() => mapGeometry(page));

		await openHighlight(page);
		await setRule(page, 0, { field: 'Department', values: ['Packing'] });
		await closeHighlight(page);

		await expectUnfaded(page, seeded, ['Alex']);
		await expect(highlightKey(page)).toContainText('Highlighting 1 of 4 Workers');
		expect(await settled(() => mapGeometry(page))).toEqual(before);
		await expect(page.getByRole('region', { name: 'Worker record' })).toContainText('Alex');
		await expect(page.getByRole('button', { name: /^Alex, / })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		expect(writes).toEqual([]);
	});

	test('@product-gap-11 Workers who match all of these narrows to Blair, and match any of these widens to three', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openMapping(page);

		await openHighlight(page);
		await setRule(page, 0, { field: 'Department', values: ['Delivery'] });
		await addRule(page);
		await setRule(page, 1, { values: ['Spanish'] });
		await closeHighlight(page);
		await expectUnfaded(page, seeded, ['Blair']);

		await openHighlight(page);
		await setMatch(page, 0, 'any');
		await closeHighlight(page);
		await expectUnfaded(page, seeded, ['Blair', 'Casey', 'Drew']);
	});

	test('@product-gap-11 has all of English and Spanish leaves only the bilingual Worker, and all is not offered for Department', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openMapping(page);

		await openHighlight(page);
		await setRule(page, 0, { field: 'Department' });
		await highlightRule(page, 0).getByTestId('highlight-operator').click();
		await expect(page.getByRole('option')).toHaveText(['is one of', 'is none of']);
		await page.getByRole('option', { name: 'is one of', exact: true }).click();

		await setRule(page, 0, {
			field: 'Languages',
			operator: 'has all of',
			values: ['English', 'Spanish']
		});
		await closeHighlight(page);

		await expectUnfaded(page, seeded, ['Casey']);
	});

	test('@product-gap-11 has none of Spanish unfades the Workers who do not speak it', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openMapping(page);

		await openHighlight(page);
		await setRule(page, 0, { operator: 'has none of', values: ['Spanish'] });
		await closeHighlight(page);

		await expectUnfaded(page, seeded, ['Alex', 'Drew']);
	});

	test('@product-gap-11 a nested group evaluates inside a query that matches any of these', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openMapping(page);

		await openHighlight(page);
		await setMatch(page, 0, 'any');
		await setRule(page, 0, { field: 'Department', values: ['Packing'] });
		await addGroup(page);
		// The nested group starts with one Languages rule; its own rule is the second.
		await setRule(page, 1, { field: 'Department', values: ['Delivery'] });
		await addRule(page, 1);
		await setRule(page, 2, { values: ['Spanish'] });
		await closeHighlight(page);

		await expectUnfaded(page, seeded, ['Alex', 'Blair']);
	});

	test('@product-gap-11 Clear highlight and Reset all each empty the query and restore every Worker', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openMapping(page);

		await openHighlight(page);
		await setRule(page, 0, { values: ['Spanish'] });
		await expectUnfaded(page, seeded, ['Blair', 'Casey']);
		await page.getByTestId('highlight-clear').click();
		await closeHighlight(page);
		await expectNothingFaded(page);
		await expect(highlightKey(page)).toHaveCount(0);
		await expect(page).not.toHaveURL(/[?&]hq=/);

		await openHighlight(page);
		await setRule(page, 0, { values: ['Spanish'] });
		await closeHighlight(page);
		await expectUnfaded(page, seeded, ['Blair', 'Casey']);
		await page.getByRole('button', { name: /^Filter/ }).click();
		await page.getByRole('button', { name: 'Reset all', exact: true }).click();
		await expectNothingFaded(page);
		await expect(highlightKey(page)).toHaveCount(0);
		await expect(page).not.toHaveURL(/[?&]hq=/);
	});

	test('@product-gap-11 a reload restores the query, a malformed query shows nothing, a legacy lang link fades as one clause', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));

		await openMapping(page);
		await openHighlight(page);
		await setRule(page, 0, { values: ['Spanish'] });
		await closeHighlight(page);
		await expectUnfaded(page, seeded, ['Blair', 'Casey']);

		await page.reload();
		await waitForMapReady(page, 15000);
		await expectUnfaded(page, seeded, ['Blair', 'Casey']);
		await expect(highlightKey(page)).toContainText('Highlighting 2 of 4 Workers');

		await openMapping(page, '?hq=not-json');
		await expectNothingFaded(page);
		await expect(highlightKey(page)).toHaveCount(0);

		await openMapping(page, `?lang=${seeded.languages.Spanish}`);
		await expectUnfaded(page, seeded, ['Blair', 'Casey']);

		// The first user edit writes the query as hq and never writes lang again.
		await openHighlight(page);
		await setRule(page, 0, { values: ['English'] });
		await closeHighlight(page);
		await expect(page).toHaveURL(/[?&]hq=/);
		await expect(page).not.toHaveURL(/[?&]lang=/);
		await expectUnfaded(page, seeded, ['Alex', 'Blair', 'Casey']);

		expect(errors).toEqual([]);
	});

	test('@product-gap-11 deleting a Language prunes it from the query on the next load', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openMapping(page);
		await openHighlight(page);
		await setRule(page, 0, { values: ['Spanish'] });
		await closeHighlight(page);
		await expect(page).toHaveURL(/[?&]hq=/);
		const hq = new URL(page.url()).searchParams.get('hq');
		expect(hq).toBeTruthy();

		const listed = await request.get('/api/languages');
		const current = (await listed.json()) as { languages: { id: string }[] };
		const deleted = await request.put('/api/languages', {
			data: current.languages.filter((language) => language.id !== seeded.languages.Spanish)
		});
		expect(deleted.ok(), await deleted.text()).toBeTruthy();

		await openMapping(page, `?hq=${encodeURIComponent(hq!)}`);
		await expectNothingFaded(page);
		await expect(highlightKey(page)).toHaveCount(0);
	});

	test('@product-gap-11 the map table marks the Workers the query matches and no others', async ({
		page,
		request
	}) => {
		await seedFixture(request);
		await openMapping(page);
		await expect(page.getByTestId('highlight-match-tag')).toHaveCount(0);

		await openHighlight(page);
		await setRule(page, 0, { values: ['Spanish'] });
		await closeHighlight(page);

		const row = (name: string) => page.locator('[data-map-table-row]').filter({ hasText: name });
		await expect(row('Blair').getByTestId('highlight-match-tag')).toHaveText('Matches highlight');
		await expect(row('Casey').getByTestId('highlight-match-tag')).toHaveText('Matches highlight');
		await expect(row('Alex').getByTestId('highlight-match-tag')).toHaveCount(0);
		await expect(row('Drew').getByTestId('highlight-match-tag')).toHaveCount(0);

		await expect(row('Casey')).toContainText('English, Spanish');
		await expect(row('Casey')).not.toContainText(' · highlighted');
	});

	test('@product-gap-11 hidden Workers are not drawn or counted, and Isolate counts only what is drawn', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);

		// Hiding Spanish removes Blair from the drawing, so the Spanish query counts three.
		await openMapping(page, `?nolang=${seeded.languages.Spanish}&${spanishHq(seeded)}`);
		await expect(drawnNodes(page)).toHaveCount(3);
		await expect(page.getByRole('button', { name: /^Blair, / })).toHaveCount(0);
		await expect(highlightKey(page)).toContainText('Highlighting 1 of 3 Workers');

		// Isolate on Drew draws one Worker, so the count is out of one.
		await openMapping(page, `?${spanishHq(seeded)}`);
		await selectOnMap(page, seeded.workerIds.Drew);
		await page.getByRole('button', { name: 'Isolate' }).click();
		await expect(drawnNodes(page)).toHaveCount(1);
		await expect(highlightKey(page)).toContainText('Highlighting 0 of 1 Workers');
	});
});
