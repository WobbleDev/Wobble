import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { answerRow, attributeRowByName, workerCountCell } from './configuration-outline.ts';

/**
 * Answers nest at least five levels deep. A five-level tree and a Worker holding its
 * deepest answer are saved through the API, then the Configuration outline is checked at
 * wide and narrow widths: every level opens, announces its level, keeps the Workers count
 * and the delete control in the same right-hand columns, and walks with the keyboard.
 */

const LEVELS = ['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5'];

async function seed(request: Parameters<Parameters<typeof test>[2]>[0]['request']) {
	const suffix = randomUUID().slice(0, 8);
	const attribute = `chain-${suffix}`;
	const ids = LEVELS.map((_, index) => `${attribute}~l${index + 1}`);
	const configured = await request.put('/api/attributes', {
		data: [
			{
				id: attribute,
				name: 'Chain',
				kind: 'tag',
				options: ids.map((id, index) => ({
					id,
					value: LEVELS[index],
					...(index > 0 ? { parentId: ids[index - 1] } : {})
				}))
			}
		]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	const created = await request.post('/api/workers', {
		data: {
			name: 'Deep Holder',
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: { [attribute]: [ids[4]] },
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		}
	});
	expect(created.status(), await created.text()).toBe(201);
}

async function open(page: Page): Promise<void> {
	await page.goto('/configuration');
	await appReady(page);
	await page.evaluate(() => document.fonts.ready);
	const chain = attributeRowByName(page, 'Chain');
	await chain.focus();
	await page.keyboard.press('ArrowRight');
	for (const level of LEVELS.slice(0, 4)) {
		await page.keyboard.press('ArrowRight');
		await expect(answerRow(page, level)).toBeFocused();
		await page.keyboard.press('ArrowRight');
	}
}

async function rightEdges(row: Locator) {
	return row.evaluate((element) => {
		const right = (selector: string) =>
			element.querySelector(selector)?.getBoundingClientRect().right ?? Number.NaN;
		const rowBox = element.getBoundingClientRect();
		return {
			count: right('[data-testid="worker-count"]'),
			remove: right('[data-action="remove"]'),
			row: rowBox.right,
			clipped: element.scrollWidth > element.clientWidth + 1
		};
	});
}

for (const width of [1100, 420, 320]) {
	test(`five answer levels stay aligned, labelled and unclipped at ${width}px`, async ({
		page,
		request
	}) => {
		await page.setViewportSize({ width, height: 900 });
		await seed(request);
		await open(page);

		const edges = [];
		for (const [index, level] of LEVELS.entries()) {
			const row = answerRow(page, level);
			await expect(row).toBeVisible();
			await expect(row).toHaveAttribute('aria-level', String(index + 2));
			await expect(row).toHaveAttribute('data-depth', String(index + 2));
			if (index < 4) await expect(row).toHaveAttribute('aria-expanded', 'true');
			edges.push(await rightEdges(row.locator('> div').first()));
		}

		// The deepest answer shows its holder; every shallower one counts it too.
		for (const level of LEVELS) {
			await expect(workerCountCell(answerRow(page, level))).toContainText('1 Worker');
		}

		// The right-hand columns line up at every depth and nothing overflows the row.
		for (const edge of edges) {
			expect(edge.count).toBeCloseTo(edges[0].count, 0);
			expect(edge.remove).toBeCloseTo(edges[0].remove, 0);
			expect(edge.clipped).toBe(false);
			expect(edge.remove).toBeLessThanOrEqual(edge.row + 1);
		}
		const viewport = await page.evaluate(() => document.documentElement.scrollWidth);
		expect(viewport).toBeLessThanOrEqual(width);
	});
}

test('the keyboard walks down five levels', async ({ page, request }) => {
	await seed(request);
	await open(page);

	await answerRow(page, 'Level 1').focus();
	for (const level of LEVELS.slice(1)) {
		await page.keyboard.press('ArrowDown');
		await expect(answerRow(page, level)).toBeFocused();
	}
});
