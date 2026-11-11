import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { activateWorksite, followActiveWorksite } from './api.ts';
import { settled, waitForMapReady } from './map.ts';
import { selectOnMap } from './person.ts';
import {
	populateWorksite,
	type PopulatedWorksite,
	ringWorksite,
	cliquesWorksite,
	hubBundleWorksite,
	modularWorksite,
	sixGroupWorksite,
	type CompositionWorksite
} from './mapping-composition-worksite.ts';
import { evaluateDrawing } from '../src/lib/features/mapping/layout/graph-layout-quality.ts';
import { answerId } from './answer-wire.ts';
import { captureRoutineImage } from './evidence.ts';

/** The region key a Worker's answer draws under: its answer id, or '' when blank. */
function answerKey(attributeId: string | undefined, text: string | undefined): string {
	return text && attributeId ? answerId(attributeId, text) : '';
}
import { flattenPath } from '../src/lib/features/mapping/layout/graph-shapes.ts';

test.use({ reducedMotion: 'reduce' });

const viewports = {
	wide: { width: 1600, height: 1000 },
	tall: { width: 1000, height: 1400 },
	floor: { width: 1024, height: 640 }
} as const;

/** Actual-renderer evidence is written here, never to the frozen historical baseline. */
const evidenceDirectory = resolve(
	process.cwd(),
	'.scratch/mapping-composed-arrangement/evidence/01-grouped'
);

const freeEvidenceDirectory = resolve(
	process.cwd(),
	'.scratch/mapping-composed-arrangement/evidence/03-free'
);
const nestedEvidenceDirectory = resolve(
	process.cwd(),
	'.scratch/mapping-composed-arrangement/evidence/02-nested'
);

/** A second Wobble build with the composition switched off at build time: the "before" renderer. */
const baselineUrl = process.env.WOBBLE_E2E_BASELINE_URL;

type DrawnGeometry = {
	scale: number;
	chosen: string | null;
	textSource: string | null;
	packetScale: number | null;
	layoutCanvas: string | null;
	report: unknown;
	atReference: boolean;
	routesPublished: boolean;
	dots: { id: string; x: number; y: number; r: number }[];
	names: {
		id: string;
		text: string;
		box: { left: number; top: number; right: number; bottom: number };
		metrics: string | null;
		screen: { width: number; height: number };
	}[];
	leaders: string[];
	leaderLines: { id: string; x1: number; y1: number; x2: number; y2: number }[];
	headings: { key: string; box: { left: number; top: number; right: number; bottom: number } }[];
	regions: { key: string; d: string | null; parent?: string }[];
	routes: { id: string; source: string; target: string; d: string; kind: string }[];
	free: { width: number; height: number };
	chrome: { id: string; box: { left: number; top: number; right: number; bottom: number } }[];
};

/** Reads the drawing as the renderer made it: dots, names, headings, outlines and final path data. */
async function readDrawing(page: Page): Promise<DrawnGeometry> {
	return page.evaluate(() => {
		const surface = document.querySelector<HTMLElement>(
			'[data-testid="relationship-map-surface"]'
		)!;
		const layer = surface.querySelector<SVGGElement>('[data-testid="relationship-map-layer"]')!;
		const matrix = layer.getScreenCTM()!;
		const inverse = matrix.inverse();
		const toMap = (x: number, y: number) => {
			const p = new DOMPoint(x, y).matrixTransform(inverse);
			return { x: p.x, y: p.y };
		};
		const boxOf = (element: Element) => {
			const rect = element.getBoundingClientRect();
			const a = toMap(rect.left, rect.top);
			const b = toMap(rect.right, rect.bottom);
			return { left: a.x, top: a.y, right: b.x, bottom: b.y };
		};
		const canvas = document
			.querySelector('[data-testid="relationship-map-canvas"]')!
			.getBoundingClientRect();
		const strip = document
			.querySelector('[data-testid="mapping-control-strip"]')
			?.getBoundingClientRect();
		return {
			scale: matrix.a,
			chosen: surface.getAttribute('data-composition-chosen'),
			textSource: surface.getAttribute('data-composition-text'),
			packetScale: Number(surface.getAttribute('data-composition-scale')) || null,
			layoutCanvas: surface.getAttribute('data-layout-canvas'),
			report: JSON.parse(surface.getAttribute('data-composition-report') ?? 'null'),
			atReference: surface.getAttribute('data-at-reference') === 'true',
			routesPublished: surface.getAttribute('data-routes-published') === 'true',
			free: { width: canvas.width, height: canvas.height - (strip?.height ?? 0) },
			chrome: ['mapping-bottom-bar', 'mapping-dot-key'].flatMap((testId) => {
				const element = document.querySelector(`[data-testid="${testId}"]`);
				return element && innerWidth >= 1024 ? [{ id: testId, box: boxOf(element) }] : [];
			}),
			dots: [...surface.querySelectorAll<SVGGElement>('g[data-node-id]')].map((group) => {
				const circle = group.querySelector('circle:not(.fill-none):not([data-hit-for])')!;
				return {
					id: group.dataset.nodeId!,
					x: Number(circle.getAttribute('cx')),
					y: Number(circle.getAttribute('cy')),
					r: Number(circle.getAttribute('r'))
				};
			}),
			names: [...surface.querySelectorAll<SVGTextElement>('text[data-node-label]')].map((text) => {
				const rect = text.getBoundingClientRect();
				return {
					id: text.dataset.nodeLabel!,
					text: [...text.childNodes]
						.filter((node) => node.nodeType === Node.TEXT_NODE)
						.map((node) => node.textContent)
						.join('')
						.trim(),
					box: boxOf(text),
					metrics: text.getAttribute('data-name-metrics'),
					screen: { width: rect.width, height: rect.height }
				};
			}),
			leaders: [...surface.querySelectorAll<SVGLineElement>('line[data-name-leader]')].map(
				(line) => line.dataset.nameLeader!
			),
			leaderLines: [...surface.querySelectorAll<SVGLineElement>('line[data-name-leader]')].map(
				(line) => ({
					id: line.dataset.nameLeader!,
					x1: Number(line.getAttribute('x1')),
					y1: Number(line.getAttribute('y1')),
					x2: Number(line.getAttribute('x2')),
					y2: Number(line.getAttribute('y2'))
				})
			),
			headings: [...surface.querySelectorAll('[data-region-label]')].map((label) => ({
				key: (label as HTMLElement).dataset.regionLabel!,
				box: boxOf(label)
			})),
			regions: [...surface.querySelectorAll<SVGGElement>('[data-group-hull]')].flatMap((group) => [
				{
					key: group.dataset.groupHull!,
					d: group.querySelector(':scope > path')?.getAttribute('d') ?? null
				},
				...[...group.querySelectorAll<SVGGElement>('[data-sub-hull]')].map((sub) => ({
					key: sub.dataset.subHull!,
					parent: group.dataset.groupHull!,
					d: sub.querySelector('path')?.getAttribute('d') ?? null
				}))
			]),
			routes: [...surface.querySelectorAll<SVGPathElement>('path[data-tie-id]')].map((path) => ({
				id: path.dataset.tieId!,
				source: path.dataset.tieSource!,
				target: path.dataset.tieTarget!,
				d: path.getAttribute('d')!,
				kind: path.dataset.tie!
			}))
		};
	});
}

/** Evaluates a drawn geometry independently of the code that produced it. */
function evaluate(
	geometry: DrawnGeometry,
	groupOf: ReadonlyMap<string, string>,
	subOf?: ReadonlyMap<string, string>
) {
	const unit = 1 / geometry.scale;
	return evaluateDrawing({
		routes: geometry.routes,
		dots: geometry.dots,
		names: geometry.names.map((name) => ({
			id: `name:${name.id}`,
			worker: name.id,
			box: name.box
		})),
		headings: geometry.headings.map((heading) => ({ id: heading.key, box: heading.box })),
		chrome: geometry.chrome,
		regions: geometry.regions.flatMap((region) => {
			const flat = region.d ? flattenPath(region.d, 0.5 * unit, 256) : undefined;
			return flat
				? [{ key: region.key, parent: region.parent, polygon: flat.points, outlined: true }]
				: [];
		}),
		workerRegions: new Map(
			geometry.dots.map((dot) => {
				const group = groupOf.get(dot.id) || '__unassigned';
				const sub = subOf?.get(dot.id);
				return [
					dot.id,
					sub === undefined ? [group] : [group, `${group}::${sub || '__unassigned'}`]
				];
			})
		),
		unit
	});
}

async function openMapping(
	page: Page,
	size: { width: number; height: number },
	departmentId: string | undefined,
	roleId?: string
) {
	await page.setViewportSize(size);
	await page.goto(
		departmentId ? `/mapping?group=${departmentId}${roleId ? `&sub=${roleId}` : ''}` : '/mapping'
	);
	await waitForMapReady(page);
	await expect(page.getByTestId('relationship-map-surface')).toHaveAttribute(
		'data-map-settled',
		'true'
	);
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** The Worksite on the comparison build, populated identically. */
async function baselineContext(
	browser: Browser,
	worksite: CompositionWorksite
): Promise<{ context: BrowserContext; populated: PopulatedWorksite }> {
	const base = baselineUrl!;
	const response = await fetch(`${base}/api/worksite`, { method: 'POST' });
	const { worksite: created } = (await response.json()) as { worksite: { id: string } };
	const { request: playwrightRequest } = await import('@playwright/test');
	const api = await playwrightRequest.newContext({
		baseURL: base,
		extraHTTPHeaders: { 'x-wobble-worksite': created.id }
	});
	const populated = await populateWorksite(api, worksite);
	await api.dispose();
	const context = await browser.newContext({ baseURL: base, reducedMotion: 'reduce' });
	await activateWorksite(context, created.id);
	await followActiveWorksite(context);
	return { context, populated };
}

const fixtures = [
	{ slug: 'six-group', worksite: sixGroupWorksite(), nested: false },
	{ slug: 'ring', worksite: ringWorksite(), nested: false },
	{ slug: 'ring-nested', worksite: ringWorksite(), nested: true },
	{ slug: 'ring-free', worksite: ringWorksite(), nested: false, ungrouped: true },
	{ slug: 'cliques-free', worksite: cliquesWorksite(), nested: false, ungrouped: true },
	{ slug: 'modular-free', worksite: modularWorksite(), nested: false, ungrouped: true }
] as const;

for (const fixture of fixtures) {
	const { slug, worksite, nested } = fixture;
	const ungrouped = 'ungrouped' in fixture;
	test(`captures the ${slug} Grouped drawing through the actual renderer`, async ({
		page,
		request,
		browser
	}) => {
		test.setTimeout(240_000);
		const directory = ungrouped
			? freeEvidenceDirectory
			: nested
				? nestedEvidenceDirectory
				: evidenceDirectory;
		const populated = await populateWorksite(request, worksite);
		const groupOf = new Map(
			populated.ids.map((id, index) => [
				id,
				answerKey(
					populated.attributeIds.get('Department'),
					worksite.workers[index].attributes.Department
				)
			])
		);
		const subOf = nested
			? new Map(
					populated.ids.map((id, index) => [
						id,
						answerKey(populated.attributeIds.get('Role'), worksite.workers[index].attributes.Role)
					])
				)
			: undefined;
		const report: Record<string, unknown> = {};
		let baseline: Awaited<ReturnType<typeof baselineContext>> | undefined;
		if (baselineUrl) baseline = await baselineContext(browser, worksite);
		for (const [aspect, size] of Object.entries(viewports)) {
			await openMapping(
				page,
				size,
				ungrouped ? undefined : populated.attributeIds.get('Department'),
				nested ? populated.attributeIds.get('Role') : undefined
			);
			const composed = await settled(() => readDrawing(page));
			expect(composed.dots).toHaveLength(worksite.workers.length);
			expect(composed.routes).toHaveLength(worksite.relationships.length);
			await captureRoutineImage(
				page,
				test.info(),
				`${slug}-${aspect}-composed.png`,
				resolve(directory, 'images')
			);
			const entry: Record<string, unknown> = {
				viewport: size,
				chosen: composed.chosen,
				textSource: composed.textSource,
				packetScale: composed.packetScale,
				layoutCanvas: composed.layoutCanvas,
				surface: composed.free,
				report: composed.report,
				atReference: composed.atReference,
				routesPublished: composed.routesPublished,
				scale: composed.scale,
				evaluation: summarize(evaluate(composed, groupOf, subOf))
			};
			if (baseline) {
				const baselinePage = await baseline.context.newPage();
				const baselineGroups = new Map(
					baseline.populated.ids.map((id, index) => [
						id,
						answerKey(
							populated.attributeIds.get('Department'),
							worksite.workers[index].attributes.Department
						)
					])
				);
				await openMapping(
					baselinePage,
					size,
					ungrouped ? undefined : baseline.populated.attributeIds.get('Department'),
					nested ? baseline.populated.attributeIds.get('Role') : undefined
				);
				const before = await settled(() => readDrawing(baselinePage));
				await captureRoutineImage(
					baselinePage,
					test.info(),
					`${slug}-${aspect}-baseline.png`,
					resolve(directory, 'images')
				);
				entry.baseline = {
					chosen: before.chosen,
					scale: before.scale,
					evaluation: summarize(evaluate(before, baselineGroups, subOf))
				};
				await baselinePage.close();
			}
			report[aspect] = entry;
		}
		// Set WOBBLE_CAPTURE=1 to regenerate the tracked captures.
		if (process.env.WOBBLE_CAPTURE === '1') {
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				resolve(directory, `${slug}-capture.json`),
				`${JSON.stringify(report, null, 2)}\n`
			);
		}
		await baseline?.context.close();
	});
}

/** Opens the six-group fixture grouped by Department and returns what the interaction tests need. */
async function openSixGroups(
	page: Page,
	request: Parameters<typeof populateWorksite>[0],
	size: { width: number; height: number } = viewports.wide
) {
	const worksite = sixGroupWorksite();
	const populated = await populateWorksite(request, worksite);
	const groupOf = new Map(
		populated.ids.map((id, index) => [
			id,
			answerKey(
				populated.attributeIds.get('Department'),
				worksite.workers[index].attributes.Department
			)
		])
	);
	await openMapping(page, size, populated.attributeIds.get('Department'));
	return { worksite, populated, groupOf, department: populated.attributeIds.get('Department')! };
}

const centre = async (page: Page, id: string) => {
	const box = (await page.locator(`circle[data-hit-for="${id}"]`).first().boundingBox())!;
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const mapPositions = (geometry: DrawnGeometry) =>
	Object.fromEntries(geometry.dots.map((dot) => [dot.id, [dot.x, dot.y]]));
const pathData = (geometry: DrawnGeometry) =>
	Object.fromEntries(geometry.routes.map((route) => [route.id, route.d]));

test('measured name boxes agree with the rendered text within one CSS pixel', async ({
	page,
	request
}) => {
	// Public Sans arrives late, the way it does on a loaded machine: the map must not measure
	// its names in the fallback face before it lands.
	await page.route(/\.woff2/, async (route) => {
		await new Promise((res) => setTimeout(res, 2500));
		await route.continue();
	});
	await openSixGroups(page, request);
	// The names are measured once Public Sans is in: until then the map stands on an estimate.
	await expect(page.getByTestId('relationship-map-surface')).toHaveAttribute(
		'data-composition-text',
		'measured'
	);
	const drawn = await settled(() => readDrawing(page));
	expect(drawn.textSource).toBe('measured');
	expect(drawn.names.length).toBeGreaterThan(0);
	for (const name of drawn.names) {
		const [width, height] = (name.metrics ?? '0x0').split('x').map(Number);
		expect(Math.abs(width - name.screen.width), `${name.text} width`).toBeLessThanOrEqual(1);
		expect(Math.abs(height - name.screen.height), `${name.text} height`).toBeLessThanOrEqual(1);
	}
	// Long, duplicate and non-ASCII names are all among the names standing at rest.
	const texts = drawn.names.map((name) => name.text);
	expect(texts.some((text) => text.endsWith('…'))).toBe(true);
	expect(texts.filter((text) => text === 'Marie Curie').length).toBe(2);
	expect(texts).toContain('Zoë Åkesson');
});

test('selection, hover, search, the card, panning and zooming leave positions and paths alone', async ({
	page,
	request
}) => {
	const { populated } = await openSixGroups(page, request);
	const before = await settled(() => readDrawing(page));
	const restingBefore = Object.fromEntries(
		before.names.map((name) => [name.id, [name.box.left, name.box.top]])
	);
	const unlabelled = before.dots.find((dot) => !before.names.some((name) => name.id === dot.id))!;

	await page.locator(`circle[data-hit-for="${unlabelled.id}"]`).first().click();
	await expect(page.getByTestId('relationship-map-surface')).toBeVisible();
	const selected = await settled(() => readDrawing(page));
	expect(mapPositions(selected)).toEqual(mapPositions(before));
	expect(pathData(selected)).toEqual(pathData(before));
	// The name budget is unchanged and selection ghosts everyone outside the reading, so some
	// resting names stop being drawn; every one that is still drawn keeps exactly its place.
	let kept = 0;
	for (const [id, at] of Object.entries(restingBefore)) {
		const now = selected.names.find((name) => name.id === id);
		if (!now) continue;
		kept += 1;
		expect(now.box.left, `resting name ${id}`).toBeCloseTo(at[0], 1);
		expect(now.box.top, `resting name ${id}`).toBeCloseTo(at[1], 1);
	}
	expect(kept).toBeGreaterThanOrEqual(1);
	expect(selected.names.some((name) => name.id === unlabelled.id)).toBe(true);

	await page.getByRole('searchbox', { name: 'Find a worker' }).fill('Ames');
	await page.getByRole('searchbox', { name: 'Find a worker' }).fill('');
	await page.getByRole('button', { name: /^Zoom in/i }).click();
	const zoomed = await settled(() => readDrawing(page));
	expect(mapPositions(zoomed)).toEqual(mapPositions(before));
	expect(pathData(zoomed)).toEqual(pathData(before));
	await page.keyboard.press('Escape');
	expect(populated.ids).toContain(unlabelled.id);
});

test('Isolate draws straight ties and hands back exactly the geometry it left', async ({
	page,
	request
}) => {
	const { populated, department } = await openSixGroups(page, request);
	const before = await settled(() => readDrawing(page));
	const hub = populated.ids[0];
	await page.goto(`/mapping?group=${department}`);
	await waitForMapReady(page);
	await selectOnMap(page, hub);
	await expect(page.getByTestId('relationship-map-surface')).toHaveAttribute(
		'data-map-settled',
		'true'
	);
	const isolate = page
		.getByTestId('relationship-map-canvas')
		.getByRole('button', { name: 'Isolate' });
	await isolate.click();
	await expect(isolate).toHaveAttribute('aria-pressed', 'true');
	const isolated = await settled(() => readDrawing(page));
	for (const route of isolated.routes) {
		expect(route.d, 'Isolate draws only direct ties').toMatch(
			/^M [-\d.]+ [-\d.]+ L [-\d.]+ [-\d.]+$/
		);
	}
	await isolate.click();
	await expect(isolate).toHaveAttribute('aria-pressed', 'false');
	const restored = await settled(() => readDrawing(page));
	expect(mapPositions(restored)).toEqual(mapPositions(before));
	expect(pathData(restored)).toEqual(pathData(before));
});

test('hovering a Worker names it without opening its card or moving anything', async ({
	page,
	request
}) => {
	await openSixGroups(page, request);
	const before = await settled(() => readDrawing(page));
	const unlabelled = before.dots.find((dot) => !before.names.some((name) => name.id === dot.id))!;
	const target = await centre(page, unlabelled.id);
	await page.mouse.move(target.x, target.y);
	await expect(page.locator(`[data-node-label="${unlabelled.id}"]`)).toBeVisible();
	await expect(page).not.toHaveURL(/sel=/);
	const hovered = await settled(() => readDrawing(page));
	expect(mapPositions(hovered)).toEqual(mapPositions(before));
	expect(pathData(hovered)).toEqual(pathData(before));
	// The Worker's name stands clear of the dots and the names already placed.
	const name = hovered.names.find((entry) => entry.id === unlabelled.id)!;
	for (const other of hovered.names.filter((entry) => entry.id !== unlabelled.id)) {
		const apart =
			name.box.right <= other.box.left ||
			other.box.right <= name.box.left ||
			name.box.bottom <= other.box.top ||
			other.box.bottom <= name.box.top;
		expect(apart, `${name.text} clear of ${other.text}`).toBe(true);
	}
});

test('draws short leaders that differ from Relationships, and no leader a tie could be mistaken for', async ({
	page,
	request
}) => {
	await openSixGroups(page, request, viewports.floor);
	const styles = await page.evaluate(() =>
		[...document.querySelectorAll<SVGLineElement>('line[data-name-leader]')].map((line) => ({
			dash: line.getAttribute('stroke-dasharray'),
			width: line.getAttribute('stroke-width'),
			tag: line.tagName,
			isTie: line.hasAttribute('data-tie')
		}))
	);
	for (const style of styles) {
		expect(style.tag).toBe('line');
		expect(style.dash).not.toBeNull();
		expect(style.width).toBe('1');
		expect(style.isTie).toBe(false);
	}
});

/** How far a name's box stands off its own dot's surface, in map units. */
function standoff(drawing: DrawnGeometry, name: DrawnGeometry['names'][number]): number {
	const dot = drawing.dots.find((entry) => entry.id === name.id)!;
	const x = Math.max(name.box.left, Math.min(dot.x, name.box.right));
	const y = Math.max(name.box.top, Math.min(dot.y, name.box.bottom));
	return Math.hypot(x - dot.x, y - dot.y) - dot.r;
}

/** How far a name's box stands off its own dot's surface, in screen pixels. */
function screenStandoff(drawing: DrawnGeometry, name: DrawnGeometry['names'][number]): number {
	return standoff(drawing, name) * drawing.scale;
}

const nameBoxes = (drawing: DrawnGeometry) =>
	new Map(drawing.names.map((name) => [name.id, name.box]));

/** The two dense Free fixtures: names must stay near their dots on both. */
const nearFixtures = [
	{ slug: 'cliques', worksite: cliquesWorksite() },
	{ slug: 'hub-bundle', worksite: hubBundleWorksite() }
] as const;

/**
 * Which side of its dot a name stands on, read from the nearest point of its box: the
 * centreline sides have one axis at zero, and the diagonal sides sit on the 45° corner.
 */
function nameSide(drawing: DrawnGeometry, name: DrawnGeometry['names'][number]): string {
	const dot = drawing.dots.find((entry) => entry.id === name.id)!;
	const x = Math.max(name.box.left, Math.min(dot.x, name.box.right));
	const y = Math.max(name.box.top, Math.min(dot.y, name.box.bottom));
	const dx = x - dot.x;
	const dy = y - dot.y;
	const across = Math.abs(dx);
	const down = Math.abs(dy);
	const vertical = dy < 0 ? 'above' : 'below';
	const horizontal = dx < 0 ? 'left' : 'right';
	if (down < 0.5) return horizontal;
	if (across < 0.5) return vertical;
	if (Math.abs(across - down) < 2) return `${vertical}-${horizontal}`;
	return across > down ? horizontal : vertical;
}

/** Camera changes preserve attachments even when their boxes become covered. */
function expectRestingNamesKept(before: DrawnGeometry, after: DrawnGeometry, when: string) {
	for (const name of before.names) {
		const now = after.names.find((entry) => entry.id === name.id);
		expect(now, `${when}: ${name.text} is still drawn`).toBeDefined();
		expect(nameSide(after, now!), `${when}: ${name.text} keeps its side`).toBe(
			nameSide(before, name)
		);
		expect(
			Math.abs(screenStandoff(after, now!) - screenStandoff(before, name)),
			`${when}: ${name.text} keeps its screen gap`
		).toBeLessThan(1.5);
	}
}

for (const { slug, worksite } of nearFixtures) {
	test(`Free returns to the framing it was fitted at after zooming and resetting (${slug})`, async ({
		page,
		request
	}) => {
		await populateWorksite(request, worksite);
		await openMapping(page, viewports.wide, undefined);
		const before = await settled(() => readDrawing(page));

		const zoomIn = page.getByRole('button', { name: 'Zoom in' });
		await zoomIn.focus();
		for (let step = 0; step < 2; step += 1) await page.keyboard.press('Enter');
		await settled(() => readDrawing(page));
		await page.getByRole('button', { name: 'Reset zoom' }).focus();
		await page.keyboard.press('Enter');
		const after = await settled(() => readDrawing(page));

		// The refit lands on the same framing; a name only moves if its kept spot is
		// covered at the refitted camera, which a return to the same framing cannot do.
		expectRestingNamesKept(before, after, 'resetting');
	});
}

/** The stored Relationships read as neighbours, so a test can tell which names a hover should keep. */
function neighboursOf(worksite: CompositionWorksite, populated: PopulatedWorksite) {
	const neighbours = new Map(populated.ids.map((id) => [id, new Set<string>()]));
	for (const [a, b] of worksite.relationships) {
		neighbours.get(populated.ids[a])!.add(populated.ids[b]);
		neighbours.get(populated.ids[b])!.add(populated.ids[a]);
	}
	return neighbours;
}

/** The Worker without a resting name whose neighbourhood holds the most named Workers. */
function unnamedWorkerNearNamed(
	before: DrawnGeometry,
	worksite: CompositionWorksite,
	populated: PopulatedWorksite
) {
	const resting = nameBoxes(before);
	const neighbours = neighboursOf(worksite, populated);
	return before.dots
		.filter((dot) => !resting.has(dot.id))
		.map((dot) => ({
			id: dot.id,
			namedNeighbours: [...(neighbours.get(dot.id) ?? [])].filter((id) => resting.has(id))
		}))
		.sort((a, b) => b.namedNeighbours.length - a.namedNeighbours.length)[0]!;
}

/**
 * Every name drawn before is still drawn, each holding its exact box. A name may be
 * hidden only when the caller's spotlight rule says so: selection and hover deliberately
 * ghost everyone outside the active Worker's neighbourhood.
 */
function expectNamesHeld(
	before: Map<string, DrawnGeometry['names'][number]['box']>,
	after: DrawnGeometry,
	when: string,
	hiddenBySpotlight: (id: string) => boolean = () => false
): number {
	let kept = 0;
	for (const [id, box] of before) {
		const now = after.names.find((name) => name.id === id);
		if (!now) {
			expect(hiddenBySpotlight(id), `${when} name ${id} is only hidden by the spotlight`).toBe(
				true
			);
			continue;
		}
		kept += 1;
		expect(now.box.left, `${when} name ${id} holds its place`).toBeCloseTo(box.left, 1);
		expect(now.box.top, `${when} name ${id} holds its place`).toBeCloseTo(box.top, 1);
	}
	return kept;
}

for (const { slug, worksite } of nearFixtures) {
	test(`Free keeps every other name in place when a Worker is hovered (${slug})`, async ({
		page,
		request
	}) => {
		const populated = await populateWorksite(request, worksite);
		await openMapping(page, viewports.wide, undefined);
		const before = await settled(() => readDrawing(page));
		const target = unnamedWorkerNearNamed(before, worksite, populated);
		expect(
			target.namedNeighbours.length,
			'the hovered Worker has a named neighbour'
		).toBeGreaterThan(0);

		const point = await centre(page, target.id);
		await page.mouse.move(point.x, point.y);
		await expect(page.locator(`[data-node-label="${target.id}"]`)).toBeVisible();
		const hovered = await settled(() => readDrawing(page));

		// The hovered name is placed after the resting ones, so none of them yields its box.
		// The spotlight intentionally hides names outside the hovered Worker's neighbourhood;
		// every name it keeps must hold exactly its place, and no neighbour may vanish.
		const beforeBoxes = nameBoxes(before);
		const neighbours = neighboursOf(worksite, populated).get(target.id)!;
		expect(
			expectNamesHeld(beforeBoxes, hovered, 'hovered', (id) => !neighbours.has(id))
		).toBeGreaterThan(0);
		// Hovering adds information: the Worker's name appears, and a named neighbour keeps hers.
		expect(
			hovered.names.some((name) => name.id === target.id),
			'the hovered name appears'
		).toBe(true);
		for (const id of target.namedNeighbours)
			expect(
				hovered.names.some((name) => name.id === id),
				`named neighbour ${id} keeps its name`
			).toBe(true);
	});
}

for (const { slug, worksite } of nearFixtures) {
	test(`Free keeps every other name in place when a Worker is selected (${slug})`, async ({
		page,
		request
	}) => {
		const populated = await populateWorksite(request, worksite);
		await openMapping(page, viewports.wide, undefined);
		const before = await settled(() => readDrawing(page));
		const target = unnamedWorkerNearNamed(before, worksite, populated);
		expect(
			target.namedNeighbours.length,
			'the selected Worker has a named neighbour'
		).toBeGreaterThan(0);

		await page.locator(`circle[data-hit-for="${target.id}"]`).first().click();
		await expect(page.getByTestId('relationship-map-surface')).toBeVisible();
		const selected = await settled(() => readDrawing(page));

		// Every name the spotlight keeps holds exactly its place, and no neighbour may vanish.
		const beforeBoxes = nameBoxes(before);
		const neighbours = neighboursOf(worksite, populated).get(target.id)!;
		expect(
			expectNamesHeld(beforeBoxes, selected, 'selected', (id) => !neighbours.has(id))
		).toBeGreaterThan(0);
		// Selecting adds information without taking a named neighbour's name away.
		expect(
			selected.names.some((name) => name.id === target.id),
			'the selected name appears'
		).toBe(true);
		for (const id of target.namedNeighbours)
			expect(
				selected.names.some((name) => name.id === id),
				`named neighbour ${id} keeps its name`
			).toBe(true);
	});
}

test('Free keeps every other name in place when a Worker is hovered in Isolate', async ({
	page,
	request
}) => {
	const populated = await populateWorksite(request, cliquesWorksite());
	const anchor = populated.ids[0];
	await page.goto('/mapping');
	await waitForMapReady(page);
	await selectOnMap(page, anchor);
	await expect(page.getByTestId('relationship-map-surface')).toHaveAttribute(
		'data-map-settled',
		'true'
	);
	const isolate = page
		.getByTestId('relationship-map-canvas')
		.getByRole('button', { name: 'Isolate' });
	await isolate.click();
	await expect(isolate).toHaveAttribute('aria-pressed', 'true');
	const before = await settled(() => readDrawing(page));
	const resting = nameBoxes(before);
	expect(resting.size, 'the Isolate names its neighbourhood').toBeGreaterThan(1);
	const other = [...resting.keys()].find((id) => id !== anchor)!;
	const point = await centre(page, other);
	await page.mouse.move(point.x, point.y);
	await expect(page.locator(`[data-node-label="${other}"]`)).toBeVisible();
	const hovered = await settled(() => readDrawing(page));

	// Isolate names every drawn Worker; the hover's spotlight still hides non-neighbours.
	// Every name it keeps holds its place, and only non-neighbours may be hidden.
	const others = new Map([...resting].filter(([id]) => id !== other));
	const neighbours = neighboursOf(cliquesWorksite(), populated).get(other)!;
	expect(expectNamesHeld(others, hovered, 'hovered', (id) => !neighbours.has(id))).toBeGreaterThan(
		1
	);
});

/** Open the Filter panel and hide one answer of an Attribute. */
async function hideFilterValue(page: Page, attribute: RegExp, value: string) {
	await page.getByRole('button', { name: /^Filter/ }).click();
	const panel = page.locator('#map-filter-panel');
	await expect(panel).toBeVisible();
	await panel.getByRole('button', { name: attribute }).click();
	await page.getByRole('menuitemcheckbox', { name: value, exact: true }).click();
	// A second press on the trigger closes the popover; Escape only closes the dropdown menu.
	await page.getByRole('button', { name: /^Filter/ }).click();
	await expect(panel).toBeHidden();
}

/** Clear every filter through the panel. */
async function clearFilters(page: Page) {
	await page.getByRole('button', { name: /^Filter/ }).click();
	const panel = page.locator('#map-filter-panel');
	await expect(panel).toBeVisible();
	await panel.getByRole('button', { name: 'Clear filters' }).click();
	await page.getByRole('button', { name: /^Filter/ }).click();
	await expect(panel).toBeHidden();
}

test('Free places names anew when a filter changes the map', async ({ page, request }) => {
	await populateWorksite(request, ringWorksite());
	await openMapping(page, viewports.wide, undefined);

	// The reference: a freshly filtered map, fitted and named from its first frame.
	await hideFilterValue(page, /^Department/, 'D1');
	const filtered = await settled(() => readDrawing(page));
	expect(filtered.names.length, 'the filtered map shows names').toBeGreaterThan(0);

	// Restore the map, zoom away from the fitted camera, then filter it again. A new
	// filter is a new map: its camera refits and its names are placed against the new
	// arrangement, rather than staying with the zoomed picture.
	await clearFilters(page);
	await settled(() => readDrawing(page));
	await page.getByRole('button', { name: 'Zoom in' }).focus();
	for (let step = 0; step < 3; step += 1) await page.keyboard.press('Enter');
	const zoomed = await settled(() => readDrawing(page));
	await hideFilterValue(page, /^Department/, 'D1');
	const after = await settled(() => readDrawing(page));

	// The fit search steps by 3%, and the two paths can land a step or two apart; a replayed
	// zoomed camera would be 70% larger, so a 10% band still proves the refit.
	expect(
		Math.abs(after.scale / filtered.scale - 1),
		'the filtered map refits instead of keeping the zoom'
	).toBeLessThan(0.1);
	expect(after.scale, 'the zoomed picture is gone').not.toBeCloseTo(zoomed.scale, 2);
	expect([...nameBoxes(after).keys()].sort(), 'the same names are drawn').toEqual(
		[...nameBoxes(filtered).keys()].sort()
	);
	// The refitted map names are placed under the Free cap, against the new arrangement.
	for (const name of after.names)
		if (screenStandoff(after, name) > 33) expect(after.leaders).toContain(name.id);
});

test('Free draws the same names at the same places with motion allowed as with reduced motion', async ({
	page,
	request
}) => {
	await populateWorksite(request, cliquesWorksite());
	await openMapping(page, viewports.wide, undefined);
	const reducedDrawing = await settled(() => readDrawing(page));
	const reduced = nameBoxes(reducedDrawing);
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await openMapping(page, viewports.wide, undefined);
	const animatedDrawing = await settled(() => readDrawing(page));
	const animated = nameBoxes(animatedDrawing);
	expect([...animated.keys()].sort(), 'the same names are drawn').toEqual(
		[...reduced.keys()].sort()
	);
	for (const [id, box] of reduced) {
		const now = animated.get(id)!;
		// DOM text boxes are measured in map units; compare their visible CSS-pixel difference.
		expect(
			Math.abs(now.left - box.left) * animatedDrawing.scale,
			`name ${id} holds its place`
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(now.top - box.top) * animatedDrawing.scale,
			`name ${id} holds its place`
		).toBeLessThanOrEqual(1);
	}
});

test('reaches the same final drawing with motion allowed as with reduced motion', async ({
	page,
	request
}) => {
	const { populated } = await openSixGroups(page, request);
	const reduced = await settled(() => readDrawing(page));
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await openMapping(page, viewports.wide, populated.attributeIds.get('Department'));
	const animated = await settled(() => readDrawing(page));
	expect(mapPositions(animated)).toEqual(mapPositions(reduced));
	expect(pathData(animated)).toEqual(pathData(reduced));
	expect(animated.routesPublished).toBe(true);
});

test('a camera-only resize keeps the composed positions and dragged placements', async ({
	page,
	request
}) => {
	await openSixGroups(page, request);
	const before = await settled(() => readDrawing(page));
	await page.setViewportSize({ width: 1200, height: 800 });
	const resized = await settled(() => readDrawing(page));
	expect(mapPositions(resized)).toEqual(mapPositions(before));
	expect(pathData(resized)).toEqual(pathData(before));
});

function summarize(e: ReturnType<typeof evaluateDrawing>) {
	return {
		dotConflicts: e.dotConflicts,
		nameConflicts: e.nameConflicts,
		headingConflicts: e.headingConflicts,
		regionConflicts: e.regionConflicts,
		layoutConflicts: e.layoutConflicts,
		invalidRoutes: e.invalidRoutes,
		properCrossings: e.properCrossings,
		shallowCrossings: e.shallowCrossings,
		sharedRuns: e.sharedRuns,
		totalLength: Math.round(e.totalLength),
		longestLength: Math.round(e.longestLength),
		outlineGap: Math.round(e.outlineGap)
	};
}
