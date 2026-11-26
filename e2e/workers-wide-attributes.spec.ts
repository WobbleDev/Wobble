import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { gridReport } from './workers-table-grid.ts';
import { addAttributes, addWorkers, type AttributeSeed } from './worksite-builder.ts';

/**
 * #256: a Worksite with six or more Attributes no longer crushes every column to
 * fit the frame. The table holds its readable column floors and scrolls sideways
 * inside its own scrollport, under the sticky header, with the checkbox and Name
 * columns pinned. Cell text wraps inside its cell, which clips its own content, so
 * a value never paints into the neighbouring one (the "No Safety Certifi5+ years"
 * overlap). Only Multi-Select chips stay on one line and truncate.
 *
 * This spec is not in `e2e/ui-specs.ts`: it seeds its own Worksite, so it runs
 * against the Rust dev shim in the regular suite rather than from recordings.
 */

const longAttributes: AttributeSeed[] = [
	{
		name: 'Department',
		kind: 'category',
		options: ['Front of House', 'Back of House', 'No Department']
	},
	// The no-value reading is "No Safety Certifications", the long label that used
	// to bleed into the Tenure cell beside it.
	{ name: 'Safety Certifications', kind: 'category', options: ['First aid', 'Food safety'] },
	{ name: 'Tenure', kind: 'category', options: ['5+ years', '1-2 years'] },
	{ name: 'Availability', kind: 'category', options: ['Weekday mornings', 'Weekend evenings'] },
	{ name: 'Role', kind: 'category', options: ['Service Assistant', 'Server'] },
	{ name: 'Station', kind: 'category', options: ['North', 'South'] },
	{ name: 'Shifts', kind: 'tag', options: ['Dinner', 'Brunch'] }
];

/** The readings each seeded Worker gets, in column order. */
const workerReadings: {
	name: string;
	assessment: string;
	values: (string | string[])[];
}[] = [
	{
		name: 'Katherine Johnson',
		assessment: 'Supporter',
		values: [
			'Front of House',
			// A blank Category shows the long system reading.
			'',
			'5+ years',
			'Weekday mornings',
			'Service Assistant',
			'North',
			['Dinner', 'Brunch']
		]
	},
	{
		name: 'Margaret Hamilton',
		assessment: 'Leader',
		values: [
			'Back of House',
			'Food safety',
			'1-2 years',
			'Weekend evenings',
			'Server',
			'South',
			['Brunch']
		]
	}
];

async function seedLongAttributeWorkers(page: Page, request: APIRequestContext) {
	const ids = await addAttributes(request, longAttributes);
	await addWorkers(
		request,
		workerReadings.map(({ name, assessment, values }) => ({
			name,
			assessment,
			attributes: Object.fromEntries(
				values.slice(0, ids.length).map((value, index) => [ids[index], value])
			)
		}))
	);
	await page.goto('/workers');
	await appReady(page);
	await expect(page.getByRole('row').filter({ hasText: 'Katherine Johnson' })).toBeVisible();
}

/** Two frames, so the layout has settled after a viewport change. */
async function settleLayout(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}

/**
 * A text box as the eye sees it: the text node's range, narrowed by the cell's
 * clipping and by the scrollport itself. Unpinned cells that slide under the
 * pinned Name column are clipped at its right edge, so being covered is not
 * mistaken for a collision.
 */
async function visibleTextCollisions(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const viewport = document.querySelector<HTMLElement>('[data-testid="workers-scroll-viewport"]');
		if (!viewport) throw new Error('The Workers table scrollport is missing.');
		const viewportRect = viewport.getBoundingClientRect();

		const textBox = (text: HTMLElement, leftEdge: number) => {
			const range = document.createRange();
			range.selectNodeContents(text);
			const rangeRect = range.getBoundingClientRect();
			let left = Math.max(rangeRect.left, leftEdge, viewportRect.left);
			let right = Math.min(rangeRect.right, viewportRect.right);
			const clip = (element: HTMLElement | null) => {
				if (!element) return;
				const style = getComputedStyle(element);
				if (!/(hidden|clip)/.test(style.overflowX)) return;
				const box = element.getBoundingClientRect();
				left = Math.max(left, box.left);
				right = Math.min(right, box.right);
			};
			clip(text);
			clip(text.closest('td'));
			return right > left ? { left, right } : null;
		};

		const collisions: string[] = [];
		for (const row of document.querySelectorAll<HTMLTableRowElement>('tbody tr[data-index]')) {
			const cells = [...row.querySelectorAll<HTMLTableCellElement>('td[data-column-id]')];
			// The pinned Name cell paints over whatever slides under it.
			const pinnedRight =
				row.querySelector<HTMLElement>('td[data-pin="name"]')?.getBoundingClientRect().right ??
				viewportRect.left;
			const boxes = cells.map((cell) => {
				const column = cell.dataset.columnId ?? '';
				const leftEdge = cell.hasAttribute('data-pin')
					? viewportRect.left
					: Math.max(viewportRect.left, pinnedRight);
				const texts = [...cell.querySelectorAll<HTMLElement>('[data-cell-text], [data-name-cell]')]
					.filter((text) => text.getClientRects().length > 0)
					.map((text) => textBox(text, leftEdge))
					.filter((box): box is { left: number; right: number } => box !== null);
				return { column, boxes: texts };
			});

			for (let index = 1; index < boxes.length; index += 1) {
				const previous = boxes[index - 1];
				const next = boxes[index];
				if (previous.boxes.length === 0 || next.boxes.length === 0) continue;
				const previousRight = Math.max(...previous.boxes.map((box) => box.right));
				const nextLeft = Math.min(...next.boxes.map((box) => box.left));
				if (previousRight > nextLeft + 1) {
					collisions.push(
						`${previous.column} overlaps ${next.column}: ${previousRight.toFixed(1)} > ${nextLeft.toFixed(1)}`
					);
				}
			}
		}
		return collisions;
	});
}

/** Header labels whose own text is wider than the label's box. */
async function truncatedHeaders(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('thead span[title]')]
			.filter((label) => label.scrollWidth > label.clientWidth + 1)
			.map((label) => label.getAttribute('title') ?? label.textContent?.trim() ?? '')
	);
}

/**
 * Values whose own text is cut: horizontally ellipsized/clipped, or vertically
 * clipped by a fixed row height. Multi-Select chips truncate by design, so they
 * are skipped when `singleOnly` is set.
 */
async function clippedText(page: Page, selector: string, singleOnly = false): Promise<string[]> {
	return page.evaluate(
		({ selector, singleOnly }) =>
			[...document.querySelectorAll<HTMLElement>(selector)]
				.filter(
					(value) =>
						value.getClientRects().length > 0 &&
						(!singleOnly || !value.closest('[data-cell-multi]'))
				)
				.filter(
					(value) =>
						value.scrollWidth > value.clientWidth + 1 || value.scrollHeight > value.clientHeight + 1
				)
				.map((value) => value.textContent?.trim() ?? ''),
		{ selector, singleOnly }
	);
}

/** All single values and empty readings that are cut inside their own cell. */
function clippedSingleValues(page: Page): Promise<string[]> {
	return clippedText(page, 'tbody tr[data-index] [data-cell-text]', true);
}

/** Assessment readings that are cut inside their own cell. */
function clippedAssessmentValues(page: Page): Promise<string[]> {
	return clippedText(page, 'tbody tr[data-index] td[data-column-id="assessment"] [data-cell-text]');
}

/** The pinned header columns' left edges, and the scrollport's scroll metrics. */
async function pinnedHeader(page: Page) {
	return page.evaluate(() => {
		const viewport = document.querySelector<HTMLElement>('[data-testid="workers-scroll-viewport"]');
		if (!viewport) throw new Error('The Workers table scrollport is missing.');
		const left = (selector: string) =>
			viewport.querySelector(selector)!.getBoundingClientRect().left;
		return {
			select: left('thead th[data-pin="select"]'),
			name: left('thead th[data-pin="name"]'),
			headerPosition: getComputedStyle(viewport.querySelector('thead')!).position,
			clientWidth: viewport.clientWidth,
			scrollWidth: viewport.scrollWidth,
			scrollLeft: viewport.scrollLeft
		};
	});
}

test('six or more Attributes keep readable columns and scroll inside the table scrollport', async ({
	page,
	request
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await seedLongAttributeWorkers(page, request);

	for (const size of [
		{ width: 1280, height: 800 },
		{ width: 1024, height: 640 }
	]) {
		await page.setViewportSize(size);
		await page
			.getByTestId('workers-scroll-viewport')
			.evaluate((element) => (element.scrollLeft = 0));
		await settleLayout(page);

		const report = await gridReport(page);
		const where = `${size.width}x${size.height}`;
		// The page itself never grows sideways: the scrollport absorbs the surplus.
		expect(report.documentOverflowX, `document overflow at ${where}`).toBe(false);
		expect(report.overflowX, `scrollport overflow at ${where}`).toBe(true);
		await expect(page.getByTestId('workers-scroll-viewport')).toHaveAttribute(
			'data-overflow',
			'true'
		);

		// Every one of the seven Attributes is still a column.
		for (const label of longAttributes.map((attribute) => attribute.name)) {
			await expect(page.getByRole('columnheader', { name: label })).toBeAttached();
		}

		const before = await pinnedHeader(page);
		expect(before.headerPosition, `sticky header at ${where}`).toBe('sticky');
		expect(before.scrollLeft, `scrolled to the start at ${where}`).toBe(0);
		expect(before.scrollWidth, `table wider than scrollport at ${where}`).toBeGreaterThan(
			before.clientWidth
		);
		expect(await truncatedHeaders(page), `truncated headers at ${where}`).toEqual([]);
		expect(await clippedSingleValues(page), `clipped single values at ${where}`).toEqual([]);
		expect(await clippedAssessmentValues(page), `clipped Assessment at ${where}`).toEqual([]);
		expect(await visibleTextCollisions(page), `text collisions at ${where}`).toEqual([]);

		// Scrolling reveals the far columns; the header stays put and the pinned
		// checkbox and Name columns never move.
		await page
			.getByTestId('workers-scroll-viewport')
			.evaluate((element) => (element.scrollLeft = 320));
		await settleLayout(page);
		const after = await pinnedHeader(page);
		expect(after.scrollLeft, `scrollport moved at ${where}`).toBeGreaterThan(0);
		expect(
			Math.abs(after.select - before.select),
			`checkbox pinned at ${where}`
		).toBeLessThanOrEqual(1);
		expect(Math.abs(after.name - before.name), `Name pinned at ${where}`).toBeLessThanOrEqual(1);
		expect(after.headerPosition, `sticky header after scroll at ${where}`).toBe('sticky');
		expect(await truncatedHeaders(page), `truncated headers after scroll at ${where}`).toEqual([]);
		expect(
			await clippedSingleValues(page),
			`clipped single values after scroll at ${where}`
		).toEqual([]);
		expect(
			await clippedAssessmentValues(page),
			`clipped Assessment after scroll at ${where}`
		).toEqual([]);
		expect(await visibleTextCollisions(page), `text collisions after scroll at ${where}`).toEqual(
			[]
		);
	}
});

test('three Attributes keep values whole and never bleed at 1024px', async ({ page, request }) => {
	await page.setViewportSize({ width: 1024, height: 640 });
	// The harness reads the shared list, so seed the short Worksite in place and
	// restore the full seven for the wide test.
	const full = longAttributes.splice(0, longAttributes.length);
	longAttributes.push(...full.slice(0, 3));
	try {
		await seedLongAttributeWorkers(page, request);
		await settleLayout(page);
		const where = '1024x640 with 3 Attributes';

		for (const label of longAttributes.map((attribute) => attribute.name)) {
			await expect(page.getByRole('columnheader', { name: label })).toBeAttached();
		}
		expect(await clippedSingleValues(page), `clipped single values at ${where}`).toEqual([]);
		expect(await clippedAssessmentValues(page), `clipped Assessment at ${where}`).toEqual([]);
		expect(await visibleTextCollisions(page), `text collisions at ${where}`).toEqual([]);
	} finally {
		longAttributes.splice(0, longAttributes.length, ...full);
	}
});
