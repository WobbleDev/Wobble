import { randomUUID } from 'node:crypto';
import { appReady, gotoConfiguration } from './page-ready.ts';
import { expect, test } from './fixtures.ts';
import { nextFrames } from './frames.ts';
import type { Page } from '@playwright/test';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';

/**
 * Document semantics and long content. The axe findings this stands in for are
 * `document-title`, `region` for the navigation rail, `definition-list` and `dlitem`;
 * each is asserted directly rather than through a new test dependency.
 */

const UNBROKEN_NOTE = 'N'.repeat(1000);
const UNBROKEN_EMAIL = `${'e'.repeat(100)}@example.test`;
const LONG_NAME = 'A'.repeat(150);
const LONG_VALUE = 'V'.repeat(400);

async function expandRecord(page: Page, name: string) {
	await page
		.getByRole('row', { name: new RegExp(name) })
		.getByRole('gridcell', { name: `Name for ${name}: ${name}`, exact: true })
		.first()
		.click();
	await expect(page.getByRole('complementary', { name: `Worker details: ${name}` })).toBeVisible();
}

/** Horizontal overflow of the document itself, which no value may cause. */
function documentOverflow(page: Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

test('every route titles the document with its view, the Worksite and the app', async ({
	page,
	activeWorksite
}) => {
	const expected: [string, string][] = [
		['/overview', `Overview — ${activeWorksite.name} — Wobble`],
		['/workers', `Workers — ${activeWorksite.name} — Wobble`],
		['/mapping', `Mapping — ${activeWorksite.name} — Wobble`],
		['/configuration', `Configuration — ${activeWorksite.name} — Wobble`],
		['/settings', `Settings — ${activeWorksite.name} — Wobble`]
	];

	for (const [path, title] of expected) {
		if (path === '/configuration') await gotoConfiguration(page);
		else {
			await page.goto(path);
			await appReady(page);
		}
		await expect(page).toHaveTitle(title);
	}

	// Client-side navigation updates it too, not only a fresh load.
	await page.goto('/overview');
	await appReady(page);
	await page.getByRole('link', { name: 'Workers', exact: true }).click();
	await expect(page).toHaveTitle(`Workers — ${activeWorksite.name} — Wobble`);
});

test('the navigation rail is a named landmark and the current route is marked', async ({
	page
}) => {
	await page.goto('/workers');
	await appReady(page);

	const rail = page.getByRole('navigation', { name: 'Worksite' });
	await expect(rail).toBeVisible();
	await expect(rail.getByRole('link', { name: 'Workers', exact: true })).toHaveAttribute(
		'aria-current',
		'page'
	);
	await expect(rail.getByRole('link', { name: 'Mapping', exact: true })).not.toHaveAttribute(
		'aria-current',
		'page'
	);

	// The main landmark and its skip link survive alongside it.
	await expect(page.getByRole('main')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Skip to content' })).toBeAttached();
});

test('the expanded record is a valid description list', async ({ page, request }) => {
	// A Worker answers every configured Attribute, so clear the seeded vocabulary.
	expect((await request.put('/api/attributes', { data: wireDefinitions([]) })).ok()).toBeTruthy();
	await createWorker(request, { name: 'Listed Worker' });

	await page.goto('/workers');
	await appReady(page);
	await expandRecord(page, 'Listed Worker');

	// A `dt`/`dd` may sit only inside a `dl`, or inside a single `div` child of
	// one. The `dl > div > div > dt` nesting was the finding.
	const offenders = await page.evaluate(() => {
		const problems: string[] = [];
		for (const term of document.querySelectorAll('dt, dd')) {
			const parent = term.parentElement;
			if (!parent) continue;
			if (parent.tagName === 'DL') continue;
			if (parent.tagName === 'DIV' && parent.parentElement?.tagName === 'DL') continue;
			const where = `${parent.tagName.toLowerCase()}<${parent.parentElement?.tagName.toLowerCase() ?? '?'}>`;
			problems.push(`${term.tagName.toLowerCase()} in ${where}`);
		}
		return problems;
	});

	expect(offenders).toEqual([]);
	await expect(page.locator('dl').filter({ hasText: 'Email' }).first()).toBeVisible();
});

test('a long unbroken record stays inside its widths at every size', async ({ page, request }) => {
	// A per-test id: attribute ids are owned globally across Worksites, so a
	// hardcoded literal collides with the other browser project's copy of this
	// test (the pre-existing setup failure). The id never appears in a selector.
	const longAttributeId = randomUUID();
	await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: longAttributeId,
				name: 'A very long Attribute name that will not fit a narrow column',
				kind: 'category',
				options: [LONG_VALUE]
			}
		])
	});
	await createWorker(request, {
		name: LONG_NAME,
		email: UNBROKEN_EMAIL,
		attributes: { [longAttributeId]: LONG_VALUE },
		notes: [{ id: 'long-note', text: UNBROKEN_NOTE, timestamp: '2024-01-01T00:00:00.000Z' }]
	});

	await page.goto('/workers');
	await appReady(page);
	await expandRecord(page, LONG_NAME);

	for (const width of [320, 390, 1024, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		await nextFrames(page);

		// An unbroken value must wrap rather than widen the page or be clipped
		// inside its own box. The Workers table's own horizontal scroll, where the
		// viewport is too narrow for the columns, is permitted and not measured here.
		const clipped = await page.evaluate(() =>
			[...document.querySelectorAll('main dd, main dt, main h2')]
				.filter((element) => element.scrollWidth > element.clientWidth + 1)
				.map((element) => `${element.tagName.toLowerCase()} ${element.textContent?.slice(0, 30)}`)
		);

		expect(await documentOverflow(page), `document overflows at ${width}px`).toBeLessThanOrEqual(1);
		expect(clipped, `clipped record values at ${width}px`).toEqual([]);
	}
});

test('a Note keeps its own line breaks and still wraps', async ({ page, request }) => {
	expect((await request.put('/api/attributes', { data: wireDefinitions([]) })).ok()).toBeTruthy();
	await createWorker(request, {
		name: 'Note Keeper',
		notes: [
			{
				id: 'note-1',
				text: `first line\nsecond line\n${UNBROKEN_NOTE}`,
				timestamp: '2024-01-01T00:00:00.000Z'
			}
		]
	});

	await page.goto('/workers');
	await appReady(page);
	await expandRecord(page, 'Note Keeper');

	const note = page.locator('main p').filter({ hasText: 'first line' }).first();
	await expect(note).toBeVisible();
	expect(await note.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('pre-wrap');

	await page.setViewportSize({ width: 320, height: 900 });
	await nextFrames(page);
	expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
});
