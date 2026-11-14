import { paintedColors } from './painted-colors.ts';
import { randomUUID } from 'node:crypto';
import { appReady } from './page-ready.ts';
import type { APIRequestContext, Page } from '@playwright/test';
import { clippedContent, expect, scrollableOverflow, test } from './fixtures.ts';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';

/**
 * Ticket 05: the dashboard holds up with real-world data and settings. Empty and
 * partial Worksites show plain messages, long names truncate, the matrix and the
 * group list scroll inside their cards with a fade at clipped edges, every label
 * reads in both themes, and Overview never scrolls at the 1024x640 floor.
 *
 * Regular-suite rules apply: no settings writes (themes ride emulateMedia, and
 * density/text-size ride the root attributes directly), one worker, zero retries.
 */

const overallCard = (page: Page) => page.getByRole('region', { name: 'Overall support' });
const coverageCard = (page: Page) => page.getByRole('region', { name: 'Committee coverage' });
const byCard = (page: Page) => page.getByRole('region', { name: /^By/ });
const agitationsCard = (page: Page) => page.getByRole('region', { name: 'Agitations' });

async function seedEmpty(request: APIRequestContext) {
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([])
	});
	expect(configured.ok()).toBeTruthy();
}

test('an empty Worksite shows plain messages and no shade key', async ({ page, request }) => {
	await seedEmpty(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	// Overall support shows the no-workers message in place of the figure and bar.
	const overall = overallCard(page);
	await expect(overall).toContainText('No workers in this worksite yet');
	await expect(overall.locator('.seg')).toHaveCount(0);

	// Committee coverage shows 0/0 with no check mark.
	const coverage = coverageCard(page);
	await expect(coverage).toContainText('Leaders 0 · needed 0');
	await expect(coverage.getByRole('img', { name: 'Target met' })).toHaveCount(0);

	// The By card names the missing grouping and its Select is empty.
	const by = byCard(page);
	await expect(by).toContainText('Nothing available to group by');
	await expect(by.locator('li')).toHaveCount(1);
	await expect(by.getByRole('button')).toHaveCount(0);

	// The Agitations card names the empty reading and renders no shade key.
	const agitations = agitationsCard(page);
	await expect(agitations).toContainText(
		'Nothing available to group by. Configure a grouping in Configuration.'
	);
	await expect(agitations.locator('div[aria-hidden="true"]')).toHaveCount(0);
	await expect(agitations.locator('table')).toHaveCount(0);
});

const LONG_GROUP = 'Rotating night-shift crew for the riverside depot and the late kiosks rota';
const LONG_AGITATION = 'The weekend rota is never posted before the Friday afternoon rush begins';

async function seedLong(request: APIRequestContext) {
	const deptId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: [LONG_GROUP, 'Back'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const long = await request.post('/api/agitations', { data: { text: LONG_AGITATION } });
	expect(long.ok()).toBeTruthy();
	const longId = (await long.json()).agitation.id as string;
	const pay = await request.post('/api/agitations', { data: { text: 'Pay' } });
	expect(pay.ok()).toBeTruthy();
	const payId = (await pay.json()).agitation.id as string;

	// Eight workers, no Leaders: the target needs two, so the shortfall line reads.
	const crew = [
		{ name: 'Ana', dept: LONG_GROUP, agitations: [longId, payId] },
		{ name: 'Beto', dept: LONG_GROUP, agitations: [longId] },
		{ name: 'Carla', dept: LONG_GROUP, agitations: [longId] },
		{ name: 'Diego', dept: LONG_GROUP, agitations: [] },
		{ name: 'Elena', dept: 'Back', agitations: [payId] },
		{ name: 'Felipe', dept: 'Back', agitations: [] },
		{ name: 'Gloria', dept: 'Back', agitations: [] },
		{ name: 'Hugo', dept: 'Back', agitations: [] }
	];
	for (const worker of crew) {
		await createWorker(request, {
			name: worker.name,
			assessment: 'Supporter',
			attributes: { [deptId]: worker.dept },
			agitations: worker.agitations
		});
	}
}

test('group names truncate, row labels wrap fully, and long headers remain readable', async ({
	page,
	request
}) => {
	await seedLong(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	// The By group's long name truncates with an ellipsis and keeps its full name.
	const groupName = byCard(page).locator('ul li a[title]').first();
	await expect(groupName).toHaveAttribute('title', LONG_GROUP);
	const groupOverflow = await groupName.evaluate((el) => ({
		truncated: el.scrollWidth > el.clientWidth + 1,
		ellipsis: getComputedStyle(el).textOverflow === 'ellipsis'
	}));
	expect(groupOverflow.truncated, 'group name truncates').toBe(true);
	expect(groupOverflow.ellipsis, 'group name shows an ellipsis').toBe(true);

	// Matrix row labels render in full and wrap inside their cell.
	const rowName = agitationsCard(page).locator('tbody th[title]').first();
	await expect(rowName).toHaveAttribute('title', LONG_AGITATION);
	const rowLayout = await rowName.evaluate((el) => ({
		text: el.textContent?.trim(),
		horizontalClip: el.scrollWidth > el.clientWidth + 1,
		verticalClip: el.scrollHeight > el.clientHeight + 1,
		wrap: getComputedStyle(el).whiteSpace
	}));
	expect(rowLayout.text, 'row label keeps its complete text').toBe(LONG_AGITATION);
	expect(rowLayout.horizontalClip, 'row label has no horizontal clipping').toBe(false);
	expect(rowLayout.verticalClip, 'row label has no vertical clipping').toBe(false);
	expect(rowLayout.wrap, 'row label can wrap').not.toBe('nowrap');

	// A header too long for its column shows its Abbreviation, keeping the mono uppercase voice;
	// the full value stays in the title.
	const visibleHeaders = agitationsCard(page).locator(
		'table[data-agitations-headers] thead th[title]'
	);
	const header = visibleHeaders.locator('[data-group-name]').first();
	await expect(visibleHeaders.first()).toHaveAttribute('title', LONG_GROUP);
	await expect(header).toHaveText('Rotating …');
	await expect(header).toHaveCSS('text-transform', 'uppercase');
	const headerOverflow = await header.evaluate((el) => ({
		truncated: el.scrollWidth > el.clientWidth + 1,
		ellipsis: getComputedStyle(el).textOverflow,
		whiteSpace: getComputedStyle(el).whiteSpace,
		mono: getComputedStyle(el).fontFamily
	}));
	expect(headerOverflow.truncated, 'header text fits without horizontal clipping').toBe(false);
	expect(headerOverflow.ellipsis, 'header needs no ellipsis').not.toBe('ellipsis');
	expect(headerOverflow.whiteSpace, 'header can wrap').not.toBe('nowrap');
	expect(headerOverflow.mono).toMatch(/mono/i);

	// The shortfall line sits above the basis line, on its own line.
	const coverage = coverageCard(page);
	await expect(coverage).toContainText('Leaders, 2 short of target');
	await expect(coverage).toContainText('1 Leader per 5 workers, of all Workers');
	const lines = await coverage.evaluate((el) => {
		const short = [...el.querySelectorAll('span')].find((s) =>
			s.textContent?.includes('short of target')
		);
		if (!short) return null;
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const range = document.createRange();
		let basisTop = NaN;
		while (walker.nextNode()) {
			const node = walker.currentNode as Text;
			if (!node.textContent?.includes('1 Leader per')) continue;
			range.selectNodeContents(node);
			basisTop = range.getBoundingClientRect().top;
		}
		return {
			display: getComputedStyle(short).display,
			shortBottom: short.getBoundingClientRect().bottom,
			basisTop
		};
	});
	expect(lines?.display, 'shortfall is a block').toBe('block');
	expect(lines!.shortBottom, 'shortfall sits above the basis line').toBeLessThanOrEqual(
		lines!.basisTop + 1
	);

	// The two-row matrix keeps natural row heights within its available card.
	const small = agitationsCard(page).locator('[data-scroll-region]');
	const naturalFit = await small.evaluate((element) => ({
		available: element.clientHeight,
		content: element.querySelector('table')!.getBoundingClientRect().height
	}));
	expect(naturalFit.content).toBeLessThanOrEqual(naturalFit.available + 1);

	// It fits its card: no edge fades in either direction.
	for (const edge of ['data-top', 'data-bottom', 'data-left', 'data-right'] as const) {
		await expect(small).toHaveAttribute(edge, 'false');
	}
});

async function seedMany(request: APIRequestContext) {
	const deptId = randomUUID();
	const groups = Array.from({ length: 12 }, (_, i) => `Team ${String(i + 1).padStart(2, '0')}`);
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([{ id: deptId, name: 'Department', kind: 'category', options: groups }])
	});
	expect(configured.ok()).toBeTruthy();

	const agitationIds: string[] = [];
	for (let i = 0; i < 12; i += 1) {
		const created = await request.post('/api/agitations', { data: { text: `Cause ${i + 1}` } });
		expect(created.ok()).toBeTruthy();
		agitationIds.push((await created.json()).agitation.id as string);
	}
	for (let i = 0; i < 12; i += 1) {
		await createWorker(request, {
			name: `Worker ${i + 1}`,
			assessment: i % 3 === 0 ? 'Leader' : 'Supporter',
			attributes: { [deptId]: groups[i]! },
			agitations: [agitationIds[i]!, agitationIds[(i + 1) % agitationIds.length]!]
		});
	}
}

test('the matrix fades clipped rows while the support breakdown pages whole groups', async ({
	page,
	request
}) => {
	await seedMany(request);
	await page.setViewportSize({ width: 1024, height: 640 });
	await page.goto('/overview');
	await appReady(page);

	// The twelve-row matrix overflows its capped card: the bottom edge fades.
	const matrix = agitationsCard(page).locator('[data-scroll-region]');
	await expect(matrix).toHaveAttribute('data-bottom', 'true');
	await expect(matrix).toHaveAttribute('data-top', 'false');

	// Scrolled to the end, the fade moves to the top edge.
	await matrix.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
	await expect(matrix).toHaveAttribute('data-bottom', 'false');
	await expect(matrix).toHaveAttribute('data-top', 'true');

	// The breakdown has no scrolling/faded edge: a footer pages whole groups.
	const by = byCard(page);
	await expect(by.locator('[data-scroll-region]')).toHaveCount(0);
	const pager = by.locator('[data-group-pager]');
	await expect(pager).toBeVisible();
	await expect(pager.locator('[data-group-range]')).toContainText(/^Groups 1–/);
	await pager.getByRole('button', { name: 'Next support breakdown page' }).click();
	await expect(pager.locator('[data-group-range]')).not.toContainText(/^Groups 1–/);
});

/** Relative luminance of a computed rgb() triple, per WCAG. */
function luminance(rgb: string): number {
	const channels = [...rgb.matchAll(/(\d+(?:\.\d+)?)/g)].slice(0, 3).map((m) => {
		const s = Number(m[1]) / 255;
		return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

async function seedContrast(request: APIRequestContext) {
	const deptId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: ['North', 'South'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const ids: Record<string, string> = {};
	for (const text of ['Rota', 'Pay', 'Hours']) {
		const created = await request.post('/api/agitations', { data: { text } });
		expect(created.ok()).toBeTruthy();
		ids[text] = (await created.json()).agitation.id as string;
	}
	// Rota concentrates in North (full heat), Pay splits, Hours sits in South.
	const crew = [
		{ name: 'Ana', assessment: 'Leader', dept: 'North', agitations: [ids.Rota] },
		{ name: 'Beto', assessment: 'Leader', dept: 'North', agitations: [ids.Rota] },
		{ name: 'Carla', assessment: 'Supporter', dept: 'North', agitations: [ids.Rota, ids.Pay] },
		{ name: 'Gina', assessment: 'Supporter', dept: 'North', agitations: [ids.Rota] },
		{ name: 'Diego', assessment: 'Disengaged', dept: 'South', agitations: [ids.Pay] },
		{ name: 'Elena', assessment: 'Hostile', dept: 'South', agitations: [ids.Hours] },
		{ name: 'Felipe', assessment: 'Unassessed', dept: 'South', agitations: [ids.Hours] }
	];
	for (const worker of crew) {
		await createWorker(request, {
			name: worker.name,
			assessment: worker.assessment,
			attributes: { [deptId]: worker.dept },
			agitations: worker.agitations
		});
	}
}

async function seedHero(request: APIRequestContext) {
	const deptId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: ['North', 'South'] }
		])
	});
	expect(configured.ok()).toBeTruthy();
	const target = await request.put('/api/worksite', { data: { committeeGoal: 1 } });
	expect(target.ok()).toBeTruthy();

	const pay = await request.post('/api/agitations', { data: { text: 'Pay' } });
	expect(pay.ok()).toBeTruthy();
	const payId = (await pay.json()).agitation.id as string;
	for (let i = 0; i < 10; i += 1) {
		await createWorker(request, {
			name: `Leader ${i + 1}`,
			assessment: 'Leader',
			attributes: { [deptId]: i % 2 === 0 ? 'North' : 'South' },
			agitations: i % 2 === 0 ? [payId] : []
		});
	}
}

/** The document and its regions fit without clipping deliberate clamps aside. */
async function expectFittedScroll(page: Page) {
	const documentScroll = await page.evaluate(() => ({
		x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		y: document.documentElement.scrollHeight - document.documentElement.clientHeight
	}));
	expect(documentScroll.x, 'no horizontal page scroll').toBeLessThanOrEqual(1);
	expect(documentScroll.y, 'no vertical page scroll').toBeLessThanOrEqual(1);
	expect(await scrollableOverflow(page), 'no inner overflow outside scroll regions').toBe(0);
}

/** Full fit: deliberate line clamps aside, nothing clips. Short names only. */
async function expectNoPageScroll(page: Page) {
	await expectFittedScroll(page);
	// Paging settles asynchronously after a resize (ResizeObserver, then a
	// reactive flush), so poll the settled page instead of catching a frame
	// mid-transition. A layout that never settles still fails on timeout.
	await expect.poll(() => clippedContent(page), { message: 'no clipped content' }).toEqual([]);
}

test('never scrolls the page at the floor in any density, and 10/10 fits its card', async ({
	page,
	request
}) => {
	await seedHero(request);
	await page.setViewportSize({ width: 1024, height: 640 });
	await page.goto('/overview');
	await appReady(page);

	// The hero number and its check mark fit inside the coverage card.
	const coverage = coverageCard(page);
	await expect(coverage).toContainText('Leaders 10 · needed 10');
	await expect(coverage.getByRole('img', { name: 'Target met' })).toBeVisible();
	await expectNoPageScroll(page);

	// The guarantee holds at every density, with the root attribute set directly
	// (regular specs never write settings; the CSS reads the same attribute).
	for (const density of ['compact', 'comfortable'] as const) {
		await page.evaluate((value) => {
			document.documentElement.dataset.density = value;
		}, density);
		await appReady(page);
		await expect(coverage).toContainText('Leaders 10 · needed 10');
		await expectNoPageScroll(page);
	}
	await page.evaluate(() => {
		document.documentElement.dataset.density = 'standard';
	});

	// At enlarged text the surface follows the no-scroll-surface rules: the page
	// itself still never scrolls.
	for (const textSize of ['125', '150'] as const) {
		await page.evaluate((value) => {
			document.documentElement.dataset.textSize = value;
		}, textSize);
		await appReady(page);
		await expect(coverage).toContainText('Leaders 10 · needed 10');
		await expectNoPageScroll(page);
	}
});

test.describe('in Spanish', () => {
	test.use({ locale: 'es-MX' });

	test('every visible string renders without overflow', async ({ page, request }) => {
		await seedContrast(request);
		await page.setViewportSize({ width: 1440, height: 874 });
		await page.goto('/overview');
		await appReady(page);

		await expect(page.locator('html')).toHaveAttribute('lang', 'es-419');
		await expect(page.getByRole('region', { name: 'Apoyo general' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Por', exact: true })).toBeVisible();
		await expect(page.getByText(/Líderes 2 · necesarios 1 · de /)).toBeVisible();
		await expect(page.getByText(/Líderes 0 · necesarios 1 · de /)).toBeVisible();
		await expect(page.getByRole('columnheader', { name: 'Todos' })).toBeVisible();
		await expect(page.getByRole('region', { name: 'Agitaciones' })).toBeVisible();
		await expectNoPageScroll(page);

		await page.setViewportSize({ width: 1024, height: 640 });
		await expectNoPageScroll(page);
	});
});

const pseudo = process.env.VITE_WOBBLE_PSEUDO_LOCALE === '1';
test.describe('in the expanded pseudo-locale', () => {
	test.skip(!pseudo, 'run with VITE_WOBBLE_PSEUDO_LOCALE=1 to exercise en-XA');

	test('longer strings never overflow the dashboard', async ({ page, request }) => {
		await seedLong(request);
		for (const size of [
			{ width: 1440, height: 874 },
			{ width: 1024, height: 640 }
		] as const) {
			await page.setViewportSize(size);
			await page.goto('/overview');
			await appReady(page);
			await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
			// Long names truncate and clamp by design; what must hold is that the
			// document and the cards' regions fit without scrolling the page.
			await expectFittedScroll(page);
			await page.screenshot({
				path: `.scratch/overview-dashboard/evidence/05-enxa-${size.width}x${size.height}.png`
			});
		}
	});
});

for (const colorScheme of ['light', 'dark'] as const) {
	for (const palette of ['default', 'colorblind'] as const) {
		test(`every cell number and printed segment count reaches 4.5:1 in ${colorScheme} with ${palette} palette`, async ({
			page,
			request
		}) => {
			await seedContrast(request);
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize({ width: 1440, height: 874 });
			await page.goto('/overview');
			await appReady(page);
			await page.evaluate((value) => {
				document.documentElement.dataset.assessmentPalette = value;
			}, palette);

			const headers = await agitationsCard(page)
				.locator('table[data-agitations-headers] thead th')
				.evaluateAll((elements) =>
					elements.map((element) => getComputedStyle(element).backgroundColor)
				);
			for (const background of headers) expect(background).toBe('rgba(0, 0, 0, 0)');

			// Matrix All cells are intentionally transparent. Composite ancestor
			// surfaces before sampling, while still resolving modern CSS colors in Chromium.
			const cells = await paintedColors(agitationsCard(page).locator('tbody td'));
			expect(cells.length).toBeGreaterThan(0);
			const zeros = cells.filter((cell) => cell.text === '0');
			expect(zeros.length).toBeGreaterThan(0);
			for (const cell of zeros) expect(cell.background).toBe(cell.neutral);
			await page.screenshot({
				path: test.info().outputPath(`agitations-${colorScheme}.png`),
				fullPage: true
			});
			for (const cell of cells) {
				expect(
					contrastRatio(cell.background, cell.color),
					`matrix cell ${cell.background} / ${cell.color} in ${colorScheme}`
				).toBeGreaterThanOrEqual(4.5);
			}

			// Printed Overall support segment counts against their own fills.
			const segments = await paintedColors(overallCard(page).locator('.seg'));
			const printed = segments.filter((s) => s.text.length > 0);
			expect(printed.length).toBeGreaterThan(0);
			for (const segment of printed) {
				expect(
					contrastRatio(segment.background, segment.color),
					`segment "${segment.text}" ${segment.background} / ${segment.color} in ${colorScheme}`
				).toBeGreaterThanOrEqual(4.5);
			}
		});
	}
}

test('contrast sampling measures transparent cells over their painted ancestor', async ({
	page
}) => {
	await page.goto('/overview');
	await appReady(page);
	await page.evaluate(() => {
		const probe = document.createElement('div');
		probe.id = 'contrast-probe';
		probe.style.cssText = 'position:fixed;inset:0 auto auto 0;background:#fff;color:#000';
		probe.innerHTML = '<span style="background:transparent;color:#000">transparent</span>';
		document.body.append(probe);
	});
	const colors = await paintedColors(page.locator('#contrast-probe span'));
	expect(colors).toHaveLength(1);
	expect(colors[0].background).toBe('rgb(255, 255, 255)');
	expect(colors[0].color).toBe('rgb(0, 0, 0)');
});
