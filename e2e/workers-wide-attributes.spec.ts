import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { gridReport } from './workers-table-grid.ts';
import { addAttributes, addWorkers, type AttributeSeed } from './worksite-builder.ts';

/**
 * #256: a Worksite with six or more Attributes no longer crushes every column to
 * fit the frame. The table holds its readable column floors and scrolls sideways
 * inside its own scrollport, under the sticky header, with the checkbox and Name
 * columns pinned. Long cell text truncates inside its cell instead of painting
 * into the neighbouring one (the "No Safety Certifi5+ years" overlap).
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

async function seedLongAttributeWorkers(page: Page, request: APIRequestContext) {
	const ids = await addAttributes(request, longAttributes);
	await addWorkers(request, [
		{
			name: 'Katherine Johnson',
			assessment: 'Supporter',
			attributes: {
				[ids[0]]: 'Front of House',
				// A blank Category shows the long system reading.
				[ids[1]]: '',
				[ids[2]]: '5+ years',
				[ids[3]]: 'Weekday mornings',
				[ids[4]]: 'Service Assistant',
				[ids[5]]: 'North',
				[ids[6]]: ['Dinner', 'Brunch']
			}
		},
		{
			name: 'Margaret Hamilton',
			assessment: 'Leader',
			attributes: {
				[ids[0]]: 'Back of House',
				[ids[1]]: 'Food safety',
				[ids[2]]: '1-2 years',
				[ids[3]]: 'Weekend evenings',
				[ids[4]]: 'Server',
				[ids[5]]: 'South',
				[ids[6]]: ['Brunch']
			}
		}
	]);
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

/** Assessment readings whose value is cut inside its cell. */
async function truncatedAssessmentValues(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		[
			...document.querySelectorAll<HTMLElement>(
				'tbody tr[data-index] td[data-column-id="assessment"] [data-cell-text]'
			)
		]
			.filter(
				(value) => value.getClientRects().length > 0 && value.scrollWidth > value.clientWidth + 1
			)
			.map((value) => value.textContent?.trim() ?? '')
	);
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
		expect(await truncatedAssessmentValues(page), `truncated Assessment at ${where}`).toEqual([]);
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
			await truncatedAssessmentValues(page),
			`truncated Assessment after scroll at ${where}`
		).toEqual([]);
		expect(await visibleTextCollisions(page), `text collisions after scroll at ${where}`).toEqual(
			[]
		);
	}
});
