import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { settled, waitForMapInteraction } from './map.ts';
import { readNames } from './mapping-name-framing.ts';
import { createWorker } from './api.ts';
import density from './fixtures/mapping-density-clipping.json' with { type: 'json' };

/**
 * The desktop floor: at 1024×640 a dense drawing can run out of clear spots for a
 * resting name, so the desktop contract drops a colliding resting name rather than
 * overprinting it. This pins the rendered no-overprint rule and the hover reveal at the
 * floor, and the Worker record's cue for Relationships below the list fold. The drop and
 * fine-search contract itself is pinned by graph-label-placement.spec.ts.
 */
test.use({ reducedMotion: 'reduce' });

const FLOOR = { width: 1024, height: 640 };

/** A small Worksite with one Worker holding seven stored Relationships. */
async function seedSevenRelationships(request: APIRequestContext): Promise<string> {
	const friends: string[] = [];
	for (let index = 1; index <= 7; index += 1) {
		friends.push(await createWorker(request, { name: `Related ${index}` }));
	}
	return createWorker(request, { name: 'Seven Ties', relationships: friends });
}

async function openDenseFloor(page: Page) {
	await page.setViewportSize(FLOOR);
	// The captured ring is the dense synthetic worksite: sixty Workers in eight clusters.
	await page.route('**/api/dataset', (route) => route.fulfill({ json: density.dataset }));
	await page.goto('/mapping');
	await waitForMapInteraction(page);
	await expect(page.locator('svg g[role="button"][data-node-id]')).toHaveCount(60);
}

test(`dense ${FLOOR.width}×${FLOOR.height} names never overprint; an unnamed Worker appears on hover`, async ({
	page
}) => {
	await openDenseFloor(page);
	const reading = await settled(() => readNames(page));
	expect(reading.names.length, 'the dense map draws names').toBeGreaterThan(0);
	for (let i = 0; i < reading.names.length; i += 1) {
		for (let j = i + 1; j < reading.names.length; j += 1) {
			const a = reading.names[i].box;
			const b = reading.names[j].box;
			expect(
				a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
				`${reading.names[i].text} and ${reading.names[j].text} overprint`
			).toBe(false);
		}
	}

	const dots = await page
		.locator('svg g[role="button"][data-node-id]')
		.evaluateAll((groups) => groups.map((group) => group.getAttribute('data-node-id')!));
	const named = new Set(reading.names.map((name) => name.id));
	const dropped = dots.find((id) => !named.has(id));
	expect(dropped, 'the dense floor does not name every Worker at rest').toBeDefined();
	await page.locator(`circle[data-hit-for="${dropped}"]`).hover();
	await expect(page.locator(`text[data-node-label="${dropped}"]`)).toHaveCount(1);
});

test('a Worker record says how many Relationships sit below the list fold', async ({
	page,
	request
}) => {
	await seedSevenRelationships(request);
	await page.setViewportSize(FLOOR);
	await page.goto('/mapping');
	await waitForMapInteraction(page);

	const worker = page.getByRole('button', { name: /^Seven Ties, Unassessed, 7 relationships/ });
	await expect(worker).toBeAttached();
	await worker.click();
	const card = page.getByRole('region', { name: 'Worker record' });
	await expect(card.getByRole('heading', { name: 'Seven Ties' })).toBeVisible();
	await expect(card.locator('ul li button')).toHaveCount(7);

	const list = card.locator('[data-relationships-list]');
	const more = card.locator('[data-relationships-more]');
	await expect
		.poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight))
		.toBe(true);
	await expect(more).toHaveText(/^\+\d+ more$/);
	await expect
		.poll(() => list.evaluate((element) => getComputedStyle(element).maskImage))
		.toContain('linear-gradient');

	await list.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect(more).toHaveCount(0);
	await expect
		.poll(() => list.evaluate((element) => getComputedStyle(element).maskImage))
		.toBe('none');
});
